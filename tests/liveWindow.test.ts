// tests/liveWindow.test.ts
// Unit coverage for the pure live-turn height-windowing helper (LANE D autoscroll).
// The behavioral end-to-end proof that this keeps Ink terminal-following lives in
// tests/autoscroll.pty.test.ts (a real pty); here we pin the pure slicing contract.
import { describe, expect, it } from 'vitest';
import type { Block, Msg, ToolState } from '../src/core/reducer';
import {
  LIVE_WINDOW_MARKER_ID,
  LIVE_WINDOW_MARKER_TEXT,
  estimatedRows,
  windowLiveMsg,
} from '../src/ui/liveWindow';
import { displayWidth } from '../src/ui/clipText';

/** A live assistant Msg wrapping a single text block. */
function textBlockMsg(text: string): Msg {
  return { id: 'm', role: 'assistant', done: false, blocks: [{ kind: 'text', id: 'm:b:1', text }] };
}

// A lone (unpaired) UTF-16 surrogate — the `�` a raw `.slice()` emits when it cuts
// between the two code units of an astral glyph. The tail slice must never yield one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

/** A live assistant Msg whose single text block is one (unbroken) `line`. */
function oneLineMsg(line: string): Msg {
  return {
    id: 'live-tail',
    role: 'assistant',
    done: false,
    blocks: [{ kind: 'text', id: 'live-tail:block:1', text: line }],
  };
}

