// tests/midTurnCompaction.test.ts
// Wave-12 — MID-TURN (preflight) context compaction.
//
// Deterministic: no network, no keys, no real FS writes. Four surfaces:
//   * selectors estimateTurnMessageTokens / estimateTurnTranscriptTokens (the char/4
//     + PER_MSG_OVERHEAD + toolCalls*PER_TOOL_BLOCK shape, over the wire TurnMessage type)
//   * midTurnCompaction chooseTurnKeepCount (budget-respecting, user-boundary-aware, AND
//     the tool-pair-safety forward snap so the kept tail never opens on a role:'tool')
//   * midTurnCompaction maybeCompactTurnMessages against an inline scripted fake ModelClient
//     (feature-off, under/over threshold, empty/thrown summary, aborted signal)
//   * turnRunner end-to-end (coordinator.test.ts pattern): a multi-iteration tool loop that
//     crosses threshold shrinks the transcript the client sees on the 2nd turn while the loop
//     still completes, and an under-threshold loop is byte-for-byte inert.
import { describe, expect, it } from 'vitest';
import {
  chooseTurnKeepCount,
  maybeCompactTurnMessages,
  MID_TURN_SUMMARY_PREFIX,
} from '../src/agent/midTurnCompaction';
import {
  estimateTurnMessageTokens,
  estimateTurnTranscriptTokens,
} from '../src/core/selectors';
import type { Action, State } from '../src/core/reducer';
import { initialState, reducer } from '../src/core/reducer';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, Tool, ToolSpec, TurnInput, TurnMessage } from '../src/core/contracts';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createToolExecutor } from '../src/tools/executor';
import { createPermissionRegistry } from '../src/agent/eventBus';
import { runTurn } from '../src/agent/turnRunner';

// --- TurnMessage builders ----------------------------------------------------

function u(content: string): TurnMessage {
  return { role: 'user', content };
}
function sys(content: string): TurnMessage {
  return { role: 'system', content };
}
function tool(toolCallId: string, content: string): TurnMessage {
  return { role: 'tool', toolCallId, content };
}
function assistant(
  content: string,
  toolCalls?: Array<{ toolCallId: string; name: string; args: unknown }>,
): TurnMessage {
  return toolCalls !== undefined
    ? { role: 'assistant', content, toolCalls }
    : { role: 'assistant', content };
}

// ---------------------------------------------------------------------------
// estimateTurnMessageTokens / estimateTurnTranscriptTokens
// PER_MSG_OVERHEAD = 4, PER_TOOL_BLOCK = 6 (selectors.ts) — pinned by value below.
// ---------------------------------------------------------------------------

