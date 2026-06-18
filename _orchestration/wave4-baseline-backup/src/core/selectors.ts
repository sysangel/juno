// src/core/selectors.ts
// W3-PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No React/Ink imports; pure functions over State. Flagged as proposed in NOTES.
import type { State } from './reducer';

export interface TokenBar {
  in: number;
  out: number;
  total: number;
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
}

export function selectTokenBar(state: State): TokenBar {
  return { in: state.tokens.in, out: state.tokens.out, total: state.tokens.in + state.tokens.out };
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
  context: { model?: string; cwd?: string; maxContext?: number } = {},
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
  };
}
