// src/hooks/useCtrlCExit.ts
// Double-press Ctrl+C interrupt/exit. Ink's default `exitOnCtrlC` is DISABLED
// (cli.ts render options) so this hook is the SOLE owner of \x03 — no other
// SIGINT/ctrl+c handler exists (useKeybinds ignores ctrl+c entirely).
//
// Behaviour (single source of truth = decideCtrlC):
//   * First Ctrl+C while a turn is in flight  → abort the turn (provider request
//     cancelled + child killed via the existing turn.abort path), app STAYS
//     alive, arm a "press ctrl+c again to exit" hint.
//   * First Ctrl+C while idle → clear the composer if it has text; always arm
//     the exit hint.
//   * Second Ctrl+C within CTRLC_WINDOW_MS → exit via the GRACEFUL quit path
//     (Ink's useApp().exit() → unmount → cli.ts's waitUntilExit → MCP shutdown +
//     terminal restore). Never a raw process.exit mid-stream.
//   * Any OTHER key disarms the window (and clears the hint); once the window
//     lapses, the next Ctrl+C is a "first press" again.
//
// The exit DECISION is a pure Date.now() comparison (not a setTimeout) so it is
// deterministic under test — inject `now` to drive the window without fake
// timers fighting Ink's effect scheduler. A separate setTimeout only auto-clears
// the transient hint UI and never gates the exit.
import { useInput, useApp } from 'ink';
import { useEffect, useRef } from 'react';

/** Second-press window. Single constant — the whole feature's timing lives here. */
export const CTRLC_WINDOW_MS = 1800;

export const CTRLC_HINT_INTERRUPTED = 'interrupted — press ctrl+c again to exit';
export const CTRLC_HINT_EXIT = 'press ctrl+c again to exit';

export type CtrlCAction = 'exit' | 'abort' | 'clear-input' | 'arm';

export interface CtrlCDecision {
  readonly action: CtrlCAction;
  /** Hint to surface. Always the exit hint for a non-exit press; unused on exit. */
  readonly hint: string;
}

/**
 * Pure Ctrl+C decision. Exported so the state machine is unit-testable without
 * Ink or timers. `lastPressAt` is null before the first press (or after a
 * disarm); `now`/`windowMs` control the second-press window.
 */
export function decideCtrlC(opts: {
  readonly lastPressAt: number | null;
  readonly now: number;
  readonly windowMs: number;
  readonly isBusy: boolean;
  readonly hasValue: boolean;
}): CtrlCDecision {
  const { lastPressAt, now, windowMs, isBusy, hasValue } = opts;
  const armed = lastPressAt !== null && now - lastPressAt < windowMs;
  if (armed) {
    return { action: 'exit', hint: '' };
  }
  if (isBusy) {
    return { action: 'abort', hint: CTRLC_HINT_INTERRUPTED };
  }
  if (hasValue) {
    return { action: 'clear-input', hint: CTRLC_HINT_EXIT };
  }
  return { action: 'arm', hint: CTRLC_HINT_EXIT };
}

export interface UseCtrlCExitOptions {
  /** Is a turn currently in flight? Read at press time (fresh controller ref). */
  readonly isBusy: () => boolean;
  /** Does the composer currently hold text? Read at press time. */
  readonly hasValue: () => boolean;
  /** Clear the composer input. */
  readonly clearValue: () => void;
  /** Abort the in-flight turn (existing turn.abort — cancels provider + kills child). */
  readonly abort: () => void;
  /** Surface (or clear, with null) the transient hint line. */
  readonly setHint: (hint: string | null) => void;
  /**
   * Graceful exit. Defaults to Ink's useApp().exit() (unmount → cli.ts teardown).
   * Injectable so tests can assert the quit path WITHOUT a real process.exit.
   */
  readonly exit?: () => void;
  /** Clock for the second-press window. Injectable for deterministic tests. */
  readonly now?: () => number;
  /** Second-press window override (defaults to CTRLC_WINDOW_MS). */
  readonly windowMs?: number;
}

/**
 * Own all Ctrl+C handling via a dedicated, overlay-UNGATED useInput. Runs
 * alongside useKeybinds' useInput (which is a no-op for ctrl+c), so ordering
 * between the two is irrelevant.
 */
export function useCtrlCExit(options: UseCtrlCExitOptions): void {
  const inkApp = useApp();
  const {
    isBusy,
    hasValue,
    clearValue,
    abort,
    setHint,
    exit = inkApp.exit,
    now = Date.now,
    windowMs = CTRLC_WINDOW_MS,
  } = options;

  // Timestamp of the last (armed) Ctrl+C press; null when disarmed. A ref, not
  // state — the decision reads it synchronously at press time and it must never
  // trigger a render on its own.
  const lastPressRef = useRef<number | null>(null);
  // Auto-clear timer for the hint UI only — never gates the exit decision.
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHintTimer = (): void => {
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  // Clear any pending hint timer on unmount so a fired callback can't setState
  // after teardown.
  useEffect(() => clearHintTimer, []);

  useInput((input, key) => {
    const isCtrlC = key.ctrl && input === 'c';

    if (!isCtrlC) {
      // Any other key disarms the window + drops the hint (only when armed, to
      // avoid churn on every keystroke).
      if (lastPressRef.current !== null) {
        lastPressRef.current = null;
        clearHintTimer();
        setHint(null);
      }
      return;
    }

    const decision = decideCtrlC({
      lastPressAt: lastPressRef.current,
      now: now(),
      windowMs,
      isBusy: isBusy(),
      hasValue: hasValue(),
    });

    if (decision.action === 'exit') {
      lastPressRef.current = null;
      clearHintTimer();
      setHint(null);
      exit();
      return;
    }

    if (decision.action === 'abort') {
      abort();
    } else if (decision.action === 'clear-input') {
      clearValue();
    }

    // Arm the second-press window and surface the hint.
    lastPressRef.current = now();
    setHint(decision.hint);

    // Auto-clear the hint UI once the window lapses (best-effort; the exit
    // decision does not depend on this firing).
    clearHintTimer();
    hintTimerRef.current = setTimeout(() => {
      hintTimerRef.current = null;
      // Only clear if still armed by THIS press (no newer press re-armed).
      if (lastPressRef.current !== null && now() - lastPressRef.current >= windowMs) {
        lastPressRef.current = null;
        setHint(null);
      }
    }, windowMs);
  });
}
