// src/tools/fileTools.ts
// Native workspace file tools. Pure beyond fs I/O:
// no clock, no randomness, no globals. All paths are workspace-jailed under
// ctx.cwd; tools NEVER throw to the caller — fs errors become { ok:false, error }.
// Tools NEVER call evaluate/awaitPermission — the executor owns the permission
// round-trip (see executor.ts + the frozen ToolCtx contract).
//
// W12 — sensitive-path deny (see DEFAULT_SENSITIVE_PATTERNS below). These tools
// additionally refuse to touch a shipped default set of secret-bearing
// paths (.env, *.pem, id_rsa, .ssh/*, .npmrc, credentials) even when the target
// sits INSIDE the workspace jail. IMPORTANT LIMIT: this covers juno's OWN file
// tools ONLY. It does NOT cover `run_shell` — shellTool.ts has no path jail and
// neither the policy nor the tool layer can see command content, so `run_shell`
// can still `cat .env`. That path is gated only by run_shell being risk:'dangerous'
// (always human-prompted); full non-interactive coverage needs the OS-sandbox deny.
import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import { atomicWriteFile } from '../services/atomicWrite';

// --- arg narrowing (no `any`) -------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function integerProp(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- sensitive-path deny ------------------------------------------------------
// A shipped-by-default deny on secret-bearing paths, enforced on the CANONICAL,
// workspace-RELATIVE path (`rel`) that resolveInWorkspace already computes —
// NOT the raw arg. Matching on the post-realpath `rel` is what makes this robust
// where a policy-layer deny is not: src/permissions/patterns.ts matchKey keys on
// the RAW args.path/args.dir, so `read_file:**/.env` is evadable via ./x/../.env,
// an absolute form, or a symlink renamed to a harmless name. All three dereference
// to the same canonical `rel`, so a check here closes them at once. (read_file/
// list_files/grep are risk:'safe' → auto-allowed, so the tool layer is also the
// only place that can close the grep-walk content leak; see createGrepTool.)
//
// COVERAGE LIMIT (see the file header): juno's own file tools ONLY, never run_shell.

/**
 * Shipped default sensitive-path patterns, matched against the canonical
 * workspace-relative path, per path SEGMENT, case-insensitively (macOS FS is
 * case-insensitive and realpath preserves on-disk case, so `.ENV` must still be
 * caught; `*` is the only glob metacharacter). Grammar (see isSensitivePath):
 *   - a pattern ending in `/` is a DIRECTORY-SEGMENT rule — deny if ANY segment
 *     matches the name (`.ssh/` denies any path containing a `.ssh` segment);
 *   - otherwise it is a BASENAME rule — glob-match the final segment.
 * Anchored per segment so it does NOT over-match: `env.example`, `environment.ts`,
 * and `readme.pem.txt` all stay readable. Covers juno's own file tools ONLY —
 * run_shell can still read these (see the file header).
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  '.env', // exact dotfile
  '.env.*', // .env.local / .env.production (but NOT env.example)
  '.npmrc', // may carry an _authToken
  'id_rsa', // conventional private-key name
  'credentials', // aws/gcloud-style credential file
  '*.pem', // any PEM key/cert, anchored to the END of the basename
  '.ssh/', // deny any path with a .ssh directory segment
];

/** Case-insensitive, anchored `*`-glob over a single path segment. Mirrors
 * globMatches' escape style but adds the `i` flag (sensitive basenames match
 * case-insensitively) and matches a whole segment (`^…$`). Total: never throws. */
function segmentMatchesGlob(segment: string, glob: string): boolean {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'iu').test(segment);
}

/**
 * Pure predicate: is the workspace-RELATIVE canonical path `rel` denied by the
 * sensitive `patterns`? Splits `rel` on either separator (Windows `\\` and POSIX
 * `/`, so a rel produced on Windows is handled too), then applies each pattern:
 * a `dir/` pattern denies if ANY segment matches its name; a bare pattern
 * glob-matches the final segment (basename). Empty `rel` (the jail root itself)
 * is never sensitive. Total: never throws.
 */
