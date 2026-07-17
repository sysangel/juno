// tests/shellTool.test.ts
// run_shell tool suite. Deterministic: a FAKE child process (no real `sh` ever
// runs) with scripted stdout/stderr, recorded kill signals, and an injectable
// timer harness so the hard timeout + SIGTERM→SIGKILL escalation are exercised
// without real waits.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ToolCtx } from '../src/core/contracts';
import type { PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import { createPermissionPolicy } from '../src/permissions/policy';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { DEFAULT_SETTINGS } from '../src/services/config';
import { createDefaultTools, BUILTIN_TOOL_SPECS } from '../src/tools/registry';
import {
  createShellTool,
  type ShellChildLike,
  type ShellSpawn,
  type ShellToolDeps,
  type TimerHandle,
} from '../src/tools/shellTool';
import type { SandboxProvider } from '../src/tools/shellSandbox';

// --- fake child process -------------------------------------------------------

interface FakeChildOptions {
  stdout?: string[];
  stderr?: string[];
  /** Emit chunks as Uint8Array instead of string. */
  bytes?: boolean;
  /** Exit code fired via exit/close after streams drain. Default 0. */
  exitCode?: number;
  /** Throw from spawn (ENOENT etc.). */
  spawnThrows?: Error;
  /** Fire the `error` listener (async spawn failure). */
  emitError?: Error;
  /** Never fire exit/close; streams hang until kill() releases them. */
  hangUntilKill?: boolean;
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  stdio: readonly string[];
  env: NodeJS.ProcessEnv;
}

interface FakeChild extends ShellChildLike {
  killSignals: Array<NodeJS.Signals | number | undefined>;
}

function makeSpawn(options: FakeChildOptions): {
  spawn: ShellSpawn;
  calls: SpawnCall[];
  child: () => FakeChild | undefined;
} {
  const calls: SpawnCall[] = [];
  let created: FakeChild | undefined;

  const spawn: ShellSpawn = (command, args, spawnOptions) => {
    calls.push({
      command,
      args: [...args],
      cwd: spawnOptions.cwd,
      stdio: spawnOptions.stdio,
      env: spawnOptions.env,
    });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const encode = (s: string): string | Uint8Array =>
      options.bytes === true ? new TextEncoder().encode(s) : s;

    const makeStream = (chunks: string[] | undefined, fireExit: boolean) =>
      (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.emitError !== undefined) {
          await new Promise<never>(() => {}); // the `error` event settles the run.
          return;
        }
        for (const chunk of chunks ?? []) {
          yield encode(chunk);
        }
        if (options.hangUntilKill === true) {
          await hang; // resolved by kill()
        }
        if (fireExit) {
          const code = options.exitCode ?? 0;
          for (const l of exitListeners) l(code);
          for (const l of closeListeners) l(code);
        }
      })();

    // Only the stdout generator fires exit/close (once), after it completes.
    const child: FakeChild = {
      killSignals: [],
      stdout: makeStream(options.stdout, true),
      stderr: makeStream(options.stderr, false),
      kill(signal?: NodeJS.Signals | number): boolean {
        child.killSignals.push(signal);
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
    created = child;
    return child;
  };

  return { spawn, calls, child: () => created };
}

// --- injectable timer harness (captures every scheduled timer) ----------------

function makeTimers(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }>;
  fire: (index: number) => void;
  pending: () => number;
} {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }> = [];
  return {
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false, fired: false };
      timers.push(entry);
      return { clear: () => (entry.cleared = true) };
    },
    timers,
    fire: (index) => {
      const entry = timers[index];
      if (entry !== undefined && !entry.cleared) {
        entry.fired = true;
        entry.fn();
      }
    },
    /** Timers still armed: neither fired nor cleared. */
    pending: () => timers.filter((t) => !t.cleared && !t.fired).length,
  };
}

// --- ctx ----------------------------------------------------------------------

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

function makeCtx(cwd: string, signal?: AbortSignal): ToolCtx {
  return {
    cwd,
    signal: signal ?? new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    state: fakeState(),
  };
}

const CWD = '/work/project';

function tool(deps: ShellToolDeps) {
  return createShellTool(deps);
}

// --- tests --------------------------------------------------------------------

