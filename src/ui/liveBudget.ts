// src/ui/liveBudget.ts
// LANE scrollback (wave 8) — derive the live-turn height budget so the total dynamic redraw
// region stays strictly shorter than the viewport, and CLAMP the one expandable chrome piece
// (the agents dropdown) so that holds even fully expanded.
//
// WHY. Ink's renderer (node_modules/ink/build/ink.js onRender) full-screen repaints —
// erasing native scrollback via clearTerminal (\x1b[3J) — the MOMENT the dynamic region
// (everything below <Static>: the live turn + all composer chrome) reaches stdout.rows.
// liveWindow.ts bounds the LIVE TURN's rendered height to `liveMaxLines`; the bound is only
// correct if `liveMaxLines` leaves room for the ACTUAL chrome below it. The old code
// subtracted a FIXED reserve (LIVE_TURN_CHROME_RESERVE = 12) that ignored the agents
// dropdown's EXPANDED height: a full 8-agent panel adds ~10 rows, blowing past the fixed
// reserve and re-triggering the scrollback-erasing repaint.
//
// THE MODEL. Two waves of pty regressions proved `rows - 12` keeps the dynamic region below
// the viewport in the BASE shape: the agents dropdown collapsed/absent and a SINGLE-line
// composer. That 12 embeds the fixed chrome (LiveTurn line, both composer rules + their gap,
// one input line, the ctrl-c hint, the status line, the transcript↔live separator, the
// elision marker) PLUS Ink's own margins and safety slack — quantities that are fragile to
// reconstruct from source, so we keep the validated constant rather than re-derive it. The
// EXPANDABLE chrome (an expanded agents dropdown, a multiline composer) is then added ON TOP
// of that base and its rows are subtracted from the live budget ONE-FOR-ONE, so the total
// dynamic region stays exactly as far under `rows` as the proven base case — regardless of
// how tall the panel or composer grow. When even a clamped panel plus the live floor cannot
// fit, the panel degrades to its collapsed one-liner.
//
// Pure + deterministic so app.tsx threads state in and the whole budget is unit-testable
// without a terminal. app.tsx feeds `subagentMaxRows` back into <SubagentPanel> so the panel
// renders EXACTLY the height this module reserved — one source of truth.
import stringWidth from 'string-width';

/**
 * Default cap on how many agent rows the EXPANDED agents dropdown shows before it windows to
 * the newest rows (mirrors SubagentPanel's own default). The clamp below lowers this on a
 * viewport too short to host the full panel plus the live region.
 */
export const SUBAGENT_MAX_VISIBLE_ROWS = 8;

/** Floor for the live turn's windowed height — the newest tokens always stay visible even on
 *  a tiny viewport (matches app.tsx's historical `Math.max(4, …)`). */
export const MIN_LIVE_LINES = 4;

/**
 * Proven base reserve (LANE D, validated by tests/autoscroll.pty.test.ts across two waves):
 * `rows - 12` keeps the dynamic region shorter than the viewport when the agents dropdown is
 * collapsed/absent and the composer is a single line. The expandable chrome is accounted for
 * ON TOP of this — see the module header.
 */
export const BASE_CHROME_RESERVE = 12;

/**
 * Number of terminal rows a display width occupies at `columns` wide (>= 1). A non-finite /
 * non-positive `columns` ⇒ wrapping unknown, so fall back to 1 row (the non-TTY / unit-test
 * path). Mirrors liveWindow.ts's rowsForWidth so the two budgets agree.
 */
function rowsForWidth(width: number, columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 1;
  return Math.max(1, Math.ceil(width / columns));
}

/**
 * Rendered row count of the composer input for a (possibly multiline, possibly wide) value at
 * `columns` wide — at least 1 (the `❯ ` prompt line is always drawn). Counts WRAPPED rows so
 * a pasted line wider than the terminal reserves its true height, not 1.
 */
export function composerRows(value: string, columns: number): number {
  if (value.length === 0) return 1;
  let rows = 0;
  for (const line of value.split('\n')) rows += rowsForWidth(stringWidth(line), columns);
  return Math.max(1, rows);
}

/**
 * Rendered row count of the SubagentPanel for a given state — the ONE authority both this
 * module and <SubagentPanel> use, so the height reserved here matches the height rendered.
 * MIRRORS SubagentPanel's layout exactly:
 *   - no entries                → 0 rows (nothing rendered)
 *   - not focused               → 1 row  (the collapsed `▾ agents (…)` one-liner)
 *   - focused, maxVisibleRows<1 → 1 row  (viewport too short to expand → degrade to collapsed)
 *   - focused, maxVisibleRows≥1 → header(1) + `↑ N earlier`(0/1) + min(entries,max) rows + `↑/esc collapse`(1)
 */
