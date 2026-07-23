// tests/compaction.test.ts
// W6 Context-Compression — pure, deterministic coverage (no network/keys/FS writes).
//
// Synthesized from the cross-family triad drafts. Exercises the four pure surfaces
// plus the fake-client compactor:
//   * reducer `compact` (summary + verbatim tail, monotonic id, field preservation)
//   * selectors estimate/pressure/shouldCompact
//   * compactor chooseKeepCount (budget-respecting, user-boundary-aware)
//   * runCompaction against an inline fake ModelClient (text accumulation, abort, empty)
//   * buildCompactionInput (system instruction + folded transcript, tools-less)
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_SYSTEM_PROMPT,
  buildCompactionInput,
  chooseKeepCount,
  classifyCompactionFailure,
  runCompaction,
  runCompactionWithRetry,
  snapKeepPastToolResults,
} from '../src/agent/compactor';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { committedForModel, initialState, reducer, type Msg, type State } from '../src/core/reducer';
import { toTurnMessages } from '../src/hooks/useStreamingTurn';
import {
  estimateMessageTokens,
  estimateTranscriptTokens,
  selectContextPressure,
  selectStatusLine,
  shouldCompact,
} from '../src/core/selectors';

function msg(id: string, role: Msg['role'], text: string): Msg {
  return {
    id,
    role,
    blocks: [{ kind: 'text', id: `${id}:block:1`, text }],
    done: true,
  };
}

function stateWithMessages(committed: Msg[]): State {
  return { ...initialState(), committed };
}

function scriptedClient(events: ReadonlyArray<AgentEvent>, seenTools?: ToolSpec[][]): ModelClient {
  return {
    streamTurn: async function* (
      _input: TurnInput,
      tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      seenTools?.push(tools);
      for (const event of events) {
        if (signal.aborted) {
          return;
        }
        yield event;
        await Promise.resolve();
      }
    },
  };
}

