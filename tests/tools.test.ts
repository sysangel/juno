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
import type { HookDispatcher, PreToolUseOutcome } from '../src/tools/hookDispatcher';
import { createFileTools, type FileToolsOptions } from '../src/tools/fileTools';
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
    pendingPermission: null,
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

  // --- W12 sensitive-path deny ------------------------------------------------
  // These file tools refuse a shipped default set of secret-bearing paths even
  // when the target sits INSIDE the jail. The deny is a DISTINCT error string from
  // the jail-escape so the two are never confused. Covers juno's own file tools
  // only, not run_shell (which has no path jail) — see fileTools.ts header.

  /** Look up a tool from a bespoke createFileTools() instance (opt-out cases). */
  function fileTool(name: string, opts?: FileToolsOptions): Tool {
    const tool = createFileTools(opts).find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    return tool;
  }

  it('sensitive: read_file denies root .env with a marker distinct from escape', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, '.env'), 'API_KEY=shh', 'utf8');

    const result = await getTool('read_file').run({ path: '.env' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive');
    // Distinct from the jail-escape error so callers/logs can tell them apart.
    expect(result.error).not.toContain('escape');
  });

  it('sensitive: read_file denies a nested sub/.env', async () => {
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, 'sub'));
    await writeFile(path.join(cwd, 'sub', '.env'), 'API_KEY=shh', 'utf8');

    const result = await getTool('read_file').run({ path: 'sub/.env' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive');
  });

  it('sensitive: read_file denies key.pem, id_rsa, .npmrc, credentials, .env.local, and .ssh/known_hosts', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'key.pem'), 'x', 'utf8');
    await writeFile(path.join(cwd, 'id_rsa'), 'x', 'utf8');
    await writeFile(path.join(cwd, '.npmrc'), 'x', 'utf8');
    await writeFile(path.join(cwd, 'credentials'), 'x', 'utf8');
    await writeFile(path.join(cwd, '.env.local'), 'x', 'utf8');
    await mkdir(path.join(cwd, '.ssh'));
    await writeFile(path.join(cwd, '.ssh', 'known_hosts'), 'x', 'utf8');

    for (const target of ['key.pem', 'id_rsa', '.npmrc', 'credentials', '.env.local', '.ssh/known_hosts']) {
      const result = await getTool('read_file').run({ path: target }, createCtx(cwd));
      expect(result.ok, `expected ${target} denied`).toBe(false);
      expect(result.error).toContain('sensitive');
    }
  });

  it('sensitive: write_file and edit_file are denied on a sensitive target', async () => {
    const cwd = await makeWorkspace();
    // Pre-seed .env so edit_file has something to (attempt to) edit.
    await writeFile(path.join(cwd, '.env'), 'API_KEY=old', 'utf8');

    const write = await getTool('write_file').run(
      { path: '.env', content: 'API_KEY=pwned' },
      createCtx(cwd),
    );
    expect(write.ok).toBe(false);
    expect(write.error).toContain('sensitive');

    const edit = await getTool('edit_file').run(
      { path: '.env', oldString: 'old', newString: 'pwned' },
      createCtx(cwd),
    );
    expect(edit.ok).toBe(false);
    expect(edit.error).toContain('sensitive');
    // The secret file is untouched by the denied write/edit.
    await expect(readFile(path.join(cwd, '.env'), 'utf8')).resolves.toBe('API_KEY=old');
  });

  it('sensitive: grep never leaks the CONTENTS of a sensitive file (.env, id_rsa)', async () => {
    const cwd = await makeWorkspace();
    const secret = 'zzUNIQUESECRETzz9137';
    await writeFile(path.join(cwd, '.env'), `TOKEN=${secret}\n`, 'utf8');
    await writeFile(path.join(cwd, 'id_rsa'), `${secret}\n`, 'utf8');
    // A NON-sensitive file carrying the same string proves grep still works and
    // the filter is scoped to the sensitive files, not to the pattern.
    await writeFile(path.join(cwd, 'visible.txt'), `here: ${secret}\n`, 'utf8');

    const result = await getTool('grep').run({ pattern: secret }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'visible.txt', line: 1, text: `here: ${secret}` }] },
    });
  });

  it('sensitive: list_files excludes sensitive basenames from the entries', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, '.env'), 'x', 'utf8');
    await writeFile(path.join(cwd, 'id_rsa'), 'x', 'utf8');
    await writeFile(path.join(cwd, 'notes.txt'), 'x', 'utf8');
    await mkdir(path.join(cwd, '.ssh'));

    const result = await getTool('list_files').run({}, createCtx(cwd));
    expect(result).toEqual({ ok: true, data: { dir: '.', entries: ['notes.txt'] } });
  });

  it('sensitive: a symlink renamed to a harmless name still resolves to the denied file', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, '.env'), 'API_KEY=shh', 'utf8');
    // An in-workspace link with an innocent name pointing at the workspace .env.
    // We match on the canonical `rel`, so the deny fires; a raw-arg policy deny
    // (keyed on args.path === 'harmless.txt') would miss this.
    await symlink(path.join(cwd, '.env'), path.join(cwd, 'harmless.txt'));

    const result = await getTool('read_file').run({ path: 'harmless.txt' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive');
    expect(result.error).not.toContain('escape');
  });

  it('sensitive: does NOT over-match environment.ts, env.example, or notes.txt', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'environment.ts'), 'export const x = 1;', 'utf8');
    await writeFile(path.join(cwd, 'env.example'), 'API_KEY=', 'utf8');
    await writeFile(path.join(cwd, 'notes.txt'), 'plain notes', 'utf8');

    for (const [target, body] of [
      ['environment.ts', 'export const x = 1;'],
      ['env.example', 'API_KEY='],
      ['notes.txt', 'plain notes'],
    ] as const) {
      const result = await getTool('read_file').run({ path: target }, createCtx(cwd));
      expect(result).toEqual({ ok: true, data: { path: target, content: body } });
    }
  });

  it('sensitive: opt-out (disableDefaults) allows reading .env', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, '.env'), 'API_KEY=shh', 'utf8');

    const read = fileTool('read_file', { sensitiveDeny: { disableDefaults: true } });
    const result = await read.run({ path: '.env' }, createCtx(cwd));
    expect(result).toEqual({ ok: true, data: { path: '.env', content: 'API_KEY=shh' } });
  });

  it('sensitive: extra patterns augment the defaults without disabling them', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'secret.txt'), 'x', 'utf8');
    await writeFile(path.join(cwd, '.env'), 'x', 'utf8');

    const read = fileTool('read_file', { sensitiveDeny: { extra: ['secret.txt'] } });
    // The extra pattern denies secret.txt...
    const extra = await read.run({ path: 'secret.txt' }, createCtx(cwd));
    expect(extra.ok).toBe(false);
    expect(extra.error).toContain('sensitive');
    // ...and the shipped defaults still deny .env.
    const dflt = await read.run({ path: '.env' }, createCtx(cwd));
    expect(dflt.ok).toBe(false);
    expect(dflt.error).toContain('sensitive');
  });

  it('registry exposes the built-in file tools and matching specs', () => {
    const tools = createDefaultTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['apply_patch', 'edit_file', 'glob_files', 'grep', 'list_files', 'read_file', 'tree', 'write_file'],
    );
    expect(BUILTIN_TOOL_SPECS.map((s) => s.name).sort()).toEqual(
      ['apply_patch', 'edit_file', 'glob_files', 'grep', 'list_files', 'read_file', 'tree', 'write_file'],
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
  hooks?: ToolExecutorDeps['hooks'];
}): ToolExecutorDeps {
  return {
    tools: opts.tools,
    policy: opts.policy,
    cwd: process.cwd(),
    signal: opts.signal ?? new AbortController().signal,
    getState: () => fakeState(),
    awaitPermission: opts.awaitPermission ?? (async (): Promise<PermissionDecision> => 'allow-once'),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
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

  it('drops a ctx.emit call made AFTER the timeout already fired', async () => {
    vi.useFakeTimers();
    try {
      let emitLate: (() => void) | undefined;
      const tool: Tool = {
        name: 'ignoring_tool',
        risk: 'safe',
        spec: { name: 'ignoring_tool', description: 'ignores abort', inputSchema: {} },
        // Ignores its AbortSignal and never resolves; captures ctx.emit so the
        // test can invoke it after the turn has already settled via timeout.
        run: (_args: unknown, ctx: ToolCtx): Promise<ToolResult> => {
          emitLate = (): void => ctx.emit({ type: 'tool-status', toolCallId: 'call-11', status: 'result', result: 'stray' });
          return new Promise<ToolResult>(() => undefined);
        },
      };
      const events: AgentEvent[] = [];
      const executor = createToolExecutor(
        makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), timeoutMs: 5000 }),
      );

      const done = executor.execute('call-11', 'ignoring_tool', {}, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      // The tool emits AFTER settlement — the gated emit must drop it.
      emitLate?.();
      await Promise.resolve();

      // Terminal result and event stream are unchanged: running + timeout error only.
      expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:error']);
      const err = statusEvents(events).at(-1);
      expect(err?.error).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- executor × promptText (rank 14) + hooks (rank 5) -------------------------

/** A hand-built HookDispatcher stub (no spawn) for executor integration. */
function fakeHooks(overrides: Partial<HookDispatcher>): HookDispatcher {
  return {
    preToolUse: overrides.preToolUse ?? (async (): Promise<PreToolUseOutcome> => ({ block: false })),
    postToolUse: overrides.postToolUse ?? (async () => ({})),
  };
}

describe('tool executor — promptText split (rank 14)', () => {
  it('carries a tool result promptText onto the terminal tool-status', async () => {
    const tool: Tool = {
      name: 'hint_tool',
      risk: 'safe',
      spec: { name: 'hint_tool', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { x: 1 }, promptText: 'HINT' }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-a', 'hint_tool', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-a', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-a', status: 'result', result: { x: 1 }, promptText: 'HINT' },
    ]);
  });

  it('a result WITHOUT promptText emits no promptText key (zero churn to existing tools)', async () => {
    const tool: Tool = {
      name: 'plain_tool',
      risk: 'safe',
      spec: { name: 'plain_tool', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { value: 1 } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-a2', 'plain_tool', {}, (event) => events.push(event));

    const result = statusEvents(events).at(-1);
    expect(result?.result).toEqual({ value: 1 });
    expect('promptText' in (result ?? {})).toBe(false);
  });
});

describe('tool executor — PreToolUse/PostToolUse hooks (rank 5)', () => {
  it('PreToolUse block → terminal error with the reason; tool.run AND policy.evaluate never reached', async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, data: 'ran' }));
    const tool: Tool = { name: 'gated', risk: 'safe', spec: { name: 'gated', description: '', inputSchema: {} }, run };
    const evaluate = vi.fn((): 'auto-allow' => 'auto-allow');
    const policy: PermissionPolicy = { evaluate, remember: () => {}, setMode: () => {} };
    const hooks = fakeHooks({ preToolUse: async () => ({ block: true, reason: 'blocked by hook' }) });

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy, hooks }));
    await executor.execute('call-b', 'gated', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-b', status: 'error', error: 'blocked by hook' },
    ]);
    expect(run).not.toHaveBeenCalled();
    // Placement proof: the PreToolUse gate runs BEFORE policy.evaluate, so a block
    // means evaluate is never consulted (a block can't be bypassed by an auto-allow).
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('PostToolUse appendText → terminal result promptText carries the reminder (ties rank 14 + 5)', async () => {
    const tool: Tool = {
      name: 'edit_x',
      risk: 'safe',
      spec: { name: 'edit_x', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { written: true } }),
    };
    const hooks = fakeHooks({ postToolUse: async () => ({ appendText: 'Re-read before editing again.' }) });

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), hooks }));
    await executor.execute('call-c', 'edit_x', {}, (event) => events.push(event));

    const result = statusEvents(events).at(-1);
    expect(result?.status).toBe('result');
    // No tool promptText → the base is JSON.stringify(data), then the reminder appended.
    expect(result?.promptText).toBe(
      `${JSON.stringify({ written: true })}\n\nRe-read before editing again.`,
    );
    // `data`/`result` (the UI-card payload) is untouched by the append.
    expect(result?.result).toEqual({ written: true });
  });

  it('PostToolUse appends onto the tool OWN promptText when present', async () => {
    const tool: Tool = {
      name: 'edit_y',
      risk: 'safe',
      spec: { name: 'edit_y', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { x: 1 }, promptText: 'TOOLHINT' }),
    };
    const hooks = fakeHooks({ postToolUse: async () => ({ appendText: 'MORE' }) });

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), hooks }));
    await executor.execute('call-d', 'edit_y', {}, (event) => events.push(event));

    expect(statusEvents(events).at(-1)?.promptText).toBe('TOOLHINT\n\nMORE');
  });

  it('PostToolUse is advisory: never runs on an error result', async () => {
    const postToolUse = vi.fn(async () => ({ appendText: 'nope' }));
    const tool: Tool = {
      name: 'boom',
      risk: 'safe',
      spec: { name: 'boom', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: false, error: 'bad' }),
    };
    const hooks = fakeHooks({ postToolUse });

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), hooks }));
    await executor.execute('call-e', 'boom', {}, (event) => events.push(event));

    expect(postToolUse).not.toHaveBeenCalled();
    expect(statusEvents(events).at(-1)).toEqual({ type: 'tool-status', toolCallId: 'call-e', status: 'error', error: 'bad' });
  });

  it('a non-blocking PreToolUse lets policy.evaluate + the tool run normally', async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, data: 'ok' }));
    const tool: Tool = { name: 'passthru', risk: 'safe', spec: { name: 'passthru', description: '', inputSchema: {} }, run };
    const evaluate = vi.fn((): 'auto-allow' => 'auto-allow');
    const policy: PermissionPolicy = { evaluate, remember: () => {}, setMode: () => {} };
    const hooks = fakeHooks({ preToolUse: async () => ({ block: false }) });

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy, hooks }));
    await executor.execute('call-f', 'passthru', {}, (event) => events.push(event));

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:result']);
  });
});

