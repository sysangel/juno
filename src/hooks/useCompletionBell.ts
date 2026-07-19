// src/hooks/useCompletionBell.ts
// W9 app-decompose — the completion bell (config-gated, default off): ring the
// terminal BEL once when a turn GENUINELY completes so a user in another window gets
// a cue. Process-edge I/O lives HERE, not in the reducer; `shouldRingBell` keeps the
// transition logic pure/testable.
//
// The bell keys off the reducer-owned `completedTurns` COUNTER, not a phase edge: a
// natural completion and an Esc-abort BOTH land at 'idle', so a phase-edge predicate
// rang on abort (wrong when the bell is on). The reducer increments completedTurns only
// on a real terminal 'end'/'max_tokens' stop (never abort/error/compaction), so it is
// the single authority that distinguishes "finished" from "cancelled" — consistent with
// "reducer is sole authority, no mirror."
import { useEffect, useRef } from 'react';

/**
 * Completion bell predicate: ring exactly when the reducer's completed-turn counter
 * ADVANCES. PURE + exported so it is unit-testable without rendering App.
 */
export function shouldRingBell(prev: number, next: number): boolean {
  return next > prev;
}

export interface CompletionBellDeps {
  /** The reducer's completed-turn counter (turn.state.completedTurns ?? 0) at this render. */
  readonly completed: number;
  /** settings.completionBell — the config gate. */
  readonly enabled: boolean | undefined;
}

export function useCompletionBell(deps: CompletionBellDeps): void {
  const { completed, enabled } = deps;
  const prevCompletedRef = useRef(completed);
  useEffect(() => {
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completed;
    if (enabled === true && shouldRingBell(prev, completed)) {
      process.stdout.write('\u0007');
    }
  }, [completed, enabled]);
}
