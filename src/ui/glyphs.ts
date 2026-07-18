// src/ui/glyphs.ts
// The one place juno's STATIC glyph literals live, named by the SEMANTIC ROLE the
// call site plays rather than by shape, so `TOOL_DONE` reads clearer than a bare '●'
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

/** Settled / result filled dot (a tool that finished). */
export const TOOL_DONE = '●';
/**
 * Queued-but-not-started filled dot. Same codepoint as {@link TOOL_DONE} yet a DISTINCT
 * meaning (both ToolCallCard and ToolDetailOverlay's static list map `pending` and
 * `result` to the same '●'); kept as its own name so collapsing the two never silently
 * merges "queued" into "done". Never {@link TOOL_WAITING} — a queued tool is NOT
 * permission-gated, and the overlay has no permission concept to render ◌ for.
 */
export const TOOL_PENDING = '●';
/**
 * Exhaustiveness placeholder for the `running` state. Never actually rendered — an
 * animated spinner replaces it at the row — but the switch branches return it so the
 * status unions stay total. Kept as a constant so those branches don't drift.
 */
export const RUNNING_STATIC = '●';

/** Permission-gated / not-yet-active hollow dot (waiting on a decision). */
export const TOOL_WAITING = '◌';

/**
 * In-progress half-circle used by the NON-animated status lists (where a live spinner
 * would be out of place): the running row in SubagentPanel / ToolDetailOverlay, and the
 * pending/running fallbacks in GroupedToolRows. Those surfaces deliberately render this
 * one glyph for "in flight, shown statically"; the name reflects that shared role.
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
  TOOL_DONE,
  TOOL_PENDING,
  RUNNING_STATIC,
  TOOL_WAITING,
  RUNNING_HALF,
  OK,
  FAIL,
  ABORTED,
} as const;
