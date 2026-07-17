// tests/lifecycleWipes.test.ts
// Wave 9 — the transcript-replacement scrollback wipe, the lifecycle seam that went
// untested and let auto-compaction (and resume) duplicate the transcript. When the
// transcript is REPLACED wholesale — clear / compact / resume-session — the reducer
// bumps `transcriptEpoch`, remounting <Static> so it REPRINTS the whole new transcript.
// The terminal can't un-print the old copy in its scrollback, so the emit-scrollback
// wipe must fire FIRST or the reprint stacks a second copy above (the reported bug).
//
// Before the fix only the /clear path wiped (inline in app.tsx); compact + resume
// bumped the epoch WITHOUT wiping. The fix moves the wipe into the hook's shared
// dispatch funnel (dispatchNow), keyed on exactly those three actions, so every
// replacement path — INCLUDING auto-compaction, which has no app.tsx dispatch site —
// wipes uniformly and none can drift. These tests pin the seam: (1) the helper's exact
// bytes + TTY gate, (2) each of the three actions wipes exactly once, (3) a
// non-replacement action never wipes, (4) the gate holds through the funnel.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { useStreamingTurn } from '../src/hooks/useStreamingTurn';
import type { StreamingTurnControls, StreamingTurnDeps } from '../src/hooks/useStreamingTurn';
import type { Msg } from '../src/core/reducer';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient } from '../src/core/contracts';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createDefaultTools, BUILTIN_TOOL_SPECS } from '../src/tools/registry';
import { wipeScrollback, WIPE_SEQUENCE, type WipeTarget } from '../src/ui/wipeScrollback';

// --- fakes -------------------------------------------------------------------

interface FakeStdout extends WipeTarget {
  readonly writes: string[];
}

/** A capturing stdout with a settable `isTTY`, so the gate can be exercised both ways. */
function fakeStdout(isTTY = true): FakeStdout {
  const writes: string[] = [];
  return {
    isTTY,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
    writes,
  };
}

/** How many erase-scrollback wipes the fake received. The hook writes to `deps.stdout`
 *  ONLY via wipeScrollback, so every capture is a wipe — but match the exact sequence
 *  to stay honest if that ever changes. */
function wipeCount(stdout: FakeStdout): number {
  return stdout.writes.filter((w) => w === WIPE_SEQUENCE).length;
}

/** A tools-less summarizer client: yields `summary` as the compaction reply (the shape
 *  runCompactionStep consumes for BOTH manual /compact and auto-compaction). */
function summarizerClient(summary: string): ModelClient {
  return {
    streamTurn: async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: 'sum' };
      if (summary.length > 0) {
        yield { type: 'text-delta', id: 'sum', delta: summary };
      }
      yield { type: 'assistant-done', id: 'sum', stopReason: 'end' };
    },
  };
}

function msg(id: string, role: Msg['role'], text: string): Msg {
  return { id, role, blocks: [{ kind: 'text', id: `${id}:block:1`, text }], done: true };
}

function fakeDeps(overrides: Partial<StreamingTurnDeps> = {}): StreamingTurnDeps {
  return {
    client: createFakeModelClient({ tickMs: 0 }),
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    specs: BUILTIN_TOOL_SPECS,
    cwd: '.',
    effort: 'medium',
    // Zero the compaction-retry backoff so the compaction wipe test never waits on a real
    // exponential sleep (a short summary would otherwise trigger the degenerate retry loop).
    compactionRetry: { baseDelayMs: 0 },
    ...overrides,
  };
}

// --- harness (the established ink-testing-library mount pattern) --------------

interface Mounted {
  readonly controls: () => StreamingTurnControls;
  readonly unmount: () => void;
}

