=== FILE: src/tools/fileTools.ts ===
```ts
import { Buffer } from 'node:buffer';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';

type JailResult = { ok: true; path: string } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveInWorkspace(cwd: string, targetPath: string): JailResult {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: 'path escapes workspace' };
  }

  return { ok: true, path: resolved };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanProp(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function makeObjectSchema(
  properties: Record<string, unknown>,
  required: string[],
): unknown {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

const readFileSpec: ToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace.',
  inputSchema: makeObjectSchema(
    { path: { type: 'string' } },
    ['path'],
  ),
};

const listFilesSpec: ToolSpec = {
  name: 'list_files',
  description: 'List entries in a workspace directory.',
  inputSchema: makeObjectSchema(
    { dir: { type: 'string', default: '.' } },
    [],
  ),
};

const grepSpec: ToolSpec = {
  name: 'grep',
  description: 'Search workspace files for a substring or regular expression.',
  inputSchema: makeObjectSchema(
    {
      pattern: { type: 'string' },
      dir: { type: 'string', default: '.' },
      glob: { type: 'string' },
    },
    ['pattern'],
  ),
};

const writeFileSpec: ToolSpec = {
  name: 'write_file',
  description: 'Write a UTF-8 text file inside the workspace.',
  inputSchema: makeObjectSchema(
    {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    ['path', 'content'],
  ),
};

const editFileSpec: ToolSpec = {
  name: 'edit_file',
  description: 'Replace text in a workspace file.',
  inputSchema: makeObjectSchema(
    {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean', default: false },
    },
    ['path', 'oldString', 'newString'],
  ),
};

function createReadFileTool(): Tool {
  return {
    name: 'read_file',
    risk: 'safe',
    spec: readFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const requestedPath = stringProp(args, 'path');
      if (requestedPath === undefined) {
        return { ok: false, error: 'invalid args' };
      }

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
      if (!jailed.ok) {
        return { ok: false, error: jailed.error };
      }

      try {
        const content = await readFile(jailed.path, 'utf8');
        return { ok: true, data: { path: requestedPath, content } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function createListFilesTool(): Tool {
  return {
    name: 'list_files',
    risk: 'safe',
    spec: listFilesSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const requestedDir = stringProp(args, 'dir') ?? '.';
      const jailed = resolveInWorkspace(ctx.cwd, requestedDir);
      if (!jailed.ok) {
        return { ok: false, error: jailed.error };
      }

      try {
        const entries = await readdir(jailed.path);
        entries.sort((a, b) => a.localeCompare(b));
        return { ok: true, data: { dir: requestedDir, entries } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

type GrepMatcher = (text: string) => boolean;

function createMatcher(pattern: string): GrepMatcher {
  try {
    const regex = new RegExp(pattern);
    return (text: string): boolean => regex.test(text);
  } catch {
    return (text: string): boolean => text.includes(pattern);
  }
}

function globMatches(fileName: string, glob: string | undefined): boolean {
  if (glob === undefined || glob === '*') {
    return true;
  }

  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(fileName);
}

function shouldSkipDir(dirName: string): boolean {
  return dirName === 'node_modules' || dirName.startsWith('.');
}

async function walkFiles(root: string, current: string, glob: string | undefined): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        files.push(...await walkFiles(root, fullPath, glob));
      }
      continue;
    }

    if (entry.isFile() && globMatches(entry.name, glob)) {
      files.push(path.relative(root, fullPath));
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
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const pattern = stringProp(args, 'pattern');
      const requestedDir = stringProp(args, 'dir') ?? '.';
      const glob = stringProp(args, 'glob');

      if (pattern === undefined || (args.glob !== undefined && glob === undefined)) {
        return { ok: false, error: 'invalid args' };
      }

      const jailed = resolveInWorkspace(ctx.cwd, requestedDir);
      if (!jailed.ok) {
        return { ok: false, error: jailed.error };
      }

      try {
        const matcher = createMatcher(pattern);
        const relativeFiles = await walkFiles(jailed.path, jailed.path, glob);
        relativeFiles.sort((a, b) => a.localeCompare(b));

        const matches: Array<{ file: string; line: number; text: string }> = [];

        for (const relativeFile of relativeFiles) {
          const fullPath = path.join(jailed.path, relativeFile);
          const content = await readFile(fullPath, 'utf8');
          const lines = content.split(/\r?\n/u);

          lines.forEach((lineText, index) => {
            if (matcher(lineText)) {
              matches.push({
                file: path.relative(path.resolve(ctx.cwd), fullPath),
                line: index + 1,
                text: lineText,
              });
            }
          });
        }

        matches.sort((a, b) => {
          const byFile = a.file.localeCompare(b.file);
          return byFile === 0 ? a.line - b.line : byFile;
        });

        return { ok: true, data: { matches } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function createWriteFileTool(): Tool {
  return {
    name: 'write_file',
    risk: 'risky',
    spec: writeFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const requestedPath = stringProp(args, 'path');
      const content = stringProp(args, 'content');

      if (requestedPath === undefined || content === undefined) {
        return { ok: false, error: 'invalid args' };
      }

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
      if (!jailed.ok) {
        return { ok: false, error: jailed.error };
      }

      try {
        await mkdir(path.dirname(jailed.path), { recursive: true });
        await writeFile(jailed.path, content, 'utf8');
        return {
          ok: true,
          data: {
            path: requestedPath,
            bytesWritten: Buffer.byteLength(content, 'utf8'),
          },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  let count = 0;
  let index = content.indexOf(search);

  while (index !== -1) {
    count += 1;
    index = content.indexOf(search, index + search.length);
  }

  return count;
}

function replaceOnce(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) {
    return content;
  }

  return `${content.slice(0, index)}${newString}${content.slice(index + oldString.length)}`;
}

function createEditFileTool(): Tool {
  return {
    name: 'edit_file',
    risk: 'risky',
    spec: editFileSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const requestedPath = stringProp(args, 'path');
      const oldString = stringProp(args, 'oldString');
      const newString = stringProp(args, 'newString');
      const replaceAll = booleanProp(args, 'replaceAll') ?? false;

      if (
        requestedPath === undefined
        || oldString === undefined
        || newString === undefined
        || oldString.length === 0
        || (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean')
      ) {
        return { ok: false, error: 'invalid args' };
      }

      const jailed = resolveInWorkspace(ctx.cwd, requestedPath);
      if (!jailed.ok) {
        return { ok: false, error: jailed.error };
      }

      try {
        const current = await readFile(jailed.path, 'utf8');
        const replacements = replaceAll ? countOccurrences(current, oldString) : current.includes(oldString) ? 1 : 0;

        if (replacements === 0) {
          return { ok: false, error: 'oldString not found' };
        }

        const next = replaceAll
          ? current.split(oldString).join(newString)
          : replaceOnce(current, oldString, newString);

        await writeFile(jailed.path, next, 'utf8');
        return { ok: true, data: { path: requestedPath, replacements } };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

export const readFileTool: Tool = createReadFileTool();
export const listFilesTool: Tool = createListFilesTool();
export const grepTool: Tool = createGrepTool();
export const writeFileTool: Tool = createWriteFileTool();
export const editFileTool: Tool = createEditFileTool();

export function createFileTools(): Tool[] {
  return [
    createReadFileTool(),
    createListFilesTool(),
    createGrepTool(),
    createWriteFileTool(),
    createEditFileTool(),
  ];
}
```

