// tests/statusPerf.test.tsx
// statusline-memo (Wave 2 item C) — measurement/regression tests for StatusLine
// memoization + repaint isolation. Two acceptance properties:
//   1. A token flush changes NO status field, so the memoized StatusLine bundle keeps
//      its identity and the render fn bails out (render-count assertion).
//   2. During a parked busy phase, consecutive frames differ ONLY in the spinner
//      glyph / elapsed substring — the status-line bytes are byte-identical.
// The honest framing (spec): memo trims render-fn work + Yoga churn; Ink still
// re-serializes the footer per commit below React. These tests assert the React-level
// isolation, not the elimination of Ink's repaint.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { act, memo, useMemo, useState, type ReactElement } from 'react';
import type { Msg, State, Action } from '../src/core/reducer';
import { reducer } from '../src/core/reducer';
import { selectActivity, selectStatusLine } from '../src/core/selectors';
import { StatusLine, type StatusLineProps } from '../src/ui/StatusLine';
import { LiveTurn } from '../src/ui/LiveTurn';
import { App, type AppDeps } from '../src/app';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService, type Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press, waitForFrame } from './helpers/ink';

const userMsg = (text: string): Msg => ({
  id: 'u1',
  role: 'user',
  blocks: [{ kind: 'text', id: 'u1:block:0', text }],
  done: true,
});
const liveMsg = (text: string): Msg => ({
  id: 'a1',
  role: 'assistant',
  blocks: [{ kind: 'text', id: 'a1:block:0', text }],
  done: false,
});

/** A realistic mid-turn state: one committed user msg, a live assistant turn with
 *  prose (→ `responding…`), a real window measurement, cumulative tokens. */
