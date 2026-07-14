// src/hooks/useOptimisticTurn.ts
// W10 optimistic-turn — the resumed-turn spinner's optimistic-mount seam,
// extracted from app.tsx (W6, decomposed in W9). Owns the optimistic-turn flag
// and the guarded submit wrapper that raises it, plus the pure pre-start
// activity fallback. The flag fills the pre-`assistant-start` gap so a --resume
// turn — whose start event is DEFERRED to its first content, ~1.7-2.2s — shows
// the busy line as promptly as a fresh turn.
//
// EFFECT-ORDER NOTE (why the takeover-clear effect stays inline in App): the
// composition root's effect order is load-bearing (… → bell → takeover clear,
// LAST). This hook is CALLED EARLY — right after useStreamingTurn — because
// `runSubmit` is consumed by useSubmitRouting well before the bell. A hook owns
// its effects AT its call position, so folding the takeover `useEffect` in here
// would hoist it AHEAD of the mcp/persistence/bell effects, reordering the
// commit. So the hook deliberately exposes `setOptimisticTurn` and the 3-line
// takeover effect stays in App at its exact pre-extraction slot — byte-for-byte,
// zero effect-order change. `optimisticActivity` (pure) + `runSubmit` (the
// isBusy-guarded raise + settle-clear) carry the extracted logic; both are
// directly unit-tested (see tests/useOptimisticTurn.test.tsx).
import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActivityState } from '../core/selectors';

/**
 * Optimistic pre-start activity: the SAME 'thinking…' busy line `selectActivity`
 * yields for a streaming turn that has emitted no visible text yet. Rendered from
 * the instant a turn is submitted until the provider's `assistant-start` flips the
 * reducer phase (see `optimisticTurn`). Because the label/abortable/attention here
 * MATCH what `selectActivity` returns for that early phase, the handover from
 * optimistic → real is seamless — `LiveTurn`'s by-value memo bails on the swap, so
 * the spinner never blinks or double-mounts and the elapsed clock keeps ticking.
 */
export const OPTIMISTIC_ACTIVITY: ActivityState = {
  label: 'thinking…',
  abortable: true,
  attention: false,
};

/**
 * Live-turn activity with the optimistic pre-start fallback: the real,
 * phase-derived activity ALWAYS wins; only when it is null AND a turn is in its
 * optimistic window do we stand in the 'thinking…' line. So `assistant-start`
 * arriving is a silent takeover (real replaces the value-equal optimistic; the
 * memoized LiveTurn doesn't even re-render), and a terminal phase (idle/error)
 * drops the line the moment the real activity clears — no lingering spinner.
 * PURE + exported so the precedence (real > optimistic > none) is unit-testable
 * without rendering App.
 */
export function optimisticActivity(
  realActivity: ActivityState | null,
  optimisticTurn: boolean,
): ActivityState | null {
  return realActivity ?? (optimisticTurn ? OPTIMISTIC_ACTIVITY : null);
}

/**
 * The minimal useStreamingTurn surface `runSubmit` reads: the synchronous busy
 * guard + the dispatcher. Structurally a subset of StreamingTurnControls, so the
 * real `turn` satisfies it and a test can pass a two-method fake.
 */
export interface OptimisticTurnDeps {
  readonly turn: {
    readonly isBusy: () => boolean;
    readonly submit: (text: string) => Promise<void>;
  };
}

export interface OptimisticTurnController {
  /**
   * True from the instant a turn is submitted until it EITHER produces a real
   * activity (normal handover, cleared by App's takeover effect) OR settles
   * without one (a failed start, cleared by `runSubmit`'s `.finally`).
   */
  readonly optimisticTurn: boolean;
  /**
   * The takeover-clear writer. Exposed so App's LAST effect (the real-activity
   * handover) keeps its exact pre-extraction slot — see the EFFECT-ORDER NOTE.
   */
  readonly setOptimisticTurn: Dispatch<SetStateAction<boolean>>;
  /**
   * Guarded submit: raises the flag then settle-clears; a no-op (flag untouched)
   * while a turn already holds the controller.
   */
  readonly runSubmit: (text: string) => void;
}

export function useOptimisticTurn({ turn }: OptimisticTurnDeps): OptimisticTurnController {
  // Optimistic-turn flag (resumed-turn spinner). True from the instant a turn is
  // submitted until it EITHER produces a real activity (the provider's first phase
  // change — normal handover) OR settles without one (a failed start). It only fills
  // the pre-`assistant-start` gap so a --resume turn — whose start event is DEFERRED
  // to its first content, ~1.7-2.2s — still shows the busy line as promptly as a fresh
  // turn. See `runSubmit` (set + settle-clear) and App's takeover effect (real-activity clear).
  const [optimisticTurn, setOptimisticTurn] = useState(false);

  // Submit wrapper that raises the optimistic-turn flag the instant a turn is
  // dispatched, then lowers it when the turn fully settles. The settle-clear is the
  // load-bearing half of the FAILED-START requirement: a spawn error / immediate
  // provider error produces no real activity, so the flag would otherwise linger — but
  // `turn.submit` still resolves once `runTurn` surfaces the error and returns, clearing
  // it. The happy path clears earlier via App's takeover effect; this `.finally` is
  // then a harmless no-op.
  //
  // The `isBusy()` early-return makes runSubmit OWN the flag it raises. When a turn
  // already holds the controller, `turn.submit` silently no-ops (useStreamingTurn's
  // `controllerRef.current !== null` guard) — but its `.finally` would still fire and
  // lower the flag, killing the IN-FLIGHT turn's optimistic indicator mid-window (the
  // pre-`assistant-start` gap this track exists to eliminate). Returning early here
  // preserves that no-op submit semantics WITHOUT touching the flag, so a second submit
  // interleaved during the optimistic window (e.g. the slash-overlay path — plain text
  // typed over the seeded '/' then Enter — which has no busy gate of its own) cannot
  // resurrect the spinner gap. The plain-input submit paths already gate on isBusy()
  // before calling; this makes the guard total and covers any future caller.
  const runSubmit = useCallback(
    (text: string): void => {
      if (turn.isBusy()) {
        return;
      }
      setOptimisticTurn(true);
      void turn.submit(text).finally(() => setOptimisticTurn(false));
    },
    [turn],
  );

  return { optimisticTurn, setOptimisticTurn, runSubmit };
}
