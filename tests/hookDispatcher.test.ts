// tests/hookDispatcher.test.ts
// Wave 12 — the config-driven PreToolUse/PostToolUse gate (src/tools/hookDispatcher.ts).
// Deterministic FAKE child process (no real spawn): stdout is a scripted
// async-iterable, exit code is injectable, and kill()/timeout are observable so the
// two-tier posture (matcher fail-CLOSED, execution fail-OPEN, JSON-over-exit) is
// asserted end to end.
import { describe, expect, it } from 'vitest';
import type { BrainChildLike, BrainSpawn, TimerHandle } from '../src/services/brain';
import { createHookDispatcher } from '../src/tools/hookDispatcher';
import type { HooksSettings } from '../src/services/config';

interface FakeChildOptions {
  /** stdout emitted as a single chunk before exit. */
  stdout?: string;
  /** Exit code fired via the `exit`/`close` listeners. Default 0. */
  exitCode?: number;
  /** Throw from spawn (ENOENT etc.). */
  spawnThrows?: Error;
  /** Fire the `error` listener (async spawn failure). */
  emitError?: Error;
  /** stdout yields nothing and hangs until kill() (drives timeout / abort). */
  hangUntilKill?: boolean;
  /** Emit a stdout chunk LARGER than the dispatcher's size cap (100_000). */
  oversized?: boolean;
}

interface SpawnCall {
  command: string;
  args: string[];
  stdio: readonly string[];
}

interface FakeChild extends BrainChildLike {
  stdinData: string;
  killed: boolean;
}

function makeSpawn(script: FakeChildOptions | FakeChildOptions[]): {
  spawn: BrainSpawn;
  calls: SpawnCall[];
  children: FakeChild[];
} {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let callIndex = -1;

  const spawn: BrainSpawn = (command, args, spawnOptions) => {
    callIndex += 1;
    const options = Array.isArray(script)
      ? (script[Math.min(callIndex, script.length - 1)] ?? {})
      : script;
    calls.push({ command, args: [...args], stdio: spawnOptions.stdio });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const child: FakeChild = {
      stdinData: '',
      killed: false,
      stdin: {
        write(chunk: string): boolean {
          child.stdinData += chunk;
          return true;
        },
        end(): void {},
      },
      stdout: (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.emitError !== undefined) {
          await new Promise<never>(() => {}); // never settles; the `error` event does
          return;
        }
        if (options.oversized === true) {
          yield 'x'.repeat(100_001);
        } else if (options.stdout !== undefined && options.stdout.length > 0) {
          yield options.stdout;
        }
        if (options.hangUntilKill === true) {
          await hang; // resolved by kill()
          return;
        }
        const code = options.exitCode ?? 0;
        for (const listener of exitListeners) listener(code);
        for (const listener of closeListeners) listener(code);
      })(),
      kill(): boolean {
        child.killed = true;
        releaseHang();
        return true;
      },
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'error') {
          if (options.emitError !== undefined) {
            queueMicrotask(() => (listener as (err: Error) => void)(options.emitError as Error));
          }
        } else if (event === 'exit') {
          exitListeners.push(listener as (code: number | null) => void);
        } else {
          closeListeners.push(listener as (code: number | null) => void);
        }
        return child;
      },
    };
    children.push(child);
    return child;
  };

  return { spawn, calls, children };
}

/** Controllable timer: the timeout callback is captured, not scheduled. */
function makeTimer(): { setTimer: (fn: () => void, ms: number) => TimerHandle; fire: () => void } {
  let captured: (() => void) | undefined;
  return {
    setTimer: (fn: () => void): TimerHandle => {
      captured = fn;
      return { clear: () => {} };
    },
    fire: () => captured?.(),
  };
}

const CMD = ['my-hook'];

function preConfig(matcher: string, command: string[] = CMD): HooksSettings {
  return { PreToolUse: [{ matcher, hooks: [{ command }] }] };
}