describe('reducer compact', () => {
  it('keeps UI history append-only while rebuilding the model view as summary plus tail', () => {
    const tools = {
      tc1: { status: 'result' as const, name: 'read_file', args: { path: 'a.ts' }, result: 'ok' },
    };
    const before: State = {
      ...initialState(),
      committed: [
        msg('u1', 'user', 'one'),
        msg('a1', 'assistant', 'two'),
        msg('u2', 'user', 'three'),
        msg('a2', 'assistant', 'four'),
      ],
      live: msg('live', 'assistant', 'partial'),
      tools,
      phase: 'awaiting-permission',
      overlay: 'permission',
      effort: 'high',
      permissionMode: 'acceptEdits',
      tokens: { in: 12, out: 34 },
      pendingPermission: { toolCallId: 'tc1', risk: 'risky' },
    };

    const after = reducer(before, { t: 'compact', summaryText: 'SUMMARY', keepCount: 2 });

    expect(after.committed.slice(0, -1)).toEqual(before.committed);
    expect(after.committed.at(-1)).toEqual({
      id: 'compaction-notice-1',
      role: 'system',
      done: true,
      blocks: [{
        kind: 'notice',
        id: 'compaction-notice-1:block:1',
        text: 'compacted 2 messages',
      }],
      compactionBoundary: { summaryText: 'SUMMARY', keepCount: 2 },
    });
    expect(committedForModel(after)).toEqual([
      {
        id: 'compaction-notice-1:summary',
        role: 'system',
        done: true,
        blocks: [{
          kind: 'text',
          id: 'compaction-notice-1:summary:block:1',
          text: 'SUMMARY',
        }],
      },
      before.committed[2],
      before.committed[3],
    ]);
    expect(after.compactions).toBe(1);
    expect(after.transcriptEpoch).toBeUndefined();
    expect(after.conversationEpoch).toBe(1);
    expect(estimateTranscriptTokens(after)).toBeLessThan(estimateTranscriptTokens(before));
    // Preserved (same references where applicable).
    expect(after.tokens).toBe(before.tokens);
    expect(after.effort).toBe('high');
    expect(after.permissionMode).toBe('acceptEdits');
    expect(after.tools).toBe(tools);
    // Turn/overlay reset.
    expect(after.live).toBeNull();
    expect(after.phase).toBe('idle');
    expect(after.overlay).toBe('none');
    expect(after.pendingPermission).toBeNull();

    // Monotonic id on a second compaction.
    const second = reducer(after, { t: 'compact', summaryText: 'SECOND', keepCount: 1 });
    expect(second.committed.at(-1)?.id).toBe('compaction-notice-2');
    expect(second.compactions).toBe(2);
    expect(second.conversationEpoch).toBe(2);

    // keepCount 0 still preserves UI history while the model sees only the summary.
    const summaryOnly = reducer(before, { t: 'compact', summaryText: 'ONLY', keepCount: 0 });
    expect(summaryOnly.committed.slice(0, -1)).toEqual(before.committed);
    expect(committedForModel(summaryOnly)).toHaveLength(1);
    expect(committedForModel(summaryOnly)[0]?.blocks[0]).toMatchObject({
      kind: 'text',
      text: 'ONLY',
    });
  });

  it('sends summary + kept tail + later appends while omitting the UI marker', () => {
    let state: State = {
      ...initialState(),
      committed: [
        msg('u1', 'user', 'one'),
        msg('a1', 'assistant', 'two'),
        msg('u2', 'user', 'three'),
        msg('a2', 'assistant', 'four'),
      ],
    };
    state = reducer(state, { t: 'compact', summaryText: 'SUMMARY', keepCount: 2 });
    state = reducer(state, { t: 'user-submit', id: 'u3', text: 'five' });

    expect(toTurnMessages(state)).toEqual([
      { role: 'system', content: 'SUMMARY' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
    ]);
    expect(toTurnMessages(state).some((message) => message.content.includes('compacted'))).toBe(false);
  });
});

describe('context pressure selectors', () => {
  it('estimates transcript size, clamps pressure, and gates compaction by current transcript size', () => {
    const tiny = stateWithMessages([msg('u1', 'user', 'hello')]);
    const large = stateWithMessages([
      msg('u1', 'user', 'x'.repeat(500)),
      msg('a1', 'assistant', 'x'.repeat(500)),
      msg('u2', 'user', 'x'.repeat(500)),
      msg('a2', 'assistant', 'x'.repeat(500)),
      msg('u3', 'user', 'x'.repeat(500)),
    ]);

    expect(estimateTranscriptTokens(large)).toBeGreaterThan(estimateTranscriptTokens(tiny));
    expect(selectContextPressure(large, 1)).toBe(1);
    expect(selectContextPressure(large, 0)).toBe(0);
    // Tiny transcript never compacts (below MIN_MESSAGES_TO_COMPACT).
    expect(shouldCompact(tiny, 1, 0.5)).toBe(false);
    // Large transcript over threshold with enough messages compacts.
    expect(shouldCompact(large, 100, 0.5)).toBe(true);
  });

  it('selectStatusLine surfaces the compaction count', () => {
    const state = stateWithMessages([msg('u1', 'user', 'x'.repeat(400))]);
    state.compactions = 3;
    const line = selectStatusLine(state, { maxContext: 10_000 });
    expect(line.compactions).toBe(3);
  });

  it('derives isCompacting from the reducer phase (compacting) and clears it otherwise', () => {
    const state = stateWithMessages([msg('u1', 'user', 'x'.repeat(400))]);

    // isCompacting is now derived from the reducer's 'compacting' phase, not a context
    // arg — the reducer is the sole authority for "a compaction is in flight". The
    // indicator is independent of the compaction COUNT (the FIRST compaction still reads
    // compactions=0 until its `compact` action lands).
    const during = selectStatusLine({ ...state, phase: 'compacting' }, { maxContext: 10_000 });
    expect(during.isCompacting).toBe(true);

    // Any non-compacting phase leaves the indicator inactive.
    expect(selectStatusLine({ ...state, phase: 'idle' }, { maxContext: 10_000 }).isCompacting).toBe(false);
    expect(selectStatusLine(state, { maxContext: 10_000 }).isCompacting).toBe(false);
  });
});

describe('chooseKeepCount', () => {
  it('chooses a coherent trailing user turn when budget allows', () => {
    const committed = [
      msg('u1', 'user', 'old user '.repeat(80)),
      msg('a1', 'assistant', 'old assistant '.repeat(80)),
      msg('u2', 'user', 'recent question'),
      msg('a2', 'assistant', 'recent answer'),
    ];
    const budget = estimateMessageTokens(committed[2]!) + estimateMessageTokens(committed[3]!) + 1;
    const keepCount = chooseKeepCount(committed, budget);
    const tail = committed.slice(-keepCount);

    expect(keepCount).toBe(2);
    expect(tail[0]?.role).toBe('user');
  });

  it('respects budget when the preceding user boundary would exceed it', () => {
    const committed = [
      msg('u1', 'user', 'old user '.repeat(80)),
      msg('a1', 'assistant', 'old assistant '.repeat(80)),
      msg('u2', 'user', 'recent question '.repeat(80)),
      msg('a2', 'assistant', 'recent answer'),
    ];
    const budget = estimateMessageTokens(committed[3]!) + 1;
    const keepCount = chooseKeepCount(committed, budget);

    expect(keepCount).toBe(1);
    expect(estimateMessageTokens(committed[3]!)).toBeLessThanOrEqual(budget);
  });

  it('never exceeds committed length and keeps at least one message when non-empty', () => {
    expect(chooseKeepCount([], 10)).toBe(0);

    const committed = [msg('u1', 'user', 'one'), msg('a1', 'assistant', 'two')];
    const keepCount = chooseKeepCount(committed, 0);

    expect(keepCount).toBeGreaterThanOrEqual(1);
    expect(keepCount).toBeLessThanOrEqual(committed.length);
  });
});

describe('runCompaction', () => {
  it('joins streamed text deltas and passes NO tools to the model client', async () => {
    const seenTools: ToolSpec[][] = [];
    const client = scriptedClient(
      [
        { type: 'assistant-start', id: 'c1' },
        { type: 'text-delta', id: 'c1', delta: 'SUM' },
        { type: 'text-delta', id: 'c1', delta: 'MARY' },
        { type: 'assistant-done', id: 'c1', stopReason: 'end' },
      ],
      seenTools,
    );

    const summary = await runCompaction(
      [{ role: 'user', content: 'please summarize' }],
      client,
      new AbortController().signal,
    );

    expect(summary).toBe('SUMMARY');
    expect(seenTools).toEqual([[]]);
  });

  it('returns promptly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const summary = await runCompaction(
      [{ role: 'user', content: 'please summarize' }],
      scriptedClient([{ type: 'text-delta', id: 'c1', delta: 'late' }]),
      controller.signal,
    );

    expect(summary).toBe('');
  });

  it('stops accumulating once the signal aborts mid-stream', async () => {
    const controller = new AbortController();
    const client: ModelClient = {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'text-delta', id: 'c1', delta: 'part1' };
        controller.abort();
        yield { type: 'text-delta', id: 'c1', delta: 'part2' };
      },
    };
    const summary = await runCompaction(
      [{ role: 'user', content: 'x' }],
      client,
      controller.signal,
    );
    expect(summary).toBe('part1');
  });

  it('returns an empty string for an empty stream', async () => {
    const summary = await runCompaction(
      [{ role: 'user', content: 'please summarize' }],
      scriptedClient([]),
      new AbortController().signal,
    );

    expect(summary).toBe('');
  });

  it('returns "" for an empty transcript without invoking the client', async () => {
    let called = false;
    const client: ModelClient = {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        called = true;
      },
    };
    const summary = await runCompaction([], client, new AbortController().signal);
    expect(summary).toBe('');
    expect(called).toBe(false);
  });

  // E: failure surfacing — every PRODUCTION ModelClient reports a summarizer failure by
  // YIELDING an `{type:'error'}` AgentEvent (claude-cli exit-non-zero/stall, the
  // openai/anthropic HTTP + stream paths); none of them throw to the consumer. So an
  // error event with no usable text must surface as a real failure (the manual /compact
  // path turns it into an honest notice) instead of swallowing to '' — the exact case a
  // throwing fake never exercised.
  it('throws when the summarizer yields an error event before any text accumulates', async () => {
    const client = scriptedClient([
      { type: 'assistant-start', id: 'c1' },
      { type: 'error', message: 'model backend exited non-zero' },
    ]);
    await expect(
      runCompaction([{ role: 'user', content: 'x' }], client, new AbortController().signal),
    ).rejects.toThrow('model backend exited non-zero');
  });

  // …but an error event AFTER partial text keeps the partial summary (never discard
  // usable output over a late failure).
  it('keeps the partial summary when an error event follows streamed text', async () => {
    const client = scriptedClient([
      { type: 'text-delta', id: 'c1', delta: 'PART' },
      { type: 'error', message: 'late failure' },
    ]);
    const summary = await runCompaction(
      [{ role: 'user', content: 'x' }],
      client,
      new AbortController().signal,
    );
    expect(summary).toBe('PART');
  });

  // Defensive: a genuinely THROWN error (not the shipped-client shape) is still
  // rethrown before any text, and still tolerated after partial text.
  it('rethrows a thrown error before text and keeps partial text after a throw', async () => {
    const throwsEarly: ModelClient = {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: 'c1' };
        throw new Error('summarizer exploded');
      },
    };
    await expect(
      runCompaction([{ role: 'user', content: 'x' }], throwsEarly, new AbortController().signal),
    ).rejects.toThrow('summarizer exploded');

    const throwsLate: ModelClient = {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'text-delta', id: 'c1', delta: 'PART' };
        throw new Error('late failure');
      },
    };
    expect(
      await runCompaction([{ role: 'user', content: 'x' }], throwsLate, new AbortController().signal),
    ).toBe('PART');
  });
});

