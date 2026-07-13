// src/hooks/useCompletionBell.ts
// W9 app-decompose — the completion bell (config-gated, default off), extracted
// verbatim from app.tsx: ring the terminal BEL once when a turn finishes (phase
// leaves streaming/running-tool for idle) so a user in another window gets a
// cue. Process-edge I/O lives HERE, not in the reducer; `shouldRingBell` keeps
// the transition logic pure/testable.
import { useEffect, useRef } from 'react';
import type { State } from '../core/reducer';

/**
 * Completion bell predicate: ring exactly when a turn ENDS — the phase leaves an
 * in-flight state ('streaming' | 'running-tool') for 'idle'. PURE + exported so
 * the transition table is unit-testable without rendering App. Overlay-driven
 * phase flips (e.g. 'awaiting-permission') and error terminals never ring.
 */
export function shouldRingBell(prev: State['phase'], next: State['phase']): boolean {
  return (prev === 'streaming' || prev === 'running-tool') && next === 'idle';
}

export interface CompletionBellDeps {
  /** The reducer phase (turn.state.phase) at this render. */
  readonly phase: State['phase'];
  /** settings.completionBell — the config gate. */
  readonly enabled: boolean | undefined;
}

export function useCompletionBell(deps: CompletionBellDeps): void {
  const { phase, enabled } = deps;
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (enabled === true && shouldRingBell(prev, phase)) {
      process.stdout.write('\u0007');
    }
  }, [phase, enabled]);
}