export function isSensitivePath(rel: string, patterns: readonly string[]): boolean {
  if (rel === '') return false;
  const segments = rel.split(/[/\\]+/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const basename = segments[segments.length - 1] as string;
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      const dirName = pattern.slice(0, -1);
      if (dirName.length === 0) continue;
      if (segments.some((segment) => segmentMatchesGlob(segment, dirName))) return true;
    } else if (segmentMatchesGlob(basename, pattern)) {
      return true;
    }
  }
  return false;
}

/** Options controlling the sensitive-path deny for a createFileTools() instance. */
export interface FileToolsOptions {
  readonly sensitiveDeny?: {
    /** Turn OFF the shipped DEFAULT_SENSITIVE_PATTERNS entirely (so, e.g., .env
     * becomes readable). The `extra` list, if any, still applies. Default: false. */
    readonly disableDefaults?: boolean;
    /** Extra patterns appended to the active set (same grammar as
     * DEFAULT_SENSITIVE_PATTERNS: a basename glob, or a `dir/` segment rule). */
    readonly extra?: readonly string[];
  };
  /** Injectable commit seam for deterministic rollback tests. Production omits this. */
  readonly patchAtomicWrite?: (finalPath: string, contents: string) => Promise<void>;
}

/** Resolve the effective sensitive-pattern set for a createFileTools() call:
 * defaults ON unless `disableDefaults`, plus any `extra`. */
function resolveSensitivePatterns(opts?: FileToolsOptions): readonly string[] {
  const deny = opts?.sensitiveDeny;
  const base = deny?.disableDefaults === true ? [] : DEFAULT_SENSITIVE_PATTERNS;
  const extra = deny?.extra ?? [];
  return extra.length === 0 ? base : [...base, ...extra];
}

// --- workspace jail -----------------------------------------------------------
// Resolve the requested path against the jail root, then reject anything that
// escapes via `..` segments OR is an absolute path outside the root. `path.relative`
// on Windows returns an ABSOLUTE path when the targets live on different drives
// (e.g. C:\ vs D:\), so the `isAbsolute(rel)` guard also covers cross-drive escapes.
//
// Symlinks are canonicalized before the containment check: a link INSIDE the
// workspace that points OUTSIDE it would otherwise pass the `path.resolve` test
// yet dereference to an escape. We `realpath` the root once and the candidate's
// deepest EXISTING ancestor (write targets may not exist yet), then re-append the
// non-existent tail before comparing — so a symlinked ancestor is caught too.

type JailResult = { ok: true; resolved: string } | { ok: false; error: string };

/** Canonicalize `target` by realpath-ing its deepest existing ancestor and
 * re-appending the not-yet-existent tail (so writes to new files resolve, while
 * any symlink along the existing prefix is still dereferenced). */
async function canonicalize(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without resolving anything — return as-is.
        return path.join(current, ...tail.reverse());
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveInWorkspace(
  cwd: string,
  targetPath: string,
  sensitivePatterns: readonly string[] = DEFAULT_SENSITIVE_PATTERNS,
): Promise<JailResult> {
  const resolved = path.resolve(cwd, targetPath);
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    // The workspace root itself must exist and resolve; if it doesn't, escape.
    return { ok: false, error: 'path escapes workspace' };
  }
  const canonical = await canonicalize(resolved);
  const rel = path.relative(root, canonical);
  // `rel === ''` means the target IS the root (allowed, e.g. list_files('.')).
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, error: 'path escapes workspace' };
  }
  // Sensitive-path deny, checked on the canonical in-jail `rel` (see the
  // sensitive-path section). DISTINCT error string from the jail-escape above so
  // callers/tests/logs can tell a jail-escape from a sensitive-deny. A symlink
  // renamed to a harmless name resolves to its sensitive `rel` here and is caught;
  // a raw-arg policy deny would miss it.
  if (isSensitivePath(rel, sensitivePatterns)) {
    return { ok: false, error: 'path is denied (sensitive file)' };
  }
  return { ok: true, resolved: canonical };
}

// --- JSON-schema builders -----------------------------------------------------

