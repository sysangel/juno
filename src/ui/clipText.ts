// src/ui/clipText.ts
// The ONE single-line clip shared across the condensed tool card (ToolCallCard.oneLine),
// the per-agent status row / first-error line (Message.firstLineClipped), and the
// below-composer subagent panel (SubagentPanel.clip), so all three measure width the
// SAME way — in terminal DISPLAY CELLS (string-width), NOT UTF-16 code units.
//
// A CJK or emoji glyph is 2 cells; a `.slice(0, max - 1)` length clip lets those overflow
// the one-terminal-row budget (the "one condensed line" card then wraps to two rows) and
// can split a surrogate pair at the cut, emitting a lone-surrogate `�` at the
// ellipsis. This helper flattens internal whitespace to single spaces, trims, and — when
// the text is wider than `maxCells` — accumulates WHOLE code points until the next one
// would exceed the budget (reserving 1 cell for the trailing ellipsis, so a 2-cell glyph
// stops a cell early rather than splitting), guaranteeing the result's display width is
// always <= `maxCells`.
import stringWidth from 'string-width';

/** Whitespace-collapse + trim + clip to `max` DISPLAY CELLS with a trailing ellipsis.
 * `max <= 0` ⇒ '' (no room to render anything). */
export function clipCells(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (stringWidth(flat) <= max) return flat;
  let out = '';
  let used = 0;
  for (const ch of flat) {
    const w = stringWidth(ch);
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}