function streamingState(): State {
  return {
    committed: [userMsg('hi there')],
    live: liveMsg('Hello'),
    tools: {},
    phase: 'streaming',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 1200, out: 300 },
    contextWindowTokens: 1200,
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

/** Mirror of app.tsx's StatusLine context (the fields are fixed here except
 *  permissionMode, which app also threads from state). */
const ctxFor = (state: State): Parameters<typeof selectStatusLine>[1] => ({
  model: 'claude-opus-4-8',
  cwd: '/srv/juno',
  maxContext: 200_000,
  skills: ['skill-a', 'skill-b'],
  pricing: { inputPerMTok: 15, outputPerMTok: 75 },
  permissionMode: state.permissionMode,
  isCompacting: false,
  toolBudget: { used: 0, max: 50 },
  mcp: undefined,
});

describe('statusline-memo — a token flush changes no status field', () => {
  it('text-delta leaves every selectStatusLine input referentially unchanged, so the bundle is deep-equal', () => {
    const s0 = streamingState();
    const status0 = selectStatusLine(s0, ctxFor(s0));

    const s1 = reducer(s0, { t: 'text-delta', id: 'a1', delta: ' world' });

    // Sanity: the flush really happened — new live + blocks identity.
    expect(s1).not.toBe(s0);
    expect(s1.live).not.toBe(s0.live);
    expect(s1.live?.blocks).not.toBe(s0.live?.blocks);
    expect(s1.live?.blocks[0]).not.toEqual(s0.live?.blocks[0]);

    // Every field app.tsx's status useMemo keys on stays referentially stable across
    // the flush — enumerated against selectors.ts. Miss one in the app dep list and
    // the strip goes stale; this pins the premise that none of them move on a flush.
    expect(s1.tokens).toBe(s0.tokens);
    expect(s1.committed).toBe(s0.committed);
    expect(s1.contextWindowTokens).toBe(s0.contextWindowTokens);
    expect(s1.effort).toBe(s0.effort);
    expect(s1.overlay).toBe(s0.overlay);
    expect(s1.phase).toBe(s0.phase);
    expect(s1.errorMessage).toBe(s0.errorMessage);
    expect(s1.permissionMode).toBe(s0.permissionMode);
    expect(s1.pendingPermissionToolCallId).toBe(s0.pendingPermissionToolCallId);
    expect(s1.compactions).toBe(s0.compactions);

    // → the recomputed bundle is identical, so a memo keyed on those fields returns
    //   the SAME object and StatusLine bails.
    const status1 = selectStatusLine(s1, ctxFor(s1));
    expect(status1).toEqual(status0);
  });
});

describe('statusline-memo — StatusLine render isolation (render-count)', () => {
  it('StatusLine is memo-wrapped (stable status ⇒ shallow-compare bail)', () => {
    expect((StatusLine as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('does not re-run StatusLine on token flushes, but re-runs when a status field changes', () => {
    let renders = 0;
    // `Counted` is memo(fn) with the SAME default shallow compare as the production
    // StatusLine, wrapping the REAL StatusLine — so its render count is a faithful
    // proxy for how often StatusLine's render fn would run.
    const Counted = memo(function Counted(props: StatusLineProps): ReactElement {
      renders += 1;
      return <StatusLine {...props} />;
    });

    let dispatch!: (a: Action) => void;
    function Harness(): ReactElement {
      const [state, setState] = useState<State>(streamingState);
      dispatch = (a) => setState((s) => reducer(s, a));
      // MIRROR of app.tsx's status useMemo dep list (context inputs are constant in
      // this harness, so only the state-field deps are enumerated here).
      const status = useMemo(
        () => selectStatusLine(state, ctxFor(state)),
        [
          state.tokens,
          state.effort,
          state.overlay,
          state.phase,
          state.errorMessage,
          state.committed,
          state.contextWindowTokens,
          state.compactions,
          state.permissionMode,
          state.pendingPermissionToolCallId,
        ],
      );
      return <Counted status={status} width={80} />;
    }

    const { lastFrame } = render(<Harness />);
    expect(renders).toBe(1);
    const frame0 = lastFrame();

    // Two token flushes (text-delta) mutate only turn.state.live — no status field.
    act(() => dispatch({ t: 'text-delta', id: 'a1', delta: ' world' }));
    act(() => dispatch({ t: 'text-delta', id: 'a1', delta: '!' }));
    expect(renders).toBe(1); // StatusLine bailed on BOTH flushes
    expect(lastFrame()).toBe(frame0); // strip bytes unchanged

    // A real status-field change (effort) MUST re-render — proves the dep list is not
    // over-broad-frozen (a missing dep would leave the strip stale here).
    act(() => dispatch({ t: 'set-effort', effort: 'high' }));
    expect(renders).toBe(2);
    expect(lastFrame()).not.toBe(frame0);
    expect(lastFrame()).toContain('high');
  });
});

describe('statusline-memo — parked busy phase: only the spinner/elapsed churn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('across an elapsed/spinner tick the status-line bytes are identical; only the live line moves', async () => {
    vi.useFakeTimers();
    let nowMs = 1000;
    const now = (): number => nowMs;

    const s = streamingState();
    const status = selectStatusLine(s, ctxFor(s));
    const activity = selectActivity(s); // responding… (the live turn has prose)

    function Footer(): ReactElement {
      return (
        <>
          <LiveTurn activity={activity} now={now} />
          <StatusLine status={status} width={80} />
        </>
      );
    }

    const { lastFrame } = render(<Footer />);
    await act(async () => {
      await Promise.resolve();
    });
    const frame0 = lastFrame() ?? '';

    const statusRow = (f: string): string =>
      f.split('\n').find((l) => l.includes('claude-opus-4-8')) ?? '';
    const liveRow = (f: string): string =>
      f.split('\n').find((l) => l.includes('responding…')) ?? '';

    expect(liveRow(frame0)).toContain('0s'); // elapsed starts at 0

    // Park: no new tokens. Advance the shared fake clock so LiveTurn's 250ms elapsed
    // tick (and ink-spinner's 80ms glyph tick) fire; bump `now` so elapsed advances.
    nowMs = 5000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const frame1 = lastFrame() ?? '';

    // The live line moved (elapsed 0s → 4s); the status strip is byte-for-byte identical.
    expect(liveRow(frame1)).toContain('4s');
    expect(statusRow(frame1)).toBe(statusRow(frame0));
    expect(frame1).not.toBe(frame0);
  });
});

describe('statusline-memo — the real App strip is memoized but NOT frozen', () => {
  function fakeDeps(): AppDeps {
    const settings: Settings = {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4.1',
      cwd: '/work',
      maxContext: 200_000,
    };
    const config = createFakeConfigService(settings);
    return {
      createClient: () => createFakeModelClient({ tickMs: 0 }),
      tools: createDefaultTools(),
      policy: createPermissionPolicy({ autoAllowSafe: true }),
      catalog: createModelCatalog(BUILTIN_MODELS),
      settings: config.get(),
      specs: BUILTIN_TOOL_SPECS,
    };
  }

  // Binds to app.tsx's ACTUAL status useMemo: a real turn changes context-window
  // occupancy (the fake script's `usage` event sets contextWindowTokens), so the
  // memoized bundle MUST recompute and the `ctx` chip MUST appear. A frozen/empty dep
  // list (or a status pinned to the initial render) would leave the strip stale and
  // this goes red.
  it('recomputes the strip after a turn — the ctx chip appears once the window is measured', async () => {
    const { stdin, lastFrame } = render(<App deps={fakeDeps()} />);
    await flushInk();
    // Fresh: no live-occupancy chip yet.
    expect(lastFrame() ?? '').not.toContain('ctx ');

    // Drive one full turn through the real UI seam; the fake script streams to
    // completion, committing the assistant message and emitting `usage`.
    await press(stdin, 'hi');
    await press(stdin, '\r');

    // Post-turn: the memoized status recomputed, so the ctx chip is now present.
    const frame = await waitForFrame(lastFrame, 'ctx ');
    expect(frame).toContain('ctx ');
  });
});
