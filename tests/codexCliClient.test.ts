import { readFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createModelCatalog } from '../src/services/catalog';
import { createModelClient } from '../src/providers/index';
import {
  buildPromptTail,
  CODEX_NDJSON_LINE_MAX_CHARS,
  codexToolArgs,
  createCodexCliClient,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/providers/codexCliClient';
import { eventToAction } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import type { McpServerConfig } from '../src/services/config';
import { initialState, reducer, type State } from '../src/core/reducer';
import { selectSubagents } from '../src/core/selectors';

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
): {
  spawn: SpawnImpl;
  child: () => FakeChild | undefined;
  /** Fire the created child's exit/close listeners (a dead child holding stdout open). */
  fireExit: (code: number | null, exitSignal?: NodeJS.Signals | null) => void;
} {
  let created: FakeChild | undefined;
  // Mirror of the latest spawn's exit listeners so `fireExit` can drive the child's
  // `exit` event independently of stdout — the held-open-stdout dead-child case.
  let latestExitListeners: Array<(code: number | null, exitSignal?: NodeJS.Signals | null) => void> = [];

  const spawn: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd, env: spawnOptions.env });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null, exitSignal?: NodeJS.Signals | null) => void> = [];
    latestExitListeners = exitListeners;

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
          exitListeners.push(listener as (code: number | null, exitSignal?: NodeJS.Signals | null) => void);
        }
        return this;
      },
    };

    created = child;
    return child;
  };

  return {
    spawn,
    child: () => created,
    fireExit: (code: number | null, exitSignal?: NodeJS.Signals | null): void => {
      for (const listener of latestExitListeners) {
        listener(code, exitSignal);
      }
    },
  };
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

  it('threads the tools arg through the codexToolArgs seam without altering argv (prompt stays last)', async () => {
    // The `tools` arg is no longer discarded — it flows through codexToolArgs.
    // That seam is wired but produces no flags yet (codex tool-offering is a
    // documented MCP-server detour), so argv is unchanged and the prompt is last.
    expect(codexToolArgs([{ name: 'spawn_subagent', description: 'x', inputSchema: {} }])).toEqual([]);

    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      { name: 'spawn_subagent', description: 'delegate', inputSchema: {} },
    ]);

    const { args } = calls[0]!;
    expect(args.at(-1)).toContain('User:');
    expect(args).not.toContain('spawn_subagent');
    expect(args).not.toContain('--mcp');
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

  it('disables Codex native multi-agent tools when Juno owns the orchestration plane', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      disableNativeMultiAgent: true,
    });

    await drain(client, baseInput, noTools);

    expect(calls[0]?.args).toContain('--disable');
    expect(calls[0]?.args).toContain('multi_agent');
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

  it('sol-text: aggregate turn usage is spend-only and never masquerades as live context occupancy', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const usage = events.find((e) => e.type === 'usage');
    // sol-text usage: input 12181, cached 9984, output 7.
    expect(usage).toEqual({ type: 'usage', tokensIn: 12181 - 9984, tokensOut: 7 });
  });

  it('tool-heavy aggregate input may exceed a live prompt without emitting contextTokens', async () => {
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-patch') });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const usage = (await drain(client, baseInput, noTools)).find((event) => event.type === 'usage');

    expect(usage).toEqual({ type: 'usage', tokensIn: 51538 - 44032, tokensOut: 609 });
    expect(usage).not.toHaveProperty('contextTokens');
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
    expect(errStatus).toMatchObject({ termination: { kind: 'exit', exitCode: 3 } });
    // The overall turn still SUCCEEDS (a failed shell command is not a turn failure).
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('codexCliClient — native Codex collaboration visibility', () => {
  it('renders native spawns, keeps launch completion active, and settles from wait evidence', async () => {
    const childId = '019f8730-child';
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-parent' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_spawn', type: 'collab_tool_call', tool: 'spawn_agent',
          sender_thread_id: 'thread-parent', receiver_thread_ids: [],
          prompt: 'Inspect rendering independently', agents_states: {}, status: 'in_progress',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_spawn', type: 'collab_tool_call', tool: 'spawn_agent',
          sender_thread_id: 'thread-parent', receiver_thread_ids: [childId],
          prompt: 'Inspect rendering independently',
          agents_states: { [childId]: { status: 'running', message: null } },
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_1', type: 'agent_message', text: 'The reviewer is running.' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_wait', type: 'collab_tool_call', tool: 'wait',
          sender_thread_id: 'thread-parent', receiver_thread_ids: [childId],
          prompt: null,
          agents_states: { [childId]: { status: 'running', message: null } },
          status: 'in_progress',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_wait', type: 'collab_tool_call', tool: 'wait',
          sender_thread_id: 'thread-parent', receiver_thread_ids: [childId],
          prompt: null,
          agents_states: { [childId]: { status: 'completed', message: 'No rendering defects found.' } },
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'msg_2', type: 'agent_message', text: 'Confirmed by the reviewer.' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
      }),
    ];
    const { spawn } = makeSpawn({ lines });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call', toolCallId: 'item_spawn', name: 'spawn_agent',
      args: { task: 'Inspect rendering independently' },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call', toolCallId: 'item_wait', name: 'wait_agent',
    }));

    const state = events.reduce<State>((current, event) =>
      reducer(current, eventToAction(event)), initialState());
    expect(state.tools.item_spawn).toMatchObject({
      status: 'result',
      result: {
        status: 'completed', taskId: childId,
        summary: 'No rendering defects found.', provider: 'codex-cli',
      },
    });
    expect(selectSubagents(state)).toEqual([
      expect.objectContaining({
        id: 'item_spawn', name: 'spawn_agent',
        description: 'Inspect rendering independently', status: 'done',
      }),
    ]);
    const assistant = state.committed.find((message) => message.role === 'assistant');
    expect(assistant?.delegationReceipt?.entries).toEqual([
      expect.objectContaining({ toolCallId: 'item_spawn', status: 'completed' }),
    ]);
  });
});

