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

// The ONE grapheme segmenter for the module, constructed ONCE at load time. `new
// Intl.Segmenter(...)` is expensive relative to a render frame, so it must NOT be built
// per call on the clip/wrap hot path — share this instance and gate it behind `clusters`.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// A char that can START or PARTICIPATE in a grapheme cluster wider than one code point:
//   U+0300–U+036F  combining diacritical marks (ride onto a preceding base),
//   U+200D         ZERO WIDTH JOINER (emoji families: 👨‍👩‍👧),
//   U+D800–U+DFFF  any UTF-16 surrogate — i.e. any astral scalar, which covers emoji,
//                  regional-indicator flag pairs, and astral variation selectors,
//   U+FE00–U+FE0F  the BMP variation selectors (emoji-presentation toggles).
// If a string contains NONE of these, every code point is its own grapheme cluster and the
// plain per-code-point `for..of` loop is already correct — and cheaper than the Segmenter —
// so pure ASCII/BMP text (incl. CJK, which is one wide code point per glyph) skips it. The
// guard runs ONCE per string, never per char, to keep the benchmark-sensitive path intact.
const CLUSTERABLE = /[\u0300-\u036F\u200D\uD800-\uDFFF\uFE00-\uFE0F]/;

/** Iterate the grapheme clusters of `s` — the boundary a clip/wrap must never split. Fast
 *  path: when `s` has no char that can form a multi-code-point cluster, yield code points
 *  directly (a string is iterable by code point), avoiding the Segmenter entirely. */
function clusters(s: string): Iterable<string> {
  return CLUSTERABLE.test(s) ? segment(s) : s;
}

function* segment(s: string): Generator<string> {
  for (const { segment: cluster } of SEGMENTER.segment(s)) yield cluster;
}

/**
 * The SINGLE source of truth for characters juno strips from untrusted text (model output,
 * tool results, file previews) before rendering it to the terminal — one predicate so the
 * scrubber and any width/clip logic can never disagree about what is unsafe to display
 * (mirrors a lone `is_unsafe_display_char` predicate). {@link sanitizeForDisplay} strips
 * the runs of this set; the ONLY sanctioned escape emitter (wipeScrollback) bypasses it.
 *
 * REMOVED:
 *   - C0 controls U+0000–U+001F EXCEPT TAB (U+0009) and LF (U+000A), which are layout —
 *     dropping the lone ESC (U+001B) de-fangs ANSI/CSI/OSC escape injection.
 *   - DEL (U+007F) and the C1 control block U+0080–U+009F.
 *   - Bidi controls used for Trojan-Source / homoglyph spoofing: embeddings & overrides
 *     U+202A–U+202E (U+202E RLO is the Trojan-Source char), isolates U+2066–U+2069,
 *     LRM/RLM U+200E/U+200F, ALM U+061C.
 *   - Zero-width / BOM: ZWSP U+200B and ZWNBSP/BOM U+FEFF.
 *
 * DELIBERATELY KEPT — load-bearing, do NOT add to this set (a real rank-7 ↔ this-set
 * interaction): U+200D ZERO WIDTH JOINER composes the exact emoji families the
 * grapheme-cluster clip/wrap protects (stripping it shatters 👨‍👩‍👧 into 👨👩👧), and
 * U+200C ZERO WIDTH NON-JOINER is load-bearing for script shaping. Note that U+200B/U+200E–
 * U+200F sit on either side of them here precisely so the range never drifts to swallow them.
 */
export const UNSAFE_DISPLAY_CHAR =
  /[\x00-\x08\x0B-\x1F\x7F-\x9F\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

// Global form of the SAME class (built from its source, so the set can't drift) for
// stripping every occurrence via String.replace; the exported const stays a stateless
// (non-global) predicate safe to reuse in the fast-path guard.
const UNSAFE_DISPLAY_CHAR_G = new RegExp(UNSAFE_DISPLAY_CHAR.source, 'g');

// Full ANSI escape RUNS, swallowed whole so no literal `[2J` / `]0;…` junk survives after
// the bare ESC is stripped: a CSI `ESC [ params interm final`, or an OSC `ESC ] … (BEL|ST)`.
// A truncated/unterminated escape falls through to the char-strip above, which still removes
// its ESC (minimum de-fang), leaving only inert literal text.
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

/**
 * Scrub `s` of terminal-unsafe characters ({@link UNSAFE_DISPLAY_CHAR}) and whole ANSI
 * escape runs before it is rendered as untrusted content, defusing escape injection and
 * bidi/Trojan-Source spoofing. This is a SEPARATE, opt-in boundary helper: {@link clipCells}
 * and {@link displayWidth} stay pure width/clip logic (callers compose, e.g.
 * `clipCells(sanitizeForDisplay(v), max)`), so the width authority never mutates content.
 *
 * Fast path: a string with no unsafe char (ESC is in the set, so escape runs can't hide) is
 * returned UNCHANGED — identity, and idempotent (`sanitize(sanitize(x)) === sanitize(x)`).
 * Runs at the render boundary, not the innermost wrap loop, but still guarded. LF and TAB
 * are preserved (layout-critical); U+200D/U+200C are preserved (see the const's doc).
 */
export function sanitizeForDisplay(s: string): string {
  if (!UNSAFE_DISPLAY_CHAR.test(s)) return s;
  return s.replace(ANSI_SEQUENCE, '').replace(UNSAFE_DISPLAY_CHAR_G, '');
}

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
  // Accumulate whole GRAPHEME CLUSTERS (not bare code points): an emoji ZWJ family or a
  // regional-indicator flag is one indivisible unit, so the clip stops on a cluster edge
  // and never leaves half a family / a dangling ZWJ before the ellipsis. `clusters` keeps
  // the per-code-point fast path for plain ASCII/BMP text — the benchmark-hot case.
  for (const cluster of clusters(flat)) {
    const w = displayWidth(cluster);
    if (used + w > max - 1) break;
    out += cluster;
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
  // Break on GRAPHEME CLUSTER boundaries so an emoji ZWJ family / regional-indicator flag
  // stays whole across a wrap — never split into a bare ZWJ + tail or two lone regional
  // indicators. The `row.length > 0` guard still gives a lone cluster wider than `max` its
  // own row rather than dropping it. `clusters` keeps the code-point fast path for ASCII/BMP.
  for (const cluster of clusters(line)) {
    const w = displayWidth(cluster);
    if (used + w > max && row.length > 0) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += cluster;
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
