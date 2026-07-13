// tests/useSessionResume.test.tsx
// W9 app-decompose — the session persistence/resume seam (useSessionResume),
// tested DIRECTLY (it had no unit surface while it lived inside app.tsx; the
// end-to-end path stays pinned by tests/resume.integration.test.tsx):
//   - save-on-commit: create() exactly once (meta from the first commit), then
//     save() the full transcript on every later commit
//   - a notices-only transcript persists NOTHING (never clobber a resumable
//     history with a stub)
//   - store failures are swallowed (persistence must never crash the session)
//   - openSessionPicker: rows load via toPaletteEntries, highlight resets, the
//     overlay opens even when the store is absent or list() throws (empty rows)
//   - moveSession: sign-safe modulo for coalesced arrow bursts (|delta| > n)
//   - acceptSession: abort() BEFORE the resume-session dispatch, active id swap,
//     createdRef latch (no redundant create() on the next commit), close on
//     miss/error without dispatching
//
// Patterns reused: a probe component captures the hook's live return (as in
// useMcpLifecycle.test); a recording fake store gives exact call-order asserts;
// flushInk/waitFor synchronization, injected ids, no fake timers.
import { useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { generateSessionId, useSessionResume } from '../src/hooks/useSessionResume';
import type { SessionResume } from '../src/hooks/useSessionResume';
import type { Action, Msg } from '../src/core/reducer';
import type { SessionMeta, SessionStore } from '../src/services/sessions';
import { flushInk, waitFor } from './helpers/ink';

function userMsg(text: string, id = 'u1'): Msg {
  return { id, role: 'user', blocks: [{ kind: 'text', id: `${id}:block:1`, text }], done: true };
}

function asstMsg(text: string, id = 'a1'): Msg {
  return { id, role: 'assistant', blocks: [{ kind: 'text', id: `${id}:block:1`, text }], done: true };
}

/** A system-feedback notice (the post-/clear "session cleared" line shape). */
function noticeMsg(text: string, id = 'n1'): Msg {
  return { id, role: 'system', blocks: [{ kind: 'text', id: `${id}:block:1`, text }], done: true };
}

interface StoreCall {
  readonly op: 'create' | 'save' | 'list' | 'load';
  readonly arg?: unknown;
}

/** A recording in-memory store; individual ops can be armed to throw. */
function createRecordingStore(seed: { meta: SessionMeta; messages: Msg[] }[] = []): {
  store: SessionStore;
  calls: StoreCall[];
  failing: { create?: boolean; save?: boolean; list?: boolean; load?: boolean };
} {
  const calls: StoreCall[] = [];
  const failing: { create?: boolean; save?: boolean; list?: boolean; load?: boolean } = {};
  const files = new Map<string, { meta: SessionMeta; messages: Msg[] }>(
    seed.map((file) => [file.meta.id, file]),
  );
  const store: SessionStore = {
    async create(meta) {
      calls.push({ op: 'create', arg: meta });
      if (failing.create === true) throw new Error('create failed');
      files.set(meta.id, { meta, messages: [] });
    },
    async list() {
      calls.push({ op: 'list' });
      if (failing.list === true) throw new Error('list failed');
      return [...files.values()].map((file) => file.meta);
    },
    async load(id) {
      calls.push({ op: 'load', arg: id });
      if (failing.load === true) throw new Error('load failed');
      return files.get(id);
    },
    async save(id, messages) {
      calls.push({ op: 'save', arg: { id, messages } });
      if (failing.save === true) throw new Error('save failed');
      const existing = files.get(id);
      if (existing !== undefined) files.set(id, { ...existing, messages: [...messages] });
    },
    async delete() {},
  };
  return { store, calls, failing };
}

interface ProbeCtx {
  out: () => SessionResume;
  activeId: () => string;
  setCommitted: (messages: Msg[]) => void;
  /** Ordered log of the turn-side effects the hook drives (abort/dispatch/close). */
  log: string[];
  dispatched: Action[];
}

/** Mount the hook in a probe that owns activeSessionId + committed like App does. */
function mountSessionResume(store: SessionStore | undefined, initialId = 'session-fixed'): ProbeCtx {
  const holder: { current: SessionResume | null } = { current: null };
  const idHolder = { current: initialId };
  const log: string[] = [];
  const dispatched: Action[] = [];
  let setCommittedOuter!: (messages: Msg[]) => void;

  function Probe(): ReturnType<typeof Text> {
    const [activeSessionId, setActiveSessionId] = useState(initialId);
    const [committed, setCommitted] = useState<Msg[]>([]);
    setCommittedOuter = setCommitted;
    idHolder.current = activeSessionId;
    holder.current = useSessionResume({
      store,
      cwd: '/work',
      model: 'claude-fable-5',
      activeSessionId,
      setActiveSessionId: (id) => {
        log.push(`setActiveSessionId:${id}`);
        setActiveSessionId(id);
      },
      committed,
      abort: () => log.push('abort'),
      dispatch: (action) => {
        log.push(`dispatch:${action.t}`);
        dispatched.push(action);
      },
      closeOverlay: () => log.push('closeOverlay'),
    });
    return <Text>sessions:{holder.current.sessions.length}</Text>;
  }

  render(<Probe />);
  return {
    out: () => {
      if (holder.current === null) throw new Error('hook return was not captured');
      return holder.current;
    },
    activeId: () => idHolder.current,
    setCommitted: (messages) => setCommittedOuter(messages),
    log,
    dispatched,
  };
}

const seededSession = (id: string, createdAt: string, messages: Msg[]): { meta: SessionMeta; messages: Msg[] } => ({
  meta: { id, createdAt, title: id },
  messages,
});

describe('generateSessionId', () => {
  it('generates distinct session-prefixed ids', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).toMatch(/^session-[a-z0-9]+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe('useSessionResume — save-on-commit persistence', () => {
  it('creates the session file ONCE, then only saves on later commits', async () => {
    const { store, calls } = createRecordingStore();
    const ctx = mountSessionResume(store);
    await flushInk();
    expect(calls).toEqual([]); // empty transcript: nothing persisted

    ctx.setCommitted([userMsg('hello')]);
    await waitFor(() => calls.some((call) => call.op === 'save'), { label: 'first save' });
    expect(calls.map((call) => call.op)).toEqual(['create', 'save']);
    const meta = calls[0]!.arg as SessionMeta;
    expect(meta.id).toBe('session-fixed');
    expect(meta.model).toBe('claude-fable-5');
    expect(meta.cwd).toBe('/work');
    expect(meta.title).toBe('hello');

    ctx.setCommitted([userMsg('hello'), asstMsg('hi there')]);
    await waitFor(() => calls.filter((call) => call.op === 'save').length === 2, {
      label: 'second save',
    });
    // No second create — the createdRef latched.
    expect(calls.map((call) => call.op)).toEqual(['create', 'save', 'save']);
    const saved = calls.at(-1)!.arg as { id: string; messages: Msg[] };
    expect(saved.id).toBe('session-fixed');
    expect(saved.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('persists NOTHING for a notices-only transcript (post-/clear stub guard)', async () => {
    const { store, calls } = createRecordingStore();
    const ctx = mountSessionResume(store);
    await flushInk();

    ctx.setCommitted([noticeMsg('session cleared')]);
    await flushInk();
    await flushInk();
    expect(calls).toEqual([]);
  });

  it('swallows store failures — a throwing create/save never crashes the session', async () => {
    const { store, calls, failing } = createRecordingStore();
    failing.create = true;
    failing.save = true;
    const ctx = mountSessionResume(store);
    await flushInk();

    ctx.setCommitted([userMsg('hello')]);
    // create() throws → the catch swallows it (save is skipped this round).
    await waitFor(() => calls.some((call) => call.op === 'create'), { label: 'attempted create' });
    await flushInk();
    // The next commit goes straight to save (createdRef latched even on failure),
    // which also throws and is also swallowed.
    ctx.setCommitted([userMsg('hello'), asstMsg('hi')]);
    await waitFor(() => calls.some((call) => call.op === 'save'), { label: 'attempted save' });
    await flushInk();
    // Still alive and interactive: the picker path still works.
    ctx.out().openSessionPicker();
    await waitFor(() => ctx.log.includes('dispatch:set-overlay'), { label: 'picker opens' });
  });

  it('is a no-op without a store (back-compat callers omit sessionStore)', async () => {
    const ctx = mountSessionResume(undefined);
    await flushInk();
    ctx.setCommitted([userMsg('hello')]);
    await flushInk();
    await flushInk();
    expect(ctx.log).toEqual([]); // nothing dispatched, nothing crashed
  });
});

describe('useSessionResume — the /resume picker', () => {
  const seeded = [
    seededSession('older', '2026-07-10T10:00:00.000Z', [userMsg('old chat')]),
    seededSession('newest', '2026-07-12T10:00:00.000Z', [userMsg('recent chat'), asstMsg('yes')]),
    seededSession('middle', '2026-07-11T10:00:00.000Z', [userMsg('mid chat')]),
  ];

  it('openSessionPicker loads rows (newest first), resets the highlight, then opens', async () => {
    const { store } = createRecordingStore(seeded);
    const ctx = mountSessionResume(store);
    await flushInk();

    ctx.out().openSessionPicker();
    await waitFor(() => ctx.out().sessions.length === 3, { label: 'rows loaded' });
    expect(ctx.out().sessions.map((entry) => entry.id)).toEqual(['newest', 'middle', 'older']);
    expect(ctx.out().selectedSessionIndex).toBe(0);
    // The overlay opens AFTER the rows land (single dispatch).
    expect(ctx.dispatched).toEqual([{ t: 'set-overlay', overlay: 'session-picker' }]);
  });

  it('opens with EMPTY rows when the store is absent or list() throws (fail-soft)', async () => {
    const absent = mountSessionResume(undefined);
    await flushInk();
    absent.out().openSessionPicker();
    await waitFor(() => absent.log.includes('dispatch:set-overlay'), { label: 'opens w/o store' });
    expect(absent.out().sessions).toEqual([]);

    const { store, failing } = createRecordingStore(seeded);
    failing.list = true;
    const throwing = mountSessionResume(store);
    await flushInk();
    throwing.out().openSessionPicker();
    await waitFor(() => throwing.log.includes('dispatch:set-overlay'), { label: 'opens on throw' });
    expect(throwing.out().sessions).toEqual([]);
  });

  it('moveSession wraps sign-safely for coalesced bursts larger than the list', async () => {
    const { store } = createRecordingStore(seeded);
    const ctx = mountSessionResume(store);
    await flushInk();
    ctx.out().openSessionPicker();
    await waitFor(() => ctx.out().sessions.length === 3, { label: 'rows loaded' });

    ctx.out().moveSession(1);
    await waitFor(() => ctx.out().selectedSessionIndex === 1, { label: 'down one' });
    ctx.out().moveSession(-5); // |delta| > n: (1 - 5) → -4 → wraps to 2, never negative
    await waitFor(() => ctx.out().selectedSessionIndex === 2, { label: 'burst wrap' });
    ctx.out().moveSession(7); // (2 + 7) % 3 → 0
    await waitFor(() => ctx.out().selectedSessionIndex === 0, { label: 'forward wrap' });
  });

  it('acceptSession hydrates: abort BEFORE the resume dispatch, id swap, then close', async () => {
    const { store } = createRecordingStore(seeded);
    const ctx = mountSessionResume(store);
    await flushInk();
    ctx.out().openSessionPicker();
    await waitFor(() => ctx.out().sessions.length === 3, { label: 'rows loaded' });
    ctx.log.length = 0;
    ctx.dispatched.length = 0;

    ctx.out().acceptSession(); // highlight 0 → 'newest'
    await waitFor(() => ctx.log.includes('closeOverlay'), { label: 'accept settles' });

    // The load-bearing ORDER: cancel the in-flight turn, swap the id, dispatch the
    // resume (whose scrollback wipe lives in the dispatch funnel), then close.
    expect(ctx.log).toEqual([
      'abort',
      'setActiveSessionId:newest',
      'dispatch:resume-session',
      'closeOverlay',
    ]);
    const resume = ctx.dispatched[0] as Extract<Action, { t: 'resume-session' }>;
    expect(resume.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(ctx.activeId()).toBe('newest');
  });

  it('a commit AFTER a resume saves to the LOADED id without a redundant create()', async () => {
    const { store, calls } = createRecordingStore(seeded);
    const ctx = mountSessionResume(store);
    await flushInk();
    ctx.out().openSessionPicker();
    await waitFor(() => ctx.out().sessions.length === 3, { label: 'rows loaded' });
    ctx.out().acceptSession();
    await waitFor(() => ctx.log.includes('closeOverlay'), { label: 'accept settles' });
    calls.length = 0;

    ctx.setCommitted([userMsg('recent chat'), asstMsg('yes'), userMsg('continued', 'u2')]);
    await waitFor(() => calls.some((call) => call.op === 'save'), { label: 'post-resume save' });
    expect(calls.map((call) => call.op)).toEqual(['save']); // createdRef latched by the resume
    const saved = calls[0]!.arg as { id: string; messages: Msg[] };
    expect(saved.id).toBe('newest');
  });

  it('closes WITHOUT dispatching on an empty list, a missing entry, or a load error', async () => {
    // Empty list (no store): just close.
    const absent = mountSessionResume(undefined);
    await flushInk();
    absent.out().acceptSession();
    await waitFor(() => absent.log.includes('closeOverlay'), { label: 'close w/o store' });
    expect(absent.log).toEqual(['closeOverlay']);

    // load() throws: swallow, close, never dispatch resume-session.
    const { store, failing } = createRecordingStore(seeded);
    const ctx = mountSessionResume(store);
    await flushInk();
    ctx.out().openSessionPicker();
    await waitFor(() => ctx.out().sessions.length === 3, { label: 'rows loaded' });
    ctx.log.length = 0;
    failing.load = true;
    ctx.out().acceptSession();
    await waitFor(() => ctx.log.includes('closeOverlay'), { label: 'close on load error' });
    expect(ctx.log).toEqual(['closeOverlay']);
    expect(ctx.dispatched.filter((action) => action.t === 'resume-session')).toEqual([]);
  });
});
