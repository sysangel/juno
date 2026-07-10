import { readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createModelCatalog } from '../src/services/catalog';
import { createModelClient } from '../src/providers/index';
import {
  createCodexCliClient,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/providers/codexCliClient';

// ---------------------------------------------------------------------------
// Test scaffolding: a deterministic FAKE child process replaying committed
// `codex exec --json` NDJSON fixtures. No real `codex` ever runs (the GATE
// forbids live subprocess calls) — except the ONE real-child error-path test at
// the bottom, following the tests/claudeCliClient.test.ts precedent (fakes gave
// false confidence twice on the stderr/exit-race paths).
// ---------------------------------------------------------------------------

const codexEntry: ModelEntry = {
  id: 'gpt-5.6-sol',
  provider: 'codex-cli',
  label: 'GPT-5.6 Sol (subscription)',
  contextWindow: 372_000,
};

const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'hello' }],
};

const noTools: ToolSpec[] = [];

/** Load a committed NDJSON fixture as its non-empty lines (the test corpus). */
function fixtureLines(name: string): string[] {
  const raw = readFileSync(new URL(`./fixtures/codex/${name}.ndjson`, import.meta.url), 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface FakeChildOptions {
  /** NDJSON lines (without trailing newline) to emit on stdout, in order. */
  lines: string[];
  /** Exit code reported via the `exit` listener after stdout drains. */
  exitCode?: number;
  /** When set, throw from spawn to simulate a spawn failure (missing binary). */
  spawnThrows?: Error;
  /** When true, the stdout iterator pauses until aborted after the lines (abort). */
  hangAfterLines?: boolean;
  /** When true, the stdout iterator hangs FOREVER after the lines (stall timers). */
  hangForever?: boolean;
  /** stderr emitted eagerly as a `'data'` chunk on a microtask (flowing pipe). */
  stderr?: string;
}

interface FakeChild extends ChildProcessLike {
  killed: boolean;
  killCount: number;
  stderrDestroyed: boolean;
  unrefCount: number;
}

function makeSpawn(
  options: FakeChildOptions,
  calls: SpawnCall[] = [],
  signal?: AbortSignal,
): { spawn: SpawnImpl; child: () => FakeChild | undefined } {
  let created: FakeChild | undefined;

  const spawn: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd, env: spawnOptions.env });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null) => void> = [];

    const child: FakeChild = {
      killed: false,
      killCount: 0,
      stderrDestroyed: false,
      unrefCount: 0,
      stdout: (async function* (): AsyncIterable<string> {
        for (const line of options.lines) {
          yield `${line}\n`;
        }
        if (options.hangForever === true) {
          await new Promise<never>(() => {});
          return;
        }
        if (options.hangAfterLines === true) {
          await new Promise<void>((resolve) => {
            if (signal !== undefined) {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener('abort', () => resolve(), { once: true });
            }
          });
          return;
        }
        const code = options.exitCode ?? 0;
        for (const listener of exitListeners) {
          listener(code);
        }
      })(),
      stderr: {
        on(event: 'data' | 'error', listener: (arg: never) => void): unknown {
          if (event === 'data' && options.stderr !== undefined) {
            const emit = listener as unknown as (chunk: string) => void;
            queueMicrotask(() => emit(options.stderr as string));
          }
          return undefined;
        },
        destroy(): void {
          child.stderrDestroyed = true;
        },
      },
      kill(): boolean {
        this.killed = true;
        this.killCount += 1;
        return true;
      },
      unref(): void {
        this.unrefCount += 1;
      },
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'exit' || event === 'close') {
          exitListeners.push(listener as (code: number | null) => void);
        }
        return this;
      },
    };

    created = child;
    return child;
  };

  return { spawn, child: () => created };
}

async function drain(
  client: ModelClient,
  input: TurnInput,
  tools: ToolSpec[],
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of client.streamTurn(input, tools, signal)) {
    events.push(event);
  }
  return events;
}