function objectSchema(properties: Record<string, unknown>, required: string[]): unknown {
  return { type: 'object', additionalProperties: false, properties, required };
}

// --- specs --------------------------------------------------------------------

const readFileSpec: ToolSpec = {
  name: 'read_file',
  description: 'Read all or a 1-based inclusive line range of a UTF-8 text file within the workspace.',
  inputSchema: objectSchema(
    {
      path: { type: 'string', description: 'Workspace-relative path to the file.' },
      startLine: { type: 'integer', minimum: 1, description: 'Optional first line (1-based, inclusive).' },
      endLine: { type: 'integer', minimum: 1, description: 'Optional last line (1-based, inclusive).' },
    },
    ['path'],
  ),
};

const globFilesSpec: ToolSpec = {
  name: 'glob_files',
  description: 'Find workspace files by a path glob. Supports * within a segment and ** across directories.',
  inputSchema: objectSchema(
    {
      pattern: { type: 'string', description: 'Workspace-relative glob, for example "src/**/*.ts".' },
      dir: { type: 'string', description: 'Workspace-relative search root. Defaults to ".".' },
      maxResults: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum results. Defaults to 200.' },
    },
    ['pattern'],
  ),
};

const treeSpec: ToolSpec = {
  name: 'tree',
  description: 'Return a bounded, sorted repository tree without reading file contents.',
  inputSchema: objectSchema(
    {
      dir: { type: 'string', description: 'Workspace-relative directory. Defaults to ".".' },
      depth: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum directory depth. Defaults to 3.' },
      maxEntries: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum entries. Defaults to 500.' },
    },
    [],
  ),
};

const listFilesSpec: ToolSpec = {
  name: 'list_files',
  description: 'List the immediate child entries of a directory within the workspace.',
  inputSchema: objectSchema(
    { dir: { type: 'string', description: 'Workspace-relative directory path. Defaults to ".".' } },
    [],
  ),
};

const grepSpec: ToolSpec = {
  name: 'grep',
  description: 'Search file contents under a directory for a substring or regular expression, returning matching lines.',
  inputSchema: objectSchema(
    {
      pattern: { type: 'string', description: 'Substring or regular expression to search for.' },
      dir: { type: 'string', description: 'Workspace-relative directory. Defaults to ".".' },
      glob: { type: 'string', description: 'Optional simple glob (with *) to filter filenames.' },
      regex: { type: 'boolean', description: 'Treat pattern as a regular expression; default false = literal substring.' },
    },
    ['pattern'],
  ),
};

const writeFileSpec: ToolSpec = {
  name: 'write_file',
  description: 'Write text content to a file within the workspace, creating parent dirs and overwriting any existing file.',
  inputSchema: objectSchema(
    {
      path: { type: 'string', description: 'Workspace-relative path to the file.' },
      content: { type: 'string', description: 'UTF-8 content to write.' },
    },
    ['path', 'content'],
  ),
};

const editFileSpec: ToolSpec = {
  name: 'edit_file',
  description: 'Replace an exact string in a workspace file with a new string (once, or all occurrences).',
  inputSchema: objectSchema(
    {
      path: { type: 'string', description: 'Workspace-relative path to the file.' },
      oldString: { type: 'string', description: 'Exact text to find.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace all occurrences. Defaults to false.' },
    },
    ['path', 'oldString', 'newString'],
  ),
};

const applyPatchSpec: ToolSpec = {
  name: 'apply_patch',
  description: 'Transactionally apply a structured batch of file creates, full-content updates, and deletes. Updates/deletes require exact oldContent preconditions; failures are rolled back.',
  inputSchema: objectSchema(
    {
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          oneOf: [
            objectSchema(
              {
                op: { const: 'create' },
                path: { type: 'string', description: 'Workspace-relative file path.' },
                content: { type: 'string', description: 'Complete UTF-8 file content.' },
              },
              ['op', 'path', 'content'],
            ),
            objectSchema(
              {
                op: { const: 'update' },
                path: { type: 'string', description: 'Workspace-relative file path.' },
                oldContent: { type: 'string', description: 'Exact current content precondition.' },
                content: { type: 'string', description: 'Complete replacement content.' },
              },
              ['op', 'path', 'oldContent', 'content'],
            ),
            objectSchema(
              {
                op: { const: 'delete' },
                path: { type: 'string', description: 'Workspace-relative file path.' },
                oldContent: { type: 'string', description: 'Exact current content precondition.' },
              },
              ['op', 'path', 'oldContent'],
            ),
          ],
        },
      },
    },
    ['operations'],
  ),
};

