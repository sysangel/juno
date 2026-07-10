import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import {
  createClaudeCliClient,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/providers/claudeCliClient';

// ---------------------------------------------------------------------------
// Self-contained harness (mirrors tests/claudeCliClient.test.ts). A deterministic
// fake child process whose stdout yields scripted NDJSON lines; no real `claude`
// ever runs. The PRIMARY fixture is the real parallel-subagent capture.
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

interface FakeChildOptions {
  lines: string[];
  exitCode?: number;
}

interface FakeChild extends ChildProcessLike {
  killed: boolean;
  killCount: number;
}

function makeSpawn(options: FakeChildOptions): SpawnImpl {
  return () => {
    const exitListeners: Array<(code: number | null) => void> = [];

    const child: FakeChild = {
      killed: false,
      killCount: 0,
      stdout: (async function* (): AsyncIterable<string> {
        for (const line of options.lines) {
          yield `${line}\n`;
        }
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

    return child;
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

type ToolCallEvent = Extract<AgentEvent, { type: 'tool-call' }>;
type ToolStatusEvent = Extract<AgentEvent, { type: 'tool-status' }>;
type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

function toolCallEvents(events: AgentEvent[]): ToolCallEvent[] {
  return events.filter((event): event is ToolCallEvent => event.type === 'tool-call');
}

function toolStatusEvents(events: AgentEvent[]): ToolStatusEvent[] {
  return events.filter((event): event is ToolStatusEvent => event.type === 'tool-status');
}

function usageEvents(events: AgentEvent[]): UsageEvent[] {
  return events.filter((event): event is UsageEvent => event.type === 'usage');
}

function streamEventLine(event: unknown, parentToolUseId: string | null = null): string {
  return JSON.stringify({
    type: 'stream_event',
    event,
    session_id: 'sess-1',
    parent_tool_use_id: parentToolUseId,
    uuid: 'u',
  });
}

function assistantBlockLine(content: unknown[], parentToolUseId: string | null = null): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      id: 'msg-1',
      role: 'assistant',
      content,
      stop_reason: null,
      usage: {},
    },
    parent_tool_use_id: parentToolUseId,
    session_id: 'sess-1',
    uuid: 'u',
    request_id: 'req-1',
  });
}

function userEchoLine(toolUseId: string, content: unknown, parentToolUseId: string | null): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: false }],
    },
    parent_tool_use_id: parentToolUseId,
    session_id: 'sess-1',
    uuid: 'u',
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
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    terminal_reason: 'completed',
  });
}

// ---------------------------------------------------------------------------