describe('codexCliClient — bounded JSONL records', () => {
  it('stops and reaps a child whose single record exceeds the memory ceiling', async () => {
    const { spawn, child } = makeSpawn({
      lines: ['x'.repeat(CODEX_NDJSON_LINE_MAX_CHARS + 1)],
    });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('output record exceeded'),
    }));
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    expect(child()?.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LANE F — agent_message double-render dedup. Some codex runtimes emit the
// assistant message as TWO `item.completed` events with the SAME item id (a
// streaming-preview completion followed by the final one). Without an id guard
// both reach the reducer's text-delta concat and the answer commits twice. The
// tool-item path was already guarded (emittedToolCall); agent_message was not.
// ---------------------------------------------------------------------------
describe('codexCliClient — agent_message dedup (double-render guard)', () => {
  /** Reduce a drained event stream to committed State (mirrors the coordinator). */
  const commit = (events: readonly AgentEvent[]): State =>
    events.reduce<State>((s, e) => reducer(s, eventToAction(e)), initialState());
  /** Concatenated text of every text block of the last committed assistant msg. */
  const committedText = (state: State): string => {
    const msg = [...state.committed].reverse().find((m) => m.role === 'assistant');
    return (msg?.blocks ?? [])
      .filter((b): b is Extract<typeof b, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join('');
  };

  it('a duplicate item.completed for the SAME agent_message id emits the text-delta ONCE', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      // Preview completion, then the final completion for the SAME id — the codex
      // streaming lifecycle that triggers the double render in the wild.
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'the answer' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'the answer' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ];
    const { spawn } = makeSpawn({ lines });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const texts = events.filter((e) => e.type === 'text-delta');
    expect(texts).toHaveLength(1);
    // End-to-end: the committed transcript holds the answer exactly once, NOT the
    // doubled 'the answerthe answer' the reducer concat would produce from two deltas.
    expect(committedText(commit(events))).toBe('the answer');
  });

  it('DISTINCT agent_message ids each emit — a legitimate multi-message turn is preserved', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first. ' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'second.' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    ];
    const { spawn } = makeSpawn({ lines });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    const texts = events.filter((e) => e.type === 'text-delta');
    expect(texts).toHaveLength(2);
    // Distinct atomic messages are distinct paragraphs, never `first.second`.
    expect(committedText(commit(events))).toBe('first. \n\nsecond.');
  });

  // RESUME PATH conclusion (task step 2), determined by reading the resume code +
  // fixtures rather than guessing:
  //   * `codex exec resume <id>` only re-emits `thread.started` with the SAME id
  //     (codexCliClient.ts, thread.started comment) and then streams the NEW turn's
  //     items — it does NOT replay the prior turn's committed agent_message into the
  //     resumed stream (no fixture models a replay; buildPromptTail also drops prior
  //     assistant messages, so nothing feeds codex its own words back).
  //   * Each turn runs its own spawn with a FRESH per-turn `emittedMessage` set and a
  //     fresh `input.id`, and item ids reset to `item_0` per turn.
  // Therefore the same-id dedup above fully covers the real trigger (a duplicate
  // completion WITHIN a turn); no cross-turn watermark is warranted — and a cross-turn
  // item-id watermark would in fact be harmful, since ids reset each turn. This test
  // pins that a resumed second turn commits its OWN answer once, unaffected by the guard.
  it('a resumed second turn commits its own answer exactly once (dedup is per-turn)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn(
      [
        { lines: codexTurnLines('thread-dd', 'answer one') },
        { lines: codexTurnLines('thread-dd', 'answer two') },
      ],
      calls,
    );
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);
    const turn2 = await drain(client, followupInput(), noTools);

    // Turn 2 resumed the captured session (proving this is the resume path)…
    expect(resumeIdOf(calls[1])).toBe('thread-dd');
    // …and its single agent_message (reusing id item_0) committed exactly once.
    const texts = turn2.filter((e) => e.type === 'text-delta');
    expect(texts).toHaveLength(1);
    expect(committedText(commit(turn2))).toBe('answer two');
  });
});

