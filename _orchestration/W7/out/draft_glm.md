=== FILE: src/tools/fileTools.ts ===
```ts
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, basename } from 'node:path';
import type { Tool, ToolCtx, ToolResult } from '../core/contracts';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function jailCheck(
  cwd: string,
  p: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolved = resolve(cwd, p);
  const rel = relative(cwd, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'path escapes workspace' };
  }
  return { ok: true, resolved };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function globToRegex(g: string): RegExp {
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

async function walkFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    if (signal.aborted) return;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (signal.aborted) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await rec(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

export const readTool: Tool = {
  name: 'read_file',
  risk: 'safe',
  spec: {
    name: 'read_file',
    description: 'Read the full contents of a UTF-8 text file within the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file.' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!isObject(args) || !isString(args.path)) {
      return { ok: false, error: 'invalid args' };
    }
    const c = jailCheck(ctx.cwd, args.path);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const content = await readFile(c.resolved, 'utf8');
      return { ok: true, data: { path: args.path, content } };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
};

export const listTool: Tool = {
  name: 'list_files',
  risk: 'safe',
  spec: {
    name: 'list_files',
    description: 'List the immediate child entries of a directory within the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace-relative directory path. Defaults to ".".' },
      },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    let dir = '.';
    if (args !== undefined && args !== null) {
      if (!isObject(args)) return { ok: false, error: 'invalid args' };
      if (args.dir !== undefined) {
        if (!isString(args.dir)) return { ok: false, error: 'invalid args' };
        dir = args.dir;
      }
    }
    const c = jailCheck(ctx.cwd, dir);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const entries = await readdir(c.resolved, { withFileTypes: true });
      const names = entries.map((e) => e.name).sort();
      return { ok: true, data: { dir, entries: names } };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
};

export const grepTool: Tool = {
  name: 'grep',
  risk: 'safe',
  spec: {
    name: 'grep',
    description: 'Search file contents under a directory for a substring, returning matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring to search for.' },
        dir: { type: 'string', description: 'Workspace-relative directory. Defaults to ".".' },
        glob: { type: 'string', description: 'Optional simple glob (with *) to filter filenames.' },
      },
      required: ['pattern'],
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!isObject(args) || !isString(args.pattern)) {
      return { ok: false, error: 'invalid args' };
    }
    let dir = '.';
    if (args.dir !== undefined) {
      if (!isString(args.dir)) return { ok: false, error: 'invalid args' };
      dir = args.dir;
    }
    let globRe: RegExp | null = null;
    if (args.glob !== undefined) {
      if (!isString(args.glob)) return { ok: false, error: 'invalid args' };
      globRe = globToRegex(args.glob);
    }
    const c = jailCheck(ctx.cwd, dir);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const files = await walkFiles(c.resolved, ctx.signal);
      const matches: Array<{ file: string; line: number; text: string }> = [];
      for (const f of files) {
        if (ctx.signal.aborted) break;
        if (globRe && !globRe.test(basename(f))) continue;
        const content = await readFile(f, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(args.pattern)) {
            matches.push({
              file: relative(ctx.cwd, f),
              line: i + 1,
              text: lines[i],
            });
          }
        }
      }
      matches.sort((a, b) => {
        if (a.file < b.file) return -1;
        if (a.file > b.file) return 1;
        return a.line - b.line;
      });
      return { ok: true, data: { matches } };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
};

export const writeTool: Tool = {
  name: 'write_file',
  risk: 'risky',
  spec: {
    name: 'write_file',
    description: 'Write text content to a file within the workspace, creating or overwriting it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file.' },
        content: { type: 'string', description: 'UTF-8 content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!isObject(args) || !isString(args.path) || !isString(args.content)) {
      return { ok: false, error: 'invalid args' };
    }
    const c = jailCheck(ctx.cwd, args.path);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const buf = Buffer.from(args.content, 'utf8');
      await writeFile(c.resolved, buf);
      return { ok: true, data: { path: args.path, bytesWritten: buf.byteLength } };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
};

export const editTool: Tool = {
  name: 'edit_file',
  risk: 'risky',
  spec: {
    name: 'edit_file',
    description: 'Replace an exact string in a workspace file with a new string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to the file.' },
        oldString: { type: 'string', description: 'Exact text to find.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences. Defaults to false.' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    if (
      !isObject(args) ||
      !isString(args.path) ||
      !isString(args.oldString) ||
      !isString(args.newString)
    ) {
      return { ok: false, error: 'invalid args' };
    }
    const replaceAll = args.replaceAll === true;
    if (args.oldString === '') {
      return { ok: false, error: 'oldString must be non-empty' };
    }
    const c = jailCheck(ctx.cwd, args.path);
    if (!c.ok) return { ok: false, error: c.error };
    try {
      const content = await readFile(c.resolved, 'utf8');
      let count = 0;
      let newContent: string;
      if (replaceAll) {
        const parts = content.split(args.oldString);
        count = parts.length - 1;
        if (count === 0) return { ok: false, error: 'oldString not found' };
        newContent = parts.join(args.newString);
      } else {
        const idx = content.indexOf(args.oldString);
        if (idx === -1) return { ok: false, error: 'oldString not found' };
        count = 1;
        newContent =
          content.slice(0, idx) +
          args.newString +
          content.slice(idx + args.oldString.length);
      }
      await writeFile(c.resolved, newContent, 'utf8');
      return { ok: true, data: { path: args.path, replacements: count } };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
};
```

