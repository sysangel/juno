import { describe, expect, it } from 'vitest';
import {
  runBrainRemember,
  type BrainRememberInput,
} from '../src/services/brainRemember';
import type { BrainChildLike, BrainSpawn, TimerHandle } from '../src/services/brain';
import { createBrainRememberTool } from '../src/tools/brainTool';
import { createDefaultTools } from '../src/tools/registry';
import type { ToolCtx } from '../src/core/contracts';

// ---------------------------------------------------------------------------
// CRITICAL TEST HYGIENE: a REAL brain-remember write auto-commits AND auto-pushes
// to a private git remote. Every test here uses a scripted FAKE spawn — the real
// `uv`/`brain-remember` binary is NEVER invoked. The single integration-style
// test at the bottom is `describe.skip` (opt-in only).
// ---------------------------------------------------------------------------

interface FakeChildOptions {
  stdout?: string;
  stdoutBytes?: boolean;
  exitCode?: number;
  spawnThrows?: Error;
  emitError?: Error;
  hangUntilKill?: boolean;
  deferExit?: boolean;
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  stdio: readonly string[];
}

interface FakeChild extends BrainChildLike {
  stdinData: string;
  stdinEnded: boolean;
  killCount: number;
}

function makeSpawn(options: FakeChildOptions): {
  spawn: BrainSpawn;
  calls: SpawnCall[];
  child: () => FakeChild | undefined;
} {
  const calls: SpawnCall[] = [];
  let created: FakeChild | undefined;

  const spawn: BrainSpawn = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd, stdio: spawnOptions.stdio });
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
      stdinEnded: false,
      killCount: 0,
      stdin: {
        write(chunk: string): boolean {
          child.stdinData += chunk;
          return true;
        },
        end(): void {
          child.stdinEnded = true;
        },
      },
      stdout: (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.emitError !== undefined) {
          await new Promise<never>(() => {});
          return;
        }
        if (options.stdout !== undefined && options.stdout.length > 0) {
          yield options.stdoutBytes === true
            ? new TextEncoder().encode(options.stdout)
            : options.stdout;
        }
        if (options.hangUntilKill === true) {
          await hang;
          return;
        }
        const code = options.exitCode ?? 0;
        const fire = (): void => {
          for (const listener of exitListeners) {
            listener(code);
          }
          for (const listener of closeListeners) {
            listener(code);
          }
        };
        if (options.deferExit === true) {
          setTimeout(fire, 0);
        } else {
          fire();
        }
      })(),
      kill(): boolean {
        child.killCount += 1;
        releaseHang();
        // A killed child still closes; mirror Node by firing close afterwards.
        queueMicrotask(() => {
          for (const listener of closeListeners) {
            listener(null);
          }
        });
        return true;
      },
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null) => void);
        } else if (event === 'close') {
          closeListeners.push(listener as (code: number | null) => void);
        } else if (event === 'error' && options.emitError !== undefined) {
          queueMicrotask(() => (listener as (err: Error) => void)(options.emitError as Error));
        }
        return child;
      },
    };
    created = child;
    return child;
  };

  return { spawn, calls, child: () => created };
}

// A no-op timer that never auto-fires (deterministic; timeout tests fire manually).
function makeManualTimer(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  fire: () => void;
  cleared: () => boolean;
} {
  let pending: (() => void) | undefined;
  let wasCleared = false;
  return {
    setTimer: (fn) => {
      pending = fn;
      return {
        clear: () => {
          wasCleared = true;
          pending = undefined;
        },
      };
    },
    fire: () => pending?.(),
    cleared: () => wasCleared,
  };
}

const CMD = ['brain-remember'] as const;
const CWD = '/tmp/ws';
const INPUT: BrainRememberInput = { fact: 'the build port is 8321', project: 'ws' };

describe('runBrainRemember (fake spawn only)', () => {
  it('writes the request JSON on stdin and returns the parsed created result', async () => {
    const created = JSON.stringify({ status: 'created', name: 'the-build-port', id: 'mem_abc', committed: true, pushed: true });
    const { spawn, calls, child } = makeSpawn({ stdout: created });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);

    expect(outcome).toEqual({ ok: true, result: { status: 'created', name: 'the-build-port', id: 'mem_abc', committed: true, pushed: true } });
    expect(calls[0]?.command).toBe('brain-remember');
    expect(calls[0]?.cwd).toBe(CWD);
    expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(child()?.stdinEnded).toBe(true);
    expect(JSON.parse(child()?.stdinData ?? '{}')).toEqual({ fact: 'the build port is 8321', project: 'ws' });
  });

  it('surfaces a dedup refusal (status:"duplicate") as a NON-error success', async () => {
    const dup = JSON.stringify({ status: 'duplicate', similarity: 0.97, hint: 'pass force=true to write anyway' });
    const { spawn } = makeSpawn({ stdout: dup });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.status).toBe('duplicate');
    }
  });

  it('maps a zero-exit {error} result to ok:false', async () => {
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ error: 'type must be one of user|feedback|project|reference' }) });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome).toEqual({ ok: false, error: 'type must be one of user|feedback|project|reference' });
  });

  it('maps a non-zero exit to ok:false, preferring the CLI error message', async () => {
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ error: 'invalid JSON on stdin' }), exitCode: 1 });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome).toEqual({ ok: false, error: 'invalid JSON on stdin' });
  });

  it('rejects malformed JSON on stdout', async () => {
    const { spawn } = makeSpawn({ stdout: 'not json{' });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome).toEqual({ ok: false, error: 'brain: remember returned malformed JSON' });
  });

  it('decodes byte-chunk stdout', async () => {
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ status: 'created', id: 'mem_z' }), stdoutBytes: true });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome.ok).toBe(true);
  });

  it('times out, kills the child, and reports it', async () => {
    const { spawn, child } = makeSpawn({ hangUntilKill: true });
    const timer = makeManualTimer();
    const promise = runBrainRemember(
      { command: CMD, cwd: CWD, timeoutMs: 1000, spawnImpl: spawn, setTimer: timer.setTimer },
      INPUT,
    );
    timer.fire();
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, error: 'brain: remember timed out after 1000ms and was killed' });
    expect(child()?.killCount).toBeGreaterThanOrEqual(1);
  });

  it('fails open when spawn throws', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('failed to spawn remember');
    }
  });

  it('fails open on an async spawn error event', async () => {
    const { spawn } = makeSpawn({ emitError: new Error('boom') });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('errored');
    }
  });

  it('errors when the command is empty', async () => {
    const { spawn } = makeSpawn({ stdout: '{}' });
    const outcome = await runBrainRemember({ command: [], cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome).toEqual({ ok: false, error: 'brain: no remember command configured' });
  });

  it('errors when a zero-exit produces no output', async () => {
    const { spawn } = makeSpawn({ stdout: '' });
    const outcome = await runBrainRemember({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, INPUT);
    expect(outcome).toEqual({ ok: false, error: 'brain: remember returned no result' });
  });
});

