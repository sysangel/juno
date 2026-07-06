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
    text = text.slice(0, Math.max(0, opts.maxChars));
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