=== FILE: src/tools/registry.ts ===
```ts
import type { Tool, ToolSpec } from '../core/contracts';
import {
  readTool,
  listTool,
  grepTool,
  writeTool,
  editTool,
} from './fileTools';

export function createDefaultTools(): Tool[] {
  return [readTool, listTool, grepTool, writeTool, editTool];
}

export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map(
  (t) => t.spec,
);
```

=== FILE: src/tools/executor.ts ===
```ts
import type {
  Tool,
  ToolCtx,
  ToolExecutor,
  ToolResult,
  PermissionPolicy,
} from '../core/contracts';
import type { AgentEvent, PermissionDecision } from '../core/events';
import type { State } from '../core/reducer';

export interface ToolExecutorDeps {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  cwd: string;
  signal: AbortSignal;
  getState: () => Readonly<State>;
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision>;
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return {
    async execute(toolCallId, name, args, emit): Promise<void> {
      if (deps.signal.aborted) {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'error',
          error: 'aborted',
        });
        return;
      }

      const tool = deps.tools.find((t) => t.name === name);
      if (!tool) {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'error',
          error: 'unknown tool: ' + name,
        });
        return;
      }

      const decision = deps.policy.evaluate(name, args, tool.risk);

      if (decision === 'auto-deny') {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'error',
          error: 'denied by policy',
        });
        return;
      }

      if (decision === 'prompt') {
        emit({
          type: 'permission-open',
          toolCallId,
          name,
          args,
          risk: tool.risk,
        });
        const d = await deps.awaitPermission(toolCallId);
        if (deps.signal.aborted) {
          emit({
            type: 'tool-status',
            toolCallId,
            status: 'error',
            error: 'aborted',
          });
          return;
        }
        if (d === 'deny') {
          emit({
            type: 'tool-status',
            toolCallId,
            status: 'error',
            error: 'denied',
          });
          return;
        }
      }

      emit({ type: 'tool-status', toolCallId, status: 'running' });

      const ctx: ToolCtx = {
        cwd: deps.cwd,
        signal: deps.signal,
        emit,
        awaitPermission: deps.awaitPermission,
        state: deps.getState(),
      };

      let r: ToolResult;
      try {
        r = await tool.run(args, ctx);
      } catch (e) {
        r = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      if (deps.signal.aborted) {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'error',
          error: 'aborted',
        });
        return;
      }

      if (r.ok) {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'result',
          result: r.data,
        });
      } else {
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'error',
          error: r.error ?? 'tool failed',
        });
      }
    },
  };
}
```

=== FILE: tests/tools.test.ts ===
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultTools } from '../src/tools/registry';
import { createToolExecutor } from '../src/tools/executor';
import type { ToolExecutorDeps } from '../src/tools/executor';
import type {
  Tool,
  ToolSpec,
  PermissionPolicy,
  PermissionDecision,
} from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import type { State } from '../src/core/reducer';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dataOf(e: AgentEvent): unknown {
  if (e.type === 'tool-status' && e.status === 'result') return e.result;
  return undefined;
}
function errorOf(e: AgentEvent): string | undefined {
  if (e.type === 'tool-status' && e.status === 'error') return e.error;
  return undefined;
}
function types(events: AgentEvent[]): string[] {
  return events.map((e) =>
    e.type === 'tool-status' ? `tool-status:${e.status}` : e.type,
  );
}