describe('estimateTurnMessageTokens', () => {
  it('is ceil(content.length/4) + PER_MSG_OVERHEAD for a plain message', () => {
    // user, 40 chars: ceil(40/4)=10, +4 overhead = 14.
    expect(estimateTurnMessageTokens(u('x'.repeat(40)))).toBe(14);
    // system, 3 chars: ceil(3/4)=1, +4 = 5.
    expect(estimateTurnMessageTokens(sys('sys'))).toBe(5);
  });

  it('counts a tool-role message by its serialized-result content string', () => {
    // tool content is the serialized result: 16 chars -> ceil(16/4)=4, +4 = 8.
    expect(estimateTurnMessageTokens(tool('t1', 'x'.repeat(16)))).toBe(8);
    // A longer result string costs more (the content is what's counted).
    expect(estimateTurnMessageTokens(tool('t1', 'x'.repeat(16)))).toBeLessThan(
      estimateTurnMessageTokens(tool('t1', 'x'.repeat(64))),
    );
  });

  it('adds PER_TOOL_BLOCK per assistant toolCall on top of the content estimate', () => {
    // assistant, 20 chars, 2 toolCalls: ceil(20/4)=5, +4, +2*6=12 -> 21.
    const withTools = assistant('x'.repeat(20), [
      { toolCallId: 'a', name: 'noop', args: {} },
      { toolCallId: 'b', name: 'noop', args: {} },
    ]);
    expect(estimateTurnMessageTokens(withTools)).toBe(21);
    // Same content with no toolCalls: ceil(20/4)=5, +4 -> 9. The delta is exactly 2*PER_TOOL_BLOCK.
    const noTools = assistant('x'.repeat(20));
    expect(estimateTurnMessageTokens(noTools)).toBe(9);
    expect(estimateTurnMessageTokens(withTools) - estimateTurnMessageTokens(noTools)).toBe(12);
  });

  it('estimateTurnTranscriptTokens sums the per-message estimate', () => {
    const msgs = [u('x'.repeat(40)), assistant('x'.repeat(20)), tool('t1', 'x'.repeat(16))];
    // 14 + 9 + 8 = 31.
    expect(estimateTurnTranscriptTokens(msgs)).toBe(31);
    expect(estimateTurnTranscriptTokens([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// chooseTurnKeepCount
// ---------------------------------------------------------------------------

describe('chooseTurnKeepCount', () => {
  it('keeps a coherent trailing user turn when budget allows', () => {
    const messages = [
      u('old user '.repeat(80)),
      assistant('old assistant '.repeat(80)),
      u('recent question'),
      assistant('recent answer'),
    ];
    const budget =
      estimateTurnMessageTokens(messages[2]!) + estimateTurnMessageTokens(messages[3]!) + 1;
    const keepCount = chooseTurnKeepCount(messages, budget);
    const tail = messages.slice(messages.length - keepCount);

    expect(keepCount).toBe(2);
    expect(tail[0]?.role).toBe('user');
  });

  it('respects budget when the preceding user boundary would exceed it', () => {
    const messages = [
      u('old user '.repeat(80)),
      assistant('old assistant '.repeat(80)),
      u('recent question '.repeat(80)),
      assistant('recent answer'),
    ];
    const budget = estimateTurnMessageTokens(messages[3]!) + 1;
    expect(chooseTurnKeepCount(messages, budget)).toBe(1);
  });

  it('snaps the boundary FORWARD so the kept tail never opens on an orphan tool_result', () => {
    const messages = [
      u('x'.repeat(4000)), // 0: huge prefix
      assistant('', [{ toolCallId: 'tc1', name: 'noop', args: {} }]), // 1: assistant tool_use
      tool('tc1', 'RESULT'), // 2: tool result
      assistant('final answer'), // 3: assistant answer
    ];
    // Budget large enough for [tool(2), assistant(3)] but not the assistant(1) before them, so
    // the NAIVE budget walk would land the tail on messages[2] — a role:'tool' orphan.
    const budget =
      estimateTurnMessageTokens(messages[2]!) + estimateTurnMessageTokens(messages[3]!) + 1;
    // Document the naive landing: 2 messages from the end opens on the tool result.
    expect(messages[messages.length - 2]?.role).toBe('tool');

    const keepCount = chooseTurnKeepCount(messages, budget);
    const tail = messages.slice(messages.length - keepCount);
    const prefix = messages.slice(0, messages.length - keepCount);

    // The forward snap moved the boundary past the orphan tool_result.
    expect(keepCount).toBe(1);
    expect(tail[0]?.role).not.toBe('tool');
    expect(tail).toEqual([messages[3]]);
    // The snapped-past tool result is folded into the summarized prefix, not the kept tail.
    expect(prefix).toContain(messages[2]);
  });

  it('returns 0 for empty and keeps >= 1 within length for a non-empty transcript at budget 0', () => {
    expect(chooseTurnKeepCount([], 10)).toBe(0);
    const two = [u('one'), assistant('two')];
    const k = chooseTurnKeepCount(two, 0);
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// maybeCompactTurnMessages — inline scripted fake ModelClient
// ---------------------------------------------------------------------------

interface SeenInputs {
  readonly inputs: TurnInput[];
}

/** A tools-less summarizer client that records each input and yields `summary`. */
function summarizerClient(summary: string, seen?: SeenInputs): ModelClient {
  return {
    streamTurn: async function* (
      input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      seen?.inputs.push(input);
      if (signal.aborted) {
        return;
      }
      yield { type: 'assistant-start', id: 'sum' };
      if (summary.length > 0) {
        yield { type: 'text-delta', id: 'sum', delta: summary };
      }
      yield { type: 'assistant-done', id: 'sum', stopReason: 'end' };
    },
  };
}

/** 5 messages whose char/4 estimate is well over 0.5 × 1000 (the default threshold). */
function overThresholdMessages(): TurnMessage[] {
  return [
    sys('sys'), // 0
    u('x'.repeat(4000)), // 1: HUGE (~1004 tokens)
    assistant('', [{ toolCallId: 'tc1', name: 'noop', args: {} }]), // 2: tool_use
    tool('tc1', 'RESULT'), // 3: tool result
    assistant('final answer'), // 4: answer
  ];
}

describe('maybeCompactTurnMessages', () => {
  const fresh = (): AbortSignal => new AbortController().signal;

  it('feature-off: maxContext undefined ⇒ unchanged, no streamTurn call', async () => {
    const seen: SeenInputs = { inputs: [] };
    const messages = overThresholdMessages();
    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient('SUMMARY', seen) },
      fresh(),
    );
    expect(result).toBe(messages);
    expect(seen.inputs).toHaveLength(0);
  });

  it('under threshold ⇒ unchanged, no streamTurn call', async () => {
    const seen: SeenInputs = { inputs: [] };
    // 5 tiny messages, far under 0.5 × 1_000_000.
    const messages = [sys('a'), u('b'), assistant('c'), tool('t', 'd'), assistant('e')];
    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient('SUMMARY', seen), maxContext: 1_000_000 },
      fresh(),
    );
    expect(result).toBe(messages);
    expect(seen.inputs).toHaveLength(0);
  });

  it('at/below the message floor ⇒ unchanged even when over threshold', async () => {
    const seen: SeenInputs = { inputs: [] };
    // 4 messages (== MIN_MESSAGES_TO_COMPACT) but a huge byte count: still a no-op.
    const messages = [sys('s'), u('x'.repeat(4000)), assistant('a'), tool('t', 'r')];
    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient('SUMMARY', seen), maxContext: 1000 },
      fresh(),
    );
    expect(result).toBe(messages);
    expect(seen.inputs).toHaveLength(0);
  });

  it('over threshold ⇒ prefix folded into ONE summary message + tail preserved + tail[0] not tool', async () => {
    const seen: SeenInputs = { inputs: [] };
    const messages = overThresholdMessages();
    // Force the naive boundary onto the tool result so the forward snap must fire.
    const keepBudget =
      estimateTurnMessageTokens(messages[3]!) + estimateTurnMessageTokens(messages[4]!) + 1;

    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient('DENSE SUMMARY', seen), maxContext: 1000, compactionKeepBudget: keepBudget },
      fresh(),
    );

    // One summarization round-trip over the prefix (which INCLUDES the snapped-past tool result).
    expect(seen.inputs).toHaveLength(1);
    // Head is the single folded-summary user message.
    expect(result[0]).toEqual({
      role: 'user',
      content: `${MID_TURN_SUMMARY_PREFIX}\nDENSE SUMMARY`,
    });
    // Tail preserved verbatim and never opens on a role:'tool' (snap-forward).
    expect(result.slice(1)).toEqual([messages[4]]);
    expect(result[1]?.role).not.toBe('tool');
    // Strictly shorter than the original transcript.
    expect(result).toHaveLength(2);
    expect(result.length).toBeLessThan(messages.length);
  });

  it('empty summary ⇒ original messages returned unchanged (context safety)', async () => {
    const messages = overThresholdMessages();
    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient(''), maxContext: 1000 },
      fresh(),
    );
    expect(result).toBe(messages);
  });

  it('throwing summarizer ⇒ original messages returned unchanged (never crash the turn)', async () => {
    const throwing: ModelClient = {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: 'sum' };
        throw new Error('summarizer exploded');
      },
    };
    const messages = overThresholdMessages();
    const result = await maybeCompactTurnMessages(
      messages,
      { client: throwing, maxContext: 1000 },
      fresh(),
    );
    expect(result).toBe(messages);
  });

  it('already-aborted signal ⇒ unchanged, no streamTurn call', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: SeenInputs = { inputs: [] };
    const messages = overThresholdMessages();
    const result = await maybeCompactTurnMessages(
      messages,
      { client: summarizerClient('SUMMARY', seen), maxContext: 1000 },
      controller.signal,
    );
    expect(result).toBe(messages);
    expect(seen.inputs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// turnRunner end-to-end (coordinator.test.ts pattern)
// ---------------------------------------------------------------------------

interface Harness {
  readonly actions: Action[];
  readonly dispatch: (action: Action) => void;
  readonly getState: () => State;
}

function createHarness(): Harness {
  let state = initialState();
  const actions: Action[] = [];
  return {
    actions,
    dispatch: (action: Action): void => {
      actions.push(action);
      state = reducer(state, action);
    },
    getState: (): State => state,
  };
}

/** A `safe` tool the default policy auto-allows (no parking) — records its args. */
function safeNoopTool(runCalls: unknown[]): Tool {
  return {
    name: 'noop',
    risk: 'safe',
    spec: { name: 'noop', description: 'safe counting tool', inputSchema: { type: 'object' } },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { ran: true } };
    },
  };
}

/**
 * A model client that BRANCHES on the input id: a `compaction-summary-*` id (built by
 * runCompaction/buildCompactionInput) is the mid-turn summarization round-trip and yields a
 * fixed summary; everything else is a REAL turn drawn from `realTurns`. Records the two
 * input streams separately so the test can assert what the model actually saw per real turn.
 */
function compactionAwareClient(realTurns: ReadonlyArray<ReadonlyArray<AgentEvent>>): {
  client: ModelClient;
  realInputs: TurnInput[];
  compactionInputs: TurnInput[];
} {
  let realCall = 0;
  const realInputs: TurnInput[] = [];
  const compactionInputs: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn: async function* (
      input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      if (input.id.startsWith('compaction-summary')) {
        compactionInputs.push(input);
        yield { type: 'assistant-start', id: 'sum' };
        yield { type: 'text-delta', id: 'sum', delta: 'SUMMARY' };
        yield { type: 'assistant-done', id: 'sum', stopReason: 'end' };
        return;
      }
      realInputs.push(input);
      const events = realTurns[realCall] ?? [
        { type: 'assistant-start', id: `a-end-${realCall}` },
        { type: 'assistant-done', id: `a-end-${realCall}`, stopReason: 'end' },
      ];
      realCall += 1;
      for (const event of events) {
        if (signal.aborted) {
          yield { type: 'aborted', reason: 'aborted' };
          return;
        }
        yield event;
        await Promise.resolve();
      }
    },
  };
  return { client, realInputs, compactionInputs };
}