describe('nested subagent render completion — claude-cli parser', () => {
  it('emits child tool calls + child results from the REAL parallel-subagent capture', async () => {
    const lines = readFileSync('tests/fixtures/claude/capture-parallel-01.ndjson', 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    const client = createClaudeCliClient(cliEntry, { spawnImpl: makeSpawn({ lines }) });
    const events = await drain(client, baseInput, noTools);

    const parentA = 'toolu_synthetic0000000000001';
    const parentB = 'toolu_synthetic0000000000002';
    const childA = 'toolu_synthetic0000000000003';
    const childB = 'toolu_synthetic0000000000004';

    const calls = toolCallEvents(events);

    // (a) exactly 2 top-level Agent tool-calls, NO parentToolUseId, each once.
    const parentAgentCalls = calls.filter(
      (e) => e.name === 'Agent' && (e.toolCallId === parentA || e.toolCallId === parentB),
    );
    expect(parentAgentCalls).toHaveLength(2);
    expect(parentAgentCalls.map((e) => e.toolCallId)).toEqual([parentA, parentB]);
    expect(parentAgentCalls.every((e) => e.parentToolUseId === undefined)).toBe(true);
    expect(calls.filter((e) => e.toolCallId === parentA)).toHaveLength(1);
    expect(calls.filter((e) => e.toolCallId === parentB)).toHaveLength(1);

    // (b) exactly 2 child Bash tool-calls, each carrying its parent Agent id.
    const childCalls = calls.filter((e) => e.parentToolUseId !== undefined);
    expect(childCalls).toHaveLength(2);
    expect(childCalls[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: childA,
      name: 'Bash',
      parentToolUseId: parentA,
    });
    expect(childCalls[1]).toMatchObject({
      type: 'tool-call',
      toolCallId: childB,
      name: 'Bash',
      parentToolUseId: parentB,
    });

    // (c) child tool-status results keyed to the child toolCallIds.
    const statuses = toolStatusEvents(events);
    expect(statuses).toContainEqual({
      type: 'tool-status',
      toolCallId: childA,
      status: 'result',
      result: '8 C:/Users/user/_tmp_w4cap/data1.txt',
    });
    expect(statuses).toContainEqual({
      type: 'tool-status',
      toolCallId: childB,
      status: 'result',
      result: '5',
    });

    // (d) terminal assistant-done stopReason 'end' (NOT 'tool_use').
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });

    // (e) no double-emitted parent Agent tool-calls (sawStreamEvent dedup holds:
    //     the parent Agent calls arrive as both stream deltas AND a block; the
    //     block is suppressed). Exactly 2 Agent tool-calls total.
    expect(calls.filter((e) => e.name === 'Agent')).toHaveLength(2);

    // (f) usage NOT inflated by child blocks. Child assistant blocks report
    //     input_tokens=2; that must never surface as a usage event. Totals come
    //     from the top-level stream (+suppressed result) = capture's 4614 / 380.
    const usages = usageEvents(events);
    expect(usages.some((e) => e.tokensIn === 2)).toBe(false);
    expect(usages.reduce((sum, e) => sum + e.tokensIn, 0)).toBe(4614);
    expect(usages.reduce((sum, e) => sum + e.tokensOut, 0)).toBe(380);
  });

  it('keeps INTERLEAVED child block tool calls isolated (index-collision regression)', async () => {
    // childA tool_use, childB tool_use, childA result, childB result — interleaved.
    // Parents arrive top-level (stream deltas) so they exist; children are blocks.
    const lines = [
      streamEventLine({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'pA', name: 'Agent', input: {} },
      }),
      streamEventLine({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"a"}' },
      }),
      streamEventLine({ type: 'content_block_stop', index: 1 }),
      streamEventLine({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'pB', name: 'Agent', input: {} },
      }),
      streamEventLine({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"subagent_type":"b"}' },
      }),
      streamEventLine({ type: 'content_block_stop', index: 2 }),
      // Interleaved child blocks + results.
      assistantBlockLine([{ type: 'tool_use', id: 'ca', name: 'Bash', input: { command: 'echo child-a' } }], 'pA'),
      assistantBlockLine([{ type: 'tool_use', id: 'cb', name: 'Bash', input: { command: 'echo child-b' } }], 'pB'),
      userEchoLine('ca', 'child-a result', 'pA'),
      userEchoLine('cb', 'child-b result', 'pB'),
      streamEventLine({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
      resultLine('end_turn'),
    ];

    const client = createClaudeCliClient(cliEntry, { spawnImpl: makeSpawn({ lines }) });
    const events = await drain(client, baseInput, noTools);
    const calls = toolCallEvents(events);
    const statuses = toolStatusEvents(events);

    const pACall = calls.find((e) => e.toolCallId === 'pA');
    const pBCall = calls.find((e) => e.toolCallId === 'pB');
    expect(pACall).toMatchObject({ name: 'Agent' });
    expect(pBCall).toMatchObject({ name: 'Agent' });
    // Top-level calls omit parentToolUseId entirely (key absent ⇒ undefined).
    expect(pACall?.parentToolUseId).toBeUndefined();
    expect(pBCall?.parentToolUseId).toBeUndefined();
    // Each child keeps its OWN args + parent — no cross-contamination.
    expect(calls.find((e) => e.toolCallId === 'ca')).toMatchObject({
      name: 'Bash',
      args: { command: 'echo child-a' },
      parentToolUseId: 'pA',
    });
    expect(calls.find((e) => e.toolCallId === 'cb')).toMatchObject({
      name: 'Bash',
      args: { command: 'echo child-b' },
      parentToolUseId: 'pB',
    });
    expect(calls.filter((e) => e.name === 'Bash')).toHaveLength(2);

    expect(statuses.find((e) => e.toolCallId === 'ca')).toEqual({
      type: 'tool-status',
      toolCallId: 'ca',
      status: 'result',
      result: 'child-a result',
    });
    expect(statuses.find((e) => e.toolCallId === 'cb')).toEqual({
      type: 'tool-status',
      toolCallId: 'cb',
      status: 'result',
      result: 'child-b result',
    });
  });
});