=== FILE: src/tools/registry.ts ===
```ts
import type { Tool, ToolSpec } from '../core/contracts';
import { createFileTools } from './fileTools';

export function createDefaultTools(): Tool[] {
  return createFileTools();
}

export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
```

=== FILE: src/tools/executor.ts ===
```ts
import type {
  PermissionDecision,
  PermissionPolicy,
  Tool,
  ToolCtx,
  ToolExecutor,
} from '../core/contracts';
import type { AgentEvent } from '../core/events';
import type { State } from '../core/reducer';

export interface ToolExecutorDeps {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  cwd: string;
  signal: AbortSignal;
  getState: () => Readonly<State>;
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision>;
}

function toolStatus(
  toolCallId: string,
  status: 'running' | 'result' | 'error',
  result?: unknown,
  error?: string,
): AgentEvent {
  if (status === 'result') {
    return { type: 'tool-status', toolCallId, status, result };
  }

  if (status === 'error') {
    return { type: 'tool-status', toolCallId, status, error };
  }

  return { type: 'tool-status', toolCallId, status };
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return {
    async execute(
      toolCallId: string,
      name: string,
      args: unknown,
      emit: (e: AgentEvent) => void,
    ): Promise<void> {
      const emitAborted = (): void => {
        emit(toolStatus(toolCallId, 'error', undefined, 'aborted'));
      };

      if (deps.signal.aborted) {
        emitAborted();
        return;
      }

      const tool = deps.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        emit(toolStatus(toolCallId, 'error', undefined, `unknown tool: ${name}`));
        return;
      }

      const policyDecision = deps.policy.evaluate(name, args, tool.risk);

      if (deps.signal.aborted) {
        emitAborted();
        return;
      }

      switch (policyDecision) {
        case 'auto-deny':
          emit(toolStatus(toolCallId, 'error', undefined, 'denied by policy'));
          return;

        case 'prompt': {
          emit({ type: 'permission-open', toolCallId, name, args, risk: tool.risk });

          const permissionDecision = await deps.awaitPermission(toolCallId);
          if (deps.signal.aborted) {
            emitAborted();
            return;
          }

          if (permissionDecision === 'deny') {
            emit(toolStatus(toolCallId, 'error', undefined, 'denied'));
            return;
          }

          break;
        }

        case 'auto-allow':
          break;

        default: {
          const exhaustive: never = policyDecision;
          emit(toolStatus(toolCallId, 'error', undefined, `unknown policy decision: ${String(exhaustive)}`));
          return;
        }
      }

      emit(toolStatus(toolCallId, 'running'));

      const ctx: ToolCtx = {
        cwd: deps.cwd,
        signal: deps.signal,
        emit,
        awaitPermission: deps.awaitPermission,
        state: deps.getState(),
      };

      const result = await tool.run(args, ctx);
      if (deps.signal.aborted) {
        emitAborted();
        return;
      }

      if (result.ok) {
        emit(toolStatus(toolCallId, 'result', result.data));
        return;
      }

      emit(toolStatus(toolCallId, 'error', undefined, result.error ?? 'tool failed'));
    },
  };
}
```

