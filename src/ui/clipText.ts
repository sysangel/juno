// src/ui/clipText.ts
// The ONE display-width authority for the TUI: every helper here measures text in
// terminal DISPLAY CELLS (string-width), NOT UTF-16 code units, so a CJK/emoji/wide
// glyph counts as its true 2 cells and is never split across a clip or wrap boundary.
// string-width is imported HERE and nowhere else — callers route their width math
// through `displayWidth` so the whole tree agrees on one measure.
//
//   - displayWidth : text → its rendered cell count (the sole string-width call site).
//   - clipCells    : whitespace-collapse + trim + single-line clip to N cells (…).
//   - wrapCells    : hard-wrap a logical line into rows of <= N cells (no word break).
//   - rowsForWidth : a HOMOGENEOUS cell budget (1 cell/column, e.g. an ASCII char cap)
//                    + the terminal columns → its wrapped-row count. Do NOT feed it the
//                    width of arbitrary text: a bare cell count cannot know glyph packing,
//                    so it UNDER-counts wide glyphs at odd columns (see rowsForText).
//   - rowsForText  : real text + the terminal columns → its TRUE wrapped-row count, via
//                    wrapCells — the accurate row count for any string incl. wide glyphs.
//
// A `.slice(0, max)` (UTF-16) clip lets a 2-cell glyph overflow the budget — the "one
// condensed line" card then wraps to two rows — and can split a surrogate pair at the
// cut, emitting a lone-surrogate `�` at the ellipsis. Accumulating WHOLE code points by
// their cell width avoids both, guaranteeing the result's display width stays in budget.
import stringWidth from 'string-width';

/** Rendered width of `value` in terminal DISPLAY CELLS (a CJK/emoji glyph is 2). The
 *  single string-width call site — every other module measures width through this. */
export function displayWidth(value: string): number {
  return stringWidth(value);
}

/** Whitespace-collapse + trim + clip to `max` DISPLAY CELLS with a trailing ellipsis.
 * `max <= 0` ⇒ '' (no room to render anything). */
export function clipCells(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (displayWidth(flat) <= max) return flat;
  let out = '';
  let used = 0;
  for (const ch of flat) {
    const w = displayWidth(ch);
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/**
 * Hard-wrap one logical line into rows no wider than `max` DISPLAY CELLS, breaking on
 * code-point boundaries — never mid-glyph, never splitting a surrogate pair. No word
 * breaking (a plain cell-accumulate), so wrapped-row counts stay deterministic for the
 * scroll math that depends on them. A line already within budget returns as a single
 * row; an empty line is one (empty) row; a lone glyph wider than `max` takes its own
 * row rather than being dropped.
 */
export function wrapCells(line: string, max: number): string[] {
  if (displayWidth(line) <= max) return [line];
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const ch of line) {
    const w = displayWidth(ch);
    if (used + w > max && row.length > 0) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += ch;
    used += w;
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * Rows a HOMOGENEOUS cell budget of `width` occupies at `columns` wide (>= 1). Correct
 * ONLY when every cell is independently placeable — an ASCII / 1-cell-per-column budget,
 * where `ceil(width / columns)` is exact. It canNOT model real text containing wide
 * glyphs: the actual wrap (`wrapCells`) never splits a 2-cell glyph, so at ODD columns a
 * trailing single cell is wasted and the true row count is HIGHER than `ceil(width /
 * columns)` — count such text with `rowsForText`. Its retained callers feed a synthetic
 * constant CAP, not measured text (liveWindow's tool-card / thinking reserves); note the
 * tool-card cap is a clipCells CELL budget, so ceil is exact only for ASCII — see
 * liveWindow's tool-card comment for the pre-existing wide-glyph caveat.
 * A non-finite / non-positive `columns` ⇒ wrapping unknown, so fall back to 1 row (the
 * non-TTY / unit-test path).
 */
export function rowsForWidth(width: number, columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 1;
  return Math.max(1, Math.ceil(width / columns));
}

/**
 * TRUE wrapped-row count of `text` at `columns` wide (>= 1), delegating to `wrapCells`
 * (the width authority) so a CJK/emoji glyph counts as its real 2 cells and never splits
 * across a row — the odd-column, wide-glyph cases `rowsForWidth` under-counts. An empty
 * line still occupies one row. A non-finite / non-positive `columns` ⇒ wrapping unknown,
 * so fall back to 1 row (the non-TTY / unit-test path).
 */
export function rowsForText(text: string, columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 1;
  return wrapCells(text, columns).length;
}