// --- read_file ----------------------------------------------------------------

function createReadFileTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'read_file',
    risk: 'safe',
    spec: readFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const requestedPath = stringProp(args, 'path');
      if (requestedPath === undefined) return { ok: false, error: 'invalid args' };
      const startLine = args.startLine === undefined ? 1 : integerProp(args, 'startLine');
      const endLine = args.endLine === undefined ? undefined : integerProp(args, 'endLine');
      if (
        startLine === undefined ||
        startLine < 1 ||
        (endLine !== undefined && (endLine < startLine || endLine < 1))
      ) {
        return { ok: false, error: 'invalid args: line range must be positive and endLine must be >= startLine' };
      }

      const jailed = await resolveInWorkspace(ctx.cwd, requestedPath, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const fullContent = await readFile(jailed.resolved, 'utf8');
        if (args.startLine === undefined && args.endLine === undefined) {
          return { ok: true, data: { path: requestedPath, content: fullContent } };
        }
        const lines = fullContent.split('\n');
        const lastLine = Math.min(endLine ?? lines.length, lines.length);
        const content = startLine > lines.length ? '' : lines.slice(startLine - 1, lastLine).join('\n');
        return {
          ok: true,
          data: { path: requestedPath, content, startLine, endLine: lastLine, totalLines: lines.length },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- glob_files / tree --------------------------------------------------------

/** Convert the deliberately small path-glob grammar to an anchored regexp. */
function pathGlob(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i] as string;
    if (char === '*' && normalized[i + 1] === '*') {
      i += 1;
      if (normalized[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

async function collectRepositoryFiles(
  root: string,
  current: string,
  sensitivePatterns: readonly string[],
  signal: AbortSignal,
  output: string[],
): Promise<void> {
  if (signal.aborted) return;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (signal.aborted) return;
    const relative = path.relative(root, path.join(current, entry.name));
    if (isSensitivePath(relative, sensitivePatterns)) continue;
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        await collectRepositoryFiles(root, path.join(current, entry.name), sensitivePatterns, signal, output);
      }
    } else if (entry.isFile()) {
      output.push(relative.split(path.sep).join('/'));
    }
    // Symlinks are intentionally omitted: navigation must not disclose an unverified target.
  }
}

function createGlobFilesTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'glob_files',
    risk: 'safe',
    spec: globFilesSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const pattern = stringProp(args, 'pattern');
      const requestedDir = args.dir === undefined ? '.' : stringProp(args, 'dir');
      const maxResults = args.maxResults === undefined ? 200 : integerProp(args, 'maxResults');
      if (pattern === undefined || pattern.length === 0 || requestedDir === undefined || maxResults === undefined || maxResults < 1 || maxResults > 1000) {
        return { ok: false, error: 'invalid args' };
      }
      let matcher: RegExp;
      try {
        matcher = pathGlob(pattern);
      } catch {
        return { ok: false, error: 'invalid args: malformed glob' };
      }
      const jailed = await resolveInWorkspace(ctx.cwd, requestedDir, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };
      try {
        const root = await realpath(ctx.cwd);
        const files: string[] = [];
        await collectRepositoryFiles(root, jailed.resolved, sensitivePatterns, ctx.signal, files);
        const prefix = path.relative(root, jailed.resolved).split(path.sep).join('/');
        const allMatches = files.filter((file) => matcher.test(prefix === '' ? file : path.posix.relative(prefix, file)));
        const matches = allMatches.slice(0, maxResults);
        return { ok: true, data: { pattern, files: matches, truncated: allMatches.length > matches.length } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function createTreeTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'tree',
    risk: 'safe',
    spec: treeSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (args !== undefined && args !== null && !isRecord(args)) return { ok: false, error: 'invalid args' };
      const record = isRecord(args) ? args : {};
      const requestedDir = record.dir === undefined ? '.' : stringProp(record, 'dir');
      const depth = record.depth === undefined ? 3 : integerProp(record, 'depth');
      const maxEntries = record.maxEntries === undefined ? 500 : integerProp(record, 'maxEntries');
      if (requestedDir === undefined || depth === undefined || depth < 1 || depth > 10 || maxEntries === undefined || maxEntries < 1 || maxEntries > 2000) {
        return { ok: false, error: 'invalid args' };
      }
      const jailed = await resolveInWorkspace(ctx.cwd, requestedDir, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };
      const entries: Array<{ path: string; type: 'file' | 'directory' }> = [];
      let truncated = false;
      try {
        const visit = async (dir: string, level: number): Promise<void> => {
          if (ctx.signal.aborted || truncated || level > depth) return;
          const children = await readdir(dir, { withFileTypes: true });
          children.sort((a, b) => a.name.localeCompare(b.name));
          for (const child of children) {
            if (ctx.signal.aborted || truncated) return;
            const relative = path.relative(jailed.resolved, path.join(dir, child.name));
            if (isSensitivePath(relative, sensitivePatterns)) continue;
            if (child.isDirectory()) {
              if (shouldSkipDir(child.name)) continue;
              if (entries.length >= maxEntries) { truncated = true; return; }
              entries.push({ path: `${relative.split(path.sep).join('/')}/`, type: 'directory' });
              await visit(path.join(dir, child.name), level + 1);
            } else if (child.isFile()) {
              if (entries.length >= maxEntries) { truncated = true; return; }
              entries.push({ path: relative.split(path.sep).join('/'), type: 'file' });
            }
          }
        };
        await visit(jailed.resolved, 1);
        return { ok: true, data: { dir: requestedDir, entries, truncated } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- list_files ---------------------------------------------------------------

function createListFilesTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'list_files',
    risk: 'safe',
    spec: listFilesSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      // args is optional; when present it must be an object with an optional string `dir`.
      if (args !== undefined && args !== null && !isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      let requestedDir = '.';
      if (isRecord(args) && args.dir !== undefined) {
        const dir = stringProp(args, 'dir');
        if (dir === undefined) return { ok: false, error: 'invalid args' };
        requestedDir = dir;
      }

      const jailed = await resolveInWorkspace(ctx.cwd, requestedDir, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const dirents = await readdir(jailed.resolved, { withFileTypes: true });
        // Filter sensitive basenames from the listing too (chosen contract:
        // exclude, don't merely block reads) so `list_files('.')` does not even
        // surface `.env`/`id_rsa` as NAMES. The target dir itself already cleared
        // the sensitive check above, so an immediate child is sensitive iff its
        // own basename is — hence testing the bare name is sufficient.
        const entries = dirents
          .map((d) => d.name)
          .filter((name) => !isSensitivePath(name, sensitivePatterns))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return { ok: true, data: { dir: requestedDir, entries } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- grep ---------------------------------------------------------------------

type GrepMatcher = (text: string) => boolean;

/**
 * Build a line matcher. Literal substring matching is the DEFAULT (linear time —
 * immune to catastrophic-backtracking ReDoS). Regex is opt-in via `useRegex`,
 * and falls back to substring if `pattern` is not a valid regex.
 */
function createMatcher(pattern: string, useRegex: boolean): GrepMatcher {
  if (!useRegex) {
    return (text: string): boolean => text.includes(pattern);
  }
  try {
    const regex = new RegExp(pattern, 'u');
    return (text: string): boolean => regex.test(text);
  } catch {
    return (text: string): boolean => text.includes(pattern);
  }
}

/** Simple `*` glob over a filename (no path separators). Undefined glob → match all. */
function globMatches(fileName: string, glob: string | undefined): boolean {
  if (glob === undefined || glob === '*') return true;
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(fileName);
}

function shouldSkipDir(dirName: string): boolean {
  return dirName === 'node_modules' || dirName.startsWith('.');
}

/** Recursively collect files under `current`, skipping node_modules + dotdirs. Aborts honour signal. */
async function walkFiles(current: string, glob: string | undefined, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) return [];
  let dirents: Dirent[];
  try {
    dirents = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of dirents) {
    if (signal.aborted) break;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        files.push(...(await walkFiles(full, glob, signal)));
      }
      continue;
    }
    if (entry.isFile() && globMatches(entry.name, glob)) {
      files.push(full);
    }
  }
  return files;
}

function createGrepTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'grep',
    risk: 'safe',
    spec: grepSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const pattern = stringProp(args, 'pattern');
      if (pattern === undefined) return { ok: false, error: 'invalid args' };

      let requestedDir = '.';
      if (args.dir !== undefined) {
        const dir = stringProp(args, 'dir');
        if (dir === undefined) return { ok: false, error: 'invalid args' };
        requestedDir = dir;
      }
      let glob: string | undefined;
      if (args.glob !== undefined) {
        const g = stringProp(args, 'glob');
        if (g === undefined) return { ok: false, error: 'invalid args' };
        glob = g;
      }
      // Only an explicit `true` opts into regex; anything else stays literal substring.
      const useRegex = args.regex === true;

      const jailed = await resolveInWorkspace(ctx.cwd, requestedDir, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const matcher = createMatcher(pattern, useRegex);
        // Realpath the root so match paths are relative to the canonical workspace
        // root — `jailed.resolved` is already canonicalized, so a raw `path.resolve`
        // would diverge on a symlinked root (e.g. macOS /var → /private/var).
        const root = await realpath(ctx.cwd);
        const files = await walkFiles(jailed.resolved, glob, ctx.signal);

        const matches: Array<{ file: string; line: number; text: string }> = [];
        for (const full of files) {
          if (ctx.signal.aborted) break;
          // Grep is the sneakiest reader: resolveInWorkspace only vetted the DIR
          // arg, then walkFiles reads every file directly. shouldSkipDir already
          // skips dot-DIRECTORIES (so .ssh/ never walked), but .env/.npmrc are
          // dotFILES and id_rsa/credentials/*.pem are plain files — all walked.
          // Skip any sensitive file so its CONTENTS never leak through a match.
          if (isSensitivePath(path.relative(root, full), sensitivePatterns)) continue;
          const content = await readFile(full, 'utf8');
          const lines = content.split(/\r?\n/u);
          for (let i = 0; i < lines.length; i++) {
            if (ctx.signal.aborted) break;
            const lineText = lines[i] as string;
            if (matcher(lineText)) {
              matches.push({ file: path.relative(root, full), line: i + 1, text: lineText });
            }
          }
        }

        matches.sort((a, b) => {
          if (a.file < b.file) return -1;
          if (a.file > b.file) return 1;
          return a.line - b.line;
        });
        return { ok: true, data: { matches } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- write_file ---------------------------------------------------------------

function createWriteFileTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'write_file',
    risk: 'risky',
    spec: writeFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const requestedPath = stringProp(args, 'path');
      const content = stringProp(args, 'content');
      if (requestedPath === undefined || content === undefined) {
        return { ok: false, error: 'invalid args' };
      }

      const jailed = await resolveInWorkspace(ctx.cwd, requestedPath, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        await mkdir(path.dirname(jailed.resolved), { recursive: true });
        await writeFile(jailed.resolved, content, 'utf8');
        return {
          ok: true,
          data: { path: requestedPath, bytesWritten: Buffer.byteLength(content, 'utf8') },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- edit_file ----------------------------------------------------------------

function createEditFileTool(sensitivePatterns: readonly string[]): Tool {
  return {
    name: 'edit_file',
    risk: 'risky',
    spec: editFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const requestedPath = stringProp(args, 'path');
      const oldString = stringProp(args, 'oldString');
      const newString = stringProp(args, 'newString');
      if (requestedPath === undefined || oldString === undefined || newString === undefined) {
        return { ok: false, error: 'invalid args' };
      }
      if (oldString.length === 0) {
        return { ok: false, error: 'invalid args' };
      }
      if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') {
        return { ok: false, error: 'invalid args' };
      }
      const replaceAll = args.replaceAll === true;

      const jailed = await resolveInWorkspace(ctx.cwd, requestedPath, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const current = await readFile(jailed.resolved, 'utf8');
        let replacements: number;
        let next: string;
        if (replaceAll) {
          const parts = current.split(oldString);
          replacements = parts.length - 1;
          if (replacements === 0) return { ok: false, error: 'oldString not found' };
          next = parts.join(newString);
        } else {
          const idx = current.indexOf(oldString);
          if (idx === -1) return { ok: false, error: 'oldString not found' };
          replacements = 1;
          next = current.slice(0, idx) + newString + current.slice(idx + oldString.length);
        }
        await writeFile(jailed.resolved, next, 'utf8');
        return { ok: true, data: { path: requestedPath, replacements } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

// --- apply_patch --------------------------------------------------------------

type PatchOperation =
  | { op: 'create'; path: string; content: string }
  | { op: 'update'; path: string; oldContent: string; content: string }
  | { op: 'delete'; path: string; oldContent: string };

type PreparedPatch = PatchOperation & { resolved: string; original: string | undefined };

function parsePatchOperations(args: unknown): PatchOperation[] | undefined {
  if (!isRecord(args) || !Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 100) return undefined;
  const operations: PatchOperation[] = [];
  for (const candidate of args.operations) {
    if (!isRecord(candidate)) return undefined;
    const op = stringProp(candidate, 'op');
    const targetPath = stringProp(candidate, 'path');
    if (targetPath === undefined || targetPath.length === 0) return undefined;
    if (op === 'create') {
      const content = stringProp(candidate, 'content');
      if (content === undefined) return undefined;
      operations.push({ op, path: targetPath, content });
    } else if (op === 'update') {
      const oldContent = stringProp(candidate, 'oldContent');
      const content = stringProp(candidate, 'content');
      if (oldContent === undefined || content === undefined) return undefined;
      operations.push({ op, path: targetPath, oldContent, content });
    } else if (op === 'delete') {
      const oldContent = stringProp(candidate, 'oldContent');
      if (oldContent === undefined) return undefined;
      operations.push({ op, path: targetPath, oldContent });
    } else {
      return undefined;
    }
  }
  return operations;
}

async function rollbackPatch(
  applied: readonly PreparedPatch[],
  atomicWrite: (finalPath: string, contents: string) => Promise<void>,
): Promise<string | undefined> {
  const failures: string[] = [];
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const item = applied[i] as PreparedPatch;
    try {
      if (item.original === undefined) {
        await unlink(item.resolved).catch((error: unknown) => {
          const code = isRecord(error) ? stringProp(error, 'code') : undefined;
          if (code !== 'ENOENT') throw error;
        });
      } else {
        await atomicWrite(item.resolved, item.original);
      }
    } catch (error) {
      failures.push(`${item.path}: ${errorMessage(error)}`);
    }
  }
  return failures.length === 0 ? undefined : failures.join('; ');
}

function createApplyPatchTool(
  sensitivePatterns: readonly string[],
  atomicWrite: (finalPath: string, contents: string) => Promise<void>,
): Tool {
  return {
    name: 'apply_patch',
    risk: 'risky',
    spec: applyPatchSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      const operations = parsePatchOperations(args);
      if (operations === undefined) {
        return { ok: false, error: 'invalid args: operations must be 1-100 valid create/update/delete entries' };
      }

      // Preflight every target and every content precondition before the first write.
      const prepared: PreparedPatch[] = [];
      const canonicalTargets = new Set<string>();
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index] as PatchOperation;
        const jailed = await resolveInWorkspace(ctx.cwd, operation.path, sensitivePatterns);
        if (!jailed.ok) return { ok: false, error: `operation ${index + 1} (${operation.path}): ${jailed.error}` };
        if (canonicalTargets.has(jailed.resolved)) {
          return { ok: false, error: `operation ${index + 1} (${operation.path}): duplicate target in patch` };
        }
        canonicalTargets.add(jailed.resolved);

        let original: string | undefined;
        try {
          const info = await stat(jailed.resolved);
          if (!info.isFile()) return { ok: false, error: `operation ${index + 1} (${operation.path}): target is not a regular file` };
          original = await readFile(jailed.resolved, 'utf8');
        } catch (error) {
          const code = isRecord(error) ? stringProp(error, 'code') : undefined;
          if (code !== 'ENOENT') return { ok: false, error: `operation ${index + 1} (${operation.path}): ${errorMessage(error)}` };
        }

        if (operation.op === 'create' && original !== undefined) {
          return { ok: false, error: `operation ${index + 1} (${operation.path}): create precondition failed; file already exists` };
        }
        if (operation.op !== 'create' && original === undefined) {
          return { ok: false, error: `operation ${index + 1} (${operation.path}): ${operation.op} precondition failed; file does not exist` };
        }
        if (operation.op !== 'create' && original !== operation.oldContent) {
          return { ok: false, error: `operation ${index + 1} (${operation.path}): content precondition failed; re-read the file and retry` };
        }
        prepared.push({ ...operation, resolved: jailed.resolved, original });
      }

      const applied: PreparedPatch[] = [];
      try {
        for (const item of prepared) {
          if (ctx.signal.aborted) throw new Error('patch cancelled before commit completed');
          // Re-resolve immediately before mutation to catch a swapped symlinked ancestor.
          const current = await resolveInWorkspace(ctx.cwd, item.path, sensitivePatterns);
          if (!current.ok || current.resolved !== item.resolved) throw new Error(`${item.path}: target changed after preflight`);
          if (item.original !== undefined) {
            const currentContent = await readFile(item.resolved, 'utf8');
            if (currentContent !== item.original) throw new Error(`${item.path}: content changed after preflight`);
          } else {
            try {
              await stat(item.resolved);
              throw new Error(`${item.path}: file appeared after preflight`);
            } catch (error) {
              const code = isRecord(error) ? stringProp(error, 'code') : undefined;
              if (code !== 'ENOENT') throw error;
            }
          }
          if (item.op === 'delete') {
            await unlink(item.resolved);
          } else {
            await mkdir(path.dirname(item.resolved), { recursive: true });
            await atomicWrite(item.resolved, item.content);
          }
          applied.push(item);
        }
      } catch (error) {
        const rollbackError = await rollbackPatch(applied, atomicWrite);
        return {
          ok: false,
          error: rollbackError === undefined
            ? `patch failed; all changes rolled back: ${errorMessage(error)}`
            : `patch failed and rollback was incomplete: ${errorMessage(error)}; rollback errors: ${rollbackError}`,
        };
      }

      return {
        ok: true,
        data: {
          filesChanged: prepared.length,
          created: prepared.filter((item) => item.op === 'create').map((item) => item.path),
          updated: prepared.filter((item) => item.op === 'update').map((item) => item.path),
          deleted: prepared.filter((item) => item.op === 'delete').map((item) => item.path),
        },
      };
    },
  };
}

// --- factory ------------------------------------------------------------------

/** Build a fresh, independent instance of every native file tool. With no opts the
 * shipped sensitive-path deny is ON (DEFAULT_SENSITIVE_PATTERNS) — bare
 * full built-in native file set is returned with defaults enabled. Pass
 * `{ sensitiveDeny: { disableDefaults: true } }` to opt out, or `{ extra: [...] }`
 * to add patterns. The resolved pattern set is closure-captured once per call and
 * shared by all five tools. */
export function createFileTools(opts?: FileToolsOptions): Tool[] {
  const sensitivePatterns = resolveSensitivePatterns(opts);
  return [
    createReadFileTool(sensitivePatterns),
    createListFilesTool(sensitivePatterns),
    createGlobFilesTool(sensitivePatterns),
    createTreeTool(sensitivePatterns),
    createGrepTool(sensitivePatterns),
    createWriteFileTool(sensitivePatterns),
    createEditFileTool(sensitivePatterns),
    createApplyPatchTool(sensitivePatterns, opts?.patchAtomicWrite ?? atomicWriteFile),
  ];
}
