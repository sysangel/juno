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
import { buildCompactionInput, chooseKeepCount, runCompaction } from '../src/agent/compactor';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { initialState, reducer, type Msg, type State } from '../src/core/reducer';
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
  it('replaces committed history with a summary plus tail and preserves session fields', () => {
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
      pendingPermissionToolCallId: 'tc1',
    };

    const after = reducer(before, { t: 'compact', summaryText: 'SUMMARY', keepCount: 2 });

    expect(after.committed).toEqual([
      {
        id: 'compaction-1',
        role: 'system',
        done: true,
        blocks: [{ kind: 'text', id: 'compaction-1:block:1', text: 'SUMMARY' }],
      },
      before.committed[2],
      before.committed[3],
    ]);
    expect(after.committed[0]?.role).toBe('system');
    expect(after.committed[0]?.id).toBe('compaction-1');
    expect(after.compactions).toBe(1);
    // Preserved (same references where applicable).
    expect(after.tokens).toBe(before.tokens);
    expect(after.effort).toBe('high');
    expect(after.permissionMode).toBe('acceptEdits');
    expect(after.tools).toBe(tools);
    // Turn/overlay reset.
    expect(after.live).toBeNull();
    expect(after.phase).toBe('idle');
    expect(after.overlay).toBe('none');
    expect(after.pendingPermissionToolCallId).toBeNull();

    // Monotonic id on a second compaction.
    const second = reducer(after, { t: 'compact', summaryText: 'SECOND', keepCount: 1 });
    expect(second.committed[0]?.id).toBe('compaction-2');
    expect(second.compactions).toBe(2);

    // keepCount 0 leaves only the summary.
    const summaryOnly = reducer(before, { t: 'compact', summaryText: 'ONLY', keepCount: 0 });
    expect(summaryOnly.committed).toEqual([
      {
        id: 'compaction-1',
        role: 'system',
        done: true,
        blocks: [{ kind: 'text', id: 'compaction-1:block:1', text: 'ONLY' }],
      },
    ]);
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

  it('selectStatusLine surfaces contextPressure + compactions', () => {
    const state = stateWithMessages([msg('u1', 'user', 'x'.repeat(400))]);
    state.compactions = 3;
    const line = selectStatusLine(state, { maxContext: 10_000 });
    expect(line.compactions).toBe(3);
    expect(line.contextPressure).toBeGreaterThan(0);
    expect(line.contextPressure).toBeLessThanOrEqual(1);
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
    expect(input.messages[0]?.content).toContain('Produce a dense, faithful summary');
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