function mountHook(deps: StreamingTurnDeps): Mounted {
  let latest: StreamingTurnControls | undefined;
  function Harness(): null {
    latest = useStreamingTurn(deps);
    return null;
  }
  let unmount: () => void = () => undefined;
  act(() => {
    unmount = render(createElement(Harness)).unmount;
  });
  return {
    controls: (): StreamingTurnControls => {
      if (latest === undefined) throw new Error('hook not mounted yet');
      return latest;
    },
    unmount,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Seed `n` committed user turns so the transcript is real conversation to compact. */
function fillTranscript(controls: () => StreamingTurnControls, n: number): void {
  act(() => {
    for (let i = 0; i < n; i += 1) {
      controls().dispatch({ t: 'user-submit', id: `u${i}`, text: 'x'.repeat(60) });
    }
  });
}

// --- the helper in isolation -------------------------------------------------

describe('wipeScrollback helper', () => {
  it('writes exactly the erase-scrollback + clear + home sequence when isTTY', () => {
    const s = fakeStdout(true);
    wipeScrollback(s);
    expect(s.writes).toEqual(['\x1b[3J\x1b[2J\x1b[H']);
    // The constant is the sole authority for the sequence — pin its bytes.
    expect(WIPE_SEQUENCE).toBe('\x1b[3J\x1b[2J\x1b[H');
  });

  it('is a no-op when isTTY is false (unit runners / pipes never get control bytes)', () => {
    const s = fakeStdout(false);
    wipeScrollback(s);
    expect(s.writes).toHaveLength(0);
  });

  it('is a no-op when isTTY is undefined', () => {
    const writes: string[] = [];
    wipeScrollback({
      write: (chunk: string): boolean => {
        writes.push(chunk);
        return true;
      },
    });
    expect(writes).toHaveLength(0);
  });
});

// --- the dispatch-funnel seam (clear / compact / resume-session) -------------

describe('useStreamingTurn transcript-replacement scrollback wipe', () => {
  it('(c) clear wipes scrollback exactly once as it bumps transcriptEpoch', async () => {
    const stdout = fakeStdout();
    const m = mountHook(fakeDeps({ stdout }));

    // A non-replacement action (user-submit) must NOT wipe — guards the funnel key.
    fillTranscript(m.controls, 1);
    await flush();
    expect(wipeCount(stdout)).toBe(0);
    const epochBefore = m.controls().state.transcriptEpoch ?? 0;

    act(() => {
      m.controls().dispatch({ t: 'clear' });
    });
    await flush();

    expect(wipeCount(stdout)).toBe(1);
    expect(m.controls().state.transcriptEpoch ?? 0).toBe(epochBefore + 1);
    m.unmount();
  });

  it('(b) resume-session wipes scrollback exactly once as it bumps transcriptEpoch', async () => {
    const stdout = fakeStdout();
    const m = mountHook(fakeDeps({ stdout }));
    await flush();
    const epochBefore = m.controls().state.transcriptEpoch ?? 0;

    act(() => {
      m.controls().dispatch({
        t: 'resume-session',
        messages: [msg('r1', 'user', 'RESUMED-FIRST'), msg('r2', 'assistant', 'RESUMED-REPLY')],
      });
    });
    await flush();

    expect(wipeCount(stdout)).toBe(1);
    expect(m.controls().state.transcriptEpoch ?? 0).toBe(epochBefore + 1);
    // The resumed transcript actually replaced committed (proves the epoch bump is real).
    expect(m.controls().state.committed).toHaveLength(2);
    m.unmount();
  });

  it('(a) compact wipes scrollback exactly once — the same funnel line auto-compaction hits', async () => {
    // compactNow() and auto-compaction (maybeCompact) both run runCompactionStep, which
    // dispatches the SAME `{ t: 'compact' }` action — so this manual drive exercises the
    // exact funnel line auto-compaction fires (auto is proven end-to-end in the selftest).
    const stdout = fakeStdout();
    const m = mountHook(
      fakeDeps({ client: summarizerClient('DENSE SUMMARY'), maxContext: 10_000, stdout }),
    );
    fillTranscript(m.controls, 6); // > MIN_MESSAGES_TO_COMPACT so the summarizer is reached
    await flush();
    const epochBefore = m.controls().state.transcriptEpoch ?? 0;
    expect(wipeCount(stdout)).toBe(0); // filling the transcript never wiped

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(() => (m.controls().state.transcriptEpoch ?? 0) > epochBefore, 'compaction');

    expect(wipeCount(stdout)).toBe(1);
    // The compaction genuinely replaced committed with a summary (the epoch bump is real).
    expect(
      m.controls().state.committed.some(
        (message) => message.role === 'system' && message.blocks.some((b) => b.kind === 'text'),
      ),
    ).toBe(true);
    m.unmount();
  });

  it('honors the TTY gate through the funnel — a non-TTY stdout never gets control bytes', async () => {
    const stdout = fakeStdout(false); // not a TTY
    const m = mountHook(fakeDeps({ stdout }));

    act(() => {
      m.controls().dispatch({ t: 'clear' });
    });
    await flush();

    // The epoch still bumped (state change is unconditional) but no bytes were emitted.
    expect(m.controls().state.transcriptEpoch ?? 0).toBe(1);
    expect(stdout.writes).toHaveLength(0);
    m.unmount();
  });
});