describe('run_shell — execution', () => {
  it('happy path: sh -c, cwd pinned, stdin closed, captures stdout/stderr + exit 0', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['hello\n'], stderr: ['warn\n'], exitCode: 0 });
    const result = await tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'echo hello' },
      makeCtx(CWD),
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      command: 'echo hello',
      exitCode: 0,
      stdout: 'hello\n',
      stderr: 'warn\n',
      truncated: false,
    });
    // Spawned WITHOUT an interactive/login shell: argv is `sh -c <command>`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('sh');
    expect(calls[0]?.args).toEqual(['-c', 'echo hello']);
    // cwd pinned to the workspace root; stdin closed (ignore).
    expect(calls[0]?.cwd).toBe(CWD);
    expect(calls[0]?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('sanitizes the child env: allowlist + LC_* only, secrets withheld', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['ok'], exitCode: 0 });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/u',
        LC_ALL: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        // Secrets that must NOT leak to the child:
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-openai-secret',
        OPENROUTER_API_KEY: 'sk-or-secret',
        FAKE_SECRET: 'hunter2',
        JUNO_MODEL: 'internal-config',
      },
    }).run({ command: 'env' }, makeCtx(CWD));

    expect(result.ok).toBe(true);
    const env = calls[0]?.env ?? {};
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(env).not.toHaveProperty('FAKE_SECRET');
    expect(env).not.toHaveProperty('JUNO_MODEL');
  });

  it('decodes byte-chunk output', async () => {
    const timers = makeTimers();
    const { spawn } = makeSpawn({ stdout: ['bytes ok'], bytes: true });
    const result = await tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'x' },
      makeCtx(CWD),
    );
    expect((result.data as { stdout: string }).stdout).toBe('bytes ok');
  });

  it('non-zero exit ⇒ ok:false with status + captured output (no throw)', async () => {
    const timers = makeTimers();
    const { spawn } = makeSpawn({ stdout: ['partial'], stderr: ['boom'], exitCode: 2 });
    const result = await tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'false' },
      makeCtx(CWD),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exited with status 2');
    expect(result.error).toContain('boom');
    expect(result.error).toContain('partial');
  });

  it('truncates each stream at the cap with an explicit marker', async () => {
    const timers = makeTimers();
    const big = 'x'.repeat(50);
    const { spawn } = makeSpawn({ stdout: [big], exitCode: 0 });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      maxOutputChars: 10,
    }).run({ command: 'yes' }, makeCtx(CWD));

    expect(result.ok).toBe(true);
    const data = result.data as { stdout: string; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.stdout.startsWith('xxxxxxxxxx')).toBe(true);
    expect(data.stdout).toContain('[output truncated at 10 chars]');
    // The captured body is clipped to the cap (marker is appended separately).
    expect(data.stdout.split('\n')[0]).toHaveLength(10);
  });

  it('timeout ⇒ SIGTERM then SIGKILL escalation, ok:false', async () => {
    const timers = makeTimers();
    const { spawn, child } = makeSpawn({ hangUntilKill: true });
    const promise = tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      timeoutMs: 5000,
      killGraceMs: 2000,
    }).run({ command: 'sleep 999' }, makeCtx(CWD));

    // Fire the hard timeout → SIGTERM + schedule the kill-grace timer.
    timers.fire(0);
    // Fire the grace timer → SIGKILL.
    timers.fire(1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out after 5000ms');
    expect(child()?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('abort mid-run ⇒ kills the child, ok:false aborted', async () => {
    const timers = makeTimers();
    const controller = new AbortController();
    const { spawn, child } = makeSpawn({ hangUntilKill: true });
    const promise = tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'sleep 999' },
      makeCtx(CWD, controller.signal),
    );
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('aborted');
    expect(child()?.killSignals[0]).toBe('SIGTERM');
    // Timer hygiene: the abort path clears the hard timeout and the child's
    // close clears the kill-grace timer — nothing is left armed post-abort.
    expect(timers.pending()).toBe(0);
  });

  it('killChild is idempotent: timeout then abort signals SIGTERM only once', async () => {
    const timers = makeTimers();
    const controller = new AbortController();
    const { spawn, child } = makeSpawn({ hangUntilKill: true });
    const promise = tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'sleep 999' },
      makeCtx(CWD, controller.signal),
    );
    // Hard timeout fires first (kills + settles 'timeout')...
    timers.fire(0);
    // ...then an abort lands: killChild must NOT re-signal or replace the
    // already-armed grace timer.
    controller.abort();

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(child()?.killSignals).toEqual(['SIGTERM']);
    // Exactly one grace timer was ever scheduled (hard + one grace = 2 total),
    // and nothing is left armed once the child closed.
    expect(timers.timers).toHaveLength(2);
    expect(timers.pending()).toBe(0);
  });

  it('already-aborted signal ⇒ never spawns', async () => {
    const controller = new AbortController();
    controller.abort();
    const { spawn, calls } = makeSpawn({ stdout: ['x'] });
    const result = await tool({ spawnImpl: spawn }).run(
      { command: 'echo x' },
      makeCtx(CWD, controller.signal),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('spawn throws ⇒ ok:false, no throw to caller', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const result = await tool({ spawnImpl: spawn }).run({ command: 'nope' }, makeCtx(CWD));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('failed to spawn shell');
  });

  it('error event ⇒ ok:false shell error', async () => {
    const timers = makeTimers();
    const { spawn } = makeSpawn({ emitError: new Error('spawn EACCES') });
    const result = await tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'x' },
      makeCtx(CWD),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('shell error');
  });

  it('rejects invalid args (missing/blank command)', async () => {
    const shell = tool({ spawnImpl: makeSpawn({}).spawn });
    expect((await shell.run({}, makeCtx(CWD))).error).toBe('invalid args');
    expect((await shell.run({ command: '   ' }, makeCtx(CWD))).error).toBe('invalid args');
    expect((await shell.run(null, makeCtx(CWD))).error).toBe('invalid args');
  });
});

