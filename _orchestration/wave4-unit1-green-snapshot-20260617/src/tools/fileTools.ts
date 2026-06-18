// src/tools/fileTools.ts
// W7 — the five v1 file tools (read/list/grep/write/edit). Pure beyond fs I/O:
// no clock, no randomness, no globals. All paths are workspace-jailed under
// ctx.cwd; tools NEVER throw to the caller — fs errors become { ok:false, error }.
// Tools NEVER call evaluate/awaitPermission — the executor owns the permission
// round-trip (see executor.ts + the frozen ToolCtx contract).
import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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

// --- workspace jail -----------------------------------------------------------
// Resolve the requested path against the jail root, then reject anything that
// escapes via `..` segments OR is an absolute path outside the root. `path.relative`
// on Windows returns an ABSOLUTE path when the targets live on different drives
// (e.g. C:\ vs D:\), so the `isAbsolute(rel)` guard also covers cross-drive escapes.

type JailResult = { ok: true; resolved: string } | { ok: false; error: string };

function resolveInWorkspace(cwd: string, targetPath: string): JailResult {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  // `rel === ''` means the target IS the root (allowed, e.g. list_files('.')).
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, error: 'path escapes workspace' };
  }
  return { ok: true, resolved };
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

function createReadFileTool(): Tool {
  return {
    name: 'read_file',
    risk: 'safe',
    spec: readFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) return { ok: false, error: 'invalid args' };
      const requestedPath = stringProp(args, 'path');
      if (requestedPath === undefined) return { ok: false, error: 'invalid args' };

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
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

function createListFilesTool(): Tool {
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

      const jailed = resolveInWorkspace(ctx.cwd, requestedDir);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const dirents = await readdir(jailed.resolved, { withFileTypes: true });
        const entries = dirents.map((d) => d.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

function createGrepTool(): Tool {
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

      const jailed = resolveInWorkspace(ctx.cwd, requestedDir);
      if (!jailed.ok) return { ok: false, error: jailed.error };

      try {
        const matcher = createMatcher(pattern, useRegex);
        const root = path.resolve(ctx.cwd);
        const files = await walkFiles(jailed.resolved, glob, ctx.signal);

        const matches: Array<{ file: string; line: number; text: string }> = [];
        for (const full of files) {
          if (ctx.signal.aborted) break;
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

function createWriteFileTool(): Tool {
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

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
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

function createEditFileTool(): Tool {
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

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
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

/** Build a fresh, independent instance of every v1 file tool. */
export function createFileTools(): Tool[] {
  return [
    createReadFileTool(),
    createListFilesTool(),
    createGrepTool(),
    createWriteFileTool(),
    createEditFileTool(),
  ];
}