/** The surviving (windowed) text block — the last block after the lead marker. */
function tailText(msg: Msg): string {
  return (msg.blocks.at(-1) as Extract<Block, { kind: 'text' }>).text;
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

// The mid-line tail slice (a boundary source line taller than the remaining budget)
// runs ONLY when `columns` is finite — every test above passes the default Infinity,
// so this branch shipped untested. It is exactly where a UTF-16 slice overflowed the
// live budget on CJK / split a surrogate pair on emoji.
describe('windowLiveMsg — wide-glyph tail slice (finite columns)', () => {
  it('is byte-identical to the old UTF-16 tail slice for pure ASCII', () => {
    // 50 chars at 10 cols = 5 rows; a 3-row budget keeps the last 3 rows = last 30
    // chars. ASCII: 1 code unit = 1 cell, so the new wrapCells path matches exactly.
    const out = windowLiveMsg(oneLineMsg('abcdefghij'.repeat(5)), 3, 10);
    expect(tailText(out)).toBe('abcdefghij'.repeat(3));
  });

  it('slices a wide CJK line to its tail ROWS without overflowing the cell budget', () => {
    // 30 CJK glyphs = 60 cells = 6 rows at 10 cols; a 3-row budget must keep the last
    // 3 rows = 15 glyphs = 30 cells. The old slice used rowsLeft*columns as a CODE-UNIT
    // count (3*10=30 units); line.length is 30, so it sliced from index 0 and kept the
    // WHOLE 6-row line — double the budget — re-triggering Ink's scrollback repaint.
    const out = windowLiveMsg(oneLineMsg('字'.repeat(30)), 3, 10);
    expect(tailText(out)).toBe('字'.repeat(15));
    expect(displayWidth(tailText(out))).toBeLessThanOrEqual(3 * 10);
  });

  it('slices a wide EMOJI line to its tail rows without splitting a surrogate pair', () => {
    // 10 emoji = 20 cells = 4 rows at 5 cols; a 3-row budget keeps the last 3 rows.
    // The old slice(line.length - 3*5) = slice(20 - 15) = slice(5) started on the LOW
    // surrogate of the 3rd emoji → a leading lone `�`.
    const out = windowLiveMsg(oneLineMsg('👍'.repeat(10)), 3, 5);
    expect(tailText(out)).not.toMatch(LONE_SURROGATE);
    expect(tailText(out)).toBe('👍'.repeat(6));
    expect(displayWidth(tailText(out))).toBeLessThanOrEqual(3 * 5);
    // Proof the OLD slice garbled at this exact cut:
    expect('👍'.repeat(10).slice(5)).toMatch(LONE_SURROGATE);
  });
});

// W3 item 1 — the deleted ghost wave-7 card budget. A tool block used to reserve ~10 rows
// (1 + 3*ceil(200/80)); the condensed card is one row, so the estimate is now the 1-row card +
// one wrap headroom = 2. The regression: a turn that the ghost budget would have prematurely
// elided (hiding the streaming answer behind an empty screen) now FITS.
describe('windowLiveMsg — tool blocks budget the real 1-row card, not the deleted ~10-row ghost', () => {
  const runningTool: Record<string, ToolState> = {
    t0: { status: 'running', name: 'grep', args: { pattern: 'x' } },
  };
  const toolThenAnswer: Msg = {
    id: 'live',
    role: 'assistant',
    done: false,
    blocks: [
      { kind: 'tool', id: 'b0', toolCallId: 't0' },
      { kind: 'text', id: 'b1', text: 'the final answer' },
    ],
  };

  it('estimates a single running tool at ~2 rows (was ~10)', () => {
    const oneTool: Msg = { id: 'x', role: 'assistant', done: false, blocks: [{ kind: 'tool', id: 'b0', toolCallId: 't0' }] };
    const est = estimatedRows(oneTool, 80, runningTool);
    expect(est).toBeLessThanOrEqual(3); // the old ghost budget was ~10
    expect(est).toBeGreaterThanOrEqual(1);
  });

  it('keeps a tool + trailing answer that the ghost budget would have elided', () => {
    // Whole turn is ~3 rows (2 tool + 1 answer). At maxLines=4 it fits and windowLiveMsg returns
    // the SAME reference (nothing elided). Under the old ~10-row-per-tool budget the tool alone
    // (10) blew a 4-row budget → the streaming answer got windowed out behind an empty screen.
    expect(estimatedRows(toolThenAnswer, 80, runningTool)).toBeLessThanOrEqual(4);
    expect(windowLiveMsg(toolThenAnswer, 4, 80, runningTool)).toBe(toolThenAnswer);
  });
});

// W3 item 2 — assistant text renders as MARKDOWN, so the estimator counts the decoration
// MarkdownView adds (code/quote gutters at columns-2, the lang label, list markers, table
// padding). A raw source-line count ignores it and UNDER-reserves a code/table-heavy turn →
// Ink's \x1b[3J scrollback erase. The estimator gates on role: only assistant text is measured
// as markdown; user/system/tool text stays verbatim.
describe('windowLiveMsg / estimatedRows — markdown decoration is counted on the assistant path', () => {
  // 8 code lines each 19 cells wide, fenced. At 20 cols the `│ ` gutter wraps each to 2 rows.
  const codeText = '```\n' + Array.from({ length: 8 }, () => 'y'.repeat(19)).join('\n') + '\n```';

  it('a fenced code block budgets strictly MORE than its raw source-line count', () => {
    const assistant = textBlockMsg(codeText);
    const rawSourceLines = codeText.split('\n').length; // 10 (```, 8 lines, ```)
    // Assistant markdown: each of the 8 code lines wraps to 2 rows past the gutter ⇒ >= 16 rows.
    expect(estimatedRows(assistant, 20)).toBeGreaterThan(rawSourceLines);
  });

  it('the SAME text on a non-assistant (verbatim) path is counted raw — proving the role gate', () => {
    const assistant = textBlockMsg(codeText);
    const user: Msg = { ...assistant, role: 'user' };
    // Verbatim: 10 source lines, none wider than 20 cols ⇒ 10 rows. Markdown counts the gutter
    // wrap on top, so the assistant estimate is strictly larger.
    expect(estimatedRows(user, 20)).toBe(codeText.split('\n').length);
    expect(estimatedRows(assistant, 20)).toBeGreaterThan(estimatedRows(user, 20));
  });

  it('the boundary-tail slice stays within budget when the kept tail re-parses into a code block', () => {
    // A block whose tail slice would INCLUDE a fence opener: keeping the last raw rows would
    // re-parse "```" + wide lines as a code block (gutter → columns-2 → each wide line 2 rows),
    // rendering TALLER than the raw-row budget the slice targeted. The markdown-aware tail trim
    // measures the kept tail exactly as it will render and drops leading lines until it fits — so
    // the decorated boundary never overflows the window.
    const text = ['intro', '```', 'Y'.repeat(19), 'Y'.repeat(19), 'Y'.repeat(19)].join('\n');
    const msg = textBlockMsg(text);
    const budget = 4;
    const out = windowLiveMsg(msg, budget, 20);
    expect(out).not.toBe(msg); // it overflowed and was windowed
    const tail = (out.blocks.at(-1) as Extract<Block, { kind: 'text' }>).text;
    // The kept tail renders within the budget (measured EXACTLY as MarkdownView will render it).
    expect(estimatedRows(textBlockMsg(tail), 20)).toBeLessThanOrEqual(budget);
  });
});
