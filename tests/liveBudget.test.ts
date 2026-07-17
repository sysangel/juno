// tests/liveBudget.test.ts
// LANE scrollback (wave 8) — unit coverage for the live-turn height budget that keeps the
// dynamic redraw region shorter than the viewport (so Ink never erases native scrollback).
// The real-terminal guarantee is proven by tests/autoscroll.pty.test.ts against the actual
// Ink renderer; these tests pin the pure MODEL: the expandable chrome (an expanded agents
// dropdown, a multiline composer) is added onto the proven base reserve and subtracted from
// the live budget one-for-one, and the panel is clamped so the live floor always survives.
import { describe, expect, it } from 'vitest';
import {
  BASE_CHROME_RESERVE,
  MIN_LIVE_LINES,
  SUBAGENT_MAX_VISIBLE_ROWS,
  composerRows,
  computeLiveBudget,
  subagentPanelRows,
  type LiveBudgetInputs,
} from '../src/ui/liveBudget';

const base = (over: Partial<LiveBudgetInputs> = {}): LiveBudgetInputs => ({
  rows: 24,
  columns: 80,
  composerValue: '',
  subagentEntryCount: 0,
  subagentFocused: false,
  ...over,
});

/** The reserve the budget accounts for = proven base chrome + the reserved (possibly clamped)
 *  agents panel + the extra composer rows beyond the first. `liveMaxLines` is `rows - reserve`
 *  (floored at MIN_LIVE_LINES). */
function reserveFor(inp: LiveBudgetInputs, subagentMaxRows: number): number {
  const extraComposer = Math.max(0, composerRows(inp.composerValue, inp.columns) - 1);
  return (
    BASE_CHROME_RESERVE +
    subagentPanelRows(inp.subagentEntryCount, inp.subagentFocused, subagentMaxRows) +
    extraComposer
  );
}

