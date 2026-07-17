// src/tools/fileTools.ts
// W7 — the five v1 file tools (read/list/grep/write/edit). Pure beyond fs I/O:
// no clock, no randomness, no globals. All paths are workspace-jailed under
// ctx.cwd; tools NEVER throw to the caller — fs errors become { ok:false, error }.
// Tools NEVER call evaluate/awaitPermission — the executor owns the permission
// round-trip (see executor.ts + the frozen ToolCtx contract).
//
// W12 — sensitive-path deny (see DEFAULT_SENSITIVE_PATTERNS below). These five
// tools additionally refuse to touch a shipped default set of secret-bearing
// paths (.env, *.pem, id_rsa, .ssh/*, .npmrc, credentials) even when the target
// sits INSIDE the workspace jail. IMPORTANT LIMIT: this covers juno's OWN file
// tools ONLY. It does NOT cover `run_shell` — shellTool.ts has no path jail and
// neither the policy nor the tool layer can see command content, so `run_shell`
// can still `cat .env`. That path is gated only by run_shell being risk:'dangerous'
// (always human-prompted); full non-interactive coverage needs the OS-sandbox deny.
import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';

// --- arg narrowing (no `any`) -------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
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
  description: 'Read the full contents of a UTF-8 text file within the workspace.',
  inputSchema: objectSchema(
    { path: { type: 'string', description: 'Workspace-relative path to the file.' } },
    ['path'],
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

      const jailed = await resolveInWorkspace(ctx.cwd, requestedPath, sensitivePatterns);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const content = await readFile(jailed.resolved, 'utf8');
        return { ok: true, data: { path: requestedPath, content } };
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

// --- factory ------------------------------------------------------------------

/** Build a fresh, independent instance of every v1 file tool. With no opts the
 * shipped sensitive-path deny is ON (DEFAULT_SENSITIVE_PATTERNS) — bare
 * createFileTools() returns exactly the five tools with defaults enabled, so
 * BUILTIN_TOOL_SPECS and the tools.test.ts fixtures stay stable. Pass
 * `{ sensitiveDeny: { disableDefaults: true } }` to opt out, or `{ extra: [...] }`
 * to add patterns. The resolved pattern set is closure-captured once per call and
 * shared by all five tools. */
export function createFileTools(opts?: FileToolsOptions): Tool[] {
  const sensitivePatterns = resolveSensitivePatterns(opts);
  return [
    createReadFileTool(sensitivePatterns),
    createListFilesTool(sensitivePatterns),
    createGrepTool(sensitivePatterns),
    createWriteFileTool(sensitivePatterns),
    createEditFileTool(sensitivePatterns),
  ];
}