describe('run_shell — permission classification', () => {
  it('is risk:dangerous and PROMPTS in default AND acceptEdits mode', () => {
    const shell = tool({});
    expect(shell.risk).toBe('dangerous');

    const args = { command: 'rm -rf /' };
    const def = createPermissionPolicy({ mode: 'default' });
    expect(def.evaluate('run_shell', args, shell.risk)).toBe('prompt');

    // acceptEdits auto-allows write_file/edit_file by NAME only — run_shell still prompts.
    const accept = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(accept.evaluate('run_shell', args, shell.risk)).toBe('prompt');
  });

  it('is never auto-allowed by risk alone, but an explicit bypass pre-grants it', () => {
    const auto = createPermissionPolicy({ autoAllowSafe: true });
    expect(auto.evaluate('run_shell', { command: 'x' }, 'dangerous')).toBe('prompt');

    const bypassed = createPermissionPolicy({ initial: [{ pattern: 'run_shell', decision: 'dangerous-bypass' }] });
    expect(bypassed.evaluate('run_shell', { command: 'x' }, 'dangerous')).toBe('auto-allow');
  });

  it('NEGATIVE: an always-allow-pattern NEVER satisfies run_shell (structural guard)', () => {
    // The exact blanket-grant hazard: a bare-name always-allow rule remembered
    // for run_shell (the UI would store `run_shell` → `run_shell:*`, and the
    // match key carries no command, so it matches EVERY call). The policy must
    // still prompt — always-allow-pattern is refused for dangerous risk.
    const bareName = createPermissionPolicy({
      initial: [{ pattern: 'run_shell', decision: 'always-allow-pattern' }],
    });
    expect(bareName.evaluate('run_shell', { command: 'rm -rf /' }, 'dangerous')).toBe('prompt');

    // Explicit wildcard variant of the same rule — same refusal.
    const wildcard = createPermissionPolicy({ allow: ['run_shell:*'] });
    expect(wildcard.evaluate('run_shell', { command: 'ls' }, 'dangerous')).toBe('prompt');

    // An always-allow remembered for ANOTHER tool obviously doesn't leak either.
    const otherTool = createPermissionPolicy({
      initial: [{ pattern: 'write_file', decision: 'always-allow-pattern' }],
    });
    expect(otherTool.evaluate('run_shell', { command: 'ls' }, 'dangerous')).toBe('prompt');

    // Non-dangerous tools are unaffected by the guard: always-allow still works.
    const writeAllowed = createPermissionPolicy({
      initial: [{ pattern: 'write_file', decision: 'always-allow-pattern' }],
    });
    expect(writeAllowed.evaluate('write_file', { path: 'a.ts' }, 'risky')).toBe('auto-allow');
  });

  it('NEGATIVE: approving one command does not pre-grant a different command', () => {
    const policy = createPermissionPolicy();
    expect(policy.evaluate('run_shell', { command: 'ls' }, 'dangerous')).toBe('prompt');

    // The user answers [y] (allow-once) — the streaming hook calls remember(),
    // which must NOT persist a rule for allow-once.
    policy.remember('run_shell', 'allow-once');

    // A different command still prompts…
    expect(policy.evaluate('run_shell', { command: 'rm -rf /' }, 'dangerous')).toBe('prompt');
    // …and so does the SAME command again (allow-once is strictly one-shot).
    expect(policy.evaluate('run_shell', { command: 'ls' }, 'dangerous')).toBe('prompt');
  });

  it('deny rules still beat a dangerous-bypass for run_shell', () => {
    const policy = createPermissionPolicy({
      initial: [
        { pattern: 'run_shell', decision: 'dangerous-bypass' },
        { pattern: 'run_shell', decision: 'deny' },
      ],
    });
    expect(policy.evaluate('run_shell', { command: 'ls' }, 'dangerous')).toBe('auto-deny');
  });
});