describe('codexCliClient — MCP passthrough (Wave 10)', () => {
  const mcpSpec = (name: string): ToolSpec => ({ name, description: 'x', inputSchema: {} });
  const autoAllow = createPermissionPolicy({ autoAllowSafe: true });

  it('wires an all-auto-allow, env-free server via -c mcp_servers + suppresses ambient config', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp', '--stdio'], risk: 'safe' },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      mcpSpec('read_file'),
      mcpSpec('mcp__docs__search'),
      mcpSpec('mcp__docs__fetch'),
    ]);

    const { args } = calls[0]!;
    // TRANSLATION, not proxy: juno's shell-free argv → codex's -c mcp_servers.<name>.*
    // (JSON-quoted for codex's TOML `-c` parser). command + args carried.
    expect(args).toContain('mcp_servers.docs.command="docs-mcp"');
    expect(args).toContain('mcp_servers.docs.args=["--stdio"]');
    // Wave 14: pin the per-call MCP timeout for the passthrough server too (mirrors
    // codexToolArgs for the spawn server) so a >60s passthrough call can't hit codex's
    // OWN 60s default tool timeout. An integer is a bare TOML scalar (no quoting).
    expect(args).toContain('mcp_servers.docs.tool_timeout_sec=3600');
    // STRICT: the user's ambient ~/.codex/config.toml MCP servers can't load ungated.
    expect(args).toContain('--ignore-user-config');
    // prompt still trails.
    expect(args.at(-1)).toContain('User:');
  });

  it('denies a mixed-risk server WHOLESALE (server-granularity: one non-auto-allow tool denies all)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // brain: recall safe (auto-allow), remember risky (prompt → NOT auto-allow).
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['brain-mcp'], toolRisk: { recall: 'safe', remember: 'risky' } },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      mcpSpec('mcp__brain__recall'),
      mcpSpec('mcp__brain__remember'),
    ]);

    const { args } = calls[0]!;
    // codex exec has NO per-tool MCP allowlist, so a server with ANY non-auto-allow tool
    // is denied ENTIRELY (can't expose recall without also exposing remember ungated).
    expect(args.join(' ')).not.toContain('mcp_servers.brain');
    // ...but ambient is still suppressed (deny-by-default posture holds).
    expect(args).toContain('--ignore-user-config');
  });

  it('wires the brain READ-ONLY server (wholesale-safe) and it stays wired against later-added tools', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // Decision (b): the read-only server exposes ONLY recall + get_episode and is read-only
    // BY CONSTRUCTION, so it carries a WHOLESALE `risk:'safe'`. That posture also covers any
    // tool codex might discover on its own live connection (see the late-added-tool gate), so
    // the server both clears the gate now and stays compliant against future tools.
    const servers: Record<string, McpServerConfig> = {
      brain: {
        command: ['uv', 'run', '--directory', '/home/u/src/brain', 'brain-server-readonly'],
        risk: 'safe',
      },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      mcpSpec('mcp__brain__recall'),
      mcpSpec('mcp__brain__get_episode'),
    ]);

    const { args } = calls[0]!;
    expect(args).toContain('mcp_servers.brain.command="uv"');
    expect(args).toContain(
      'mcp_servers.brain.args=["run","--directory","/home/u/src/brain","brain-server-readonly"]',
    );
    expect(args).toContain('--ignore-user-config');
  });

  it('rescues the mixed server via a WILDCARD allow (which also covers later-added tools)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['brain-mcp'], toolRisk: { recall: 'safe', remember: 'risky' } },
    };
    // A wildcard `mcp__brain__*` allow makes EVERY brain tool auto-allow — including a
    // hypothetical tool ADDED after this turn's enumeration — so the server (and its ungated
    // codex connection) is safe to wire. The gate MIRRORS juno's decision, not static risk.
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpServers: servers,
      policy: createPermissionPolicy({ autoAllowSafe: true, allow: ['mcp__brain__*'] }),
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      mcpSpec('mcp__brain__recall'),
      mcpSpec('mcp__brain__remember'),
    ]);

    expect(calls[0]!.args).toContain('mcp_servers.brain.command="brain-mcp"');
  });

  it('does NOT rescue a mixed server via a per-tool allow (a later-added tool would slip)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['brain-mcp'], toolRisk: { recall: 'safe', remember: 'risky' } },
    };
    // A per-tool allow for `remember` makes every tool EXPOSED this turn auto-allow, but the
    // server default stays risky. codex connects live and could call a later-added risky tool
    // ungated, so the gate fails closed — deny the whole server.
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpServers: servers,
      policy: createPermissionPolicy({ autoAllowSafe: true, allow: ['mcp__brain__remember'] }),
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [
      mcpSpec('mcp__brain__recall'),
      mcpSpec('mcp__brain__remember'),
    ]);

    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.brain');
  });

  it('denies a server whose DEFAULT is risky even when every EXPOSED tool auto-allows (late-added guard)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // docs has a risky default (no server-wide `risk`); only `search` is marked safe.
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], toolRisk: { search: 'safe' } },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    // Only the (auto-allowing) search tool is exposed this turn…
    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__docs__search')]);

    // …yet the server is NOT wired: a docs tool added later inherits the risky default and
    // would ride codex's ungated connection, so the turn-scoped enumeration is not enough.
    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.docs');
    // Passthrough is still ACTIVE, so ambient config stays suppressed.
    expect(calls[0]!.args).toContain('--ignore-user-config');
  });

  it('denies a wholesale-safe server whose config RAISES a not-exposed tool to risky (toolRisk guard)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // docs is server-wide safe, but a per-tool `toolRisk` RAISES `nuke` to risky. `nuke` is
    // NOT exposed this turn, so the exposed-tool + default-posture checks both pass — yet
    // codex's live connection could call `nuke`, which juno's gate would prompt (not
    // auto-allow). A statically-known toolRisk key must be probed too: fail closed.
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], risk: 'safe', toolRisk: { nuke: 'risky' } },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__docs__search')]);

    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.docs');
  });

  it('denies a wholesale-safe server when a NAMED deny targets a not-exposed tool in its namespace', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // docs is server-wide safe and only `search` is exposed (auto-allows). But a NAMED deny
    // for `mcp__docs__purge` (not exposed this turn) means juno's gate would auto-deny purge,
    // while codex's ungated connection could still call it. Fail closed — deny the server.
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], risk: 'safe' },
    };
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpServers: servers,
      policy: createPermissionPolicy({ autoAllowSafe: true, deny: ['mcp__docs__purge'] }),
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__docs__search')]);

    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.docs');
  });

  it('denies a wholesale-safe server under a WILDCARD deny over its namespace', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], risk: 'safe' },
    };
    // `mcp__docs__*` denies the whole namespace — the late-added probe alone already sinks it
    // (the probe tool auto-denies), and the namespace-deny check confirms it. Deny closed.
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpServers: servers,
      policy: createPermissionPolicy({ autoAllowSafe: true, deny: ['mcp__docs__*'] }),
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__docs__search')]);

    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.docs');
  });

  it('denies a server carrying env (no off-argv MCP-config channel — secrets never on argv)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      secret: { command: ['secret-mcp'], env: { TOKEN: 'abc123' }, toolRisk: { ping: 'safe' } },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__secret__ping')]);

    const joined = calls[0]!.args.join(' ');
    // env-carrying server is NOT wired (a `-c …env…` would be `ps`-visible).
    expect(joined).not.toContain('mcp_servers.secret');
    // ...and neither the secret nor its key ever reach argv.
    expect(joined).not.toContain('abc123');
    expect(joined).not.toContain('TOKEN');
  });

  it('never wires a tool from an UNCONFIGURED server (deny-by-default)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], toolRisk: { search: 'safe' } },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });

    // ghost is not a configured server; docs has no exposed tool this turn.
    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__ghost__do')]);

    const joined = calls[0]!.args.join(' ');
    expect(joined).not.toContain('mcp_servers.ghost');
    expect(joined).not.toContain('mcp_servers.docs');
    // Passthrough is still ACTIVE (juno configured servers), so ambient stays suppressed.
    expect(calls[0]!.args).toContain('--ignore-user-config');
  });

  it('fails a server closed when an arg-scoped deny rule shadows an otherwise-safe tool', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    // Wholesale-safe default (so the late-added-tool posture check passes) — the deny below
    // is then the reason the server is denied.
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp'], risk: 'safe' },
    };
    // An arg-scoped deny never fires on the empty-args spawn-time eval, so it would look
    // auto-allowed; fail closed instead → the server is NOT wired.
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpServers: servers,
      policy: createPermissionPolicy({ autoAllowSafe: true, deny: ['mcp__docs__search:/etc/*'] }),
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('mcp__docs__search')]);

    expect(calls[0]!.args.join(' ')).not.toContain('mcp_servers.docs');
  });

  it('no passthrough (no mcpServers/policy): ambient config is NOT suppressed (pre-Wave-10)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: fixtureLines('sol-text') }, calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, [mcpSpec('read_file')]);

    const { args } = calls[0]!;
    expect(args).not.toContain('--ignore-user-config');
    expect(args.join(' ')).not.toContain('mcp_servers.');
  });

  it('carries the passthrough + --ignore-user-config uniformly onto the resume turn', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn(
      [{ lines: codexTurnLines('thread-mcp', 'one') }, { lines: codexTurnLines('thread-mcp', 'two') }],
      calls,
    );
    const servers: Record<string, McpServerConfig> = {
      docs: { command: ['docs-mcp', '--stdio'], risk: 'safe' },
    };
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, mcpServers: servers, policy: autoAllow });
    const tools = [mcpSpec('mcp__docs__search')];

    await drain(client, { ...baseInput, cwd: '/work/jail' }, tools);
    await drain(client, followupInput({ cwd: '/work/jail' }), tools);

    // Turn 2 is the RESUME path (verified) and STILL carries the gated server + strict flag
    // (codex `exec resume` accepts both -c and --ignore-user-config — verified on 0.144.1).
    expect(resumeIdOf(calls[1])).toBe('thread-mcp');
    expect(calls[1]!.args).toContain('mcp_servers.docs.command="docs-mcp"');
    expect(calls[1]!.args).toContain('--ignore-user-config');
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
    // Wave 14: a spawn ENOENT classifies as child-exit (not retryable).
    const spawnErr = events.find((e) => e.type === 'error');
    expect((spawnErr as { envelope?: { kind: string } }).envelope?.kind).toBe('child-exit');
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
    // Wave 14: an exit-error → child-exit, with the RAW stderr tail carried on the
    // envelope (cleanly separate from the human-facing message).
    const env = (errors[0] as { envelope?: { kind: string; retryable: boolean; stderrTail?: string } }).envelope;
    expect(env?.kind).toBe('child-exit');
    expect(env?.retryable).toBe(false);
    expect(env?.stderrTail).toContain('Not inside a trusted directory');
  });

  it('a context overflow reported only on child stderr remains recoverable as context-overflow', async () => {
    // Some Codex startup/resume failures never emit turn.failed NDJSON: the CLI
    // prints the provider rejection to stderr and exits non-zero. The process
    // wrapper must not erase the semantic error kind, because turnRunner keys its
    // one-shot reactive compaction recovery from this envelope.
    const { spawn } = makeSpawn({
      lines: [],
      exitCode: 1,
      stderr: 'Error: prompt is too long for this model\n',
    });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);
    const error = events.find((event) => event.type === 'error');

    expect(error?.type).toBe('error');
    if (error?.type !== 'error') throw new Error('expected error event');
    expect(error.envelope).toEqual({
      kind: 'context-overflow',
      retryable: false,
      stderrTail: 'Error: prompt is too long for this model',
    });
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
    // Wave 14: the humanized stall message ("codex stalled: …") keeps the word
    // "stall" so it classifies as timeout (retryable).
    const stallErr = events.find((e) => e.type === 'error');
    const stallEnv = (stallErr as { envelope?: { kind: string; retryable: boolean } }).envelope;
    expect(stallEnv?.kind).toBe('timeout');
    expect(stallEnv?.retryable).toBe(true);
  });

  it('reads positive timeout knobs from env and lets injected values win', async () => {
    const clock = makeClock();
    const controller = new AbortController();
    const { spawn } = makeSpawn({ lines: [], hangForever: true }, [], controller.signal);
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      env: {
        JUNO_CODEX_IDLE_TIMEOUT_MS: '111',
        JUNO_CODEX_STALE_STREAM_MS: '222',
      },
      idleTimeoutMs: 77,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools, controller.signal);
    await flush();
    expect(clock.pending().some((timer) => timer.ms === 77)).toBe(true);
    expect(clock.pending().some((timer) => timer.ms === 222)).toBe(true);
    expect(clock.pending().some((timer) => timer.ms === 111)).toBe(false);

    controller.abort();
    await eventsPromise;
  });

  it('does NOT reap a child while a tool ITEM is in flight (item-granular silence is normal)', async () => {
    // THE field stall: a plain (no-bridge) codex turn runs a long command_execution.
    // codex emits NOTHING on stdout between item.started and item.completed, so >idle
    // silence is EXPECTED. The in-flight item must suppress BOTH guards (they re-arm),
    // not reap a healthy child.
    const clock = makeClock();
    const controller = new AbortController();
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'sleep 300' },
      }),
    ];
    const { spawn, child } = makeSpawn({ lines, hangForever: true }, [], controller.signal);
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 50,
      staleStreamMs: 90,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools, controller.signal);
    await flush();
    clock.fire((t) => t.ms === 50); // idle guard fires while the item is in flight
    await flush();

    // Suppressed: no kill, and a FRESH idle guard re-armed (not a stall throw).
    expect(child()?.killCount ?? 0).toBe(0);
    expect(clock.pending().some((t) => t.ms === 50)).toBe(true);

    // The stale guard is suppressed identically while the item is in flight.
    clock.fire((t) => t.ms === 90);
    await flush();
    expect(child()?.killCount ?? 0).toBe(0);

    // A real abort still terminates the turn cleanly (no spurious error).
    controller.abort();
    const events = await eventsPromise;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'aborted' });
  });

  it('does NOT reap a child during a long silent reasoning ITEM', async () => {
    // Reasoning is item-granular just like command execution: Codex may emit the
    // start and remain silent for minutes before the completed item. This protects
    // the non-tool half of the endurance contract.
    const clock = makeClock();
    const controller = new AbortController();
    const { spawn, child } = makeSpawn(
      {
        lines: [
          JSON.stringify({ type: 'thread.started', thread_id: 't-reasoning' }),
          JSON.stringify({ type: 'turn.started' }),
          JSON.stringify({
            type: 'item.started',
            item: { id: 'reasoning-1', type: 'reasoning' },
          }),
        ],
        hangForever: true,
      },
      [],
      controller.signal,
    );
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 50,
      staleStreamMs: 90,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools, controller.signal);
    await flush();
    clock.fire((timer) => timer.ms === 50);
    await flush();
    clock.fire((timer) => timer.ms === 90);
    await flush();

    expect(child()?.killCount ?? 0).toBe(0);
    expect(clock.pending().some((timer) => timer.ms === 50)).toBe(true);
    expect(clock.pending().some((timer) => timer.ms === 90)).toBe(true);

    controller.abort();
    const events = await eventsPromise;
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'aborted' });
  });

  it('(sleep) a host suspend (wall ≫ mono) re-arms the fired guard instead of reaping the child', async () => {
    // Wave 14 Item C: a laptop sleep fires the setTimeout the moment the host wakes; the
    // wall clock advanced while the monotonic clock stayed frozen. That divergence is a
    // suspend, not a dead stream — the guard must re-arm once, not kill a healthy child.
    const clock = makeClock();
    const controller = new AbortController();
    let wallMs = 1000;
    let monoNs = 0n;
    const { spawn, child } = makeSpawn(
      { lines: fixtureLines('sol-text').slice(0, 2), hangForever: true },
      [],
      controller.signal,
    );
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 50,
      staleStreamMs: 90,
      setTimer: clock.setTimer,
      now: () => wallMs,
      mono: () => monoNs,
    });

    const eventsPromise = drain(client, baseInput, noTools, controller.signal);
    await flush(); // lastActivity stamped at wall 1000 / mono 0 (last chunk)

    // Simulate a 60s suspend: wall jumped, monotonic clock barely moved.
    wallMs = 1000 + 60_000;
    monoNs = 100_000_000n; // 100ms
    clock.fire((t) => t.ms === 50); // the idle timer comes due immediately on wake
    await flush();

    // NOT reaped — a fresh idle guard was re-armed instead of stalling.
    expect(child()?.killCount ?? 0).toBe(0);
    expect(clock.pending().some((t) => t.ms === 50)).toBe(true);

    controller.abort();
    const events = await eventsPromise;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'aborted' });
  });

  it('(sleep regression) a genuine stall (wall ≈ mono) still reaps — sleep detection cannot swallow it', async () => {
    const clock = makeClock();
    let wallMs = 1000;
    let monoNs = 0n;
    const { spawn, child } = makeSpawn({ lines: fixtureLines('sol-text').slice(0, 2), hangForever: true });
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 50,
      staleStreamMs: 90,
      setTimer: clock.setTimer,
      now: () => wallMs,
      mono: () => monoNs,
    });

    const eventsPromise = drain(client, baseInput, noTools);
    await flush();

    // Both clocks advanced together (no suspend) → a real stall must still fire.
    wallMs = 1000 + 50;
    monoNs = 50_000_000n; // 50ms
    clock.fire((t) => t.ms === 50);
    const events = await eventsPromise;

    expect(child()?.killed).toBe(true);
    const stallErr = events.find((e) => e.type === 'error');
    expect((stallErr as { envelope?: { kind: string; retryable: boolean } }).envelope).toEqual({
      kind: 'timeout',
      retryable: true,
    });
  });

  it('surfaces a dead child holding stdout open as an exit-error IMMEDIATELY (not a 60s stall)', async () => {
    // codex dies but a descendant keeps the stdout write-end open, so it.next() never
    // resolves. Without the exit-racer this surfaces ~60s late, mislabeled as a stall.
    // The exit-racer drops the guards on exit, drains briefly, then surfaces the real
    // exit — with the eagerly-captured stderr tail.
    const clock = makeClock();
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
    ]; // NO turn.completed — the child dies mid-turn.
    const { spawn, child, fireExit } = makeSpawn({
      lines,
      hangForever: true,
      stderr: 'boom: crash detail\n',
    });
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      idleTimeoutMs: 60_000,
      staleStreamMs: 90_000,
      setTimer: clock.setTimer,
      postExitDrainMs: 10,
    });

    const eventsPromise = drain(client, baseInput, noTools);
    await flush();
    fireExit(1); // child exits 1 while stdout stays held open
    await flush();
    clock.fire((t) => t.ms === 10); // the post-exit drain window elapses
    const events = await eventsPromise;

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('exited with code 1');
    expect((errors[0] as { message: string }).message).toContain('boom');
    const env = (errors[0] as { envelope?: { kind: string; retryable: boolean; stderrTail?: string } })
      .envelope;
    expect(env?.kind).toBe('child-exit');
    expect(env?.retryable).toBe(false);
    expect(env?.stderrTail).toContain('boom');
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    // The child was NOT killed as a stall, and the 60s idle/stale guards were dropped
    // (no leaked timers) — proof the failure did not travel the stall path.
    expect(child()?.killCount ?? 0).toBe(0);
    expect(clock.pending()).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Session resume (v2, `codex exec resume`): a per-attempt SEQUENCED spawn so a
