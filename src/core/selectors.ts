// src/core/selectors.ts
// W3-PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No React/Ink imports; pure functions over State. Flagged as proposed in NOTES.
import type { Msg, State } from './reducer';

export interface TokenBar {
  in: number;
  out: number;
  total: number;
}

export interface CostState {
  /** USD cost of the session so far: cumulative input cost + output cost. */
  usd: number;
}

export interface StatusLineState {
  model: string;
  cwd: string;
  tokens: TokenBar;
  /** Fraction of the context window used, clamped to [0, 1]. */
  contextFraction: number;
  effort: State['effort'];
  overlay: State['overlay'];
  phase: State['phase'];
  statusText: string;
  pendingPermissionToolCallId: string | null;
  /** Names of the skills available this session (render-only indicator). */
  skills?: ReadonlyArray<string>;
  /** Active permission mode (only non-default values render a chip). */
  permissionMode?: 'default' | 'acceptEdits';
  /**
   * Estimate-based context pressure in [0,1] over the CURRENT committed transcript
   * (what gets RE-SENT next turn) — distinct from `contextFraction`, which is keyed
   * to lifetime cumulative `tokens`. Drives the compaction-aware bar tint.
   */
  contextPressure?: number;
  /** Number of compactions performed this session (renders a `cmp:<n>` chip when > 0). */
  compactions?: number;
  /**
   * True while an auto/manual compaction LLM call is in flight. Render-only: it makes
   * the otherwise-silent compaction window VISIBLE (the `cmp` chip switches to an active
   * `compacting…` form) so a submit dropped during the window is no longer invisible.
   */
  isCompacting?: boolean;
  /**
   * Per-turn tool-call budget for the iteration guard. `used` is the running count this turn;
   * `max` is the configured ceiling (undefined => unbounded). Render-only: the StatusLine shows
   * a `tools:used/max` chip (warn tint near the limit) only when a ceiling is set and used > 0,
   * so the runaway guard is VISIBLE rather than silent.
   */
  toolBudget?: { used: number; max?: number };
  /**
   * Cumulative session USD cost derived from the session's total tokens × the
   * active model's pricing. Absent when the model has no per-token price
   * (subscription backend) — the chip then renders nothing. Render-only.
   */
  cost?: CostState;
}

/**
 * Compaction trigger default: summarize once the estimated re-sent transcript crosses
 * 50% of `maxContext`. Tunable via config (`compactionThreshold`).
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.5;

/**
 * Floor on committed length before compaction is allowed. Below this, a compaction
 * could not meaningfully shrink the transcript (summary + tail ≈ original), so the
 * trigger stays off regardless of pressure.
 */
export const MIN_MESSAGES_TO_COMPACT = 4;

/** Rough per-message framing overhead (role tags / delimiters), in estimated tokens. */
const PER_MSG_OVERHEAD = 4;
/** Rough per-tool-block cost (tool name + arg framing), in estimated tokens. */
const PER_TOOL_BLOCK = 6;

/**
 * ESTIMATE (not a real tokenizer) of the transcript that `toTurnMessages` will
 * RE-SEND next turn: sum over committed messages of `ceil(textLen/4) + overhead`,
 * plus a small constant per tool block. `char/4` is the standard rough token
 * heuristic. Pure — no React, no import of the hook's `textFromBlocks`.
 *
 * Deliberately keyed to `state.committed` (current transcript), NOT to `state.tokens`
 * (lifetime cumulative spend, which over-counts re-sends and never falls after a
 * compaction). After a compaction `committed` shrinks, so this drops and the trigger
 * self-clears.
 */
export function estimateMessageTokens(msg: Msg): number {
  let textLen = 0;
  let toolBlocks = 0;
  for (const block of msg.blocks) {
    if (block.kind === 'text') {
      textLen += block.text.length;
    } else {
      toolBlocks += 1;
    }
  }
  return Math.ceil(textLen / 4) + PER_MSG_OVERHEAD + toolBlocks * PER_TOOL_BLOCK;
}

