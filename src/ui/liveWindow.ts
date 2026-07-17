// src/ui/liveWindow.ts
// LANE D (wave 7) — autoscroll / terminal-follow fix.
//
// THE PROBLEM. Committed turns live in Ink's <Static> (printed once into the
// terminal's own scrollback). The IN-FLIGHT turn (`state.live`) is NOT in Static —
// it renders in Ink's dynamic redraw region, below Static, every token flush. Ink's
// renderer (node_modules/ink/build/ink.js onRender) has a hard branch:
//
//     if (outputHeight >= stdout.rows)
//         stdout.write(clearTerminal + fullStaticOutput + output)   // \x1b[2J\x1b[3J\x1b[H
//
// i.e. the MOMENT the dynamic region (the live turn + composer chrome) grows taller
// than the viewport, Ink stops doing in-place log-update and instead full-screen
// repaints EVERY frame, erasing the scrollback (\x1b[3J) each time. The visible
// result is the reported bug: the terminal no longer scroll-follows the newest
// streamed text, earlier scrollback is destroyed, and the user must scroll manually.
//
// THE FIX (keep <Static> — a viewport rewrite was rejected). Bound the live turn's
// RENDERED height to the last `maxLines` lines so the dynamic region always stays
// shorter than the viewport. Ink then keeps using in-place log-update: the window
// slides as tokens arrive (newest line pinned just above the composer = native
// bottom-follow), scrollback is preserved, and at commit (`assistant-done`) the FULL
// untruncated turn flows into <Static>/scrollback exactly as before — nothing is
// lost, the elision is a live-streaming display bound only.
//
// This is a pure, render-time transform of the live Msg — no reducer/state change,
// so committed history, tool snapshots, and the StatusLine/InputBox memo bail-outs
// are all untouched.
import type { Block, Msg } from '../core/reducer';
import { rowsForText, rowsForWidth, wrapCells } from './clipText';

/** Stable React key for the elision marker (constant → no remount churn). */
export const LIVE_WINDOW_MARKER_ID = 'live-window:elided';
/** Text of the dim marker prepended when leading live content is elided. */
export const LIVE_WINDOW_MARKER_TEXT = '⋮ earlier output — full text prints when the turn completes';

// Rendered-height estimates for non-text blocks. Ink WRAPS every line at the
// terminal width, so a block's rendered ROW count is not its source-line count —
// a single long paragraph is one source line but many wrapped rows. The whole
// point of this budget is to keep the live turn shorter than the viewport, so it
// MUST count wrapped rows (see finding: source-line budgeting left the autoscroll
// bug reproducible for wide prose). These constants MIRROR the render-time caps in
// ToolCallCard.tsx / Message.tsx; over-estimating is safe (windows more), under-
// estimating re-triggers Ink's scrollback-erasing full-repaint branch.
const NOTICE_EST_LINES = 1;
// Tool card = glyph/name line + up to RESULT_MAX_LINES result lines, each capped at
// RESULT_LINE_MAX_CHARS by clipCells (ToolCallCard.tsx) — a CELL budget, not chars, so a
// wide-glyph line can still fill 200 cells. At 80 cols a 200-cell result line wraps to
// ~3 rows, so a card is ~10 rows, not 4.
const TOOL_RESULT_MAX_LINES = 3; // RESULT_MAX_LINES
const TOOL_RESULT_LINE_MAX_CHARS = 200; // RESULT_LINE_MAX_CHARS
// Extended-thinking renders collapsed: a heading + a preview capped at
// THINKING_MAX_LINES lines / THINKING_MAX_CHARS chars (Message.tsx). The char cap
// can wrap past the line count, so the reserve is the max of the two.
const THINKING_MAX_LINES = 4;
const THINKING_MAX_CHARS = 500;

/** Wrapped-row count of one source line (empty line still occupies 1 row). Counts via
 *  rowsForText so a wide-glyph line at odd columns reports its TRUE (never under-counted)
 *  height — under-reserving here re-triggers Ink's scrollback-erasing full repaint. */
function rowsForLine(line: string, columns: number): number {
  return rowsForText(line, columns);
}

/** Wrapped-row count of a whole (possibly multi-line) text block. */
function textRows(text: string, columns: number): number {
  if (text.length === 0) return 0;
  let rows = 0;
  for (const line of text.split('\n')) rows += rowsForLine(line, columns);
  return rows;
}