function makePolicy(
  evalResult: 'auto-allow' | 'auto-deny' | 'prompt',
): PermissionPolicy {
  return {
    evaluate: () => evalResult,
    remember: () => {},
  };
}

function makeDeps(opts: {
  tools?: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  cwd: string;
  awaitPermission?: (id: string) => Promise<PermissionDecision>;
}): ToolExecutorDeps {
  return {
    tools: opts.tools ?? createDefaultTools(),
    policy: opts.policy,
    cwd: opts.cwd,
    signal: new AbortController().signal,
    getState: () => ({}) as unknown as Readonly<State>,
    awaitPermission: opts.awaitPermission ?? (async () => 'allow-once'),
  };
}

async function runExec(
  deps: ToolExecutorDeps,
  toolCallId: string,
  name: string,
  args: unknown,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const exec = createToolExecutor(deps);
  await exec.execute(toolCallId, name, args, (e) => events.push(e));
  return events;
}

describe('file tools', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'juno-tools-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('write_file then read_file round-trips and reports bytesWritten', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    const write = tools.find((t) => t.name === 'write_file')!;
    const r1 = await write.run({ path: 'hello.txt', content: 'hello' }, ctx);
    expect(r1.ok).toBe(true);
    expect(isObject(r1.data) && r1.data.bytesWritten).toBe(5);

    const read = tools.find((t) => t.name === 'read_file')!;
    const r2 = await read.run({ path: 'hello.txt' }, ctx);
    expect(r2.ok).toBe(true);
    expect(isObject(r2.data) && r2.data.content).toBe('hello');
    expect(isObject(r2.data) && r2.data.path).toBe('hello.txt');
  });

  it('list_files returns sorted entries', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    await writeFile(join(cwd, 'b.txt'), 'b');
    await writeFile(join(cwd, 'a.txt'), 'a');
    await mkdir(join(cwd, 'sub'));
    const list = tools.find((t) => t.name === 'list_files')!;
    const r = await list.run({}, ctx);
    expect(r.ok).toBe(true);
    expect(isObject(r.data) && (r.data as { entries: string[] }).entries).toEqual([
      'a.txt',
      'b.txt',
      'sub',
    ]);
  });

  it('grep finds a known line with correct line number', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    await writeFile(
      join(cwd, 'g.txt'),
      'alpha\nbeta\ngamma\nbeta\n',
    );
    const grep = tools.find((t) => t.name === 'grep')!;
    const r = await grep.run({ pattern: 'beta' }, ctx);
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: Array<{ file: string; line: number; text: string }> }).matches;
    expect(matches.length).toBe(2);
    expect(matches[0].line).toBe(2);
    expect(matches[1].line).toBe(4);
    expect(matches[0].text).toBe('beta');
  });

  it('edit_file replaces and reports count', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    await writeFile(join(cwd, 'e.txt'), 'foo bar foo');
    const edit = tools.find((t) => t.name === 'edit_file')!;
    const r1 = await edit.run(
      { path: 'e.txt', oldString: 'bar', newString: 'baz' },
      ctx,
    );
    expect(r1.ok).toBe(true);
    expect(isObject(r1.data) && r1.data.replacements).toBe(1);

    const read = tools.find((t) => t.name === 'read_file')!;
    const r2 = await read.run({ path: 'e.txt' }, ctx);
    expect(isObject(r2.data) && r2.data.content).toBe('foo baz foo');

    const r3 = await edit.run(
      { path: 'e.txt', oldString: 'bar', newString: 'baz' },
      ctx,
    );
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe('oldString not found');

    const r4 = await edit.run(
      { path: 'e.txt', oldString: 'foo', newString: 'qux', replaceAll: true },
      ctx,
    );
    expect(r4.ok).toBe(true);
    expect(isObject(r4.data) && r4.data.replacements).toBe(2);
  });

  it('jail: read_file rejects paths escaping workspace', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    const read = tools.find((t) => t.name === 'read_file')!;
    const r = await read.run({ path: '../outside.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('escape');

    const r2 = await read.run({ path: join(tmpdir(), 'outside.txt') }, ctx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('escape');
  });

  it('invalid args return ok:false', async () => {
    const tools = createDefaultTools();
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'allow-once' as PermissionDecision,
      state: {} as unknown as Readonly<State>,
    };
    const read = tools.find((t) => t.name === 'read_file')!;
    const r = await read.run({ notpath: 1 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid args');
  });
});

describe('ToolExecutor', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'juno-exec-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('safe tool with auto-allow: emits running then result, no permission-open', async () => {
    await writeFile(join(cwd, 'f.txt'), 'content');
    const deps = makeDeps({ policy: makePolicy('auto-allow'), cwd });
    const events = await runExec('tc1', 'read_file', { path: 'f.txt' }, deps);
    expect(types(events)).toEqual(['tool-status:running', 'tool-status:result']);
    const res = events.find((e) => e.type === 'tool-status' && e.status === 'result')!;
    expect(isObject(dataOf(res)) && (dataOf(res) as { content: string }).content).toBe('content');
  });

  it('risky tool with prompt + allow-once: emits permission-open then running then result', async () => {
    const deps = makeDeps({
      policy: makePolicy('prompt'),
      cwd,
      awaitPermission: async () => 'allow-once',
    });
    const events = await runExec(
      'tc2',
      'write_file',
      { path: 'out.txt', content: 'hi' },
      deps,
    );
    expect(types(events)).toEqual([
      'permission-open',
      'tool-status:running',
      'tool-status:result',
    ]);
    const res = events.find((e) => e.type === 'tool-status' && e.status === 'result')!;
    expect(isObject(dataOf(res)) && (dataOf(res) as { bytesWritten: number }).bytesWritten).toBe(2);
  });

  it('auto-deny: terminal error, run not called', async () => {
    let runCalled = false;
    const fakeTool: Tool = {
      name: 'fake_risky',
      risk: 'risky',
      spec: { name: 'fake_risky', description: '', inputSchema: {} } as unknown as ToolSpec,
      run: async () => {
        runCalled = true;
        return { ok: true, data: null };
      },
    };
    const deps = makeDeps({
      tools: [fakeTool],
      policy: makePolicy('auto-deny'),
      cwd,
    });
    const events = await runExec('tc3', 'fake_risky', {}, deps);
    expect(types(events)).toEqual(['tool-status:error']);
    expect(errorOf(events[0])).toBe('denied by policy');
    expect(runCalled).toBe(false);
  });

  it('awaitPermission deny: terminal error, run not called', async () => {
    let runCalled = false;
    const fakeTool: Tool = {
      name: 'fake_risky',
      risk: 'risky',
      spec: { name: 'fake_risky', description: '', inputSchema: {} } as unknown as ToolSpec,
      run: async () => {
        runCalled = true;
        return { ok: true, data: null };
      },
    };
    const deps = makeDeps({
      tools: [fakeTool],
      policy: makePolicy('prompt'),
      cwd,
      awaitPermission: async () => 'deny',
    });
    const events = await runExec('tc4', 'fake_risky', {}, deps);
    expect(types(events)).toEqual(['permission-open', 'tool-status:error']);
    expect(errorOf(events[1])).toBe('denied');
    expect(runCalled).toBe(false);
  });

  it('unknown tool name: terminal error', async () => {
    const deps = makeDeps({ policy: makePolicy('auto-allow'), cwd });
    const events = await runExec('tc5', 'no_such_tool', {}, deps);
    expect(types(events)).toEqual(['tool-status:error']);
    expect(errorOf(events[0])).toBe('unknown tool: no_such_tool');
  });
});
```

=== NOTES ===
- All five tools share a `jailCheck` helper using `path.resolve`/`relative`/`isAbsolute`; escapes return `path escapes workspace` without touching the filesystem.
- Tools never throw to callers; fs errors are caught and surfaced as `{ ok:false, error }`. Args are narrowed via type guards (no `any`).
- `grep` walks recursively skipping `node_modules` and dot-directories, does substring matching, sorts by file then line, and supports a simple `*` filename glob.
- The executor owns the permission round-trip exclusively: it calls `policy.evaluate`, emits `permission-open` only on `prompt`, awaits permission, and checks `signal.aborted` at each await point emitting a terminal `aborted` error.
- Tests use `mkdtemp`/`rm` per case, fake `PermissionPolicy`/`awaitPermission`, and assert event ordering via a `types()` helper. `State` is faked via `{} as unknown as Readonly<State>` (no `any`).