// --- executor input-schema validation (b6-boundary-honesty item 2) -------------

describe('tool executor — input-schema validation at the boundary', () => {
  it('rejects malformed args against a constrained schema BEFORE run(): single terminal error naming the field + redacted echo', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'reader',
      risk: 'safe',
      spec: {
        name: 'reader',
        description: 'r',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-iv1', 'reader', {}, (event) => events.push(event));

    // The tool never ran, and no 'running' status was emitted (validation is pre-run).
    expect(run).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tool-status' && e.status === 'running')).toBe(false);
    // Exactly one terminal error, naming the missing field + echoing the (redacted) args.
    expect(statusEvents(events)).toHaveLength(1);
    const err = statusEvents(events)[0]!;
    expect(err.status).toBe('error');
    expect(err.error).toContain('Invalid arguments for tool "reader"');
    expect(err.error).toContain('path: is required');
    expect(err.error).toContain('Received: {}');
  });

  it('names the field AND expected type on a wrong-typed arg', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'reader',
      risk: 'safe',
      spec: {
        name: 'reader',
        description: 'r',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-iv2', 'reader', { path: 42 }, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    const err = statusEvents(events).at(-1)!;
    expect(err.error).toContain('path: expected string, got number');
  });

  it('is FAIL-OPEN: a loose {type:"object"} schema runs a valid object call normally', async () => {
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, data: { ran: true } }));
    const tool: Tool = {
      name: 'loose',
      risk: 'safe',
      spec: { name: 'loose', description: '', inputSchema: { type: 'object' } },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-iv3', 'loose', { anything: 1 }, (event) => events.push(event));

    expect(run).toHaveBeenCalledTimes(1);
    expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:result']);
  });
});

