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

/** Stable React key for the elision marker (constant → no remount churn). */
export const LIVE_WINDOW_MARKER_ID = 'live-window:elided';
/** Text of the dim marker prepended when leading live content is elided. */
export const LIVE_WINDOW_MARKER_TEXT = '⋮ earlier output — full text prints when the turn completes';

// Rough rendered-height estimates for non-text blocks (text uses its real line
// count). Tool cards are already height-capped (glyph line + ≤3 result lines);
// notices are single lines. These only feed the height BUDGET, never what renders.
const TOOL_EST_LINES = 4;
const NOTICE_EST_LINES = 1;
// Extended-thinking renders collapsed (a heading + a bounded preview) above the
// blocks, so reserve a small fixed budget for it when present.
const REASONING_EST_LINES = 5;

/** Estimated rendered line count of a single block. */
function blockLines(block: Block): number {
  if (block.kind === 'text') {
    return block.text.length === 0 ? 0 : block.text.split('\n').length;
  }
  if (block.kind === 'notice') return NOTICE_EST_LINES;
  return TOOL_EST_LINES; // tool
}

/**
 * Return a display copy of the live streaming `msg` whose rendered height is
 * bounded to roughly `maxLines` lines (showing the TAIL — the newest content),
 * prefixed with a dim elision marker when anything was dropped. Returns the SAME
 * `msg` reference (no allocation) when it already fits or clamping is disabled
 * (`maxLines` non-finite / ≤ 0) — so short turns and non-app callers are untouched.
 *
 * The line budget is approximate (source lines, not terminal-wrapped rows); callers
 * should pass a `maxLines` with headroom below the true viewport (see app.tsx).
 */
export function windowLiveMsg(msg: Msg, maxLines: number): Msg {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return msg;

  const budget = msg.reasoning ? maxLines - REASONING_EST_LINES : maxLines;
  const effectiveBudget = Math.max(1, budget);

  let total = 0;
  for (const block of msg.blocks) total += blockLines(block);
  if (total <= effectiveBudget) return msg;

  // Walk from the LAST block toward the first, keeping blocks until the budget is
  // spent; slice the boundary text block to its trailing lines.
  const kept: Block[] = [];
  let used = 0;
  for (let i = msg.blocks.length - 1; i >= 0; i--) {
    const block = msg.blocks[i]!;
    const remaining = effectiveBudget - used;
    if (remaining <= 0) break;
    const height = blockLines(block);
    if (height <= remaining) {
      kept.push(block);
      used += height;
      continue;
    }
    // Over budget: only a text block can be partially shown (its last `remaining`
    // lines). A tool/notice block is atomic — stop before it.
    if (block.kind === 'text') {
      const lines = block.text.split('\n');
      const tail = lines.slice(lines.length - remaining).join('\n');
      kept.push({ ...block, text: tail });
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
