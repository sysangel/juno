// tests/useOptimisticTurn.test.tsx
// W10 optimistic-turn — the resumed-turn spinner's optimistic-mount seam
// (useOptimisticTurn), tested directly. The full-App behavioral proof stays in
// tests/resumedTurnSpinner.test.tsx (optimistic mount, seamless handover, failed-
// start clear, Esc-abort, and the slash-overlay interleave); this file pins the
// EXTRACTED seam AT the hook boundary so every branch the W3 spinner bugs lived in
// keeps a direct guard after the decomposition:
//   - optimisticActivity precedence: real > optimistic > none (pure)
//   - runSubmit raises the flag at submit and dispatches the turn
//   - runSubmit settle-clears the flag when the turn resolves with no real activity
//     (the failed-start path — the takeover effect never fires)
//   - the isBusy() early-return no-ops WITHOUT touching an in-flight flag (the
//     interleaved second submit) and without dispatching a second turn
//   - setOptimisticTurn is exposed as the takeover-clear writer App's LAST effect uses
//
// No fake timers: the pre-settle window is held open by a manually-resolved promise
// (a settle SEAM), and async clears are asserted via waitFor across real effect
// flushes — the established Ink-test discipline in this repo.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  OPTIMISTIC_ACTIVITY,
  optimisticActivity,
  useOptimisticTurn,
} from '../src/hooks/useOptimisticTurn';
import type { OptimisticTurnController, OptimisticTurnDeps } from '../src/hooks/useOptimisticTurn';
import type { ActivityState } from '../src/core/selectors';
import { selectActivity } from '../src/core/selectors';
import { initialState } from '../src/core/reducer';
import { flushInk, waitFor } from './helpers/ink';

const REAL_ACTIVITY: ActivityState = { label: 'responding…', abortable: true, attention: false };

type FakeTurn = OptimisticTurnDeps['turn'];

/**
 * A two-method useStreamingTurn fake: a togglable `isBusy` + a `submit` whose
 * promise is held open until `settle()`, so the pre-settle optimistic window is
 * inspectable without any timers. STABLE identity (created once) so the hook's
 * `[turn]`-keyed runSubmit is not rebuilt between renders — mirroring the real
 * controls object, which is likewise stable within a turn.
 */
function makeFakeTurn(): {
  turn: FakeTurn;
  setBusy: (busy: boolean) => void;
  submitted: () => readonly string[];
  settle: () => void;
} {
  let busy = false;
  const submitted: string[] = [];
  let resolveCurrent: (() => void) | null = null;
  const turn: FakeTurn = {
    isBusy: () => busy,
    submit: (text: string): Promise<void> => {
      submitted.push(text);
      return new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      });
    },
  };
  return {
    turn,
    setBusy: (b) => {
      busy = b;
    },
    submitted: () => submitted,
    settle: () => resolveCurrent?.(),
  };
}

interface OptimisticProbe {
  out: () => OptimisticTurnController;
}

/** Mount useOptimisticTurn in a bare Probe, capturing its controller each render. */
function mountOptimistic(turn: FakeTurn): OptimisticProbe {
  const holder: { current: OptimisticTurnController | null } = { current: null };
  function Probe(): ReturnType<typeof Text> {
    holder.current = useOptimisticTurn({ turn });
    return <Text>flag:{String(holder.current.optimisticTurn)}</Text>;
  }
  render(<Probe />);
  return {
    out: () => {
      if (holder.current === null) throw new Error('hook return was not captured');
      return holder.current;
    },
  };
}

