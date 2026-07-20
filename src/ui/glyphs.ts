// src/ui/glyphs.ts
// The one place juno's STATIC glyph literals live, named by the SEMANTIC ROLE the
// call site plays rather than by shape, so `TOOL_PENDING` reads clearer than a bare '●'
// scattered across eight components. This is a pure de-scatter of literals that were
// already in the tree — every constant preserves the EXACT current codepoint; nothing
// is normalized.
//
// WHY this module exists (beyond de-duplication): every glyph here is width 1 in juno's
// own width authority (`displayWidth` → string-width). InputBox.tsx documents a real
// shipped "jiggle" bug where a one-column width mismatch shoved adjacent text sideways
// as focus moved. tests/glyphs.test.ts locks displayWidth === 1 for each of these so a
// future edit that swaps in a width-2 glyph (or an East-Asian-wide normalization) fails
// loudly instead of silently reflowing a layout slot budgeted for one cell.
//
// NOT here on purpose:
//   - The animated spinner is ink-spinner's built-in `type="dots"` — an EXTERNAL frame
//     set juno does not own. We do NOT reimplement it; we only mirror its frames as
//     SPINNER_DOTS_FRAMES so the test can guard against a dependency bump changing width.
//   - There is no cursor glyph: the composer draws its cursor via `<Text inverse>`
//     styling (InputBox.tsx), not a character. Do not add a phantom cursor export.
import type { PresentedStatus } from '../core/selectors';
import type { FlatTokenName } from './theme';

/** Composer / message-echo prompt marker (bare, width 1). */
export const PROMPT = '❯';
/**
 * The rendered prompt LINE: the marker plus its conventional trailing space. Both the
 * InputBox composer prompt and the Message user-echo marker draw this exact two-cell
 * string; keeping the space in one constant stops any site drifting a column (the '❯ '
 * vs '❯  ' jiggle class). Two cells wide — NOT a single-cell glyph, so it is excluded
 * from the width-1 invariant set below.
 */
export const PROMPT_LINE = `${PROMPT} ` as const; // '❯ '

/** U+2500 box-drawing hairline — one row, never a full border box (InputBox rule, MD hr). */
export const RULE_CHAR = '─';

/**
 * Queued-but-not-started filled dot — the SOLE '●' in juno's surfaces. It means only
 * "queued": a tool issued but not yet executing. A settled/done tool renders ✓ (OK), NOT
 * '●' — this lane closed the old ●↔✓ collision where a done tool and a queued tool wore
 * the same dot. Never {@link TOOL_WAITING} — a queued tool is NOT permission-gated, and the
 * overlay has no permission concept to render ◌ for.
 */
export const TOOL_PENDING = '●';

/** Permission-gated / not-yet-active hollow dot (waiting on a decision). */
export const TOOL_WAITING = '◌';

/**
 * In-progress half-circle: the STATICALLY-shown running glyph, used where a live spinner
 * would be out of place — the running row in SubagentPanel / ToolDetailOverlay. (In
 * GroupedToolRows it survives only as the never-rendered `running` placeholder that keeps
 * that switch exhaustive; the live group row draws the animated spinner.) Those surfaces
 * render this one glyph for "in flight, shown statically"; the name reflects that role.
 */
export const RUNNING_HALF = '◐';

/** Success check. */
export const OK = '✓';
/** Failure cross. */
export const FAIL = '✗';
/**
 * Cancelled / aborted circled slash. A user Esc/Ctrl+C (or a parent-abort cascade) is
 * NOT a failure, so an aborted subagent gets its own neutral glyph — deliberately
 * distinct from OK ✓, FAIL ✗, and the running half-circle ◐ — rendered in a muted
 * (textDim) hue rather than error red. Width 1 in juno's authority (asserted below).
 */
export const ABORTED = '⊘';