describe('hookDispatcher — PreToolUse decisions', () => {
  it('JSON {decision:block, reason} → blocks with the reason surfaced', async () => {
    const { spawn, calls, children } = makeSpawn({
      stdout: JSON.stringify({ decision: 'block', reason: 'no edits in prod' }),
    });
    const timer = makeTimer();
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: timer.setTimer });

    const outcome = await dispatcher.preToolUse('edit_file', { path: 'x' });

    expect(outcome).toEqual({ block: true, reason: 'no edits in prod' });
    // Shell-free spawn: argv array, piped stdin, stderr ignored.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('my-hook');
    expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    // stdin payload = the PreToolUse hook contract.
    expect(JSON.parse(children[0]?.stdinData ?? '')).toEqual({
      hook_event_name: 'PreToolUse',
      tool_name: 'edit_file',
      tool_input: { path: 'x' },
    });
  });

  it("Claude alias {permissionDecision:'deny', permissionDecisionReason} → blocks", async () => {
    const { spawn } = makeSpawn({
      stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'denied by policy hook' }),
    });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({
      block: true,
      reason: 'denied by policy hook',
    });
  });

  it('exit 2 with NO parseable JSON → blocks (exit code governs)', async () => {
    const { spawn } = makeSpawn({ stdout: 'not json at all', exitCode: 2 });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    const outcome = await dispatcher.preToolUse('read_file', {});
    expect(outcome.block).toBe(true);
  });

  it('JSON approve WINS over a nonzero (exit 2) exit code → does NOT block', async () => {
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ decision: 'approve' }), exitCode: 2 });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });

  it('exit 0 with no decision JSON → proceeds (no objection)', async () => {
    const { spawn } = makeSpawn({ stdout: '', exitCode: 0 });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });
});

describe('hookDispatcher — matcher fail-CLOSED', () => {
  it('a matcher that fails to compile BLOCKS the tool and never spawns a hook', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '' });
    // `(` is an invalid regex → compile fails → fail-closed.
    const dispatcher = createHookDispatcher(preConfig('('), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    const outcome = await dispatcher.preToolUse('read_file', {});
    expect(outcome.block).toBe(true);
    if (outcome.block) {
      expect(outcome.reason).toContain('failed to compile');
    }
    expect(calls).toHaveLength(0); // the child was never spawned
  });

  it('a non-matching (valid) matcher → no spawn, proceeds', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ decision: 'block' }) });
    const dispatcher = createHookDispatcher(preConfig('Bash'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
    expect(calls).toHaveLength(0);
  });

  it('matcher is anchored to the FULL tool name (Edit does not match edit_file)', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ decision: 'block' }) });
    const dispatcher = createHookDispatcher(preConfig('Edit'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('edit_file', {})).toEqual({ block: false });
    expect(calls).toHaveLength(0);

    // But an anchored alternation that matches the whole name DOES fire.
    const { spawn: spawn2, calls: calls2 } = makeSpawn({ stdout: JSON.stringify({ decision: 'block', reason: 'r' }) });
    const dispatcher2 = createHookDispatcher(preConfig('edit_file|write_file'), {
      spawnImpl: spawn2,
      scheduler: makeTimer().setTimer,
    });
    expect((await dispatcher2.preToolUse('edit_file', {})).block).toBe(true);
    expect(calls2).toHaveLength(1);
  });
});

describe('hookDispatcher — execution fail-OPEN', () => {
  it('spawn error → fail-open (proceeds)', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });

  it('async error event → fail-open (proceeds)', async () => {
    const { spawn } = makeSpawn({ emitError: new Error('spawn async failure') });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });

  it('per-hook timeout → kills the child and fails open', async () => {
    const { spawn, children } = makeSpawn({ hangUntilKill: true });
    const timer = makeTimer();
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: timer.setTimer });

    const pending = dispatcher.preToolUse('read_file', {});
    timer.fire(); // trip the per-hook timeout
    expect(await pending).toEqual({ block: false });
    expect(children[0]?.killed).toBe(true);
  });

  it('stdout exceeding the size cap → kills the child and fails open', async () => {
    const { spawn, children } = makeSpawn({ oversized: true });
    const dispatcher = createHookDispatcher(preConfig('*'), { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
    expect(children[0]?.killed).toBe(true);
  });

  it('a hook timeout override is honored (still fails open on expiry)', async () => {
    const cfg: HooksSettings = {
      PreToolUse: [{ matcher: '*', hooks: [{ command: CMD, timeoutMs: 250 }] }],
    };
    const { spawn, children } = makeSpawn({ hangUntilKill: true });
    const timer = makeTimer();
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: timer.setTimer });

    const pending = dispatcher.preToolUse('read_file', {});
    timer.fire();
    expect(await pending).toEqual({ block: false });
    expect(children[0]?.killed).toBe(true);
  });
});

