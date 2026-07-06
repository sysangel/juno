import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createModelClient } from '../src/providers/index';
import {
  createClaudeCliClient,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/providers/claudeCliClient';

// ---------------------------------------------------------------------------
// Test scaffolding: a deterministic FAKE child process. No real `claude` ever
// runs (the GATE forbids live subprocess calls). The fake's stdout is an
// async-iterable yielding scripted NDJSON lines; kill() and the lifecycle
// listeners are recorded so abort/exit behavior can be asserted.
// ---------------------------------------------------------------------------

const cliEntry: ModelEntry = {
  id: 'claude-opus-4-8',
  provider: 'claude-cli',
  label: 'Claude Opus 4.8 (subscription)',
  contextWindow: 1_000_000,
};

const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'hello' }],
};

const noTools: ToolSpec[] = [];
const lookupTool: ToolSpec = { name: 'lookup', description: 'Lookup things', inputSchema: { type: 'object' } };

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
}

interface FakeChildOptions {
  /** NDJSON lines (without trailing newline) to emit on stdout, in order. */
  lines: string[];
  /** Exit code reported via the `exit` listener after stdout drains. */
  exitCode?: number;
  /** When set, throw from spawn to simulate a spawn failure. */
  spawnThrows?: Error;
  /** When true, the stdout iterator pauses indefinitely (until aborted) after
   *  the scripted lines — to exercise mid-stream abort. */
  hangAfterLines?: boolean;
  /** When true, the stdout iterator hangs FOREVER after the scripted lines (no
   *  abort, no further chunk) — to exercise the idle/stale stall timers. */
  hangForever?: boolean;
}

interface FakeChild extends ChildProcessLike {
  killed: boolean;
  killCount: number;
}

function makeSpawn(
  options: FakeChildOptions,
  calls: SpawnCall[] = [],
  signal?: AbortSignal,
): { spawn: SpawnImpl; child: () => FakeChild | undefined } {
  let created: FakeChild | undefined;

  const spawn: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null) => void> = [];

    const child: FakeChild = {
      killed: false,
      killCount: 0,
      stdout: (async function* (): AsyncIterable<string> {
        for (const line of options.lines) {
          yield `${line}\n`;
        }
        if (options.hangForever === true) {
          // Hang forever — never resolves, never aborts, never exits. Exercises
          // the idle/stale stall timers (the test fires the injected fake clock).
          await new Promise<never>(() => {});
          return;
        }
        if (options.hangAfterLines === true) {
          // Block until the caller aborts; yields nothing more.
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
        // Fire exit AFTER stdout drains (normal completion).
        const code = options.exitCode ?? 0;
        for (const listener of exitListeners) {
          listener(code);
        }
      })(),
      kill(): boolean {
        this.killed = true;
        this.killCount += 1;
        return true;
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

// ---------------------------------------------------------------------------
// Fixtures taken VERBATIM from docs/WAVE0A-subscription-drive-findings.md §3.
// ---------------------------------------------------------------------------

const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: '/work',
  session_id: 'sess-1',
  tools: [],
  mcp_servers: [],
  model: 'claude-opus-4-8[1m]',
  permissionMode: 'default',
  slash_commands: [],
  apiKeySource: 'none',
  claude_code_version: '2.1.178',
  agents: [],
  skills: [],
  plugins: [],
});

const RATE_LIMIT_LINE = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1750000000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
  uuid: 'u-1',
  session_id: 'sess-1',
});

function assistantBlockLine(content: unknown[], stopReason: string | null = null): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg-1',
      role: 'assistant',
      content,
      stop_reason: stopReason,
      usage: {},
    },
    parent_tool_use_id: null,
    session_id: 'sess-1',
    uuid: 'u-2',
    request_id: 'req-1',
  });
}

function resultLine(stopReason = 'end_turn'): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 90,
    ttft_ms: 10,
    num_turns: 1,
    result: 'final text',
    stop_reason: stopReason,
    session_id: 'sess-1',
    total_cost_usd: 0,
    usage: { input_tokens: 9, output_tokens: 4 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
  });
}

function streamEventLine(event: unknown): string {
  return JSON.stringify({ type: 'stream_event', event, session_id: 'sess-1', parent_tool_use_id: null, uuid: 'u' });
}