=== FILE: tests/tools.test.ts ===
```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { PermissionDecision, PermissionPolicy, Tool, ToolCtx, ToolResult } from '../src/core/contracts';
import { createToolExecutor } from '../src/tools/executor';
import { createDefaultTools } from '../src/tools/registry';

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'juno-tools-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function getTool(name: string): Tool {
  const tool = createDefaultTools().find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

function createCtx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async () => 'allow-once',
    state: {},
  };
}

function statusEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool-status' }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: 'tool-status' }> => event.type === 'tool-status');
}

describe('file tools', () => {
  it('writes and reads a file, reporting bytes written', async () => {
    const cwd = await makeWorkspace();
    const writeTool = getTool('write_file');
    const readTool = getTool('read_file');
    const content = 'hello\nworld\n';

    const writeResult = await writeTool.run({ path: 'notes/a.txt', content }, createCtx(cwd));
    expect(writeResult).toEqual({
      ok: true,
      data: {
        path: 'notes/a.txt',
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      },
    });

    const readResult = await readTool.run({ path: 'notes/a.txt' }, createCtx(cwd));
    expect(readResult).toEqual({
      ok: true,
      data: { path: 'notes/a.txt', content },
    });
  });

  it('lists sorted directory entries', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(cwd, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(cwd, 'm.txt'), 'm', 'utf8');

    const result = await getTool('list_files').run({}, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { dir: '.', entries: ['a.txt', 'm.txt', 'z.txt'] },
    });
  });

  it('greps a known line with the correct line number', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'alpha.txt'), 'first\nneedle here\nthird\n', 'utf8');
    await writeFile(path.join(cwd, 'beta.txt'), 'none\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle', dir: '.', glob: '*.txt' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [{ file: 'alpha.txt', line: 2, text: 'needle here' }],
      },
    });
  });

  it('edits a file and reports replacement count', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'red', newString: 'green', replaceAll: true },
      createCtx(cwd),
    );

    expect(result).toEqual({
      ok: true,
      data: { path: 'edit.txt', replacements: 2 },
    });
    await expect(readFile(path.join(cwd, 'edit.txt'), 'utf8')).resolves.toBe('green blue green');
  });

  it('fails edit when oldString is missing', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'purple', newString: 'green' },
      createCtx(cwd),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('oldString');
  });

  it('rejects paths that escape the workspace', async () => {
    const cwd = await makeWorkspace();

    const result = await getTool('read_file').run({ path: '../outside' }, createCtx(cwd));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });
});

class FakePolicy implements PermissionPolicy {
  public constructor(private readonly decision: 'auto-allow' | 'auto-deny' | 'prompt') {}

  public evaluate(): 'auto-allow' | 'auto-deny' | 'prompt' {
    return this.decision;
  }

  public remember(): void {
    return undefined;
  }
}

function makeExecutorDeps(
  tool: Tool,
  policy: PermissionPolicy,
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision> = async () => 'allow-once',
) {
  const controller = new AbortController();

  return {
    tools: [tool],
    policy,
    cwd: process.cwd(),
    signal: controller.signal,
    getState: () => ({}),
    awaitPermission,
  };
}

describe('tool executor', () => {
  it('auto-allows safe tools and emits running then result without permission prompt', async () => {
    const tool: Tool = {
      name: 'safe_tool',
      risk: 'safe',
      spec: { name: 'safe_tool', description: 'safe', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { value: 1 } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeExecutorDeps(tool, new FakePolicy('auto-allow')));

    await executor.execute('call-1', 'safe_tool', { x: 1 }, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-1', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-1', status: 'result', result: { value: 1 } },
    ]);
  });

  it('prompts for risky tools and proceeds after allow-once', async () => {
    const tool: Tool = {
      name: 'risky_tool',
      risk: 'risky',
      spec: { name: 'risky_tool', description: 'risky', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: 'done' }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeExecutorDeps(
      tool,
      new FakePolicy('prompt'),
      async () => 'allow-once',
    ));

    await executor.execute('call-2', 'risky_tool', { path: 'x' }, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-2', name: 'risky_tool', args: { path: 'x' }, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'result', result: 'done' },
    ]);
  });

  it('auto-deny emits terminal error and does not run the tool', async () => {
    const run = vi.fn<() => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'blocked_tool',
      risk: 'risky',
      spec: { name: 'blocked_tool', description: 'blocked', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeExecutorDeps(tool, new FakePolicy('auto-deny')));

    await executor.execute('call-3', 'blocked_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(statusEvents(events)).toEqual([
      { type: 'tool-status', toolCallId: 'call-3', status: 'error', error: 'denied by policy' },
    ]);
  });

  it('permission deny emits terminal error and does not run the tool', async () => {
    const run = vi.fn<() => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'prompted_tool',
      risk: 'risky',
      spec: { name: 'prompted_tool', description: 'prompted', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeExecutorDeps(
      tool,
      new FakePolicy('prompt'),
      async () => 'deny',
    ));

    await executor.execute('call-4', 'prompted_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-4', name: 'prompted_tool', args: {}, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-4', status: 'error', error: 'denied' },
    ]);
  });

  it('unknown tool name emits terminal error', async () => {
    const events: AgentEvent[] = [];
    const executor = createToolExecutor({
      tools: [],
      policy: new FakePolicy('auto-allow'),
      cwd: process.cwd(),
      signal: new AbortController().signal,
      getState: () => ({}),
      awaitPermission: async () => 'allow-once',
    });

    await executor.execute('call-5', 'missing_tool', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-5', status: 'error', error: 'unknown tool: missing_tool' },
    ]);
  });
});
```

=== NOTES ===

I did not write to the filesystem. The implementation keeps permission handling entirely in `ToolExecutor`, validates `unknown` args without `any`, jails all paths with `path.resolve`/`path.relative`, and limits source imports to the pinned core contracts/events plus `node:*`. Tests use temp workspaces and collect emitted events for order assertions.