function noopToolUseTurn(i: number): ReadonlyArray<AgentEvent> {
  return [
    { type: 'assistant-start', id: `a-${i}` },
    { type: 'tool-call', id: `a-${i}`, toolCallId: `tc-${i}`, name: 'noop', args: { i } },
    { type: 'assistant-done', id: `a-${i}`, stopReason: 'tool_use' },
  ];
}

function endTurn(): ReadonlyArray<AgentEvent> {
  return [
    { type: 'assistant-start', id: 'a-final' },
    { type: 'text-delta', id: 'a-final', delta: 'done' },
    { type: 'assistant-done', id: 'a-final', stopReason: 'end' },
  ];
}

interface RunResult {
  readonly runCalls: unknown[];
  readonly harness: Harness;
  readonly realInputs: TurnInput[];
  readonly compactionInputs: TurnInput[];
}

/** Drive one runTurn through the REAL executor + a safe auto-allowed tool. */
async function driveTurn(
  initialMessages: TurnMessage[],
  maxContext?: number,
): Promise<RunResult> {
  const harness = createHarness();
  const registry = createPermissionRegistry();
  const controller = new AbortController();
  const policy = createPermissionPolicy(); // autoAllowSafe defaults true
  const runCalls: unknown[] = [];
  const tool = safeNoopTool(runCalls);
  const executor = createToolExecutor({
    tools: [tool],
    policy,
    cwd: '.',
    signal: controller.signal,
    getState: harness.getState,
    awaitPermission: registry.await,
  });
  const { client, realInputs, compactionInputs } = compactionAwareClient([
    noopToolUseTurn(0),
    endTurn(),
  ]);

  await runTurn(
    {
      id: 'turn-e2e',
      messages: initialMessages,
      model: 'test-model',
      cwd: '.',
      effort: 'medium',
    },
    {
      client,
      executor,
      specs: [tool.spec],
      dispatch: harness.dispatch,
      signal: controller.signal,
      registry,
      ...(maxContext !== undefined ? { maxContext } : {}),
    },
  );

  return { runCalls, harness, realInputs, compactionInputs };
}