function createCtx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    awaitPermission: async () => 'allow-once',
    state: {} as ToolCtx['state'],
  };
}

describe('createBrainRememberTool', () => {
  it('is risk:risky and named brain_remember', () => {
    const tool = createBrainRememberTool({ command: CMD, cwd: CWD, timeoutMs: 5000 });
    expect(tool.name).toBe('brain_remember');
    expect(tool.risk).toBe('risky');
  });

  it('rejects missing/empty fact without spawning', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '{}' });
    const tool = createBrainRememberTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    expect(await tool.run({}, createCtx(CWD))).toEqual({ ok: false, error: 'invalid args: fact must be a non-empty string' });
    expect(await tool.run({ fact: '   ' }, createCtx(CWD))).toEqual({ ok: false, error: 'invalid args: fact must be a non-empty string' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a bad type without spawning', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '{}' });
    const tool = createBrainRememberTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ fact: 'x', type: 'bogus' }, createCtx(CWD));
    expect(result).toEqual({ ok: false, error: 'invalid args: type must be user|feedback|project|reference' });
    expect(calls).toHaveLength(0);
  });

  it('threads provenance (project=cwd basename) and force onto stdin — no session trailer', async () => {
    const { spawn, child } = makeSpawn({ stdout: JSON.stringify({ status: 'created', id: 'mem_1' }) });
    const tool = createBrainRememberTool({ command: CMD, cwd: '/home/u/proj', timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ fact: 'keep this', type: 'user', name: 'my-note', force: true }, createCtx('/home/u/proj'));
    expect(result.ok).toBe(true);
    // `session` is deliberately ABSENT: juno's session id lives inside <App>
    // (mutable on /resume) and is not reachable at registry wiring time.
    expect(JSON.parse(child()?.stdinData ?? '{}')).toEqual({
      fact: 'keep this',
      project: 'proj',
      type: 'user',
      name: 'my-note',
      force: true,
    });
  });

  it('returns a clear error result (never throws) when the write path fails', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const tool = createBrainRememberTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ fact: 'x' }, createCtx(CWD));
    expect(result.ok).toBe(false);
  });
});

describe('registry gating for brain_remember', () => {
  const stubDeps = { command: CMD, cwd: CWD, timeoutMs: 5000 };

  it('is ABSENT unless brainRemember is provided', () => {
    const names = createDefaultTools({ memory: undefined }).map((t) => t.name);
    expect(names).not.toContain('brain_remember');
  });

  it('is registered when brainRemember is provided', () => {
    const names = createDefaultTools({ brainRemember: stubDeps }).map((t) => t.name);
    expect(names).toContain('brain_remember');
  });

  it('is parent-agent-only: pushed AFTER spawn_subagent, so out of the childTools snapshot', () => {
    const names = createDefaultTools({
      brainRemember: stubDeps,
      subagent: {
        createClient: () => ({ streamTurn: async function* () {} }),
        catalog: {} as never,
        policy: {} as never,
        defaultModel: 'm',
      },
    }).map((t) => t.name);
    // The subagent tool captures childTools BEFORE brain_remember is pushed, so a
    // sub-agent can never see it. Ordering (after spawn_subagent) is the proof.
    expect(names.indexOf('brain_remember')).toBeGreaterThan(names.indexOf('spawn_subagent'));
  });
});

// ---------------------------------------------------------------------------
// OPT-IN integration test — DISABLED by default. Enabling it invokes the REAL
// brain-remember CLI, which writes a memory file, git-commits it, AND pushes to
// the private remote. Never run in CI or unattended. Flip to `describe.only` and
// point CMD at `uv run --directory ~/src/brain brain-remember` to exercise live.
// ---------------------------------------------------------------------------
describe.skip('brain_remember live integration (opt-in, WRITES + PUSHES)', () => {
  it('writes a real memory via the CLI', async () => {
    const outcome = await runBrainRemember(
      {
        command: ['uv', 'run', '--directory', `${process.env.HOME}/src/brain`, 'brain-remember'],
        cwd: process.cwd(),
        timeoutMs: 30_000,
      },
      { fact: 'juno-ts brain_remember live smoke-test note', type: 'reference', force: true },
    );
    expect(outcome.ok).toBe(true);
  });
});