// ---------------------------------------------------------------------------
// Deterministic fake clock for the stall-timeout tests: records pending
// callbacks instead of arming real timers; the test fires a recorded callback
// by predicate, and asserts pending callbacks are cleared on the happy path.
// ---------------------------------------------------------------------------
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
    return {
      clear: (): void => {
        t.cleared = true;
      },
    };
  };
  return {
    setTimer,
    timers,
    /** Fire the FIRST not-yet-cleared timer matching `pred`. */
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

/**
 * Drain the microtask queue across a few real macrotasks so the streamTurn
 * async generator fully parks on the hung `it.next()` race (all scripted lines
 * consumed, both guard timers armed) BEFORE the test fires the fake clock.
 * Uses the REAL setTimeout (the client's timers are the injected fake clock).
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------

describe('claudeCliClient — spawn + arg surface', () => {
  it('spawns the claude CLI in print/stream-json mode with the resolved model and NEVER --bare', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn(
      { lines: [INIT_LINE, assistantBlockLine([{ type: 'text', text: 'hi' }]), resultLine()] },
      calls,
    );
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.command).toBe('claude');
    expect(call?.args).toContain('-p');
    expect(call?.args).toContain('--output-format');
    expect(call?.args).toContain('stream-json');
    expect(call?.args).toContain('--verbose');
    expect(call?.args).toContain('--include-partial-messages');
    // Default model = entry.id when input.model is omitted.
    const modelIdx = call?.args.indexOf('--model') ?? -1;
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(call?.args[modelIdx + 1]).toBe('claude-opus-4-8');
    // The OAuth-killing flag must never appear.
    expect(call?.args).not.toContain('--bare');
  });

  it('input.model overrides entry.id in --model', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, model: 'sonnet' }, noTools);

    const call = calls[0];
    const modelIdx = call?.args.indexOf('--model') ?? -1;
    expect(call?.args[modelIdx + 1]).toBe('sonnet');
  });

  it('passes --effort <level> for each effort level (the CLI owns the model-keyed translation)', async () => {
    for (const level of ['medium', 'high', 'xhigh'] as const) {
      const calls: SpawnCall[] = [];
      const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
      const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

      await drain(client, { ...baseInput, effort: level }, noTools);

      const call = calls[0];
      const effortIdx = call?.args.indexOf('--effort') ?? -1;
      expect(effortIdx).toBeGreaterThanOrEqual(0);
      expect(call?.args[effortIdx + 1]).toBe(level);
    }
  });

  it('defaults --effort to medium when input.effort is omitted', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);

    const call = calls[0];
    const effortIdx = call?.args.indexOf('--effort') ?? -1;
    expect(effortIdx).toBeGreaterThanOrEqual(0);
    expect(call?.args[effortIdx + 1]).toBe('medium');
  });

  // --- Permission regime: bring the render-only claude-cli backend under juno's
  //     gate/jail (--allowedTools / --disallowedTools / --permission-mode / cwd). ---

  const fileSpec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object' } });
  const junoFileTools: ToolSpec[] = [
    fileSpec('read_file'),
    fileSpec('list_files'),
    fileSpec('grep'),
    fileSpec('write_file'),
    fileSpec('edit_file'),
  ];
  const jailInput: TurnInput = { ...baseInput, cwd: '/work/jail' };

  const allowedFrom = (call: SpawnCall | undefined): string[] => {
    const idx = call?.args.indexOf('--allowedTools') ?? -1;
    return idx >= 0 ? (call?.args[idx + 1] ?? '').split(',') : [];
  };
  const disallowedFrom = (call: SpawnCall | undefined): string[] => {
    const idx = call?.args.indexOf('--disallowedTools') ?? -1;
    return idx >= 0 ? (call?.args[idx + 1] ?? '').split(',') : [];
  };

  it('juno default mode: only read-only tools are allowlisted (Write/Edit are NOT)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    // baseInput has no permissionMode → juno `default` mode.
    await drain(client, baseInput, junoFileTools);

    const allowed = allowedFrom(calls[0]);
    expect(allowed).toEqual(['Read', 'Glob', 'Grep']);
    expect(allowed).not.toContain('Write');
    expect(allowed).not.toContain('Edit');
  });

  it('juno default mode: Write/Edit are hard-denied via --disallowedTools', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, permissionMode: 'default' }, junoFileTools);

    const denied = disallowedFrom(calls[0]);
    expect(denied).toContain('Write');
    expect(denied).toContain('Edit');
  });

  it('juno acceptEdits mode: Write/Edit ARE allowlisted (path-scoped) and NOT denied', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, { ...jailInput, permissionMode: 'acceptEdits' }, junoFileTools);

    const allowed = allowedFrom(calls[0]);
    expect(allowed).toEqual([
      'Read(//work/jail/**)',
      'Glob(//work/jail/**)',
      'Grep(//work/jail/**)',
      'Write(//work/jail/**)',
      'Edit(//work/jail/**)',
    ]);
    const denied = disallowedFrom(calls[0]);
    expect(denied).not.toContain('Write');
    expect(denied).not.toContain('Edit');
  });

  it('path-scopes allowlist entries to the jail root using Tool(//<cwd>/**) syntax', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, jailInput, [fileSpec('read_file')]);

    expect(allowedFrom(calls[0])).toEqual(['Read(//work/jail/**)']);
  });

  it('omits juno-internal tools (no CLI analogue) from --allowedTools', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, baseInput, [
      fileSpec('read_file'),
      fileSpec('spawn_subagent'),
      fileSpec('remember_fact'),
      lookupTool,
    ]);

    // No cwd on baseInput → bare (unscoped) grant; only the mapped read tool.
    expect(allowedFrom(calls[0])).toEqual(['Read']);
  });

  it('omits --allowedTools entirely when no tool maps to a CLI tool', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);

    expect(calls[0]?.args).not.toContain('--allowedTools');
  });

  it('always hard-denies all six shell/network/sub-agent escape hatches via --disallowedTools', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    // Even with NO tools handed to the turn, the deny list is unconditional.
    await drain(client, baseInput, noTools);

    const denied = disallowedFrom(calls[0]);
    for (const tool of ['Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Task', 'Agent']) {
      expect(denied).toContain(tool);
    }
  });

  it('mirrors juno permissionMode onto --permission-mode (default when unset)', async () => {
    for (const mode of [undefined, 'default', 'acceptEdits'] as const) {
      const calls: SpawnCall[] = [];
      const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
      const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

      await drain(client, { ...baseInput, permissionMode: mode }, noTools);

      const call = calls[0];
      const idx = call?.args.indexOf('--permission-mode') ?? -1;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(call?.args[idx + 1]).toBe(mode ?? 'default');
    }
  });

  it('pins the child cwd to the workspace jail root (input.cwd)', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, { ...baseInput, cwd: '/work/jail' }, noTools);

    expect(calls[0]?.cwd).toBe('/work/jail');
  });

  it('sets child stdin to ignore (no ~3s stdin wait) and hides the window', async () => {
    let captured: { stdio: unknown; windowsHide: unknown } | undefined;
    const spawn: SpawnImpl = (_command, _args, options) => {
      captured = { stdio: options.stdio, windowsHide: options.windowsHide };
      return {
        stdout: (async function* () {
          yield `${resultLine()}\n`;
        })(),
        kill: () => true,
        on(): ChildProcessLike {
          return this as unknown as ChildProcessLike;
        },
      } as ChildProcessLike;
    };
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    await drain(client, baseInput, noTools);

    expect(captured?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(captured?.windowsHide).toBe(true);
  });
});

describe('claudeCliClient — block-mode NDJSON translation', () => {
  it('translates text + thinking blocks and a result into the normalized event stream', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        RATE_LIMIT_LINE,
        assistantBlockLine([
          { type: 'thinking', thinking: 'because', signature: 'sig' },
          { type: 'text', text: 'Hello' },
        ]),
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'reasoning-delta', id: 'turn-1', delta: 'because' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 4, contextTokens: 9 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('translates a tool_use block into a completed tool-call and stopReason tool_use', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        assistantBlockLine([
          { type: 'tool_use', id: 'toolu-1', name: 'lookup', input: { q: 'music' }, caller: { type: 'direct' } },
        ]),
        resultLine('tool_use'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, [lookupTool]);

    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu-1',
      name: 'lookup',
      args: { q: 'music' },
    });
    // Render-only: the CLI ran the tool itself, so the turn terminates cleanly
    // ('end') — it must NOT signal 'tool_use', which would make the turn runner
    // re-execute the tool and re-spawn `claude -p`.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('emits subagent-originated assistant block content (parent_tool_use_id non-null)', async () => {
    // Wave 4 Unit 2: child (subagent) block content is NO LONGER dropped — it is
    // rendered (text/thinking/tool_use) so nested cards complete. Child content
    // arrives as block-mode only and bypasses the sawStreamEvent suppression.
    const subagentLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'nested' }], stop_reason: null, usage: {} },
      parent_tool_use_id: 'toolu-parent',
      session_id: 'sess-1',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({
      lines: [INIT_LINE, subagentLine, assistantBlockLine([{ type: 'text', text: 'top' }]), resultLine()],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'top' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'nested' });
    // Child content must NOT affect the terminal stop reason.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('claudeCliClient — delta-mode (stream_event) translation', () => {
  it('translates wrapped Anthropic SSE deltas (text/thinking/tool input) to normalized events', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        streamEventLine({ type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 2 } } }),
        streamEventLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        streamEventLine({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'mull' },
        }),
        streamEventLine({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu-9', name: 'lookup', input: {} },
        }),
        streamEventLine({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
        }),
        streamEventLine({ type: 'content_block_stop', index: 1 }),
        streamEventLine({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
        resultLine('tool_use'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, [lookupTool]);

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'reasoning-delta', id: 'turn-1', delta: 'mull' });
    // message_start emits input with output 0 (avoid double-count) + contextTokens (no cache → == input).
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 0, contextTokens: 9 });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 0, tokensOut: 7 });
    expect(events).toContainEqual({ type: 'tool-call-delta', toolCallId: 'toolu-9', argsDelta: '{"q":"x"}' });
    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu-9',
      name: 'lookup',
      args: { q: 'x' },
    });
    // Render-only: the CLI ran the tool itself, so the turn terminates cleanly
    // ('end') — it must NOT signal 'tool_use', which would make the turn runner
    // re-execute the tool and re-spawn `claude -p`.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('claudeCliClient — delta + consolidated-block coexistence (real --include-partial-messages stream)', () => {
  // VERIFIED LIVE (2026-06-17): `claude -p … --include-partial-messages` emits
  // BOTH the fine-grained stream_event deltas AND a consolidated `assistant`
  // block for the SAME content, interleaved. Delta mode is authoritative; the
  // block must NOT be re-emitted, or the default backend double-renders text and
  // double-EXECUTES tool calls.
  it('emits text deltas once and does NOT re-emit the consolidated assistant text', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        streamEventLine({ type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } }),
        streamEventLine({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        streamEventLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PO' } }),
        streamEventLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NG' } }),
        // The consolidated block arrives mid-stream (exactly as observed live).
        assistantBlockLine([{ type: 'text', text: 'PONG' }], 'end_turn'),
        streamEventLine({ type: 'content_block_stop', index: 0 }),
        streamEventLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    // EXACTLY the two deltas — NOT a third 'PONG' from the consolidated block.
    expect(events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : []))).toEqual(['PO', 'NG']);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    // Usage streamed from deltas only; result usage suppressed (no double-count).
    expect(events.filter((e) => e.type === 'usage')).toEqual([
      { type: 'usage', tokensIn: 9, tokensOut: 0, contextTokens: 9 },
      { type: 'usage', tokensIn: 0, tokensOut: 2 },
    ]);
  });

  it('emits a tool-call ONCE when it appears in both the deltas and the consolidated block (no double execution)', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        streamEventLine({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-7', name: 'lookup', input: {} },
        }),
        streamEventLine({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
        }),
        // Consolidated block ALSO carries the completed tool_use.
        assistantBlockLine([{ type: 'tool_use', id: 'toolu-7', name: 'lookup', input: { q: 'x' } }], 'tool_use'),
        streamEventLine({ type: 'content_block_stop', index: 0 }),
        streamEventLine({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
        resultLine('tool_use'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, [lookupTool]);

    const toolCalls = events.filter((e) => e.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu-7',
      name: 'lookup',
      args: { q: 'x' },
    });
    // Render-only: the CLI ran the tool itself, so the turn terminates cleanly
    // ('end') — it must NOT signal 'tool_use', which would make the turn runner
    // re-execute the tool and re-spawn `claude -p`.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('surfaces subagent-originated stream_event deltas via a child-scoped accumulator (parent_tool_use_id non-null)', async () => {
    // Wave 4 Unit 2 (forward-compat): the real capture has NO child stream
    // deltas (children are block-only), but if one ever arrives it must be
    // surfaced (not silently dropped) and routed through a child-scoped map so
    // its index never collides with the parent's, while never regressing or
    // double-emitting the top-level deltas.
    const subDelta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'nested' } },
      session_id: 'sess-1',
      parent_tool_use_id: 'toolu-parent',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        subDelta,
        streamEventLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'top' } }),
        streamEventLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    // Top-level text emits exactly once (no regression, no double-emit).
    expect(events.filter((e) => e.type === 'text-delta' && e.delta === 'top')).toHaveLength(1);
    // The child stream delta is now surfaced too.
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'nested' });
    // Child stream events must NOT affect the terminal stop reason.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('a child-only stream_event does NOT put the top-level turn into delta mode (block-mode top-level content/usage survive)', async () => {
    // Regression: `sawStreamEvent` means "the TOP-LEVEL turn is in delta mode" —
    // it gates suppression of the top-level consolidated assistant block and the
    // result usage. A child (subagent) stream_event must NOT set that flag, or a
    // later BLOCK-MODE top-level assistant message (no top-level deltas) and its
    // result usage would be wrongly dropped. Per the SEAMS ground truth, child
    // tool calls do NOT arrive as stream_event deltas, so the only top-level
    // content here is the block — it must be emitted, and usage must survive.
    const subDelta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'nested' } },
      session_id: 'sess-1',
      parent_tool_use_id: 'toolu-parent',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        subDelta,
        // Block-mode top-level assistant message (NO top-level stream_event deltas).
        assistantBlockLine([{ type: 'text', text: 'top-block' }], 'end_turn'),
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    // The child stream delta is still surfaced.
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'nested' });
    // The top-level consolidated block content is NOT dropped (delta mode was
    // never entered at the top level).
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'top-block' });
    // The result usage survives (block mode → emitted, not suppressed).
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 4, contextTokens: 9 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('claudeCliClient — render-only tool execution (CLI runs its own tools)', () => {
  // The CLI executes tools internally and echoes results in `user` events. juno
  // surfaces those as a terminal tool-status (so the card completes) and must
  // NOT re-execute — proven by the 'end' stopReason (the turn runner breaks on
  // anything that is not 'tool_use', so it never re-runs the tool or loops).
  it('emits a terminal tool-status(result) from the CLI tool_result echo and ends cleanly', async () => {
    const userEcho = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu-1', type: 'tool_result', content: '391', is_error: false }],
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        assistantBlockLine(
          [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'expr 390 + 1' } }],
          'tool_use',
        ),
        userEcho,
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    // The tool-call is rendered exactly once...
    expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(1);
    // ...and completed by the CLI's echoed result.
    expect(events).toContainEqual({ type: 'tool-status', toolCallId: 'toolu-1', status: 'result', result: '391' });
    // Clean terminal reason → the turn runner will NOT re-execute or loop.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('maps an is_error tool_result echo to a tool-status(error)', async () => {
    const userEcho = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu-2', type: 'tool_result', content: 'command not found', is_error: true }],
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        assistantBlockLine([{ type: 'tool_use', id: 'toolu-2', name: 'Bash', input: { command: 'nope' } }], 'tool_use'),
        userEcho,
        resultLine('end_turn'),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual({
      type: 'tool-status',
      toolCallId: 'toolu-2',
      status: 'error',
      error: 'command not found',
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('emits a tool-status for a subagent tool_result echo (parent_tool_use_id non-null)', async () => {
    // Wave 4 Unit 2: child (subagent) tool results are NO LONGER dropped. They
    // route purely by tool_use_id, so the right nested child card completes.
    const subEcho = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ tool_use_id: 'toolu-sub', type: 'tool_result', content: 'nested', is_error: false }],
      },
      parent_tool_use_id: 'toolu-parent',
      session_id: 'sess-1',
      uuid: 'u',
    });
    const { spawn } = makeSpawn({ lines: [INIT_LINE, subEcho, resultLine('end_turn')] });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual({
      type: 'tool-status',
      toolCallId: 'toolu-sub',
      status: 'result',
      result: 'nested',
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('claudeCliClient — robustness', () => {
  it('skips malformed NDJSON lines and still terminates cleanly', async () => {
    const { spawn } = makeSpawn({
      lines: [
        INIT_LINE,
        '{ this is not json',
        assistantBlockLine([{ type: 'text', text: 'ok' }]),
        '}}}garbage',
        resultLine(),
      ],
    });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'ok' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('handles NDJSON split across chunk boundaries', async () => {
    // Manually drive a stdout that splits a JSON object across two chunks.
    const fullLine = assistantBlockLine([{ type: 'text', text: 'spanned' }]);
    const mid = Math.floor(fullLine.length / 2);
    const spawn: SpawnImpl = () => ({
      stdout: (async function* () {
        yield fullLine.slice(0, mid);
        yield `${fullLine.slice(mid)}\n`;
        yield `${resultLine()}\n`;
      })(),
      kill: () => true,
      on(): ChildProcessLike {
        return this as unknown as ChildProcessLike;
      },
    }) as ChildProcessLike;
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'spanned' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('a spawn failure yields one error + assistant-done(error), no assistant-start', async () => {
    const { spawn } = makeSpawn({ lines: [], spawnThrows: new Error('ENOENT: claude not found') });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((e) => e.type === 'assistant-start')).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('a non-zero exit WITHOUT a result event yields error + assistant-done(error)', async () => {
    const { spawn } = makeSpawn({ lines: [INIT_LINE], exitCode: 1 });
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});

describe('claudeCliClient — abort handling', () => {
  it('returns only {aborted} for a pre-aborted signal and never spawns', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [resultLine()] }, calls);
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const controller = new AbortController();
    controller.abort();

    const events = await drain(client, baseInput, noTools, controller.signal);

    expect(events).toEqual([{ type: 'aborted' }]);
    expect(calls).toHaveLength(0);
  });

  it('mid-stream abort kills the child and yields {aborted}', async () => {
    const controller = new AbortController();
    const calls: SpawnCall[] = [];
    const { spawn, child } = makeSpawn(
      { lines: [INIT_LINE, assistantBlockLine([{ type: 'text', text: 'partial' }])], hangAfterLines: true },
      calls,
      controller.signal,
    );
    const client = createClaudeCliClient(cliEntry, { spawnImpl: spawn });

    const events: AgentEvent[] = [];
    for await (const event of client.streamTurn(baseInput, noTools, controller.signal)) {
      events.push(event);
      if (event.type === 'text-delta') {
        // Abort mid-stream, right after the first text delta.
        controller.abort();
      }
    }

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'aborted' });
    expect(child()?.killed).toBe(true);
    expect(child()?.killCount).toBeGreaterThanOrEqual(1);
    // No assistant-done after an abort.
    expect(events.some((e) => e.type === 'assistant-done')).toBe(false);
  });
});

describe('claudeCliClient — registry wiring', () => {
  it('createModelClient builds the claude-cli client and threads spawnImpl', async () => {
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn(
      { lines: [INIT_LINE, assistantBlockLine([{ type: 'text', text: 'via registry' }]), resultLine()] },
      calls,
    );
    const client = createModelClient(cliEntry, { spawnImpl: spawn });

    const events = await drain(client, baseInput, noTools);

    expect(calls).toHaveLength(1);
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'via registry' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('the still-unknown provider id throws (claude-cli is now known, mystery is not)', () => {
    const entry: ModelEntry = { id: 'x', provider: 'mystery', label: 'X', contextWindow: 1 };
    expect(() => createModelClient(entry)).toThrow('unknown provider: mystery');
  });
});

describe('claudeCliClient — streaming health checks (idle / stale-stream timeout)', () => {
  // Distinct small windows so the fake clock can target each guard by `ms`.
  const idleTimeoutMs = 50;
  const staleStreamMs = 90;

  it('T-idle: a stream that yields INIT then hangs fires the idle timer → kill + error + assistant-done(error)', async () => {
    const clock = makeClock();
    const calls: SpawnCall[] = [];
    const { spawn, child } = makeSpawn({ lines: [INIT_LINE], hangForever: true }, calls);
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: spawn,
      idleTimeoutMs,
      staleStreamMs,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools);
    // Park the generator on the hung iterator (INIT consumed, timers armed).
    await flush();
    // Fire the (re-armed) idle guard.
    clock.fire((t) => t.ms === idleTimeoutMs);
    const events = await eventsPromise;

    // The hung child was reaped exactly once by the stall path.
    expect(child()?.killCount).toBe(1);
    // No abort — this is a stall, not a cancellation.
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events[events.length - 2]).toEqual({
      type: 'error',
      message: expect.stringContaining('idle'),
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('T-stale: a whitespace trickle does NOT reset the stale guard → stale timer fires → kill + error + assistant-done(error)', async () => {
    const clock = makeClock();
    const calls: SpawnCall[] = [];
    // INIT is real progress (a parseable NDJSON object) — it resets the stale
    // guard exactly once. The subsequent whitespace-only lines reset the READ
    // guard (idle) on every chunk but are NOT parseable NDJSON, so per SEAMS §2
    // T2 they must make NO real progress and reset the stale guard ZERO times.
    // The generator then trickles to a halt (hangForever) — standing in for a
    // process that keeps emitting whitespace-padded newlines but never another
    // real event. The stale guard, measured from the INIT line, is the catch.
    const { spawn, child } = makeSpawn(
      { lines: [INIT_LINE, '   ', ' \t ', '  '], hangForever: true },
      calls,
    );
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: spawn,
      idleTimeoutMs,
      staleStreamMs,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools);
    await flush();

    // Mechanism check — this is what the old test failed to assert. Count the
    // timers actually armed for each guard:
    //   stale (ms === staleStreamMs): 1 initial + 1 (INIT, the only real
    //     progress) = 2. The 3 whitespace lines added ZERO. With the old
    //     `line.length > 0` bug this would be 5 — and a whitespace trickle
    //     would re-arm T2 forever, so neither timer would ever fire and the UI
    //     would hang: the exact failure mode the stale guard exists to prevent.
    //   idle (ms === idleTimeoutMs): reset by EVERY chunk, whitespace included,
    //     so strictly more timers than stale — proving whitespace resets T1 but
    //     not T2 (the distinction the SEAMS draws).
    const staleTimers = clock.timers.filter((t) => t.ms === staleStreamMs);
    const idleTimers = clock.timers.filter((t) => t.ms === idleTimeoutMs);
    expect(staleTimers).toHaveLength(2);
    expect(idleTimers.length).toBeGreaterThan(staleTimers.length);

    clock.fire((t) => t.ms === staleStreamMs);
    const events = await eventsPromise;

    expect(child()?.killCount).toBe(1);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events[events.length - 2]).toEqual({
      type: 'error',
      message: expect.stringContaining('stale'),
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('T-no-false-positive: a normal stream completes before any timer, with no kill and no leaked timers', async () => {
    const clock = makeClock();
    const { spawn, child } = makeSpawn({
      lines: [INIT_LINE, assistantBlockLine([{ type: 'text', text: 'Hello' }]), resultLine('end_turn')],
    });
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: spawn,
      idleTimeoutMs,
      staleStreamMs,
      setTimer: clock.setTimer,
    });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hello' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    // No stall → child never killed, and both guards were cleared (no leak).
    expect(child()?.killCount).toBe(0);
    expect(clock.pending()).toHaveLength(0);
  });

  it('T-abort-beats-stall: aborting a hung stream before the idle timer yields {aborted}, not an error', async () => {
    const clock = makeClock();
    const controller = new AbortController();
    const calls: SpawnCall[] = [];
    const { spawn } = makeSpawn({ lines: [INIT_LINE], hangForever: true }, calls, controller.signal);
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: spawn,
      idleTimeoutMs,
      staleStreamMs,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, baseInput, noTools, controller.signal);
    await flush();
    controller.abort(); // abort before firing any guard timer
    const events = await eventsPromise;

    expect(events.at(-1)).toEqual({ type: 'aborted' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'assistant-done')).toBe(false);
    // Guards cleared on the abort exit path (no leak).
    expect(clock.pending()).toHaveLength(0);
  });

  it('T-timers-cleared-on-normal-exit: the injected scheduler is fully cleared on the happy path', async () => {
    const clock = makeClock();
    const { spawn } = makeSpawn({
      lines: [INIT_LINE, assistantBlockLine([{ type: 'text', text: 'ok' }]), resultLine('end_turn')],
    });
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: spawn,
      idleTimeoutMs,
      staleStreamMs,
      setTimer: clock.setTimer,
    });

    await drain(client, baseInput, noTools);

    // At least one guard pair was armed, and every one is now cleared.
    expect(clock.timers.length).toBeGreaterThanOrEqual(2);
    expect(clock.pending()).toHaveLength(0);
  });
});