// single client instance can be driven across turns and per-attempt behavior can
// vary. Mirrors the claudeCliClient --resume suite.
// ---------------------------------------------------------------------------

function makeSeqSpawn(
  scripts: FakeChildOptions[],
  calls: SpawnCall[] = [],
  signal?: AbortSignal,
): { spawn: SpawnImpl; children: () => FakeChild[] } {
  const children: FakeChild[] = [];
  let callIndex = 0;

  const spawn: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd, env: spawnOptions.env });
    // Reuse the last script for any spawn beyond the provided list.
    const options = scripts[Math.min(callIndex, scripts.length - 1)] ?? { lines: [] };
    callIndex += 1;
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
    children.push(child);
    return child;
  };

  return { spawn, children: () => children };
}

/** NDJSON lines for one successful codex turn that reports `threadId` + a message. */
function codexTurnLines(threadId: string, text = 'ok'): string[] {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 9, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 },
    }),
  ];
}

// A follow-up turn whose transcript already has one completed assistant turn, so the
// tail (messages committed since the delivered watermark) is exactly the new user text.
const followupInput = (over: Partial<TurnInput> = {}): TurnInput => ({
  id: 'turn-2',
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'follow up' },
  ],
  conversationEpoch: 0,
  ...over,
});

/** The trailing positional prompt (codex takes the prompt LAST). */
const promptOf = (call: SpawnCall | undefined): string => call?.args.at(-1) ?? '';
/** The session id positional immediately after `resume`, or undefined if fresh. */
const resumeIdOf = (call: SpawnCall | undefined): string | undefined => {
  const idx = call?.args.indexOf('resume') ?? -1;
  return idx >= 0 ? call?.args[idx + 1] : undefined;
};
/** The `-c sandbox_mode=<mode>` override value on the argv, or undefined if absent. */
const sandboxModeOf = (call: SpawnCall | undefined): string | undefined => {
  const hit = call?.args.find((a) => a.startsWith('sandbox_mode='));
  return hit === undefined ? undefined : hit.slice('sandbox_mode='.length);
};