export function subagentPanelRows(
  entryCount: number,
  focused: boolean,
  maxVisibleRows: number,
): number {
  if (entryCount <= 0) return 0;
  if (!focused || maxVisibleRows < 1) return 1;
  const shown = Math.min(entryCount, maxVisibleRows);
  const earlier = entryCount > shown ? 1 : 0;
  return 1 /* header */ + earlier + shown + 1 /* collapse hint */;
}

export interface LiveBudgetInputs {
  /** Terminal rows (stdout.rows). Non-finite / ≤ 0 ⇒ budgeting disabled (Infinity out). */
  readonly rows: number;
  /** Terminal columns (stdout.columns) — for wrap-aware composer height. */
  readonly columns: number;
  /** Current composer text — its multiline/wrapped height is expandable chrome. */
  readonly composerValue: string;
  /** Number of subagents the session has (0 ⇒ the panel renders nothing). */
  readonly subagentEntryCount: number;
  /** True when the agents dropdown is EXPANDED (reducer overlay `subagents`). */
  readonly subagentFocused: boolean;
}

export interface LiveBudget {
  /** Upper bound (in wrapped rows) on the live turn's rendered height — feed to
   *  <StreamingMessage maxLines>. Guarantees the dynamic region stays < rows. */
  readonly liveMaxLines: number;
  /** How many agent rows the EXPANDED panel may show — feed to <SubagentPanel maxRows>.
   *  Clamped below SUBAGENT_MAX_VISIBLE_ROWS only when the viewport is too short. */
  readonly subagentMaxRows: number;
}

/**
 * Rows the expandable agents dropdown may occupy while still leaving the base chrome, the
 * extra composer rows, and the live-region floor room. The panel's rendered height must fit
 * within this or the live turn would be starved below MIN_LIVE_LINES.
 */
function panelBudget(rows: number, extraComposerRows: number): number {
  return rows - BASE_CHROME_RESERVE - extraComposerRows - MIN_LIVE_LINES;
}

/**
 * Derive the live-turn budget and the agents-dropdown row cap from the current terminal size
 * and chrome state. Adds the expandable chrome (expanded panel + multiline composer) onto the
 * proven base reserve and subtracts it one-for-one from the live budget, so Ink never enters
 * its scrollback-erasing full-repaint branch. When `rows` is non-finite / ≤ 0 (no TTY threaded
 * through — unit tests, non-app callers) clamping is disabled: `liveMaxLines = Infinity`
 * (liveWindow returns the msg untouched) and the panel keeps its default cap.
 */
export function computeLiveBudget(inp: LiveBudgetInputs): LiveBudget {
  if (!Number.isFinite(inp.rows) || inp.rows <= 0) {
    return { liveMaxLines: Number.POSITIVE_INFINITY, subagentMaxRows: SUBAGENT_MAX_VISIBLE_ROWS };
  }

  const extraComposerRows = Math.max(0, composerRows(inp.composerValue, inp.columns) - 1);
  const budget = panelBudget(inp.rows, extraComposerRows);

  let subagentMaxRows = SUBAGENT_MAX_VISIBLE_ROWS;
  if (inp.subagentEntryCount > 0 && inp.subagentFocused) {
    const desired = subagentPanelRows(inp.subagentEntryCount, true, SUBAGENT_MAX_VISIBLE_ROWS);
    if (desired > budget) {
      // Clamp the visible agent rows so the expanded panel fits `budget`. When clamped the
      // `↑ N earlier` head is always present (entries > shown), so the non-row chrome is
      // header + earlier + collapse = 3; whatever remains hosts agent rows. `< 1` ⇒ no room
      // to expand at all, so the panel degrades to its collapsed one-liner (subagentPanelRows
      // treats maxVisibleRows < 1 as collapsed).
      subagentMaxRows = Math.max(0, budget - 3);
    }
  }

  const panelRows = subagentPanelRows(inp.subagentEntryCount, inp.subagentFocused, subagentMaxRows);
  const reserve = BASE_CHROME_RESERVE + panelRows + extraComposerRows;
  const liveMaxLines = Math.max(MIN_LIVE_LINES, inp.rows - reserve);
  return { liveMaxLines, subagentMaxRows };
}
