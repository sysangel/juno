// tests/clipText.test.ts
// Wave-9 lane: the consolidated display-width authority (src/ui/clipText.ts).
//   - displayWidth : measures in terminal cells (CJK/emoji = 2, combining = 0).
//   - clipCells    : single-line clip that never overflows the cell budget nor splits
//                    a surrogate pair / orphans a combining mark at the cut.
//   - wrapCells    : hard-wrap by cell width — the cell-correct replacement for the old
//                    UTF-16 `.slice()` hard-wrap; ASCII-identical, wide-char-safe.
//   - rowsForWidth : the single deduped copy formerly mirrored in liveWindow/liveBudget;
//                    parity here covers both former call sites' usage patterns.
//
// Combining sequences are written with an explicit ́ (COMBINING ACUTE ACCENT) so the
// base+mark decomposition is unambiguous in source (a precomposed literal would be one
// scalar and never exercise the combining path).
import { describe, it, expect } from 'vitest';
import { displayWidth, clipCells, wrapCells, rowsForWidth } from '../src/ui/clipText';

// An unpaired UTF-16 surrogate — the `�` garble a raw `.slice()` emits when it cuts
// between the two code units of an astral glyph. No correct helper may ever produce one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('displayWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('')).toBe(0);
  });

  it('counts CJK and emoji as two cells each', () => {
    expect(displayWidth('字')).toBe(2);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('👍')).toBe(2);
  });

  it('counts a combining mark as zero (it renders onto its base)', () => {
    expect(displayWidth('é')).toBe(1); // e + combining acute = one cell
    expect(displayWidth('áb́')).toBe(2);
  });
});

describe('clipCells — cell-correct single-line clip', () => {
  it('passes short text through untouched (whitespace-collapsed + trimmed)', () => {
    expect(clipCells('  hello   world  ', 40)).toBe('hello world');
  });

  it('max <= 0 ⇒ empty', () => {
    expect(clipCells('anything', 0)).toBe('');
    expect(clipCells('anything', -3)).toBe('');
  });

  it('clips CJK on a whole-glyph boundary, never overflowing the budget', () => {
    const out = clipCells('字'.repeat(10), 5); // 20 cells → clip to 5 (incl. the …)
    expect(out).toBe('字字…');
    // The old `.slice(0, max - 1)` would keep 4 UTF-16 units = 4 CJK = 8 cells + … = 9.
    expect(displayWidth(out)).toBe(5);
  });

  it('clips emoji at an ODD budget without splitting a surrogate pair', () => {
    // max-1 = 3 lands mid-way through the second 👍 for a raw UTF-16 slice; the cell
    // clip stops a glyph early instead of emitting a lone surrogate.
    const out = clipCells('👍'.repeat(10), 4);
    expect(out).toBe('👍…');
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(displayWidth(out)).toBeLessThanOrEqual(4);
  });

  it('keeps a combining mark attached to its base at the cut', () => {
    const out = clipCells('áb́ć', 2); // 3 base+mark cells → clip to 2
    expect(out).toBe('á…'); // the acute rides with its 'a', not orphaned onto …
    expect(displayWidth(out)).toBe(2);
  });
});

describe('wrapCells — cell-correct hard-wrap', () => {
  const lossless = (line: string, max: number): void => {
    expect(wrapCells(line, max).join('')).toBe(line); // wrap drops nothing
  };

  it('is byte-identical to the old UTF-16 hard-wrap for pure ASCII', () => {
    expect(wrapCells('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrapCells('abc', 3)).toEqual(['abc']); // exactly the budget → one row
    expect(wrapCells('ab', 5)).toEqual(['ab']); // under budget → one row
    expect(wrapCells('', 5)).toEqual(['']); // empty line is still one (empty) row
  });

  it('wraps CJK on whole-glyph rows, never overflowing max', () => {
    const rows = wrapCells('字'.repeat(4), 3); // 8 cells, budget 3
    // The old `.length`-based slice gave ['字字字','字'] — a 6-cell first row that
    // overflows the panel and visually wraps, corrupting the scroll math.
    expect(rows).toEqual(['字', '字', '字', '字']);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(3);
    lossless('字'.repeat(4), 3);
  });

  it('never splits an emoji surrogate pair across rows', () => {
    const rows = wrapCells('x' + '👍'.repeat(3), 5);
    expect(rows).toEqual(['x👍👍', '👍']);
    for (const r of rows) {
      expect(r).not.toMatch(LONE_SURROGATE);
      expect(displayWidth(r)).toBeLessThanOrEqual(5);
    }
    lossless('x' + '👍'.repeat(3), 5);
  });

  it('keeps combining marks with their base glyph when wrapping', () => {
    const rows = wrapCells('á'.repeat(4), 2); // 4 base+mark cells, budget 2
    for (const r of rows) {
      expect(displayWidth(r)).toBeLessThanOrEqual(2);
      expect(r.startsWith('́')).toBe(false); // no row opens on an orphaned mark
    }
    lossless('á'.repeat(4), 2);
  });

  it('gives an over-wide lone glyph its own row rather than dropping it', () => {
    expect(wrapCells('字', 1)).toEqual(['字']); // 2 cells, budget 1 → own row, not lost
  });
});

describe('rowsForWidth — the single deduped row-count helper', () => {
  it('ceils width / columns, floored at one row', () => {
    expect(rowsForWidth(10, 5)).toBe(2);
    expect(rowsForWidth(11, 5)).toBe(3);
    expect(rowsForWidth(5, 5)).toBe(1);
    expect(rowsForWidth(0, 5)).toBe(1); // empty still occupies a row
  });

  it('falls back to one row when columns is non-finite / non-positive', () => {
    expect(rowsForWidth(100, 0)).toBe(1);
    expect(rowsForWidth(100, -5)).toBe(1);
    expect(rowsForWidth(100, Number.POSITIVE_INFINITY)).toBe(1);
    expect(rowsForWidth(100, Number.NaN)).toBe(1);
  });

  it('parity: liveWindow.rowsForLine pattern — rowsForWidth(displayWidth(line), columns)', () => {
    // A line of 80 CJK glyphs = 160 cells wraps to 2 rows at 80 columns.
    expect(rowsForWidth(displayWidth('字'.repeat(80)), 80)).toBe(2);
    // A sub-width line is one row.
    expect(rowsForWidth(displayWidth('日本語'), 80)).toBe(1);
  });

  it('parity: liveBudget.composerRows pattern — rowsForWidth(displayWidth(line) + 1, columns - 2)', () => {
    // A line exactly (columns - 2) wide budgets 1 row, but the +1 cursor cell tips it
    // to 2 — the exact under-reserve liveBudget adds the cursor cell to prevent.
    expect(rowsForWidth(78 + 1, 80 - 2)).toBe(2);
    expect(rowsForWidth(40 + 1, 80 - 2)).toBe(1);
  });
});