// Deterministic fake clock for the stall-timeout test (records callbacks instead
// of arming real timers; the test fires one by predicate).
interface FakeTimer {
  ms: number;
  fn: () => void;
  cleared: boolean;
}
function makeClock(): {
  setTimer: (fn: () => void, ms: number) => { clear: () => void };
  timers: FakeTimer[];
  fire: (pred: (t: FakeTimer) => boolean) => void;
  pending: () => FakeTimer[];
} {
  const timers: FakeTimer[] = [];
  const setTimer = (fn: () => void, ms: number): { clear: () => void } => {
    const t: FakeTimer = { ms, fn, cleared: false };
    timers.push(t);
    return { clear: (): void => void (t.cleared = true) };
  };
  return {
    setTimer,
    timers,
    fire(pred: (t: FakeTimer) => boolean): void {
      const t = timers.find((x) => !x.cleared && pred(x));
      if (t !== undefined) {
        t.cleared = true;
        t.fn();
      }
    },
    pending(): FakeTimer[] {
      return timers.filter((t) => !t.cleared);
    },
  };
}

/** Park the streamTurn generator on the hung race before firing the fake clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------

describe('codexCliClient — spawn + arg surface', () => {
  it('spawns `codex exec --json` against the 0.144.x flag surface with the prompt last', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools);

    expect(calls).toHaveLength(1);
    const { command, args } = calls[0]!;
    expect(command).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    // model
    const mIdx = args.indexOf('-m');
    expect(args[mIdx + 1]).toBe('gpt-5.6-sol');
    // no interactive approval (the removed --ask-for-approval intent) + subscription auth
    expect(args).toContain('approval_policy=never');
    expect(args).toContain('preferred_auth_method=chatgpt');
    // 0.143 flag must NOT be used
    expect(args).not.toContain('--ask-for-approval');
    // prompt is the trailing positional
    expect(args.at(-1)).toContain('User:');
    expect(args.at(-1)).toContain('hello');
  });

  it('input.model overrides entry.id in -m', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('gpt55-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, model: 'gpt-5.5' }, noTools);

    const args = calls[0]!.args;
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
  });

  it('default permission mode → --sandbox read-only, no --cd unless a cwd is set', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools); // no cwd

    const args = calls[0]!.args;
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).not.toContain('--cd');
  });

  it('acceptEdits mode → --sandbox workspace-write with --cd pinned to the jail root', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail', permissionMode: 'acceptEdits' }, noTools);

    const args = calls[0]!.args;
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args[args.indexOf('--cd') + 1]).toBe('/work/jail');
    // NEVER danger-full-access.
    expect(args).not.toContain('danger-full-access');
  });

  it('pins the child cwd to input.cwd and sets stdin to ignore + windowsHide', async () => {
    let seen: { stdio: unknown; windowsHide: boolean; cwd?: string } | undefined;
    const spawn: SpawnImpl = (_command, _args, options) => {
      seen = { stdio: options.stdio, windowsHide: options.windowsHide, cwd: options.cwd };
      return {
        stdout: (async function* () {
          for (const line of fixtureLines('sol-text')) yield `${line}\n`;
        })(),
        stderr: { on: () => undefined },
        kill: () => true,
        on(): ChildProcessLike {
          return this as unknown as ChildProcessLike;
        },
      } as ChildProcessLike;
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools);

    expect(seen?.cwd).toBe('/work/jail');
    expect(seen?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(seen?.windowsHide).toBe(true);
  });
});

describe('codexCliClient — auth safety (OPENAI_API_KEY scrub)', () => {
  it('strips OPENAI_API_KEY from the spawned child env, keeping the rest', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      env: { OPENAI_API_KEY: 'sk-should-be-removed', HOME: '/home/aiden', PATH: '/usr/bin' },
    });

    await drain(client, baseInput, noTools);

    const env = calls[0]!.env!;
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect('OPENAI_API_KEY' in env).toBe(false);
    // Non-secret env is preserved so codex can still find its home + PATH.
    expect(env.HOME).toBe('/home/aiden');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the caller-provided env object', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-live' };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, env });

    await drain(client, baseInput, noTools);

    expect(env.OPENAI_API_KEY).toBe('sk-live'); // caller's copy untouched
  });
});

describe('codexCliClient — text turns (item-granular translation)', () => {
  for (const fixture of ['sol-text', 'gpt55-text', 'mini-text', 'reasoning-terra'] as const) {
    it(`${fixture}: one agent_message renders as a single text-delta + usage + assistant-done(end)`, async () => {
      const { spawn } = makeSpawn({ lines: fixtureLines(fixture) });
      const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

      const events = await drain(client, baseInput, noTools);

      expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
      const texts = events.filter((e) => e.type === 'text-delta');
      expect(texts).toHaveLength(1);
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
      // This transport has NO reasoning deltas even for reasoning-terra.
      expect(events.some((e) => e.type === 'reasoning-delta')).toBe(false);
    });
  }

  it('sol-text: token usage maps input_tokens (incl. cache) → contextTokens, cache-excluded → tokensIn', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const usage = events.find((e) => e.type === 'usage');
    // sol-text usage: input 12181, cached 9984, output 7.
    expect(usage).toEqual({ type: 'usage', tokensIn: 12181 - 9984, tokensOut: 7, contextTokens: 12181 });
  });
});

describe('codexCliClient — tool-using turn (sol-patch)', () => {
  it('renders command_execution + file_change as tool cards and collapses the stop reason to end', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-patch') });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    // file_change item_1 → apply_patch card, running then result summary (add <path>).
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', toolCallId: 'item_1', name: 'apply_patch' }),
    );
    const fileResult = events.find(
      (e) => e.type === 'tool-status' && e.toolCallId === 'item_1' && e.status === 'result',
    );
    expect(fileResult).toBeDefined();
    expect((fileResult as { result: string }).result).toContain('add ');
    expect((fileResult as { result: string }).result).toContain('hello.txt');

    // command_execution item_2 → shell card carrying the actual command, exit 0 → result.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'item_2',
        name: 'shell',
        args: { command: "/bin/zsh -lc 'od -An -t x1 hello.txt'" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-status', toolCallId: 'item_2', status: 'running' }),
    );
    const cmdResult = events.find(
      (e) => e.type === 'tool-status' && e.toolCallId === 'item_2' && e.status === 'result',
    );
    expect(cmdResult).toBeDefined();

    // Preamble + final agent_message both render.
    const texts = events.filter((e) => e.type === 'text-delta');
    expect(texts).toHaveLength(2);

    // RENDER-ONLY collapse: a turn full of tool items still ends 'end', NOT 'tool_use'
    // (which would make turnRunner re-execute + re-spawn codex forever).
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(events.some((e) => e.type === 'assistant-done' && e.stopReason === 'tool_use')).toBe(false);
  });

  it('a non-zero command_execution exit finalizes its card as a tool-status error', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_0', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: null, status: 'in_progress' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', command: 'false', aggregated_output: 'boom on stderr', exit_code: 3, status: 'completed' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ];
    const { spawn } = makeSpawn({ lines });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const errStatus = events.find((e) => e.type === 'tool-status' && e.toolCallId === 'item_0' && e.status === 'error');
    expect(errStatus).toBeDefined();
    expect((errStatus as { error: string }).error).toContain('boom on stderr');
    // The overall turn still SUCCEEDS (a failed shell command is not a turn failure).
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('codexCliClient — error-model turn (turn.failed)', () => {
  it('surfaces the decoded turn.failed reason exactly once and ends in error', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('error-model'), exitCode: 1 });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, { ...baseInput, model: 'no-such-model' }, noTools);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    // The JSON-encoded error message is decoded to its innermost human reason.
    expect((errors[0] as { message: string }).message).toContain(
      'not supported when using Codex with a ChatGPT account',
    );
    // The non-terminal item-level warning ("Model metadata … not found") is DROPPED,
    // not surfaced as a second error.
    expect((errors[0] as { message: string }).message).not.toContain('Model metadata');
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});

describe('codexCliClient — failure & lifecycle paths', () => {
  it('a spawn failure (missing binary) yields error + assistant-done(error), no assistant-start', async () => {
    const { spawn } = makeSpawn({ lines: [], spawnThrows: new Error('ENOENT: codex not found') });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((e) => e.type === 'assistant-start')).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('a startup error that emits NO NDJSON (exit 1) surfaces the stderr tail via the exit-race path', async () => {
    // codex "Not inside a trusted directory" prints to stderr and exits 1 with no
    // NDJSON. stdout closes with no terminal turn event → the bounded exit-wait +
    // eager stderr tail must still produce a real error card (not a clean 'end').
    const { spawn } = makeSpawn({ lines: [], exitCode: 1, stderr: 'Not inside a trusted directory\n' });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('code 1');
    expect((errors[0] as { message: string }).message).toContain('Not inside a trusted directory');
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('an idle stall reaps the hung child and surfaces an error (pump/guards lifted)', async () => {
    const clock = makeClock();
    const { spawn, child } = makeSpawn({ lines: fixtureLines('sol-text').slice(0, 2), hangForever: true });
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 50,
      staleStreamMs: 90,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools);
    await flush();
    clock.fire((t) => t.ms === 50); // fire the idle guard
    const events = await eventsPromise;

    expect(child()?.killed).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    expect(clock.pending()).toHaveLength(0); // guards cleared on the stall exit path
  });
});

describe('codexCliClient — abort handling', () => {
  it('returns only {aborted} for a pre-aborted signal and never spawns', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const controller = new AbortController();
    controller.abort();

    const events = await drain(client, baseInput, noTools, controller.signal);

    expect(events).toEqual([{ type: 'aborted' }]);
    expect(calls).toHaveLength(0);
  });

  it('mid-stream abort kills the child, yields {aborted}, and never emits assistant-done', async () => {
    const controller = new AbortController();
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'partial' } }),
    ];
    const { spawn, child } = makeSpawn({ lines, hangAfterLines: true }, [], controller.signal);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events: AgentEvent[] = [];
    for await (const event of client.streamTurn(baseInput, noTools, controller.signal)) {
      events.push(event);
      if (event.type === 'text-delta') {
        controller.abort();
      }
    }

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'aborted' });
    expect(child()?.killed).toBe(true);
    expect(events.some((e) => e.type === 'assistant-done')).toBe(false);
  });

  it('mid-stream abort releases the child stderr read-end and unrefs the child', async () => {
    const controller = new AbortController();
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'partial' } }),
    ];
    const { spawn, child } = makeSpawn({ lines, hangAfterLines: true }, [], controller.signal);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    for await (const event of client.streamTurn(baseInput, noTools, controller.signal)) {
      if (event.type === 'text-delta') {
        controller.abort();
      }
    }

    expect(child()?.stderrDestroyed).toBe(true);
    expect((child()?.unrefCount ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('codexCliClient — REAL child error path (production pipe shape)', () => {
  // Fakes gave false confidence twice on the stderr/exit-race paths in prior waves —
  // this spawns an ACTUAL subprocess through the real spawn impl so real pipes +
  // Node's real flushStdio are exercised (the eager stderr tail must beat flushStdio).
  it.skipIf(process.platform === 'win32')(
    'a failing subprocess surfaces its actual stderr tail in the error message',
    async () => {
      const realSpawn: SpawnImpl = () =>
        nodeSpawn('sh', ['-c', 'printf boom 1>&2; exit 1'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as ChildProcessLike;
      const client = createCodexCliClient(codexEntry, { spawnImpl: realSpawn });

      const events = await drain(client, baseInput, noTools);

      const errors = events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect((errors[0] as { message: string }).message).toContain('boom');
      expect((errors[0] as { message: string }).message).toContain('code 1');
      expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    },
    5000,
  );
});

describe('codexCliClient — catalog + provider registration', () => {
  it('createModelClient builds a codex-cli client that streams a real fixture turn', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') });
    const client = createModelClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('the built-in catalog registers all three codex-cli entries with subscription (no pricing) shape', () => {
    const catalog = createModelCatalog();

    const sol = catalog.resolve('gpt-5.6-sol');
    expect(sol).toMatchObject({ provider: 'codex-cli', label: 'GPT-5.6 Sol (subscription)', contextWindow: 372_000 });
    expect(sol?.pricing).toBeUndefined();
    // aliases resolve
    expect(catalog.resolve('sol')?.id).toBe('gpt-5.6-sol');
    expect(catalog.resolve('gpt-5.6')?.id).toBe('gpt-5.6-sol');

    expect(catalog.resolve('gpt-5.5')).toMatchObject({ provider: 'codex-cli', contextWindow: 272_000 });
    expect(catalog.resolve('gpt-5.4-mini')).toMatchObject({ provider: 'codex-cli', contextWindow: 272_000 });

    const codexEntries = catalog.byProvider('codex-cli');
    expect(codexEntries.map((e) => e.id).sort()).toEqual(['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-sol']);
    // Subscription backends carry NO pricing chip.
    expect(codexEntries.every((e) => e.pricing === undefined)).toBe(true);
  });
});