describe('buildPromptTail (pure)', () => {
  it('serializes the messages committed since the delivered watermark, in transcript order', () => {
    // Real mid-turn ordering: a `/steer` commits as a user message BEFORE the turn's
    // assistant message, so the transcript is [user, STEER, assistant, user]. With
    // 'first' already delivered (watermark 1), the tail is the steer plus the new turn —
    // the steer must NOT be sliced out despite sitting before the last assistant.
    const input: TurnInput = {
      id: 't',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'steer note' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    };
    expect(buildPromptTail(input, 1)).toBe('User:\nsteer note\n\nUser:\nsecond');
  });

  it('excludes the codex-generated assistant reply from the tail (the resumed session already has it)', () => {
    const input: TurnInput = {
      id: 't',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    };
    expect(buildPromptTail(input, 1)).toBe('User:\nsecond');
    expect(buildPromptTail(input, 1)).not.toContain('Assistant:');
  });

  it('excludes system messages from the tail (the resumed session already has them)', () => {
    const input: TurnInput = {
      id: 't',
      messages: [
        { role: 'assistant', content: 'reply' },
        { role: 'system', content: 'a late system frame' },
        { role: 'user', content: 'next' },
      ],
    };
    expect(buildPromptTail(input, 0)).toBe('User:\nnext');
  });
});