describe('composerRows', () => {
  it('is 1 for an empty value (the ❯ prompt line is always drawn)', () => {
    expect(composerRows('', 80)).toBe(1);
  });

  it('counts newline-split lines', () => {
    expect(composerRows('a\nb\nc', 80)).toBe(3);
  });

  it('counts WRAPPED rows for a line wider than the terminal', () => {
    expect(composerRows('x'.repeat(200), 80)).toBe(3); // ceil((200+1 cursor)/(80-2 prompt))
  });

  it('reserves the extra row a line at EXACTLY terminal width really renders', () => {
    // The composer renders beside the 2-col `❯ ` prompt and the focused caret adds an inverse
    // cursor cell, so an 80-char line at 80 cols wraps to 2 terminal rows (verified by rendering
    // InputBox through Ink). Budgeting 1 here under-reserved by a row per such pasted line —
    // pushing the dynamic region past stdout.rows and re-triggering the \x1b[3J scrollback erase.
    expect(composerRows('x'.repeat(80), 80)).toBe(2);
    expect(composerRows('x'.repeat(800), 80)).toBe(11); // an 800-char paste line ⇒ 11 rows, not 10
  });

  it('counts wide glyphs whole at ODD content width (no under-reserve)', () => {
    // columns 5 ⇒ effective content width 3 (odd) beside the 2-col `❯ ` prompt. Four 2-cell
    // 字 + the cursor cell wrap ONE glyph per row (a cell wasted each row) ⇒ 4 rows. The old
    // `ceil((displayWidth+1)/(columns-2))` = ceil(9/3) = 3 under-reserved by a row — the exact
    // scrollback-erasing under-count this helper exists to prevent, now closed for wide glyphs.
    expect(composerRows('字'.repeat(4), 5)).toBe(4);
    // Emoji likewise: 4 👍 (8 cells) + cursor at width 3 wrap one glyph per row ⇒ 4 rows,
    // where the old ceil((8+1)/3) = 3 under-reserved.
    expect(composerRows('👍'.repeat(4), 5)).toBe(4);
  });

  it('falls back to 1 row per source line when columns is unknown', () => {
    expect(composerRows('x'.repeat(200), Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('subagentPanelRows', () => {
  it('is 0 with no entries', () => {
    expect(subagentPanelRows(0, false, 8)).toBe(0);
    expect(subagentPanelRows(0, true, 8)).toBe(0);
  });

  it('is 1 (collapsed) when not focused', () => {
    expect(subagentPanelRows(5, false, 8)).toBe(1);
  });

  it('expands to header + rows + collapse-hint when it fits', () => {
    expect(subagentPanelRows(3, true, 8)).toBe(1 + 3 + 1);
  });

  it('adds an `↑ N earlier` head when entries exceed the cap', () => {
    expect(subagentPanelRows(20, true, 8)).toBe(1 + 1 + 8 + 1);
  });

  it('degrades to the collapsed one-liner when there is no room to expand (maxVisibleRows < 1)', () => {
    expect(subagentPanelRows(5, true, 0)).toBe(1);
  });
});

describe('computeLiveBudget', () => {
  it('disables clamping when rows is non-finite (unit / non-TTY callers)', () => {
    const b = computeLiveBudget(base({ rows: Number.POSITIVE_INFINITY }));
    expect(b.liveMaxLines).toBe(Number.POSITIVE_INFINITY);
    expect(b.subagentMaxRows).toBe(SUBAGENT_MAX_VISIBLE_ROWS);
  });

  it('reproduces the proven base reserve exactly with no panel and a single-line composer', () => {
    // Collapsed/absent panel + empty composer ⇒ the historical `rows - 12`, so the two
    // existing autoscroll pty regressions keep their validated margin.
    const b = computeLiveBudget(base({ rows: 24 }));
    expect(b.liveMaxLines).toBe(24 - BASE_CHROME_RESERVE);
  });

  it('subtracts the EXPANDED agents dropdown one-for-one from the live budget', () => {
    // 40-row viewport: a full 8-agent panel (10 rows) fits its budget, so it is reserved in
    // full and the live budget drops by exactly that height (accounted region == rows).
    const inp = base({ rows: 40, subagentEntryCount: 8, subagentFocused: true });
    const b = computeLiveBudget(inp);
    expect(b.subagentMaxRows).toBe(SUBAGENT_MAX_VISIBLE_ROWS);
    expect(reserveFor(inp, b.subagentMaxRows) + b.liveMaxLines).toBe(inp.rows);
    // The expanded panel really did cost the live budget its full height vs. collapsed.
    const collapsed = computeLiveBudget(base({ rows: 40, subagentEntryCount: 8, subagentFocused: false }));
    expect(collapsed.liveMaxLines - b.liveMaxLines).toBe(
      subagentPanelRows(8, true, 8) - subagentPanelRows(8, false, 8),
    );
  });

  it('subtracts extra composer rows one-for-one', () => {
    const inp = base({ composerValue: 'a\nb\nc\nd' }); // 4 rows ⇒ +3 over the base 1
    const b = computeLiveBudget(inp);
    expect(b.liveMaxLines).toBe(24 - BASE_CHROME_RESERVE - 3);
  });

  it('clamps the expanded panel on a short viewport so the live floor survives', () => {
    const inp = base({ rows: 18, subagentEntryCount: 8, subagentFocused: true });
    const b = computeLiveBudget(inp);
    expect(b.subagentMaxRows).toBeLessThan(SUBAGENT_MAX_VISIBLE_ROWS);
    expect(b.liveMaxLines).toBeGreaterThanOrEqual(MIN_LIVE_LINES);
    // The clamped panel still fits its budget, so live is never starved below the floor.
    const panelRows = subagentPanelRows(inp.subagentEntryCount, true, b.subagentMaxRows);
    expect(panelRows).toBeLessThanOrEqual(inp.rows - BASE_CHROME_RESERVE - MIN_LIVE_LINES);
  });

  it('holds the model invariant across a matrix of sizes / entry counts / composer heights', () => {
    for (const rows of [18, 20, 24, 40, 80]) {
      for (const columns of [40, 80, 120]) {
        for (const subagentEntryCount of [0, 1, 3, 8, 25]) {
          for (const subagentFocused of [false, true]) {
            for (const composerValue of ['', 'one line', 'a\nb\nc\nd\ne', 'w'.repeat(300)]) {
              const inp = base({ rows, columns, subagentEntryCount, subagentFocused, composerValue });
              const b = computeLiveBudget(inp);
              const reserve = reserveFor(inp, b.subagentMaxRows);
              // liveMaxLines is exactly rows-reserve, floored at MIN_LIVE_LINES.
              expect(b.liveMaxLines).toBe(Math.max(MIN_LIVE_LINES, rows - reserve));
              // When the floor is NOT hit, the accounted region (base + panel + extra composer
              // + live) equals rows exactly — the base reserve holds the real-chrome slack that
              // keeps the true dynamic region strictly under `rows` (pty test proves that edge).
              if (rows - reserve >= MIN_LIVE_LINES) {
                expect(reserve + b.liveMaxLines).toBe(rows);
              }
              expect(b.liveMaxLines).toBeGreaterThanOrEqual(MIN_LIVE_LINES);
            }
          }
        }
      }
    }
  });
});