describe('optimisticActivity — real > optimistic > none', () => {
  it('the real, phase-derived activity always wins, regardless of the optimistic flag', () => {
    expect(optimisticActivity(REAL_ACTIVITY, false)).toBe(REAL_ACTIVITY);
    expect(optimisticActivity(REAL_ACTIVITY, true)).toBe(REAL_ACTIVITY);
  });

  it('falls back to the optimistic thinking… line only when real is null AND the flag is set', () => {
    expect(optimisticActivity(null, true)).toBe(OPTIMISTIC_ACTIVITY);
    expect(optimisticActivity(null, true)?.label).toBe('thinking…');
  });

  it('is null when there is no real activity and no optimistic turn', () => {
    expect(optimisticActivity(null, false)).toBeNull();
  });

  it('wave-13 retry-ui: the retry realActivity wins over the optimistic thinking… fallback', () => {
    // A pre-first-byte retry produces a NON-null realActivity via selectActivity even
    // during the optimistic window; it must take over the busy line from 'thinking…'.
    const retryActivity = selectActivity({
      ...initialState(),
      retry: { attempt: 2, max: 3, delayMs: 2000 },
    });
    expect(retryActivity).not.toBeNull();
    const shown = optimisticActivity(retryActivity, true);
    expect(shown).toBe(retryActivity);
    expect(shown?.label).toBe('retrying 2/3 · 2s backoff');
    expect(shown?.label).not.toBe(OPTIMISTIC_ACTIVITY.label);
  });
});

describe('useOptimisticTurn — the guarded submit + flag seam', () => {
  it('runSubmit raises the flag at submit and dispatches the turn', async () => {
    const fake = makeFakeTurn();
    const probe = mountOptimistic(fake.turn);
    await flushInk();
    expect(probe.out().optimisticTurn).toBe(false);

    await act(async () => {
      probe.out().runSubmit('resume me');
    });
    await flushInk();

    // Flag up immediately; the turn was dispatched; submit is still in flight (gated).
    expect(probe.out().optimisticTurn).toBe(true);
    expect(fake.submitted()).toEqual(['resume me']);
  });

  it('settle-clears the flag when the turn resolves with no real activity (failed start)', async () => {
    const fake = makeFakeTurn();
    const probe = mountOptimistic(fake.turn);
    await flushInk();
    await act(async () => {
      probe.out().runSubmit('resume me');
    });
    await flushInk();
    expect(probe.out().optimisticTurn).toBe(true);

    // The turn settles (a spawn/immediate error surfaced then returned) with no
    // assistant-start, so App's takeover effect never fires — runSubmit's `.finally`
    // is the ONLY thing that can lower the flag here.
    fake.settle();
    await waitFor(() => probe.out().optimisticTurn === false, {
      label: 'flag cleared by the settle path on a failed start',
    });
  });

  it('the isBusy() early-return keeps an in-flight optimistic flag up (interleaved second submit)', async () => {
    const fake = makeFakeTurn();
    const probe = mountOptimistic(fake.turn);
    await flushInk();

    // Turn A: raises the flag; the controller is now held (busy).
    await act(async () => {
      probe.out().runSubmit('turn A');
    });
    await flushInk();
    expect(probe.out().optimisticTurn).toBe(true);
    fake.setBusy(true);

    // A second submit interleaved DURING the optimistic window (the slash-overlay
    // path, which has no busy gate of its own) must NOT dispatch a second turn and
    // must NOT touch the flag — otherwise its `.finally` would resurrect the pre-start
    // gap this track exists to eliminate.
    await act(async () => {
      probe.out().runSubmit('turn B');
    });
    await flushInk();
    expect(fake.submitted()).toEqual(['turn A']); // B was rejected by the guard
    expect(probe.out().optimisticTurn).toBe(true); // A's spinner survives the interleave

    // Turn A completes → the flag lowers (single owner, no double-clear).
    fake.setBusy(false);
    fake.settle();
    await waitFor(() => probe.out().optimisticTurn === false, {
      label: 'flag cleared once turn A settled',
    });
  });

  it('exposes setOptimisticTurn as the takeover-clear writer (App LAST effect)', async () => {
    const fake = makeFakeTurn();
    const probe = mountOptimistic(fake.turn);
    await flushInk();
    await act(async () => {
      probe.out().runSubmit('resume me');
    });
    await flushInk();
    expect(probe.out().optimisticTurn).toBe(true);

    // App's takeover effect calls this the instant a real activity appears; proves the
    // exposed writer lowers the flag on the happy-path handover, independently of the
    // gated submit settling.
    await act(async () => {
      probe.out().setOptimisticTurn(false);
    });
    await flushInk();
    expect(probe.out().optimisticTurn).toBe(false);
  });
});
