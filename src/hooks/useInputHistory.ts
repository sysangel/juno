// src/hooks/useInputHistory.ts
// W9 app-decompose — the composer's input-history ring (G — in-memory only this
// wave), extracted verbatim from app.tsx. One reason to change: how submitted
// lines are recalled.
//
// `historyRef` holds submitted lines oldest→newest; `cursorRef` is null when the
// composer shows the live draft (not navigating), else an index into the ring;
// `draftRef` stashes the in-progress text so Down past the newest entry restores
// it. Pure refs + callbacks — no state, no effects — so navigation never causes
// a render beyond the setValue it performs.
import { useCallback, useRef } from 'react';

export interface InputHistoryDeps {
  /** The live composer text (stashed as the draft on the first Up). */
  readonly value: string;
  /** Composer setter — navigation writes recalled entries through it. */
  readonly setValue: (value: string) => void;
}

export interface InputHistory {
  /** Record a submitted line and reset navigation to the live draft. Called
   * from submit() BEFORE the composer is cleared. */
  readonly push: (line: string) => void;
  /** Up on the composer's first line: recall an OLDER entry. */
  readonly prev: () => void;
  /** Down on the composer's last line: recall a NEWER entry / restore the draft.
   * Returns whether the Down was CONSUMED (false ⇒ already at the live draft). */
  readonly next: () => boolean;
  /** Typing or pasting exits history navigation: the edited text becomes the new
   * live draft, so the next Up re-stashes it and starts from the newest entry.
   * Called from the composer's change handler. */
  readonly resetNavigation: () => void;
}

export function useInputHistory(deps: InputHistoryDeps): InputHistory {
  const { value, setValue } = deps;

  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');

  // Record a submitted line at the end of the history ring and reset navigation to
  // the live draft.
  const push = useCallback((line: string): void => {
    historyRef.current.push(line);
    cursorRef.current = null;
  }, []);

  // Up on the composer's first line: recall an OLDER history entry. First press
  // stashes the in-progress draft, then walks toward the oldest entry (clamped).
  const prev = useCallback((): void => {
    const history = historyRef.current;
    if (history.length === 0) {
      return;
    }
    if (cursorRef.current === null) {
      draftRef.current = value;
      cursorRef.current = history.length - 1;
    } else if (cursorRef.current > 0) {
      cursorRef.current -= 1;
    } else {
      return; // already at the oldest entry
    }
    setValue(history[cursorRef.current]!);
  }, [value, setValue]);

  // Down on the composer's last line: recall a NEWER entry, and past the newest
  // restore the stashed draft (returning to the not-navigating state).
  // Returns whether the Down was CONSUMED: `false` when already at the live draft (a
  // no-op — the composer then hands focus to the subagent panel), `true` when it recalled
  // a newer entry or restored the stashed draft.
  const next = useCallback((): boolean => {
    const history = historyRef.current;
    if (cursorRef.current === null) {
      return false; // already showing the live draft — Down is a no-op here
    }
    if (cursorRef.current < history.length - 1) {
      cursorRef.current += 1;
      setValue(history[cursorRef.current]!);
    } else {
      cursorRef.current = null;
      setValue(draftRef.current);
    }
    return true;
  }, [setValue]);

  const resetNavigation = useCallback((): void => {
    cursorRef.current = null;
  }, []);

  return { push, prev, next, resetNavigation };
}