describe('codexCliClient — session reuse (`exec resume` closure)', () => {
  it('turn 1 spawns fresh (no resume); turn 2 spawns `exec resume <captured>` with a tail-only prompt', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-abc') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools);
    await drain(client, followupInput({ cwd: '/work/jail' }), noTools);

    // Turn 1: fresh — `exec` (not `exec resume`), full labeled prompt.
    expect(calls[0]?.args[0]).toBe('exec');
    expect(calls[0]?.args).not.toContain('resume');
    expect(promptOf(calls[0])).toContain('User:');
    expect(promptOf(calls[0])).toContain('hello');

    // Turn 2: resumes the captured session id with a TAIL-ONLY prompt.
    expect(calls[1]?.args[0]).toBe('exec');
    expect(calls[1]?.args[1]).toBe('resume');
    expect(resumeIdOf(calls[1])).toBe('thread-abc');
    expect(promptOf(calls[1])).toBe('User:\nfollow up');
    // The earlier turn is NOT replayed on resume.
    expect(promptOf(calls[1])).not.toContain('Assistant:');
    expect(promptOf(calls[1])).not.toContain('hi there');
    // Other stable flags remain on the resume argv.
    for (const flag of ['--json', '--skip-git-repo-check', 'approval_policy=never', 'preferred_auth_method=chatgpt']) {
      expect(calls[1]?.args).toContain(flag);
    }
  });

  it('re-pins required + approve for the Juno bridge on both fresh and resumed turns', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-bridge') }], calls);
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      mcpConfig: { serverName: 'juno', url: 'http://127.0.0.1:5123/mcp/secret' },
    });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools);
    await drain(client, followupInput({ cwd: '/work/jail' }), noTools);

    expect(calls).toHaveLength(2);
    expect(resumeIdOf(calls[0])).toBeUndefined();
    expect(resumeIdOf(calls[1])).toBe('thread-bridge');
    for (const call of calls) {
      expect(call.args).toContain('mcp_servers.juno.required=true');
      expect(call.args).toContain('mcp_servers.juno.default_tools_approval_mode="approve"');
      expect(call.args.at(-1)).toContain('User:');
    }
  });

  it('a mid-turn /steer survives into the resume tail (steer commits BEFORE the turn assistant)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-steer') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    // Turn 1 delivers one user message (watermark → 1).
    await drain(client, baseInput, noTools);
    // Turn 2's transcript: the original user, a mid-turn steer, the assistant reply,
    // then the new user turn. An after-last-assistant slice would drop the steer.
    await drain(
      client,
      {
        id: 'turn-2',
        conversationEpoch: 0,
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'user', content: 'steer note' },
          { role: 'assistant', content: 'hi there' },
          { role: 'user', content: 'follow up' },
        ],
      },
      noTools,
    );

    expect(resumeIdOf(calls[1])).toBe('thread-steer');
    expect(promptOf(calls[1])).toBe('User:\nsteer note\n\nUser:\nfollow up');
    expect(promptOf(calls[1])).not.toContain('hi there');
  });

  it('SANDBOX RETENTION (acceptEdits): resume re-pins `-c sandbox_mode=workspace-write`, drops --sandbox/--cd', async () => {
    // The load-bearing guard: `exec resume` REJECTS --sandbox/--cd, so a naive port
    // would silently lose the sandbox mode. The resume argv MUST carry the mode via a
    // -c config override instead, and cwd MUST ride the spawn `cwd` option.
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-we') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    const turn1: TurnInput = { ...baseInput, cwd: '/work/jail', permissionMode: 'acceptEdits' };
    await drain(client, turn1, noTools);
    await drain(client, followupInput({ cwd: '/work/jail', permissionMode: 'acceptEdits' }), noTools);

    // Turn 1 (fresh) uses the flag surface that `exec` accepts.
    expect(calls[0]?.args[calls[0].args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(calls[0]?.args[calls[0].args.indexOf('--cd') + 1]).toBe('/work/jail');
    expect(sandboxModeOf(calls[0])).toBeUndefined(); // fresh uses --sandbox, not the -c override

    // Turn 2 (resume): the rejected flags are GONE; sandbox rides the -c override…
    expect(calls[1]?.args).not.toContain('--sandbox');
    expect(calls[1]?.args).not.toContain('--cd');
    expect(sandboxModeOf(calls[1])).toBe('workspace-write');
    // …and cwd pinning rides the spawn cwd option (the mechanism proven by live probe).
    expect(calls[1]?.cwd).toBe('/work/jail');
    // NEVER danger-full-access on either turn.
    expect(calls[1]?.args).not.toContain('danger-full-access');
    expect(sandboxModeOf(calls[1])).not.toBe('danger-full-access');
  });

  it('SANDBOX RETENTION (default): resume re-pins `-c sandbox_mode=read-only`', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-ro') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools); // default mode
    await drain(client, followupInput({ cwd: '/work/jail' }), noTools);

    expect(calls[0]?.args[calls[0].args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(calls[1]?.args).not.toContain('--sandbox');
    expect(sandboxModeOf(calls[1])).toBe('read-only');
    expect(calls[1]?.cwd).toBe('/work/jail');
  });

  it('an epoch bump (/clear, /compact, resume-session) forces a fresh full-transcript spawn', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-e') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, conversationEpoch: 0 }, noTools);
    // Same transcript, but the epoch bumped (as clear/compact/resume-session do).
    await drain(client, followupInput({ conversationEpoch: 1 }), noTools);

    expect(resumeIdOf(calls[0])).toBeUndefined();
    expect(calls[1]?.args).not.toContain('resume');
    // Fresh spawn replays the full transcript, not a tail.
    expect(promptOf(calls[1])).toContain('follow up');
    expect(promptOf(calls[1])).toContain('hello');
  });

  it('a model change forces a fresh full-transcript spawn (no resume)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn([{ lines: codexTurnLines('thread-m') }], calls);
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, model: 'gpt-5.6-sol' }, noTools);
    await drain(client, followupInput({ model: 'gpt-5.5' }), noTools);

    expect(calls[1]?.args).not.toContain('resume');
    expect(calls[1]?.args[calls[1].args.indexOf('-m') + 1]).toBe('gpt-5.5');
  });

  it('an in-band turn.failed clears the session so the NEXT turn spawns fresh', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn(
      [
        { lines: codexTurnLines('thread-f') }, // turn 1: captures the session
        {
          // turn 2 (resume): model/API failure → session must be cleared.
          lines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'thread-f' }),
            JSON.stringify({ type: 'turn.failed', error: { message: 'boom from the model' } }),
          ],
        },
        { lines: codexTurnLines('thread-f2') }, // turn 3: must be fresh
      ],
      calls,
    );
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);
    const turn2 = await drain(client, followupInput(), noTools);
    await drain(client, followupInput({ id: 'turn-3' }), noTools);

    // Turn 2 attempted resume and surfaced the failure (no in-turn retry).
    expect(resumeIdOf(calls[1])).toBe('thread-f');
    expect(turn2.some((e) => e.type === 'error' && e.message.includes('boom from the model'))).toBe(true);
    expect(turn2.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-2', stopReason: 'error' });
    // Turn 3 is fresh — the failed session was invalidated.
    expect(calls[2]?.args).not.toContain('resume');
  });

  it('a mid-stream abort clears the session so the NEXT turn spawns fresh', async () => {
    const controller = new AbortController();
    const calls: SpawnCall[] = [];
    const { spawn } = makeSeqSpawn(
      [
        { lines: codexTurnLines('thread-ab') }, // turn 1: captures the session (clean)
        {
          // turn 2 (resume): emits a delta then hangs until aborted.
          lines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'thread-ab' }),
            JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'partial' } }),
          ],
          hangAfterLines: true,
        },
        { lines: codexTurnLines('thread-ab2') }, // turn 3: must be fresh
      ],
      calls,
      controller.signal,
    );
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);
    // Turn 2 resumes, then abort mid-stream.
    const events: AgentEvent[] = [];
    for await (const event of client.streamTurn(followupInput(), noTools, controller.signal)) {
      events.push(event);
      if (event.type === 'text-delta') {
        controller.abort();
      }
    }
    await drain(client, followupInput({ id: 'turn-3' }), noTools);

    expect(resumeIdOf(calls[1])).toBe('thread-ab');
    expect(events.at(-1)).toEqual({ type: 'aborted' });
    // Turn 3 is fresh — the aborted session (codex state diverged from juno) was cleared.
    expect(calls[2]?.args).not.toContain('resume');
  });
});