export function estimateTranscriptTokens(state: State): number {
  let total = 0;
  for (const msg of state.committed) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** Estimate-based context pressure in [0,1] over the current committed transcript. */
export function selectContextPressure(state: State, maxContext = 1_047_576): number {
  if (maxContext <= 0) return 0;
  return Math.min(1, estimateTranscriptTokens(state) / maxContext);
}

/**
 * Whether the harness should compact now: pressure at/over `threshold` AND enough
 * committed messages to shrink. Pure + side-effect-free; the compactor (Unit 2) is
 * the sole caller for the auto path and owns the actual summarize/dispatch.
 */
export function shouldCompact(
  state: State,
  maxContext: number,
  threshold = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  return (
    selectContextPressure(state, maxContext) >= threshold &&
    state.committed.length > MIN_MESSAGES_TO_COMPACT
  );
}

export function selectTokenBar(state: State): TokenBar {
  return { in: state.tokens.in, out: state.tokens.out, total: state.tokens.in + state.tokens.out };
}

/**
 * Pure cumulative session USD cost, priced against `pricing`.
 *
 * Uses `state.tokens` — the cumulative session totals — consistent with the
 * `tok:total` chip the StatusLine already shows. (A true per-turn delta would
 * need a new State field / reducer change, which is a frozen-seam touch and is
 * therefore out of scope; this selector reads only the existing cumulative
 * totals and touches no frozen file.)
 *
 * Returns undefined when `pricing` is absent (e.g. the subscription claude-cli
 * backend) so the caller hides the chip rather than rendering a misleading $0.00.
 */
export function selectCost(
  state: State,
  pricing?: { inputPerMTok: number; outputPerMTok: number },
): CostState | undefined {
  if (pricing === undefined) return undefined;
  const usd =
    (state.tokens.in / 1_000_000) * pricing.inputPerMTok +
    (state.tokens.out / 1_000_000) * pricing.outputPerMTok;
  return { usd };
}

/** Context-bar fraction. `max` defaults to a placeholder until config supplies the real window. */
export function selectContextFraction(state: State, max = 128000): number {
  if (max <= 0) return 0;
  return Math.min(1, (state.tokens.in + state.tokens.out) / max);
}

export function selectEffort(state: State): State['effort'] {
  return state.effort;
}

export function selectOverlay(state: State): State['overlay'] {
  return state.overlay;
}

export function selectPhase(state: State): State['phase'] {
  return state.phase;
}

export function selectPendingPermission(state: State): string | null {
  return state.pendingPermissionToolCallId;
}

/** Human-readable status for the StatusLine, derived purely from phase. */
export function selectStatusText(state: State): string {
  switch (state.phase) {
    case 'idle':
      return 'idle';
    case 'streaming':
      return 'thinking…';
    case 'awaiting-permission':
      return 'awaiting permission';
    case 'running-tool':
      return 'running tool…';
    case 'error':
      return state.errorMessage ?? 'error';
  }
}

/**
 * Bundle for the StatusLine. `model`/`cwd` are runtime/config concerns the UI
 * passes in (the reducer doesn't own them), with safe placeholders.
 */
export function selectStatusLine(
  state: State,
  context: {
    model?: string;
    cwd?: string;
    maxContext?: number;
    skills?: ReadonlyArray<string>;
    permissionMode?: 'default' | 'acceptEdits';
    isCompacting?: boolean;
    toolBudget?: { used: number; max?: number };
    pricing?: { inputPerMTok: number; outputPerMTok: number };
  } = {},
): StatusLineState {
  return {
    model: context.model ?? 'fake',
    cwd: context.cwd ?? '.',
    tokens: selectTokenBar(state),
    contextFraction: selectContextFraction(state, context.maxContext),
    effort: state.effort,
    overlay: state.overlay,
    phase: state.phase,
    statusText: selectStatusText(state),
    pendingPermissionToolCallId: state.pendingPermissionToolCallId,
    skills: context.skills,
    permissionMode: context.permissionMode,
    contextPressure: selectContextPressure(state, context.maxContext),
    compactions: state.compactions ?? 0,
    isCompacting: context.isCompacting ?? false,
    toolBudget: context.toolBudget,
    cost: selectCost(state, context.pricing),
  };
}