describe('buildCompactionInput', () => {
  it('builds a system-instructed summarization turn with one folded user transcript', () => {
    const messages: TurnMessage[] = [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: 'I will inspect the tree.',
        toolCalls: [{ toolCallId: 'tc1', name: 'list_files', args: { path: '.' } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'src/index.ts' },
    ];

    const input = buildCompactionInput(messages, 'compact-test');

    expect(input.id).toBe('compact-test');
    expect(input.messages[0]?.role).toBe('system');
    // The structured multi-section prompt: a section header + the carry-forward clause
    // (stops detail decay across successive compactions) + the no-tools guard.
    expect(input.messages[0]?.content).toContain('Files touched (exact paths)');
    expect(input.messages[0]?.content).toContain('carry every still-relevant fact forward verbatim');
    expect(input.messages[0]?.content).toContain('Do not call any tool');
    expect(input.messages[1]?.role).toBe('user');

    const folded = input.messages[1];
    if (folded?.role !== 'user') {
      throw new Error('expected folded user message');
    }

    expect(folded.content).toContain('[user] list files');
    expect(folded.content).toContain('[assistant] I will inspect the tree.');
    expect(folded.content).toContain('list_files');
    expect(folded.content).toContain('[tool tc1]');
    // No `tools` concept leaks onto TurnInput (frozen contract — tools passed as [] at call).
    expect(Object.prototype.hasOwnProperty.call(input, 'tools')).toBe(false);
  });
});

// RANK 1 — the two load-bearing clauses of the structured summarization prompt.
describe('COMPACTION_SYSTEM_PROMPT', () => {
  it('carries prior compaction summaries forward and forbids tool calls', () => {
    // Carry-forward: the transcript re-folds juno's OWN prior `compaction-<n>` message
    // (labeled `[system]`), so the prompt must instruct preserving it verbatim.
    expect(COMPACTION_SYSTEM_PROMPT).toContain('earlier compaction summary');
    expect(COMPACTION_SYSTEM_PROMPT).toContain('earlier [system] summary line');
    expect(COMPACTION_SYSTEM_PROMPT).toContain('carry every still-relevant fact forward verbatim');
    // No-tools guard keeps this a pure text turn.
    expect(COMPACTION_SYSTEM_PROMPT).toContain('Produce ONLY the summary text');
    expect(COMPACTION_SYSTEM_PROMPT).toContain('Do not call any tool');
  });
});

// RANK 2 — snap the kept-tail boundary past orphan tool results.
describe('snapKeepPastToolResults', () => {
  it('snaps forward when the tail would open on a tool-result message', () => {
    const committed = [
      msg('u1', 'user', 'ask'),
      msg('a1', 'assistant', 'call'),
      msg('t1', 'tool', 'result'),
      msg('a2', 'assistant', 'answer'),
    ];
    // keepCount 2 would start the tail at the tool Msg (committed[2]).
    const snapped = snapKeepPastToolResults(committed, 2);
    expect(snapped).toBe(1);
    expect(committed.slice(-snapped)[0]?.role).not.toBe('tool');
  });

  it('snaps an all-tool tail down to 0 (summary-only is orphan-free)', () => {
    const committed = [msg('u1', 'user', 'ask'), msg('t1', 'tool', 'r1'), msg('t2', 'tool', 'r2')];
    expect(snapKeepPastToolResults(committed, 2)).toBe(0);
  });

  it('returns the count unchanged when the tail already opens on user/assistant/system', () => {
    const committed = [msg('t0', 'tool', 'r'), msg('u1', 'user', 'ask'), msg('a1', 'assistant', 'ans')];
    // Tail of 2 opens on the user Msg — nothing to snap.
    expect(snapKeepPastToolResults(committed, 2)).toBe(2);
  });

  it('integration: a budget-exhaustion boundary landing on a tool Msg is snapped off it', () => {
    const committed = [
      msg('u1', 'user', 'old user '.repeat(200)), // huge — including it blows the budget
      msg('t1', 'tool', 'tool result '.repeat(20)),
      msg('a1', 'assistant', 'answer'),
    ];
    // Budget fits exactly the assistant + tool tail, but not the preceding huge user turn,
    // so chooseKeepCount stops on budget exhaustion with the tail opening on the tool Msg.
    const budget = estimateMessageTokens(committed[2]!) + estimateMessageTokens(committed[1]!) + 1;
    const raw = chooseKeepCount(committed, budget);
    expect(committed.slice(-raw)[0]?.role).toBe('tool'); // the precondition that would 400

    const snapped = snapKeepPastToolResults(committed, raw);
    expect(committed.slice(-snapped)[0]?.role).not.toBe('tool');
  });
});

// RANK 15 — bounded retry + degenerate-summary detection.

/** A client whose per-attempt event script varies by call index (last script repeats). */
function multiAttemptClient(perAttempt: ReadonlyArray<ReadonlyArray<AgentEvent>>): {
  client: ModelClient;
  calls: () => number;
} {
  let call = 0;
  const client: ModelClient = {
    streamTurn: async function* (
      _input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      const events = perAttempt[call] ?? perAttempt[perAttempt.length - 1] ?? [];
      call += 1;
      for (const event of events) {
        if (signal.aborted) return;
        yield event;
        await Promise.resolve();
      }
    },
  };
  return { client, calls: () => call };
}

const NO_BACKOFF = { baseDelayMs: 0 } as const;
const longSummary = 'S'.repeat(250); // >= MIN_SUMMARY_SEED (200)
function textThenDone(delta: string): ReadonlyArray<AgentEvent> {
  return [
    { type: 'text-delta', id: 'c', delta },
    { type: 'assistant-done', id: 'c', stopReason: 'end' },
  ];
}

describe('runCompactionWithRetry', () => {
  const sig = (): AbortSignal => new AbortController().signal;

  it('retries an empty first attempt and returns the second attempt text', async () => {
    const { client, calls } = multiAttemptClient([[], textThenDone(longSummary)]);
    const out = await runCompactionWithRetry([{ role: 'user', content: 'x' }], client, sig(), NO_BACKOFF);
    expect(out).toBe(longSummary);
    expect(calls()).toBe(2);
  });

  it('retries a degenerately short summary', async () => {
    const { client, calls } = multiAttemptClient([textThenDone('short'), textThenDone(longSummary)]);
    const out = await runCompactionWithRetry([{ role: 'user', content: 'x' }], client, sig(), NO_BACKOFF);
    expect(out).toBe(longSummary);
    expect(calls()).toBe(2);
  });

  it('rethrows a context-length error immediately with NO second attempt', async () => {
    const { client, calls } = multiAttemptClient([
      [
        { type: 'assistant-start', id: 'c' },
        { type: 'error', message: 'prompt is too long: 300000 tokens' },
      ],
      textThenDone(longSummary),
    ]);
    await expect(
      runCompactionWithRetry([{ role: 'user', content: 'x' }], client, sig(), NO_BACKOFF),
    ).rejects.toThrow('prompt is too long');
    expect(calls()).toBe(1);
  });

  it('retries a transient error then succeeds', async () => {
    const { client, calls } = multiAttemptClient([
      [
        { type: 'assistant-start', id: 'c' },
        { type: 'error', message: 'connection reset by peer' },
      ],
      textThenDone(longSummary),
    ]);
    const out = await runCompactionWithRetry([{ role: 'user', content: 'x' }], client, sig(), NO_BACKOFF);
    expect(out).toBe(longSummary);
    expect(calls()).toBe(2);
  });

  it('returns "" with zero attempts when the signal is already aborted', async () => {
    const { client, calls } = multiAttemptClient([textThenDone(longSummary)]);
    const controller = new AbortController();
    controller.abort();
    const out = await runCompactionWithRetry(
      [{ role: 'user', content: 'x' }],
      client,
      controller.signal,
      NO_BACKOFF,
    );
    expect(out).toBe('');
    expect(calls()).toBe(0);
  });

  it('returns the best non-empty short summary after exhausting all attempts', async () => {
    const { client, calls } = multiAttemptClient([
      textThenDone('short-1'),
      textThenDone('short-2'),
      textThenDone('short-3'),
    ]);
    const out = await runCompactionWithRetry([{ role: 'user', content: 'x' }], client, sig(), {
      baseDelayMs: 0,
      maxAttempts: 3,
    });
    expect(out).toBe('short-3'); // best non-empty (ties resolve to latest); never throws
    expect(calls()).toBe(3);
  });
});

describe('classifyCompactionFailure', () => {
  it('flags context-length overflow messages', () => {
    for (const message of [
      'This model has a maximum context length of 200000 tokens',
      'context_length_exceeded',
      'prompt is too long: 250000 tokens',
      'input is too long',
      'too many tokens in the request',
      'please reduce the length of the messages',
      'input length exceeds the model limit',
    ]) {
      expect(classifyCompactionFailure(message)).toBe('context_length');
    }
  });

  it('treats 4xx-shaped / validation messages as deterministic', () => {
    for (const message of [
      '400 Bad Request',
      'invalid request payload',
      '422 Unprocessable Entity',
      '401 unauthorized',
    ]) {
      expect(classifyCompactionFailure(message)).toBe('deterministic');
    }
  });

  it('treats network / rate-limit / server errors as transient', () => {
    for (const message of [
      'connection reset by peer',
      '503 Service Unavailable',
      'rate limit exceeded',
      'overloaded',
      'network timeout',
    ]) {
      expect(classifyCompactionFailure(message)).toBe('transient');
    }
  });
});