/** Estimated rendered ROW count of a single block, wrap-aware. */
function blockLines(block: Block, columns: number): number {
  if (block.kind === 'text') return textRows(block.text, columns);
  if (block.kind === 'notice') {
    return Math.max(NOTICE_EST_LINES, rowsForLine(block.text, columns));
  }
  // tool — RESULT_LINE_MAX_CHARS is a clipCells CELL cap, so `rowsForWidth` is exact for
  // ASCII result lines but can under-reserve ~1 row for a near-cap wide-glyph line at small
  // odd columns (e.g. 25 cols: true 9 vs ceil(200/25)=8; converges to 0 at >=40 cols). This
  // pre-existing gap is owned by the deferred cell-budget migration (5d25834), not fixed here.
  return 1 + TOOL_RESULT_MAX_LINES * rowsForWidth(TOOL_RESULT_LINE_MAX_CHARS, columns);
}

/** Wrap-aware reserve for the collapsed extended-thinking region. */
function reasoningRows(columns: number): number {
  return 1 + Math.max(THINKING_MAX_LINES, rowsForWidth(THINKING_MAX_CHARS, columns));
}

/**
 * Return the trailing `remaining` WRAPPED ROWS of a text block, splitting mid-line
 * when the boundary source line is itself taller than the remaining budget (a wide
 * paragraph). Character-slicing a wrapped line to its tail rows is approximate but
 * only ever shows LESS than the budget, never more — the bound we must not exceed.
 */
function tailTextByRows(text: string, remaining: number, columns: number): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const rows = rowsForLine(line, columns);
    if (used + rows <= remaining) {
      kept.unshift(line);
      used += rows;
      continue;
    }
    const rowsLeft = remaining - used;
    if (rowsLeft > 0 && Number.isFinite(columns) && columns > 0) {
      // Keep the last `rowsLeft` wrapped rows, measured in DISPLAY CELLS via the
      // clipText authority. The old `line.slice(line.length - rowsLeft*columns)`
      // treated `rowsLeft*columns` as a UTF-16 CODE-UNIT count: on a CJK stream
      // (1 code unit = 2 cells) that kept ~2x the row budget — overflowing the
      // live window and re-triggering Ink's scrollback-erasing full repaint — and
      // could slice through a surrogate pair, emitting a lone `�`. wrapCells breaks
      // only on whole code points and never mid-glyph, and joins back losslessly.
      const wrapped = wrapCells(line, columns);
      const partial = wrapped.slice(-rowsLeft).join('');
      if (partial.length > 0) kept.unshift(partial);
    }
    break;
  }
  return kept.join('\n');
}

/**
 * Return a display copy of the live streaming `msg` whose rendered height is
 * bounded to roughly `maxLines` TERMINAL ROWS (showing the TAIL — the newest
 * content), prefixed with a dim elision marker when anything was dropped. Returns
 * the SAME `msg` reference (no allocation) when it already fits or clamping is
 * disabled (`maxLines` non-finite / ≤ 0) — so short turns and non-app callers are
 * untouched.
 *
 * `columns` is the terminal width used to count wrapped rows; pass the real
 * viewport width (app.tsx threads it from useTerminalSize). A non-finite /
 * non-positive `columns` disables wrap counting (1 row per source line) — the
 * behavior unit tests and non-TTY callers rely on. Callers should pass a
 * `maxLines` with headroom below the true viewport (see app.tsx).
 */
export function windowLiveMsg(
  msg: Msg,
  maxLines: number,
  columns: number = Number.POSITIVE_INFINITY,
): Msg {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return msg;

  const budget = msg.reasoning ? maxLines - reasoningRows(columns) : maxLines;
  const effectiveBudget = Math.max(1, budget);

  let total = 0;
  for (const block of msg.blocks) total += blockLines(block, columns);
  if (total <= effectiveBudget) return msg;

  // Walk from the LAST block toward the first, keeping blocks until the budget is
  // spent; slice the boundary text block to its trailing wrapped rows.
  const kept: Block[] = [];
  let used = 0;
  for (let i = msg.blocks.length - 1; i >= 0; i--) {
    const block = msg.blocks[i]!;
    const remaining = effectiveBudget - used;
    if (remaining <= 0) break;
    const height = blockLines(block, columns);
    if (height <= remaining) {
      kept.push(block);
      used += height;
      continue;
    }
    // Over budget: only a text block can be partially shown (its last `remaining`
    // wrapped rows). A tool/notice block is atomic — stop before it.
    if (block.kind === 'text') {
      const tail = tailTextByRows(block.text, remaining, columns);
      if (tail.length > 0) kept.push({ ...block, text: tail });
    }
    break;
  }
  kept.reverse();

  const marker: Block = {
    kind: 'notice',
    id: LIVE_WINDOW_MARKER_ID,
    text: LIVE_WINDOW_MARKER_TEXT,
  };
  return { ...msg, blocks: [marker, ...kept] };
}