/** Selected-row marker for interactive lists — palette + tool-detail overlay; accent+bold at the call site. */
export const SELECTED = '▸';
/** Neutral list bullet (mcp "connecting" server rows). */
export const BULLET = '◦';
/** Agents-strip collapse/expand marker. */
export const DISCLOSURE = '▾';
/** Extended-thinking region marker. */
export const THINKING = '✻';
/** Scroll/overflow "more/earlier above" marker. */
export const ARROW_UP = '↑';
/** Scroll/overflow "more below" marker. */
export const ARROW_DOWN = '↓';

/**
 * The frames of ink-spinner's built-in `type="dots"` animation, mirrored here ONLY so
 * the invariant test can lock that every frame shares one width (so the animation never
 * reflows) and catch a cli-spinners version bump that changed frame width. juno keeps
 * calling `<Spinner type="dots" />`; this constant is a drift guard, not the renderer.
 */
export const SPINNER_DOTS_FRAMES = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'] as const;

/**
 * Every SINGLE-CELL static glyph, keyed by its export name, for the width-invariant test
 * to iterate. PROMPT_LINE (two cells) and SPINNER_DOTS_FRAMES (a frame set) are excluded
 * by design and asserted separately.
 */
export const SINGLE_CELL_GLYPHS = {
  PROMPT,
  RULE_CHAR,
  TOOL_PENDING,
  TOOL_WAITING,
  RUNNING_HALF,
  OK,
  FAIL,
  ABORTED,
  SELECTED,
  BULLET,
  DISCLOSURE,
  THINKING,
  ARROW_UP,
  ARROW_DOWN,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// The ONE presentation seam every lifecycle surface routes through (wave-14 a1).
// Classification lives in core (`presentedStatus`); this is its GLYPH + COLOR half.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared GLYPH for the presented states that are UNIFORM across every surface.
 * done (✓/OK) and queued (●/TOOL_PENDING) are now UNIFORM everywhere too, so they map
 * at their call sites rather than here; only the RUNNING presentation still differs (an
 * animated spinner on the live cards vs the static ◐ in non-animated lists), which is why
 * running is likewise excluded. Only waiting/error/aborted/declined route through here.
 * `declined` shares the ⊘ GLYPH with `aborted` (neither is a red crash), but its COLOR is amber
 * (`warning`, via {@link presentedStatusToken}), NOT the dim of a cancel — a deliberate
 * deny reads distinct from both a red failure AND an incidental abort.
 */
export function presentedStateGlyph(
  status: 'waiting' | 'error' | 'aborted' | 'declined',
): string {
  switch (status) {
    case 'waiting':
      return TOOL_WAITING; // ◌
    case 'error':
      return FAIL; // ✗
    case 'aborted':
      return ABORTED; // ⊘
    case 'declined':
      return ABORTED; // ⊘  (neutral — a decline is not a crash)
  }
}

/**
 * Shared COLOR token (the glyph's hue). Uniform across every surface. done=green,
 * running=cyan, queued=dim-pending, waiting=amber, error=red, aborted=neutral dim (an
 * incidental cancel), declined=amber (`warning` — a deliberate deny is distinct from both
 * a red crash and a dim cancel).
 */
export function presentedStatusToken(status: PresentedStatus): FlatTokenName {
  switch (status) {
    case 'done':
      return 'toolResult';
    case 'running':
      return 'toolRunning';
    case 'queued':
      return 'toolPending';
    case 'waiting':
      return 'warning';
    case 'error':
      return 'toolError';
    case 'aborted':
      return 'textDim';
    case 'declined':
      return 'warning';
  }
}

/**
 * True when a status carries its meaning across the WHOLE row (glyph + all text): a red
 * failure SHOUTS, an amber wait/decline SHOUTS; `aborted` is deliberately EXCLUDED — an
 * incidental cancel dims only its glyph/detail and keeps the tool name in default text;
 * done/running/queued likewise keep a colored glyph over dim/neutral detail.
 */
export function isWholeLinePresented(status: PresentedStatus): boolean {
  return status === 'error' || status === 'waiting' || status === 'declined';
}
