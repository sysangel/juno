// src/ui/collapse.ts
// Pure presentational helper for collapsing long tool output / reasoning to a
// bounded preview. NO state, NO I/O — a total function of its input.
//
// The TUI renders committed messages into Ink <Static> (printed once, never
// redrawn — see ARCHITECTURE.md), so collapse is a render-time cap driven by the
// content in reducer state, NOT a mutable per-card toggle. The raw payload stays
// off-screen; the card shows a first-N-lines preview plus a `… +K lines` marker.

export interface Collapsed {
  /** The shown portion: the first `maxLines` lines, further capped to `maxChars`. */
  readonly text: string;
  /** Lines dropped past the `maxLines` cap (0 when nothing was hidden by it). */
  readonly hiddenLines: number;
  /** True when the `maxChars` cap trimmed within the shown lines. */
  readonly truncated: boolean;
}

export interface CollapseOptions {
  readonly maxLines: number;
  readonly maxChars: number;
}

/**
 * Cap `raw` to `maxLines` lines and `maxChars` characters. Total and pure — a
 * short input passes through unchanged (`hiddenLines: 0`, `truncated: false`).
 */
export function collapse(raw: string, opts: CollapseOptions): Collapsed {
  const lines = raw.split('\n');
  const shownLines = lines.slice(0, Math.max(0, opts.maxLines));
  const hiddenLines = lines.length - shownLines.length;
  let text = shownLines.join('\n');
  let truncated = false;
  if (text.length > opts.maxChars) {
    // Cut on a WHOLE CODE POINT, never a UTF-16 code unit: a raw
    // `text.slice(0, maxChars)` can slice between the two halves of an astral
    // surrogate pair (emoji) and emit a lone `�`. Iterating with `for…of` yields
    // whole code points; `ch.length` is their UTF-16 width, so we keep the SAME
    // code-unit budget (a wide glyph is kept whole-or-dropped). The budget stays
    // in code units — not display cells — deliberately: it must remain coupled to
    // liveWindow.reasoningRows' reserve, and newlines are preserved (so clipText's
    // clipCells, which is cell-based + whitespace-collapsing + self-ellipsising,
    // does not apply to this multi-line, no-ellipsis preview).
    const limit = Math.max(0, opts.maxChars);
    let kept = '';
    for (const ch of text) {
      if (kept.length + ch.length > limit) break;
      kept += ch;
    }
    text = kept;
    truncated = true;
  }
  return { text, hiddenLines, truncated };
}

/**
 * Human indicator for a collapse — e.g. `… +120 lines`, `… truncated`,
 * `… +3 lines, truncated`, or `''` when nothing was hidden.
 */
export function collapseIndicator(c: Collapsed): string {
  const parts: string[] = [];
  if (c.hiddenLines > 0) parts.push(`+${c.hiddenLines} line${c.hiddenLines === 1 ? '' : 's'}`);
  if (c.truncated) parts.push('truncated');
  return parts.length > 0 ? `… ${parts.join(', ')}` : '';
}