// --- executor output-schema pinning (b6-boundary-honesty item 3) ---------------

describe('tool executor — optional output-schema pinning', () => {
  const outputSchema = {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  };

  it('passes a result that matches the declared output schema (normal result event)', async () => {
    const tool: Tool = {
      name: 'pinned',
      risk: 'safe',
      spec: { name: 'pinned', description: '', inputSchema: {} },
      outputSchema,
      run: async (): Promise<ToolResult> => ({ ok: true, data: { summary: 'hi' } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-ov1', 'pinned', {}, (event) => events.push(event));

    expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:result']);
    expect(statusEvents(events).at(-1)?.result).toEqual({ summary: 'hi' });
  });

  it('surfaces a result-shape mismatch as a terminal error naming the field; NO result event', async () => {
    const tool: Tool = {
      name: 'pinned',
      risk: 'safe',
      spec: { name: 'pinned', description: '', inputSchema: {} },
      outputSchema,
      run: async (): Promise<ToolResult> => ({ ok: true, data: { summary: 42 } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-ov2', 'pinned', {}, (event) => events.push(event));

    expect(events.some((e) => e.type === 'tool-status' && e.status === 'result')).toBe(false);
    const err = statusEvents(events).at(-1)!;
    expect(err.status).toBe('error');
    expect(err.error).toContain('does not match its declared output schema');
    expect(err.error).toContain('summary: expected string, got number');
  });

  it('a tool with NO outputSchema is byte-identical to today (regression guard)', async () => {
    const tool: Tool = {
      name: 'unpinned',
      risk: 'safe',
      spec: { name: 'unpinned', description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { whatever: 1, shape: 'ok' } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));
    await executor.execute('call-ov3', 'unpinned', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-ov3', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-ov3', status: 'result', result: { whatever: 1, shape: 'ok' } },
    ]);
  });
});
