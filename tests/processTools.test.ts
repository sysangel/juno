import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelClient, Tool, ToolCtx } from '../src/core/contracts';
import type { PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import { createProcessManager } from '../src/tools/processTools';
import { createDefaultTools } from '../src/tools/registry';
import { createPermissionPolicy } from '../src/permissions/policy';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { DEFAULT_SETTINGS } from '../src/services/config';

const roots: string[] = [];
const managers: Array<ReturnType<typeof createProcessManager>> = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'juno-process-'));
  roots.push(root);
  return root;
}

function state(): Readonly<State> {
  return { committed: [], live: null, tools: {}, phase: 'idle', overlay: 'none', effort: 'medium', permissionMode: 'default', tokens: { in: 0, out: 0 }, pendingPermission: null, errorMessage: null };
}

function ctx(cwd: string): ToolCtx {
  return { cwd, signal: new AbortController().signal, emit: () => undefined, awaitPermission: async (): Promise<PermissionDecision> => 'allow-once', state: state() };
}

function get(manager: ReturnType<typeof createProcessManager>, name: string): Tool {
  const tool = manager.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  return tool;
}

async function pollUntil(manager: ReturnType<typeof createProcessManager>, id: string, predicate: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const chunks: unknown[] = [];
  let droppedChars = 0;
  for (let i = 0; i < 80; i += 1) {
    const result = await get(manager, 'poll_process').run({ process_id: id }, ctx('.'));
    if (result.ok && typeof result.data === 'object' && result.data !== null) {
      const data = result.data as Record<string, unknown>;
      if (Array.isArray(data.chunks)) chunks.push(...data.chunks);
      if (typeof data.droppedChars === 'number') droppedChars += data.droppedChars;
      if (predicate(data)) return { ...data, chunks, droppedChars };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('process did not reach expected state');
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed process tools', () => {
  it('starts immediately, streams bounded output through polls, and reports exit', async () => {
    const root = await workspace();
    let next = 0;
    const manager = createProcessManager({ maxOutputChars: 8, id: () => `p${++next}` });
    managers.push(manager);
    const started = await get(manager, 'start_process').run({ command: "printf 'abcdefghijkl'; sleep 0.03" }, ctx(root));
    expect(started).toMatchObject({ ok: true, data: { processId: 'p1', status: 'running' } });
    const final = await pollUntil(manager, 'p1', (data) => data.status !== 'running');
    expect(final.status).toBe('exited');
    expect(final.exitCode).toBe(0);
    expect(final.droppedChars).toBe(4);
    expect(final.chunks).toEqual([{ stream: 'stdout', text: 'efghijkl' }]);
    expect(await get(manager, 'poll_process').run({ process_id: 'p1' }, ctx(root))).toEqual({ ok: false, error: 'unknown process: p1' });
  });

  it('supports bounded stdin without a PTY and stdin activity keeps the session usable', async () => {
    const root = await workspace();
    const manager = createProcessManager({ id: () => 'stdin' });
    managers.push(manager);
    await get(manager, 'start_process').run({ command: 'read line; printf "got:%s" "$line"' }, ctx(root));
    expect(await get(manager, 'write_process_stdin').run({ process_id: 'stdin', text: 'hello\n' }, ctx(root))).toEqual({ ok: true, data: { processId: 'stdin', bytesWritten: 6 } });
    const final = await pollUntil(manager, 'stdin', (data) => data.status !== 'running');
    expect(final.chunks).toEqual([{ stream: 'stdout', text: 'got:hello' }]);
  });

  it('distinguishes idle timeout from the absolute wall timeout', async () => {
    const root = await workspace();
    const manager = createProcessManager({ id: () => 'idle', killGraceMs: 10 });
    managers.push(manager);
    await get(manager, 'start_process').run({ command: 'sleep 10', idle_timeout_ms: 25, wall_timeout_ms: 500 }, ctx(root));
    const final = await pollUntil(manager, 'idle', (data) => data.status !== 'running');
    expect(final).toMatchObject({ status: 'timed_out', reason: 'idle timeout after 25ms without process I/O' });

    const wallManager = createProcessManager({ id: () => 'wall', killGraceMs: 10 });
    managers.push(wallManager);
    await get(wallManager, 'start_process').run({ command: 'while :; do printf x; sleep 0.01; done', idle_timeout_ms: 60, wall_timeout_ms: 90 }, ctx(root));
    const wall = await pollUntil(wallManager, 'wall', (data) => data.status !== 'running');
    expect(wall).toMatchObject({ status: 'timed_out', reason: 'wall timeout after 90ms' });
  });

  it('terminates on request and shutdown rejects new starts', async () => {
    const root = await workspace();
    const manager = createProcessManager({ id: () => 'server', killGraceMs: 10 });
    managers.push(manager);
    await get(manager, 'start_process').run({ command: 'sleep 10' }, ctx(root));
    expect(await get(manager, 'terminate_process').run({ process_id: 'server' }, ctx(root))).toMatchObject({ ok: true, data: { status: 'terminated' } });
    await manager.shutdown();
    expect(await get(manager, 'start_process').run({ command: 'true' }, ctx(root))).toEqual({ ok: false, error: 'process manager is shutting down' });
  });

  it('escalates against a SIGTERM-ignoring process group so descendants cannot leak', async () => {
    if (process.platform === 'win32') return;
    const root = await workspace();
    const manager = createProcessManager({ id: () => 'stubborn', killGraceMs: 20 });
    managers.push(manager);
    await get(manager, 'start_process').run({ command: "sh -c 'trap \"\" TERM; echo $$ > child.pid; while :; do sleep 1; done'" }, ctx(root));
    let pidText = '';
    for (let i = 0; i < 40 && pidText === ''; i += 1) {
      try { pidText = await readFile(path.join(root, 'child.pid'), 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    const pid = Number(pidText.trim());
    expect(Number.isInteger(pid)).toBe(true);
    await get(manager, 'terminate_process').run({ process_id: 'stubborn' }, ctx(root));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('bounds concurrent sessions and releases a terminal slot after its final poll', async () => {
    const root = await workspace();
    let id = 0;
    const manager = createProcessManager({ id: () => `slot-${++id}`, maxSessions: 1 });
    managers.push(manager);
    await get(manager, 'start_process').run({ command: 'true' }, ctx(root));
    expect(await get(manager, 'start_process').run({ command: 'true' }, ctx(root))).toEqual({ ok: false, error: 'process session limit reached (1)' });
    await pollUntil(manager, 'slot-1', (data) => data.status !== 'running');
    expect(await get(manager, 'start_process').run({ command: 'true' }, ctx(root))).toMatchObject({ ok: true, data: { processId: 'slot-2' } });
  });

  it('jails cwd lexically and after symlink canonicalization', async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(root, 'inside'));
    await symlink(outside, path.join(root, 'escape'));
    const manager = createProcessManager({ id: () => 'never' });
    managers.push(manager);
    expect(await get(manager, 'start_process').run({ command: 'pwd', cwd: '../' }, ctx(root))).toEqual({ ok: false, error: 'cwd escapes the workspace' });
    expect(await get(manager, 'start_process').run({ command: 'pwd', cwd: 'escape' }, ctx(root))).toEqual({ ok: false, error: 'cwd resolves outside the workspace' });
  });

  it('is opt-in and parent-only: registry appends all four after the subagent child snapshot', () => {
    const manager = createProcessManager();
    managers.push(manager);
    expect(createDefaultTools().some((tool) => tool.name === 'start_process')).toBe(false);
    const subagent = {
      createClient: (): ModelClient => ({ async *streamTurn() { /* unused */ } }),
      catalog: createModelCatalog(BUILTIN_MODELS),
      defaultModel: DEFAULT_SETTINGS.defaultModel,
      policy: createPermissionPolicy(),
    };
    const names = createDefaultTools({ subagent, processes: manager }).map((tool) => tool.name);
    expect(names.slice(-4)).toEqual(['start_process', 'poll_process', 'write_process_stdin', 'terminate_process']);
    expect(names.indexOf('spawn_subagent')).toBeLessThan(names.indexOf('start_process'));
  });

  it('publishes strict schemas and intentional risks', () => {
    const manager = createProcessManager();
    managers.push(manager);
    expect(manager.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ['start_process', 'dangerous'], ['poll_process', 'safe'], ['write_process_stdin', 'dangerous'], ['terminate_process', 'risky'],
    ]);
    for (const tool of manager.tools) expect(tool.spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
