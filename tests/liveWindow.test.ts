// tests/liveWindow.test.ts
// Unit coverage for the pure live-turn height-windowing helper (LANE D autoscroll).
// The behavioral end-to-end proof that this keeps Ink terminal-following lives in
// tests/autoscroll.pty.test.ts (a real pty); here we pin the pure slicing contract.
import { describe, expect, it } from 'vitest';
import type { Block, Msg } from '../src/core/reducer';
import {
  LIVE_WINDOW_MARKER_ID,
  LIVE_WINDOW_MARKER_TEXT,
  windowLiveMsg,
} from '../src/ui/liveWindow';

/** Build a live assistant Msg with a single text block of `n` numbered lines. */
function longTextMsg(n: number): Msg {
  const text = Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
  return {
    id: 'live-1',
    role: 'assistant',
    done: false,
    blocks: [{ kind: 'text', id: 'live-1:block:1', text }],
  };
}

describe('windowLiveMsg', () => {
  it('returns the SAME reference when the turn already fits the budget', () => {
    const msg = longTextMsg(5);
    expect(windowLiveMsg(msg, 10)).toBe(msg);
  });

  it('returns the SAME reference when clamping is disabled (Infinity / ≤0)', () => {
    const msg = longTextMsg(500);
    expect(windowLiveMsg(msg, Number.POSITIVE_INFINITY)).toBe(msg);
    expect(windowLiveMsg(msg, 0)).toBe(msg);
    expect(windowLiveMsg(msg, -1)).toBe(msg);
  });

  it('keeps only the TRAILING lines of an overflowing text block, plus a marker', () => {
    const msg = longTextMsg(40);
    const out = windowLiveMsg(msg, 8);

    // First block is the dim elision marker with a STABLE id (no remount churn).
    const marker = out.blocks[0]!;
    expect(marker.kind).toBe('notice');
    expect(marker.id).toBe(LIVE_WINDOW_MARKER_ID);
    expect((marker as Extract<Block, { kind: 'notice' }>).text).toBe(LIVE_WINDOW_MARKER_TEXT);

    // The surviving text block holds the LAST 8 source lines (newest = bottom-follow).
    const body = out.blocks[1]!;
    expect(body.kind).toBe('text');
    const lines = (body as Extract<Block, { kind: 'text' }>).text.split('\n');
    expect(lines).toEqual([
      'line 33',
      'line 34',
      'line 35',
      'line 36',
      'line 37',
      'line 38',
      'line 39',
      'line 40',
    ]);
    // Original message is never mutated.
    expect(msg.blocks[0]!.kind).toBe('text');
    expect((msg.blocks[0] as Extract<Block, { kind: 'text' }>).text.split('\n')).toHaveLength(40);
  });

  it('drops fully-elided leading blocks but keeps the last tool card in the window', () => {
    const msg: Msg = {
      id: 'live-2',
      role: 'assistant',
      done: false,
      blocks: [
        { kind: 'text', id: 'live-2:block:1', text: Array.from({ length: 30 }, (_, i) => `a${i}`).join('\n') },
        { kind: 'tool', id: 'live-2:block:2', toolCallId: 'tc-1' },
        { kind: 'text', id: 'live-2:block:3', text: 'tail-1\ntail-2' },
      ],
    };
    const out = windowLiveMsg(msg, 8);
    // Marker leads; the trailing tool card + short tail text survive (leading 30-line
    // block is elided). Kept blocks retain original order + ids.
    expect(out.blocks[0]!.id).toBe(LIVE_WINDOW_MARKER_ID);
    const kinds = out.blocks.slice(1).map((b) => b.kind);
    expect(kinds).toContain('tool');
    const lastText = out.blocks.at(-1)!;
    expect((lastText as Extract<Block, { kind: 'text' }>).text).toBe('tail-1\ntail-2');
  });

  it('reserves budget for a reasoning region so the dynamic area stays bounded', () => {
    const withReasoning: Msg = { ...longTextMsg(40), reasoning: 'thinking…' };
    const out = windowLiveMsg(withReasoning, 8);
    // Reasoning is preserved verbatim...
    expect(out.reasoning).toBe('thinking…');
    // ...and it costs budget, so FEWER trailing lines survive than without reasoning.
    const withoutReasoning = windowLiveMsg(longTextMsg(40), 8);
    const withLines = (out.blocks.at(-1) as Extract<Block, { kind: 'text' }>).text.split('\n');
    const withoutLines = (withoutReasoning.blocks.at(-1) as Extract<Block, { kind: 'text' }>).text.split('\n');
    expect(withLines.length).toBeLessThan(withoutLines.length);
  });
});