/**
 * A 5-message conversation lead (> MIN_MESSAGES_TO_COMPACT, so the mid-turn floor is cleared
 * and it is the TOKEN threshold that gates) whose first message dominates the byte count.
 */
function conversationLead(headContent: string): TurnMessage[] {
  return [
    { role: 'user', content: headContent },
    { role: 'user', content: 'more context one' },
    { role: 'assistant', content: 'ok one' },
    { role: 'user', content: 'more context two' },
    { role: 'assistant', content: 'ok two' },
  ];
}

describe('turnRunner mid-turn compaction (end-to-end)', () => {
  it('a threshold-crossing tool loop shrinks the 2nd turn transcript while the loop completes', async () => {
    const HUGE = 'x'.repeat(4000);
    // 5-message lead (clears the message floor) whose huge head (~1004 tokens) trips the
    // 0.5×1000=500 token threshold once the first tool_use commits its assistant + tool_result.
    const { runCalls, harness, realInputs, compactionInputs } = await driveTurn(
      conversationLead(HUGE),
      1000,
    );

    // The tool ran once and the loop reached a clean idle terminal (it did NOT stall/crash).
    expect(runCalls).toHaveLength(1);
    expect(harness.getState().phase).toBe('idle');

    // Exactly one mid-turn summarization round-trip; two real model turns streamed.
    expect(compactionInputs).toHaveLength(1);
    expect(realInputs).toHaveLength(2);

    // The FIRST real turn saw the full huge transcript.
    expect(realInputs[0]!.messages.find((m) => m.role === 'user')?.content).toBe(HUGE);

    // The SECOND real turn was compacted BEFORE re-entry: it opens on the folded summary,
    // the huge user message is gone, and the byte count collapsed.
    const secondMessages = realInputs[1]!.messages;
    expect(secondMessages[0]).toEqual({
      role: 'user',
      content: `${MID_TURN_SUMMARY_PREFIX}\nSUMMARY`,
    });
    expect(secondMessages.some((m) => m.content === HUGE)).toBe(false);
    expect(secondMessages.length).toBeLessThan(realInputs[0]!.messages.length + 2);
    const secondBytes = secondMessages.reduce((n, m) => n + m.content.length, 0);
    expect(secondBytes).toBeLessThan(HUGE.length);
    // The freshly appended assistant(tool_use) + tool(result) pair survived intact at the end.
    expect(secondMessages.at(-2)?.role).toBe('assistant');
    expect(secondMessages.at(-1)?.role).toBe('tool');
    // No kept message opens the tail on an orphan tool_result (snap-forward held).
    expect(secondMessages[1]?.role).not.toBe('tool');
  });

  it('an under-threshold tool loop is inert: no summarization, transcript byte-for-byte unchanged', async () => {
    // Same 5-message lead (so the message floor is cleared and it is the THRESHOLD that
    // gates), but a small head + a huge maxContext ⇒ the transcript never crosses threshold.
    const { runCalls, harness, realInputs, compactionInputs } = await driveTurn(
      conversationLead('run the tool'),
      1_000_000,
    );

    expect(runCalls).toHaveLength(1);
    expect(harness.getState().phase).toBe('idle');

    // No mid-turn summarization call happened at all (threshold gate, not the message floor).
    expect(compactionInputs).toHaveLength(0);
    expect(realInputs).toHaveLength(2);

    // The 2nd real turn is the plain concatenation the loop built: no summary injected, no
    // message dropped or rewritten. Its lead is byte-identical to the 1st turn's transcript.
    const firstMessages = realInputs[0]!.messages;
    const secondMessages = realInputs[1]!.messages;
    expect(secondMessages.some((m) => m.content.startsWith(MID_TURN_SUMMARY_PREFIX))).toBe(false);
    expect(secondMessages.length).toBe(firstMessages.length + 2); // + assistant + tool_result
    expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(secondMessages[0]).toEqual({ role: 'user', content: 'run the tool' });
  });
});
