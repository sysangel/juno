// tests/microcompact.test.ts
// Wave-14 (b8-compaction-resilience) — the DETERMINISTIC no-LLM microcompaction tier.
//
// Pure: no network, no client, no I/O. Pins the load-bearing invariants — message
// COUNT/ORDER/ROLES + every toolCallId are preserved, only OLDER tool-result CONTENT is
// cleared, a short result is never expanded, and the estimate strictly drops when there
// is bulky old tool output to clear.
import { describe, expect, it } from 'vitest';
import { microcompactTurnMessages } from '../src/agent/microcompact';
import { estimateTurnTranscriptTokens } from '../src/core/selectors';
import type { TurnMessage } from '../src/core/contracts';

const PLACEHOLDER = '[tool output cleared to save context]';

function u(content: string): TurnMessage {
  return { role: 'user', content };
}
function sys(content: string): TurnMessage {
  return { role: 'system', content };
}
function tool(toolCallId: string, content: string): TurnMessage {
  return { role: 'tool', toolCallId, content };
}
function assistant(id: string): TurnMessage {
  return { role: 'assistant', content: `use ${id}`, toolCalls: [{ toolCallId: id, name: 'noop', args: {} }] };
}

/** Bulky big tool-result content, distinct per tool call so verbatim keeps are checkable. */
const big = (n: number): string => `result-${n}-${'x'.repeat(500)}`;

/** 5 bulky tool results (t1..t5) interleaved with assistant tool_use + narrative. */
function bulkyTranscript(): TurnMessage[] {
  return [
    sys('system prompt'),
    u('user question'),
    assistant('t1'),
    tool('t1', big(1)),
    assistant('t2'),
    tool('t2', big(2)),
    assistant('t3'),
    tool('t3', big(3)),
    assistant('t4'),
    tool('t4', big(4)),
    assistant('t5'),
    tool('t5', big(5)),
    { role: 'assistant', content: 'final answer' },
  ];
}

describe('microcompactTurnMessages', () => {
  it('clears older tool results to the placeholder, keeps the most-recent N verbatim, preserves ids/order/roles/count', () => {
    const input = bulkyTranscript();
    const snapshot = input.map((m) => ({ ...m }));
    const out = microcompactTurnMessages(input); // default keepRecentToolResults = 3

    // Count / order / roles are invariant.
    expect(out).toHaveLength(input.length);
    expect(out.map((m) => m.role)).toEqual(input.map((m) => m.role));

    const toolMsgs = out.filter(
      (m): m is Extract<TurnMessage, { role: 'tool' }> => m.role === 'tool',
    );
    // Every toolCallId preserved, in order.
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // The two OLDEST (older than the last 3) are cleared to the placeholder.
    expect(toolMsgs[0]!.content).toBe(PLACEHOLDER);
    expect(toolMsgs[1]!.content).toBe(PLACEHOLDER);
    // The most-recent 3 tool results are kept VERBATIM.
    expect(toolMsgs[2]!.content).toBe(big(3));
    expect(toolMsgs[3]!.content).toBe(big(4));
    expect(toolMsgs[4]!.content).toBe(big(5));

    // Inputs are not mutated.
    expect(input).toEqual(snapshot);
  });

  it('passes user/assistant/system messages through UNCHANGED (same reference)', () => {
    const input = bulkyTranscript();
    const out = microcompactTurnMessages(input);
    input.forEach((message, index) => {
      if (message.role !== 'tool') {
        expect(out[index]).toBe(message); // reference-identical passthrough
      }
    });
  });

  it('a transcript with <= keepRecentToolResults tool messages is unchanged (no shrink)', () => {
    const input = [
      sys('s'),
      assistant('t1'),
      tool('t1', big(1)),
      assistant('t2'),
      tool('t2', big(2)),
      assistant('t3'),
      tool('t3', big(3)),
    ]; // exactly 3 tool messages == default keepRecent
    const out = microcompactTurnMessages(input);
    expect(out).toEqual(input);
    expect(estimateTurnTranscriptTokens(out)).toBe(estimateTurnTranscriptTokens(input));
  });

  it('does NOT expand a short older tool result (placeholder only applied when it shrinks)', () => {
    const short = 'ok'; // 2 chars, shorter than the placeholder
    const input = [
      assistant('t1'),
      tool('t1', short), // OLD (4 tool messages, keepRecent 3) but too short to shrink
      assistant('t2'),
      tool('t2', big(2)),
      assistant('t3'),
      tool('t3', big(3)),
      assistant('t4'),
      tool('t4', big(4)),
    ];
    const out = microcompactTurnMessages(input);
    const firstTool = out.filter((m) => m.role === 'tool')[0]!;
    expect(firstTool.content).toBe(short); // unchanged — never expanded to the longer placeholder
  });

  it('headChars>0 keeps a head prefix before the placeholder', () => {
    const content = `HEAD${'x'.repeat(500)}`;
    const input = [
      assistant('t1'),
      tool('t1', content), // the only OLD tool result (4 total, keepRecent 3)
      assistant('t2'),
      tool('t2', big(2)),
      assistant('t3'),
      tool('t3', big(3)),
      assistant('t4'),
      tool('t4', big(4)),
    ];
    const out = microcompactTurnMessages(input, { headChars: 4 });
    const firstTool = out.filter((m) => m.role === 'tool')[0]!;
    expect(firstTool.content).toBe(`HEAD\n${PLACEHOLDER}`);
  });

  it('estimateTurnTranscriptTokens strictly drops when there are bulky old tool results', () => {
    const input = bulkyTranscript();
    const out = microcompactTurnMessages(input);
    expect(estimateTurnTranscriptTokens(out)).toBeLessThan(estimateTurnTranscriptTokens(input));
  });
});