describe('hookDispatcher — abort', () => {
  it('signal already aborted → no spawn, proceeds', async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ decision: 'block' }) });
    const dispatcher = createHookDispatcher(preConfig('*'), {
      spawnImpl: spawn,
      scheduler: makeTimer().setTimer,
      signal: controller.signal,
    });

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
    expect(calls).toHaveLength(0);
  });

  it('abort DURING a hook → kills the child and proceeds (fail-open on abort)', async () => {
    const controller = new AbortController();
    const { spawn, children } = makeSpawn({ hangUntilKill: true });
    const dispatcher = createHookDispatcher(preConfig('*'), {
      spawnImpl: spawn,
      scheduler: makeTimer().setTimer, // captured, never auto-fires
      signal: controller.signal,
    });

    const pending = dispatcher.preToolUse('read_file', {});
    controller.abort();
    expect(await pending).toEqual({ block: false });
    expect(children[0]?.killed).toBe(true);
  });
});

describe('hookDispatcher — PostToolUse append', () => {
  it('reads hookSpecificOutput.additionalContext as the reminder, with the post payload', async () => {
    const cfg: HooksSettings = {
      PostToolUse: [{ matcher: '*', hooks: [{ command: CMD }] }],
    };
    const { spawn, children } = makeSpawn({
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'Re-read before editing again.' } }),
    });
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    const out = await dispatcher.postToolUse('edit_file', { path: 'x' }, { ok: true });
    expect(out).toEqual({ appendText: 'Re-read before editing again.' });
    // The post payload carries the tool_response too.
    expect(JSON.parse(children[0]?.stdinData ?? '')).toEqual({
      hook_event_name: 'PostToolUse',
      tool_name: 'edit_file',
      tool_input: { path: 'x' },
      tool_response: { ok: true },
    });
  });

  it('top-level additionalContext is also accepted', async () => {
    const cfg: HooksSettings = { PostToolUse: [{ matcher: '*', hooks: [{ command: CMD }] }] };
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ additionalContext: 'do not re-display' }) });
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.postToolUse('read_media', {}, {})).toEqual({ appendText: 'do not re-display' });
  });

  it('no JSON append field → no appendText (advisory no-op)', async () => {
    const cfg: HooksSettings = { PostToolUse: [{ matcher: '*', hooks: [{ command: CMD }] }] };
    const { spawn } = makeSpawn({ stdout: '' });
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.postToolUse('read_file', {}, {})).toEqual({});
  });

  it('multiple matching hooks concatenate their reminders', async () => {
    const cfg: HooksSettings = {
      PostToolUse: [{ matcher: '*', hooks: [{ command: CMD }, { command: CMD }] }],
    };
    const { spawn } = makeSpawn([
      { stdout: JSON.stringify({ additionalContext: 'first' }) },
      { stdout: JSON.stringify({ additionalContext: 'second' }) },
    ]);
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    expect(await dispatcher.postToolUse('read_file', {}, {})).toEqual({ appendText: 'first\n\nsecond' });
  });

  it('PostToolUse never blocks even on a block-shaped JSON payload', async () => {
    const cfg: HooksSettings = { PostToolUse: [{ matcher: '*', hooks: [{ command: CMD }] }] };
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ decision: 'block', reason: 'ignored' }), exitCode: 2 });
    const dispatcher = createHookDispatcher(cfg, { spawnImpl: spawn, scheduler: makeTimer().setTimer });

    // No appendText, and crucially no throw / block — post is advisory.
    expect(await dispatcher.postToolUse('read_file', {}, {})).toEqual({});
  });
});
