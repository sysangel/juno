// src/core/abort.ts
// The three literal `error` reasons a tool/subagent card can carry that mean the run was
// CANCELLED (by the user or the parent), not that it genuinely FAILED:
//
//   INTERRUPTED_NOTICE ('interrupted')  — a turn-level Esc/Ctrl+C: the reducer's
//     `normalizeInterruptedTools` settles every in-flight member to
//     { status: 'error', error: INTERRUPTED_NOTICE } so an abort never commits a
//     live spinner; the same string is also the dim scrollback notice block.
//   SUBAGENT_ABORTED ('sub-agent aborted') — a subagent-tool parent-abort cascade:
//     `subagentTool.run` returns { ok: false, error: SUBAGENT_ABORTED } when the
//     parent's AbortController fires, landing on the live tools map as 'error'.
//   ABORTED_NOTICE ('aborted') — the EXECUTOR's own cancel marker: `emitAborted`
//     (executor.ts) settles a tool to { status: 'error', error: ABORTED_NOTICE } when the
//     abort signal fires at the entry gate, between PreToolUse hooks, or after the
//     permission prompt. `normalizeInterruptedTools` leaves an already-settled error tool
//     untouched, so this string PERSISTS — without matching it here, an executor-aborted
//     tool would misclassify as a red FAIL.
//
// Both funnel a card to ToolStatus 'error', so the raw status alone cannot tell a
// benign cancel from a real failure. `isAbortReason` is the ONE predicate both render
// surfaces (the transcript SubagentStatusRow + the below-composer SubagentPanel) key
// off, so a cancel classifies identically to a neutral `aborted` glyph on both — and
// the two surfaces can never drift on a hand-copied string literal.
//
// Lives in `core` (pure, no tool/UI imports) so selectors, the reducer, and the
// subagent tool can all share the constants without a core→tools dependency edge.

/** Turn-level Esc/Ctrl+C abort marker (reducer notice + normalized tool error). */
export const INTERRUPTED_NOTICE = 'interrupted';

/** Subagent-tool parent-abort cascade marker (`subagentTool.run` error). */
export const SUBAGENT_ABORTED = 'sub-agent aborted';

/** Executor's own cancel marker — `emitAborted` settles a tool to this on a signal abort at
 *  the entry gate / between hooks / post-permission. Shared so the literal and `isAbortReason`
 *  can never drift. */
export const ABORTED_NOTICE = 'aborted';

/**
 * True when a card's `error` string is one of the abort markers — i.e. the run was
 * cancelled, not failed. Matches on the FIRST line/trimmed so a normalized error that
 * carried a trailing newline (or is compared before/after `.split('\n')[0]` clipping)
 * still classifies. Undefined / any other message ⇒ a genuine error (false).
 */
export function isAbortReason(error?: string): boolean {
  if (error === undefined) return false;
  const first = error.split('\n')[0]?.trim();
  return first === INTERRUPTED_NOTICE || first === SUBAGENT_ABORTED || first === ABORTED_NOTICE;
}

/** User pressed [d] on the permission prompt — a routine decline, NOT a failure. */
export const DENIED = 'denied';

/** Policy auto-denied the call (`policy.evaluate` → 'auto-deny') — also a decline. */
export const DENIED_BY_POLICY = 'denied by policy';

/**
 * True when a card's `error` string is one of the DENY markers — i.e. the call was
 * declined (by the user's [d] or an auto-deny policy), not that it genuinely failed.
 * Sibling of {@link isAbortReason}: EXACT first-line/trimmed match (never `startsWith`),
 * so a real tool error whose text merely contains "denied" (e.g. `denied: access`) is
 * NOT misclassified as a decline. Undefined / any other message ⇒ false.
 */
export function isDenyReason(error?: string): boolean {
  if (error === undefined) return false;
  const first = error.split('\n')[0]?.trim();
  return first === DENIED || first === DENIED_BY_POLICY;
}