// --- OS sandbox (macOS Seatbelt) ----------------------------------------------

/** A fake SandboxProvider. When available + wraps, its buildWrappedArgv reflects
 * the inputs so the spawn call can be asserted; a `failBuild` provider returns
 * undefined (the SBPL-injection / unbuildable case that must fail closed). */
function fakeSandbox(opts: {
  available: boolean;
  failBuild?: boolean;
  seenCwd?: (cwd: string) => void;
}): SandboxProvider {
  return {
    available: opts.available,
    buildWrappedArgv: (canonicalCwd, shell, command) => {
      opts.seenCwd?.(canonicalCwd);
      if (opts.failBuild === true) {
        return undefined;
      }
      return { command: 'sandbox-exec', args: ['-p', 'PROFILE', shell, '-c', command] };
    },
  };
}

const identityRealpath = async (p: string): Promise<string> => p;

describe('run_shell — OS sandbox confinement + fail-closed', () => {
  it('(a) sandbox available ⇒ spawns sandbox-exec with the wrapped argv, NOT bare sh', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['ok'], exitCode: 0 });
    let seen: string | undefined;
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: identityRealpath,
      sandbox: fakeSandbox({ available: true, seenCwd: (c) => (seen = c) }),
    }).run({ command: 'echo hi' }, makeCtx(CWD));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('sandbox-exec');
    expect(calls[0]?.args).toEqual(['-p', 'PROFILE', 'sh', '-c', 'echo hi']);
    // The child still runs with cwd pinned to the workspace root.
    expect(calls[0]?.cwd).toBe(CWD);
    // cwd was canonicalized before being handed to the profile builder.
    expect(seen).toBe(CWD);
  });

  it('(b) sandbox unavailable ⇒ the bare `sh -c` path is byte-for-byte unchanged', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['ok'], exitCode: 0 });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: identityRealpath,
      sandbox: fakeSandbox({ available: false }),
    }).run({ command: 'echo hi' }, makeCtx(CWD));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('sh');
    expect(calls[0]?.args).toEqual(['-c', 'echo hi']);
    expect(calls[0]?.cwd).toBe(CWD);
  });

  it('(c) available but profile UNBUILDABLE ⇒ fails closed, NEVER spawns', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['ok'], exitCode: 0 });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: identityRealpath,
      sandbox: fakeSandbox({ available: true, failBuild: true }),
    }).run({ command: 'echo hi' }, makeCtx(CWD));

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('refusing to run unsandboxed');
    // THE invariant: an auto-allowed-but-unwrappable command spawns NOTHING.
    expect(calls).toHaveLength(0);
  });

  it('(c2) cwd cannot be canonicalized ⇒ fails closed, NEVER spawns', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ stdout: ['ok'], exitCode: 0 });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: async () => {
        throw new Error('ENOENT: no such directory');
      },
      sandbox: fakeSandbox({ available: true }),
    }).run({ command: 'echo hi' }, makeCtx(CWD));

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('refusing to run unsandboxed');
    expect(calls).toHaveLength(0);
  });

  it('(d) sandbox-exec vanished (ENOENT at spawn) ⇒ error, NO bare-sh fallback', async () => {
    const timers = makeTimers();
    const { spawn, calls } = makeSpawn({ emitError: new Error('spawn sandbox-exec ENOENT') });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: identityRealpath,
      sandbox: fakeSandbox({ available: true }),
    }).run({ command: 'echo hi' }, makeCtx(CWD));

    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('shell error');
    // Exactly ONE spawn attempt — sandbox-exec — and no bare `sh` retry.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('sandbox-exec');
  });

  it('(f) sandboxed + non-zero exit ⇒ error carries a sandbox-active hint', async () => {
    const timers = makeTimers();
    // A denied write surfaces as EPERM 'Operation not permitted' on stderr.
    const { spawn } = makeSpawn({
      stderr: ['touch: /etc/x: Operation not permitted\n'],
      exitCode: 1,
    });
    const result = await tool({
      spawnImpl: spawn,
      setTimer: timers.setTimer,
      realpath: identityRealpath,
      sandbox: fakeSandbox({ available: true }),
    }).run({ command: 'touch /etc/x' }, makeCtx(CWD));

    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('exited with status 1');
    // The confinement hint is appended, and the EPERM signature makes it pointed.
    expect(error).toContain('run_shell is OS-sandboxed');
    expect(error).toContain('most likely a sandbox denial');
  });

  it('(f2) UNSANDBOXED + non-zero exit ⇒ NO sandbox hint (byte-for-byte legacy error)', async () => {
    const timers = makeTimers();
    const { spawn } = makeSpawn({ stderr: ['boom'], exitCode: 2 });
    const result = await tool({ spawnImpl: spawn, setTimer: timers.setTimer }).run(
      { command: 'false' },
      makeCtx(CWD),
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain('OS-sandboxed');
  });

  it('(e) risk is single-sourced from sandbox availability', () => {
    // Available ⇒ 'sandboxed' (auto-allow); unavailable OR absent ⇒ 'dangerous'.
    expect(tool({ sandbox: fakeSandbox({ available: true }) }).risk).toBe('sandboxed');
    // Fail-closed: flag on but host cannot enforce ⇒ still dangerous (prompts).
    expect(tool({ sandbox: fakeSandbox({ available: false }) }).risk).toBe('dangerous');
    // No provider (the default, incl. BUILTIN_TOOL_SPECS / fixtures) ⇒ dangerous.
    expect(tool({}).risk).toBe('dangerous');
  });

  it('(e2) sandboxed risk auto-allows; unavailable keeps prompting (policy coupling)', () => {
    const policy = createPermissionPolicy({ autoAllowSafe: true });
    const args = { command: 'npm test' };

    const confined = tool({ sandbox: fakeSandbox({ available: true }) });
    expect(policy.evaluate('run_shell', args, confined.risk)).toBe('auto-allow');

    const bare = tool({ sandbox: fakeSandbox({ available: false }) });
    expect(policy.evaluate('run_shell', args, bare.risk)).toBe('prompt');
  });

  it('(e3) createDefaultTools wiring: available ⇒ sandboxed, unavailable ⇒ dangerous/prompt', () => {
    const confined = createDefaultTools({ shell: { sandbox: fakeSandbox({ available: true }) } }).find(
      (t) => t.name === 'run_shell',
    );
    expect(confined?.risk).toBe('sandboxed');

    // Fail-closed integration: flag on but sandbox unavailable ⇒ run_shell still prompts.
    const failClosed = createDefaultTools({ shell: { sandbox: fakeSandbox({ available: false }) } }).find(
      (t) => t.name === 'run_shell',
    );
    expect(failClosed?.risk).toBe('dangerous');
    const policy = createPermissionPolicy();
    expect(policy.evaluate('run_shell', { command: 'ls' }, failClosed?.risk ?? 'dangerous')).toBe(
      'prompt',
    );

    // No sandbox ⇒ BUILTIN_TOOL_SPECS / fixtures unaffected (dangerous).
    const plain = createDefaultTools({ shell: {} }).find((t) => t.name === 'run_shell');
    expect(plain?.risk).toBe('dangerous');
  });
});

