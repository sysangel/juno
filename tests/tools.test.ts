// tests/tools.test.ts
// W7 — file tools + executor suite. Deterministic: real fs only inside a per-test
// mkdtemp workspace, cleaned in afterEach. No network, no clock, no randomness.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PermissionPolicy,
  Tool,
  ToolCtx,
  ToolResult,
} from '../src/core/contracts';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import { createToolExecutor, type ToolExecutorDeps } from '../src/tools/executor';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';

// --- helpers ------------------------------------------------------------------

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'juno-tools-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A minimal, real Readonly<State> for ToolCtx — no `any`, no unsafe cast. */
function fakeState(): Readonly<State> {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

function getTool(name: string): Tool {
  const tool = createDefaultTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function createCtx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    state: fakeState(),
  };
}

function statusEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool-status' }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> => event.type === 'tool-status',
  );
}

function eventTags(events: AgentEvent[]): string[] {
  return events.map((e) => (e.type === 'tool-status' ? `tool-status:${e.status}` : e.type));
}

// --- file tools ---------------------------------------------------------------

describe('file tools', () => {
  it('write_file then read_file round-trips (nested path) and reports bytesWritten', async () => {
    const cwd = await makeWorkspace();
    const content = 'hello\nworld\n';

    const writeResult = await getTool('write_file').run(
      { path: 'notes/a.txt', content },
      createCtx(cwd),
    );
    expect(writeResult).toEqual({
      ok: true,
      data: { path: 'notes/a.txt', bytesWritten: Buffer.byteLength(content, 'utf8') },
    });

    const readResult = await getTool('read_file').run({ path: 'notes/a.txt' }, createCtx(cwd));
    expect(readResult).toEqual({ ok: true, data: { path: 'notes/a.txt', content } });
  });

  it('list_files returns sorted entries (files + dirs)', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(cwd, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(cwd, 'm.txt'), 'm', 'utf8');
    await mkdir(path.join(cwd, 'sub'));

    const result = await getTool('list_files').run({}, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { dir: '.', entries: ['a.txt', 'm.txt', 'sub', 'z.txt'] },
    });
  });

  it('grep finds known lines with correct line numbers, sorted by file then line', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'alpha.txt'), 'first\nneedle here\nthird\n', 'utf8');
    await writeFile(path.join(cwd, 'beta.txt'), 'needle\nnone\nneedle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [
          { file: 'alpha.txt', line: 2, text: 'needle here' },
          { file: 'beta.txt', line: 1, text: 'needle' },
          { file: 'beta.txt', line: 3, text: 'needle' },
        ],
      },
    });
  });

  it('grep honours a simple * glob on the filename', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'keep.md'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, 'skip.txt'), 'needle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle', glob: '*.md' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'keep.md', line: 1, text: 'needle' }] },
    });
  });

  it('grep skips node_modules and dot-directories', async () => {
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, 'node_modules'));
    await mkdir(path.join(cwd, '.git'));
    await writeFile(path.join(cwd, 'node_modules', 'x.txt'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, '.git', 'y.txt'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, 'top.txt'), 'needle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'top.txt', line: 1, text: 'needle' }] },
    });
  });

  it('grep default path is literal substring: a pathological regex pattern does not hang', async () => {
    const cwd = await makeWorkspace();
    // A line that triggers catastrophic backtracking if `(a+)+$` were a regex.
    await writeFile(path.join(cwd, 'evil.txt'), `${'a'.repeat(40)}\nliteral (a+)$ here\n`, 'utf8');

    const start = process.hrtime.bigint();
    const result = await getTool('grep').run({ pattern: '(a+)+$' }, createCtx(cwd));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Treated as a literal substring `(a+)+$` — not present in the file → 0 matches.
    expect(result).toEqual({ ok: true, data: { matches: [] } });
    // The ReDoS proof: completes promptly instead of taking ~70s.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('grep matches a literal regex-looking substring by default (no regex flag)', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'lit.txt'), 'has (a+)+$ inside\nplain\n', 'utf8');

    const result = await getTool('grep').run({ pattern: '(a+)+$' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'lit.txt', line: 1, text: 'has (a+)+$ inside' }] },
    });
  });

  it('grep opt-in regex: pattern is compiled when regex:true', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'rx.txt'), 'aaa\nbbb\na\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'a+', regex: true }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [
          { file: 'rx.txt', line: 1, text: 'aaa' },
          { file: 'rx.txt', line: 3, text: 'a' },
        ],
      },
    });
  });

  it('grep default treats regex metachars literally: "a.c" matches "a.c" not "abc"', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'dot.txt'), 'a.c\nabc\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'a.c' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'dot.txt', line: 1, text: 'a.c' }] },
    });
  });

  it('edit_file replaceAll replaces and reports count', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'red', newString: 'green', replaceAll: true },
      createCtx(cwd),
    );
    expect(result).toEqual({ ok: true, data: { path: 'edit.txt', replacements: 2 } });
    await expect(readFile(path.join(cwd, 'edit.txt'), 'utf8')).resolves.toBe('green blue green');
  });

  it('edit_file replaces only the first occurrence by default', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'foo bar foo', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'foo', newString: 'qux' },
      createCtx(cwd),
    );
    expect(result).toEqual({ ok: true, data: { path: 'edit.txt', replacements: 1 } });
    await expect(readFile(path.join(cwd, 'edit.txt'), 'utf8')).resolves.toBe('qux bar foo');
  });

  it('edit_file fails when oldString is missing', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'purple', newString: 'green' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('oldString');
  });

  it('jail: rejects a relative path that escapes the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run({ path: '../outside' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: rejects an absolute path outside the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run(
      { path: path.join(tmpdir(), 'definitely-outside.txt') },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: write_file cannot escape the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('write_file').run(
      { path: '../escapee.txt', content: 'nope' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: read_file cannot follow a symlink pointing outside the workspace', async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
    // A link INSIDE the workspace whose target is a file OUTSIDE it.
    await symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'));

    const result = await getTool('read_file').run({ path: 'link.txt' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: write_file cannot follow a symlink pointing outside the workspace', async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(path.join(outside, 'target.txt'), 'original', 'utf8');
    await symlink(path.join(outside, 'target.txt'), path.join(cwd, 'link.txt'));

    const result = await getTool('write_file').run(
      { path: 'link.txt', content: 'pwned' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
    // The outside file must be untouched.
    await expect(readFile(path.join(outside, 'target.txt'), 'utf8')).resolves.toBe('original');
  });

  it('jail: rejects a path whose ANCESTOR directory is a symlink escaping the workspace', async () => {
    const cwd = await makeWorkspace();
    const outside = await makeWorkspace();
    await mkdir(path.join(outside, 'sub'));
    // `escape` is a directory symlink inside the workspace pointing outside it.
    await symlink(path.join(outside, 'sub'), path.join(cwd, 'escape'));

    // Target file does NOT exist yet, but its ancestor dereferences outside.
    const result = await getTool('write_file').run(
      { path: 'escape/new.txt', content: 'nope' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: writing a not-yet-existing nested file inside the workspace still works', async () => {
    const cwd = await makeWorkspace();
    const content = 'fresh\n';
    const result = await getTool('write_file').run(
      { path: 'deep/newly/created.txt', content },
      createCtx(cwd),
    );
    expect(result).toEqual({
      ok: true,
      data: { path: 'deep/newly/created.txt', bytesWritten: Buffer.byteLength(content, 'utf8') },
    });
    await expect(readFile(path.join(cwd, 'deep/newly/created.txt'), 'utf8')).resolves.toBe(content);
  });

  it('returns invalid args on bad input', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run({ notpath: 1 }, createCtx(cwd));
    expect(result).toEqual({ ok: false, error: 'invalid args' });
  });

  it('registry exposes 5 tools and matching specs', () => {
    const tools = createDefaultTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['edit_file', 'grep', 'list_files', 'read_file', 'write_file'],
    );
    expect(BUILTIN_TOOL_SPECS.map((s) => s.name).sort()).toEqual(
      ['edit_file', 'grep', 'list_files', 'read_file', 'write_file'],
    );
    // risk levels pinned by the seam
    expect(getTool('read_file').risk).toBe('safe');
    expect(getTool('list_files').risk).toBe('safe');
    expect(getTool('grep').risk).toBe('safe');
    expect(getTool('write_file').risk).toBe('risky');
    expect(getTool('edit_file').risk).toBe('risky');
  });
});

// --- executor -----------------------------------------------------------------

class FakePolicy implements PermissionPolicy {
  public constructor(private readonly decision: 'auto-allow' | 'auto-deny' | 'prompt') {}
  public evaluate(): 'auto-allow' | 'auto-deny' | 'prompt' {
    return this.decision;
  }
  public remember(): void {
    return undefined;
  }
  public setMode(): void {
    return undefined;
  }
}

function makeDeps(opts: {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  awaitPermission?: (toolCallId: string) => Promise<PermissionDecision>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): ToolExecutorDeps {
  return {
    tools: opts.tools,
    policy: opts.policy,
    cwd: process.cwd(),
    signal: opts.signal ?? new AbortController().signal,
    getState: () => fakeState(),
    awaitPermission: opts.awaitPermission ?? (async (): Promise<PermissionDecision> => 'allow-once'),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

describe('tool executor', () => {
  it('auto-allows safe tools: emits running then result, no permission-open', async () => {
    const tool: Tool = {
      name: 'safe_tool',
      risk: 'safe',
      spec: { name: 'safe_tool', description: 'safe', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { value: 1 } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

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
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('prompt'), awaitPermission: async () => 'allow-once' }),
    );

    await executor.execute('call-2', 'risky_tool', { path: 'x' }, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-2', name: 'risky_tool', args: { path: 'x' }, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'result', result: 'done' },
    ]);
  });

  it('auto-deny: terminal error, run NOT called', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'blocked_tool',
      risk: 'risky',
      spec: { name: 'blocked_tool', description: 'blocked', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-deny') }));

    await executor.execute('call-3', 'blocked_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(statusEvents(events)).toEqual([
      { type: 'tool-status', toolCallId: 'call-3', status: 'error', error: 'denied by policy' },
    ]);
  });

  it('permission deny: terminal error, run NOT called', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'prompted_tool',
      risk: 'risky',
      spec: { name: 'prompted_tool', description: 'prompted', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('prompt'), awaitPermission: async () => 'deny' }),
    );

    await executor.execute('call-4', 'prompted_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(eventTags(events)).toEqual(['permission-open', 'tool-status:error']);
    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-4', name: 'prompted_tool', args: {}, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-4', status: 'error', error: 'denied' },
    ]);
  });

  it('unknown tool name: terminal error', async () => {
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-5', 'missing_tool', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-5', status: 'error', error: 'unknown tool: missing_tool' },
    ]);
  });

  it('aborted before run: terminal error, run NOT called', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'safe_tool',
      risk: 'safe',
      spec: { name: 'safe_tool', description: 'safe', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), signal: controller.signal }),
    );

    await executor.execute('call-6', 'safe_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-6', status: 'error', error: 'aborted' },
    ]);
  });

  it('surfaces a throwing tool as a terminal error (does not crash)', async () => {
    const tool: Tool = {
      name: 'throwing_tool',
      risk: 'safe',
      spec: { name: 'throwing_tool', description: 'throws', inputSchema: {} },
      run: async (): Promise<ToolResult> => {
        throw new Error('boom');
      },
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-7', 'throwing_tool', {}, (event) => events.push(event));

    expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:error']);
    const err = statusEvents(events).at(-1);
    expect(err?.error).toContain('boom');
  });

  it('times out a wedged tool: aborts its signal and returns a terminal error', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const tool: Tool = {
        name: 'wedged_tool',
        risk: 'safe',
        spec: { name: 'wedged_tool', description: 'wedges', inputSchema: {} },
        // Never resolves on its own — only the timeout can release the turn.
        run: (_args: unknown, ctx: ToolCtx): Promise<ToolResult> => {
          observedSignal = ctx.signal;
          return new Promise<ToolResult>(() => undefined);
        },
      };
      const events: AgentEvent[] = [];
      const executor = createToolExecutor(
        makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), timeoutMs: 5000 }),
      );

      const done = executor.execute('call-8', 'wedged_tool', {}, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      // The tool's own signal was aborted so a cooperative tool could unwind.
      expect(observedSignal?.aborted).toBe(true);
      expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:error']);
      const err = statusEvents(events).at(-1);
      expect(err?.error).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes normally under the timeout: no timeout error', async () => {
    vi.useFakeTimers();
    try {
      const tool: Tool = {
        name: 'quick_tool',
        risk: 'safe',
        spec: { name: 'quick_tool', description: 'quick', inputSchema: {} },
        run: async (): Promise<ToolResult> => ({ ok: true, data: { value: 42 } }),
      };
      const events: AgentEvent[] = [];
      const executor = createToolExecutor(
        makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), timeoutMs: 5000 }),
      );

      // Resolves on the microtask queue — no timer advance needed.
      await executor.execute('call-9', 'quick_tool', {}, (event) => events.push(event));

      expect(events).toEqual([
        { type: 'tool-status', toolCallId: 'call-9', status: 'running' },
        { type: 'tool-status', toolCallId: 'call-9', status: 'result', result: { value: 42 } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a tool that settles AFTER the timeout already fired', async () => {
    vi.useFakeTimers();
    try {
      let release: (result: ToolResult) => void = () => undefined;
      const tool: Tool = {
        name: 'slow_tool',
        risk: 'safe',
        spec: { name: 'slow_tool', description: 'slow', inputSchema: {} },
        run: (): Promise<ToolResult> =>
          new Promise<ToolResult>((resolve) => {
            release = resolve;
          }),
      };
      const events: AgentEvent[] = [];
      const executor = createToolExecutor(
        makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), timeoutMs: 5000 }),
      );

      const done = executor.execute('call-10', 'slow_tool', {}, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      // The tool finally settles LATE — its result must be dropped, not re-emitted.
      release({ ok: true, data: 'too late' });
      await Promise.resolve();

      expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:error']);
      const err = statusEvents(events).at(-1);
      expect(err?.error).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