describe('codexCliClient — REAL child resume error path (production pipe shape)', () => {
  // Per the node-child-stdio rule: error-path child-process code needs at least ONE
  // real child (fakes gave false confidence on stderr/exit-race paths). Turn 1 is a
  // fake that captures the session; turn 2's RESUME spawn is a real failing subprocess
  // whose exit-race + eager stderr tail must surface a real error AND clear the session
  // so turn 3 spawns fresh.
  it.skipIf(process.platform === 'win32')(
    'a resume spawn that exits non-zero surfaces its stderr tail and clears the session',
    async () => {
      const calls: SpawnCall[] = [];
      let callIndex = 0;
      const spawn: SpawnImpl = (command, args, options) => {
        calls.push({ command, args: [...args], cwd: options.cwd });
        const idx = callIndex;
        callIndex += 1;
        if (idx === 1) {
          // Turn 2: the RESUME attempt — a real subprocess that fails on stderr.
          return nodeSpawn('sh', ['-c', 'printf boom 1>&2; exit 1'], {
            stdio: ['ignore', 'pipe', 'pipe'],
          }) as unknown as ChildProcessLike;
        }
        // Turns 1 and 3: fake clean children (capture the session, then verify fresh).
        const lines = idx === 0 ? codexTurnLines('thread-real') : codexTurnLines('thread-real2');
        const exitListeners: Array<(code: number | null) => void> = [];
        return {
          stdout: (async function* (): AsyncIterable<string> {
            for (const line of lines) yield `${line}\n`;
            for (const listener of exitListeners) listener(0);
          })(),
          stderr: { on: () => undefined },
          kill: () => true,
          unref: () => undefined,
          on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): ChildProcessLike {
            if (event === 'exit' || event === 'close') exitListeners.push(listener as (code: number | null) => void);
            return this as unknown as ChildProcessLike;
          },
        } as ChildProcessLike;
      };
      const client = createCodexCliClient(codexEntry, { spawnImpl: spawn });

      await drain(client, baseInput, noTools);
      const turn2 = await drain(client, followupInput(), noTools);
      await drain(client, followupInput({ id: 'turn-3' }), noTools);

      // Turn 2 attempted the resume with the captured id and failed with a real error.
      expect(resumeIdOf(calls[1])).toBe('thread-real');
      const errors = turn2.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect((errors[0] as { message: string }).message).toContain('boom');
      expect((errors[0] as { message: string }).message).toContain('code 1');
      expect(turn2.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-2', stopReason: 'error' });
      // Turn 3 is fresh — the failed resume session was cleared.
      expect(calls[2]?.args).not.toContain('resume');
    },
    5000,
  );
});