describe('run_shell — registry wiring', () => {
  it('is registered only when the shell opt is supplied', () => {
    expect(createDefaultTools().some((t) => t.name === 'run_shell')).toBe(false);
    expect(BUILTIN_TOOL_SPECS.some((s) => s.name === 'run_shell')).toBe(false);
    expect(createDefaultTools({ shell: {} }).some((t) => t.name === 'run_shell')).toBe(true);
  });

  it('is a parent-only tool: pushed AFTER spawn_subagent (out of the childTools snapshot)', () => {
    // The subagent tool is built from the tools assembled BEFORE it; run_shell is
    // pushed AFTER, so a subagent never inherits it. Assert that ordering.
    const subagentDeps = {
      createClient: (): ModelClient => ({
        async *streamTurn() {
          /* unused in registry wiring */
        },
      }),
      catalog: createModelCatalog(BUILTIN_MODELS),
      policy: createPermissionPolicy({ autoAllowSafe: true }),
      defaultModel: DEFAULT_SETTINGS.defaultModel,
    };
    const names = createDefaultTools({ subagent: subagentDeps, shell: {} }).map((t) => t.name);
    expect(names).toContain('spawn_subagent');
    expect(names).toContain('run_shell');
    expect(names.indexOf('run_shell')).toBeGreaterThan(names.indexOf('spawn_subagent'));
  });
});
