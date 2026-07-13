// src/hooks/useSessionResume.ts
// W9 app-decompose — session persistence + the /resume picker orchestration,
// extracted verbatim from app.tsx. One reason to change: how sessions are
// saved, listed and rehydrated.
//
// Owns: the best-effort save-on-commit effect (create once, then save), the
// picker's row/highlight state, and the hydrate-and-dispatch accept path. The
// ACTIVE session id itself stays in app.tsx — it is cross-cutting composition
// plumbing (the subagent recorder and the on-disk subagent reader key on it,
// both wired BEFORE the turn hook this one consumes) — so this hook receives
// the id + its setter instead of owning the useState.
//
// The resume-session dispatch goes through the caller-supplied `dispatch`
// (useStreamingTurn's), whose dispatchNow funnel owns the scrollback wipe —
// the wipe does NOT live here and must not move here.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, State } from '../core/reducer';
import type { SessionStore } from '../services/sessions';
import { sessionMetaFor, toPaletteEntries } from '../services/sessionPersistence';
import type { SessionPaletteEntry } from '../ui/UnifiedCommandPalette';

/**
 * Generate a unique-enough session id for THIS run. Lives here (not the
 * reducer) because it reads the clock + randomness — the reducer stays pure.
 * app.tsx uses it to seed `activeSessionId` lazily via useState initializer
 * (called once).
 */
export function generateSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SessionResumeDeps {
  /** Optional session persistence store; absent ⇒ nothing is saved or listed. */
  readonly store: SessionStore | undefined;
  /** Working directory recorded into new session meta. */
  readonly cwd: string;
  /** The SELECTED model id recorded into new session meta. */
  readonly model: string;
  /** The active session id (owned by app.tsx — see the header note). */
  readonly activeSessionId: string;
  readonly setActiveSessionId: (id: string) => void;
  /** The committed transcript (turn.state.committed) — the persistence trigger. */
  readonly committed: State['committed'];
  /** turn.abort — cancels an in-flight turn before a resume swaps the transcript. */
  readonly abort: () => void;
  /** turn.dispatch — the resume-session / set-overlay dispatch path. */
  readonly dispatch: (action: Action) => void;
  /** Close the active overlay (clears the composer — app.tsx's closeOverlay). */
  readonly closeOverlay: () => void;
}

export interface SessionResume {
  /** The picker's row data (loaded lazily from the store on open). */
  readonly sessions: SessionPaletteEntry[];
  readonly selectedSessionIndex: number;
  readonly openSessionPicker: () => void;
  readonly moveSession: (delta: number) => void;
  readonly acceptSession: () => void;
}

export function useSessionResume(deps: SessionResumeDeps): SessionResume {
  const { store, cwd, model, activeSessionId, setActiveSessionId, committed, abort, dispatch, closeOverlay } = deps;

  // `sessions` is the picker's row data; `createdRef` tracks whether the active
  // session's file has been `create()`d yet so the persistence effect creates
  // once then only `save()`s.
  const [sessions, setSessions] = useState<SessionPaletteEntry[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const createdRef = useRef(false);

  // Session persistence (best-effort, fire-and-forget). On each committed-transcript
  // change, lazily `create()` the session file ONCE (so a title can be derived from
  // the first user message) then `save()` the full committed transcript. Guarded by
  // a present `store` and a non-empty transcript. Errors are swallowed —
  // persistence must NEVER crash the session (mirrors compaction's best-effort ethos).
  useEffect(() => {
    // Persist only real conversation. A transcript of nothing but system-feedback
    // notices (F: the post-`/clear` `session cleared` line) must NOT overwrite the
    // active session file — that would clobber a resumable history with a stub.
    const hasConversation = committed.some(
      (message) => message.role === 'user' || message.role === 'assistant',
    );
    if (store === undefined || !hasConversation) {
      return;
    }
    void (async (): Promise<void> => {
      try {
        if (!createdRef.current) {
          createdRef.current = true;
          await store.create(
            sessionMetaFor({
              id: activeSessionId,
              createdAt: new Date().toISOString(),
              model,
              cwd,
              messages: committed,
            }),
          );
        }
        await store.save(activeSessionId, committed);
      } catch {
        // best-effort: never propagate a persistence failure into render.
      }
    })();
  }, [committed, store, cwd, activeSessionId, model]);

  // Open the session picker: load the store's session list into palette rows,
  // reset the highlight, then open the overlay. Best-effort — if the store throws
  // or is absent, open with an empty list (the picker renders just its header).
  const openSessionPicker = useCallback((): void => {
    setSelectedSessionIndex(0);
    void (async (): Promise<void> => {
      let entries: SessionPaletteEntry[] = [];
      if (store !== undefined) {
        try {
          entries = toPaletteEntries(await store.list());
        } catch {
          entries = [];
        }
      }
      setSessions(entries);
      dispatch({ t: 'set-overlay', overlay: 'session-picker' });
    })();
  }, [store, dispatch]);

  // Sign-safe modulo `((i + d) % n + n) % n` — see the mover cluster in
  // src/hooks/usePickerControls.ts for the full derivation (the coalesced arrow
  // delta can exceed the list length, so the naive `(i + d + n) % n` idiom can
  // leave a NEGATIVE index).
  const moveSession = useCallback((delta: number): void => {
    setSelectedSessionIndex((current) => {
      if (sessions.length === 0) {
        return current;
      }
      return ((current + delta) % sessions.length + sessions.length) % sessions.length;
    });
  }, [sessions.length]);

  // Hydrate the highlighted session: load it from the store and dispatch the
  // resume. On a miss (or no store / empty list) just close the overlay. Setting
  // `activeSessionId` to the loaded id makes continued turns append to the SAME
  // session; `createdRef = true` skips a redundant create() on the next commit.
  const acceptSession = useCallback((): void => {
    const entry = sessions[selectedSessionIndex];
    if (store === undefined || entry === undefined) {
      closeOverlay();
      return;
    }
    void (async (): Promise<void> => {
      try {
        const loaded = await store.load(entry.id);
        if (loaded !== undefined) {
          // Cancel any in-flight turn BEFORE swapping the transcript. resume-session
          // resets the reducer to idle but does NOT abort the running turn, so without
          // this the controller stays held (the next submit is silently dropped) and a
          // parked permission await orphans into a permanent input freeze. abort()
          // releases the controller and drainDeny()s the registry; a no-op when idle.
          abort();
          setActiveSessionId(entry.id);
          createdRef.current = true;
          dispatch({ t: 'resume-session', messages: loaded.messages });
        }
      } catch {
        // best-effort: a failed load must never crash the session.
      }
      closeOverlay();
    })();
  }, [closeOverlay, store, selectedSessionIndex, sessions, abort, dispatch, setActiveSessionId]);

  return { sessions, selectedSessionIndex, openSessionPicker, moveSession, acceptSession };
}
