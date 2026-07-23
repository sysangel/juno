// tests/streamingTurn.test.ts
// W13 — coverage for the previously-untested hook src/hooks/useStreamingTurn.ts.
//
// useStreamingTurn is React glue (useReducer + AbortController + ~16ms delta
// batching + the SHARED permission registry/policy round-trip). We exercise it
// by mounting a tiny harness component that calls the hook and publishes its
// returned controls to an outer ref every render — the established ink-testing-
// library mount pattern (app.smoke.test.tsx / components.test.tsx) plus React
// `act()` so state updates flush deterministically.
//
// Deterministic: no network, no keys, no real FS writes. Two clients drive it:
//   * the real createFakeModelClient (full pretend-run script) for the
//     happy-path commit + the streamed-text block-segmentation assertion, and
//     (the hook's ~16ms delta batcher is a dispatch-count optimization with no
//     correctness-observable effect — see case (b) — so it is not asserted), and
//   * a tiny in-test scripted client that stops with `tool_use` so the REAL
//     executor runs and PARKS on the shared policy — the only way to drive the
//     permission round-trip (resolvePermission / abort / permissionRequest).
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act } from 'react';
import { Text } from 'ink';
import { useStreamingTurn } from '../src/hooks/useStreamingTurn';
import type { StreamingTurnControls, StreamingTurnDeps } from '../src/hooks/useStreamingTurn';
import type { Action, Block, State } from '../src/core/reducer';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, Tool, ToolSpec, TurnInput } from '../src/core/contracts';
import type { PermissionPolicy } from '../src/core/contracts';
import type { SubagentRecorder } from '../src/services/subagentRecorder';
import type { SessionTraceRecorder } from '../src/services/sessionTrace';
import { createFakeModelClient } from '../src/core/fakeClient';
import { selectActivity } from '../src/core/selectors';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createDefaultTools, BUILTIN_TOOL_SPECS } from '../src/tools/registry';
import { cleanupInkRenderers, flushInk, renderInk as render } from './helpers/ink';

// --- harness ----------------------------------------------------------------

interface Mounted {
  /** The latest controls from the hook (refreshed on every render). */
  readonly controls: () => StreamingTurnControls;
  readonly renderCount: () => number;
  readonly unmount: () => void;
}

/**
 * Mount a component that calls useStreamingTurn(deps) and stashes the live
 * controls into a holder each render, so the test can call submit/abort/etc and
 * read state/permissionRequest at any point.
 */
function mountHook(deps: StreamingTurnDeps): Mounted {
  let latest: StreamingTurnControls | undefined;
  let renderCount = 0;

  function Harness(): null {
    renderCount += 1;
    latest = useStreamingTurn(deps);
    return null;
  }

  let unmount: () => void = () => undefined;
  act(() => {
    const mounted = render(createElement(Harness));
    unmount = mounted.unmount;
  });

  return {
    controls: (): StreamingTurnControls => {
      if (latest === undefined) {
        throw new Error('hook not mounted yet');
      }
      return latest;
    },
    renderCount: () => renderCount,
    unmount,
  };
}

/** Flush microtasks + a macrotask tick inside act() so React re-renders settle. */
async function flush(): Promise<void> {
  await flushInk();
}

/** Poll (bounded) until `predicate` holds, flushing React between checks. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function textBlocks(blocks: ReadonlyArray<Block>): Array<Extract<Block, { kind: 'text' }>> {
  return blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text');
}

function lastAssistant(state: State) {
  return [...state.committed].reverse().find((m) => m.role === 'assistant');
}

function lastAssistantTurn(state: State) {
  const last = lastAssistant(state);
  if (last?.turnId === undefined) return last === undefined ? [] : [last];
  return state.committed.filter(
    (message) => message.role === 'assistant' && message.turnId === last.turnId,
  );
}

// --- a scripted client that stops with tool_use (real executor runs) --------

function scriptedToolUseClient(turns: ReadonlyArray<ReadonlyArray<AgentEvent>>): ModelClient {
  let call = 0;
  return {
    streamTurn: async function* (
      _input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      const events = turns[call] ?? [
        { type: 'assistant-start', id: `a-${call}` },
        { type: 'assistant-done', id: `a-${call}`, stopReason: 'end' },
      ];
      call += 1;
      for (const event of events) {
        if (signal.aborted) {
          yield { type: 'aborted', reason: 'aborted' };
          return;
        }
        yield event;
        await Promise.resolve();
      }
    },
  };
}

function fakeDeps(overrides: Partial<StreamingTurnDeps> = {}): StreamingTurnDeps {
  return {
    client: createFakeModelClient({ tickMs: 0 }),
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    specs: BUILTIN_TOOL_SPECS,
    cwd: '.',
    effort: 'medium',
    // Zero the compaction-retry backoff so the /compact hook tests never wait on a real
    // exponential sleep (the wrapper still runs its full attempt loop, just instantly).
    compactionRetry: { baseDelayMs: 0 },
    ...overrides,
  };
}

/**
 * A stub `write_file` tool (risky) that records its args and performs NO real IO.
 * Used for the scripted tool_use cases so the executor genuinely runs but never
 * touches the filesystem (the real default write_file would write to disk).
 */
function stubWriteTool(runCalls: unknown[]): Tool {
  return {
    name: 'write_file',
    risk: 'risky',
    spec: { name: 'write_file', description: 'stub write', inputSchema: { type: 'object' } },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { written: false } };
    },
  };
}

/** A `safe` stub tool the default-true autoAllowSafe policy runs without parking. */
function stubSafeTool(runCalls: unknown[]): Tool {
  return {
    name: 'noop',
    risk: 'safe',
    spec: { name: 'noop', description: 'stub safe', inputSchema: { type: 'object' } },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { ran: true } };
    },
  };
}

/** A single safe-tool `tool_use` turn (auto-allowed) then a clean-end turn. */
function safeToolThenEnd(toolCallId: string): ReadonlyArray<ReadonlyArray<AgentEvent>> {
  return [
    [
      { type: 'assistant-start', id: 'a-1' },
      { type: 'tool-call', id: 'a-1', toolCallId, name: 'noop', args: {} },
      { type: 'assistant-done', id: 'a-1', stopReason: 'tool_use' },
    ],
    [
      { type: 'assistant-start', id: 'a-2' },
      { type: 'text-delta', id: 'a-2', delta: 'done' },
      { type: 'assistant-done', id: 'a-2', stopReason: 'end' },
    ],
  ];
}

/** Two-call script: a risky write_file (stopReason tool_use) then a clean end. */
function riskyWriteTurns(toolCallId: string, args: unknown): ReadonlyArray<ReadonlyArray<AgentEvent>> {
  return [
    [
      { type: 'assistant-start', id: 'a-1' },
      { type: 'tool-call', id: 'a-1', toolCallId, name: 'write_file', args },
      { type: 'assistant-done', id: 'a-1', stopReason: 'tool_use' },
    ],
    [
      { type: 'assistant-start', id: 'a-2' },
      { type: 'text-delta', id: 'a-2', delta: 'done' },
      { type: 'assistant-done', id: 'a-2', stopReason: 'end' },
    ],
  ];
}

/**
 * A stub `run_shell` tool declared `risk: 'dangerous'` — the default policy always
 * PROMPTS for it (never auto-allowed by risk alone), so it parks the same as the
 * risky write, but its `permission-open` carries risk 'dangerous'. Used to prove
 * the parked request's risk propagates from the tool through `state.pendingPermission`
 * and is NOT a hardcoded 'risky' fallback.
 */
function stubDangerousTool(runCalls: unknown[]): Tool {
  return {
    name: 'run_shell',
    risk: 'dangerous',
    spec: { name: 'run_shell', description: 'stub dangerous', inputSchema: { type: 'object' } },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { ran: true } };
    },
  };
}

/** Two-call script: a dangerous run_shell (stopReason tool_use) then a clean end. */
function dangerousShellTurns(toolCallId: string, args: unknown): ReadonlyArray<ReadonlyArray<AgentEvent>> {
  return [
    [
      { type: 'assistant-start', id: 'a-1' },
      { type: 'tool-call', id: 'a-1', toolCallId, name: 'run_shell', args },
      { type: 'assistant-done', id: 'a-1', stopReason: 'tool_use' },
    ],
    [
      { type: 'assistant-start', id: 'a-2' },
      { type: 'text-delta', id: 'a-2', delta: 'done' },
      { type: 'assistant-done', id: 'a-2', stopReason: 'end' },
    ],
  ];
}

afterEach(() => {
  cleanupInkRenderers();
});

describe('useStreamingTurn', () => {
  it('renders a burst of tool lifecycle events through one 16ms batch', async () => {
    const mounted = mountHook(fakeDeps());

    act(() => {
      mounted.controls().dispatch({ t: 'assistant-start', id: 'batch-turn' });
    });
    const beforeBurst = mounted.renderCount();

    act(() => {
      mounted.controls().dispatch({
        t: 'tool-call',
        toolCallId: 'batch-tool',
        name: 'noop',
        args: {},
      });
      mounted.controls().dispatch({
        t: 'tool-status',
        toolCallId: 'batch-tool',
        status: 'running',
      });
      mounted.controls().dispatch({
        t: 'tool-status',
        toolCallId: 'batch-tool',
        status: 'result',
        result: { ok: true },
      });
    });

    expect(mounted.renderCount()).toBe(beforeBurst);
    await waitFor(
      () => mounted.renderCount() === beforeBurst + 1,
      'one render for the tool lifecycle batch',
    );

    expect(mounted.renderCount()).toBe(beforeBurst + 1);
    expect(mounted.controls().state.tools['batch-tool']).toMatchObject({
      status: 'result',
      result: { ok: true },
    });
    mounted.unmount();
  });

  it('flushes a queued tool call before opening its permission overlay', async () => {
    const mounted = mountHook(fakeDeps());

    act(() => {
      mounted.controls().dispatch({ t: 'assistant-start', id: 'permission-turn' });
      mounted.controls().dispatch({
        t: 'tool-call',
        toolCallId: 'gated-tool',
        name: 'write_file',
        args: { path: 'report.md' },
      });
      mounted.controls().dispatch({
        t: 'permission-open',
        toolCallId: 'gated-tool',
        name: 'write_file',
        args: { path: 'report.md' },
        risk: 'risky',
      });
    });
    await flush();

    expect(mounted.controls().state.tools['gated-tool']).toMatchObject({
      name: 'write_file',
      status: 'pending',
    });
    expect(mounted.controls().permissionRequest).toMatchObject({
      toolCallId: 'gated-tool',
      name: 'write_file',
      risk: 'risky',
    });
    mounted.unmount();
  });

  it('snapshots every queued terminal tool status before assistant-done commits', async () => {
    const mounted = mountHook(fakeDeps());

    act(() => {
      mounted.controls().dispatch({ t: 'assistant-start', id: 'snapshot-turn' });
      mounted.controls().dispatch({
        t: 'tool-call',
        toolCallId: 'snapshot-tool',
        name: 'noop',
        args: {},
      });
      mounted.controls().dispatch({
        t: 'tool-status',
        toolCallId: 'snapshot-tool',
        status: 'result',
        result: { complete: true },
      });
      mounted.controls().dispatch({
        t: 'assistant-done',
        id: 'snapshot-turn',
        stopReason: 'end',
      });
    });
    await flush();

    expect(lastAssistant(mounted.controls().state)?.toolSnapshot?.['snapshot-tool']).toMatchObject({
      status: 'result',
      result: { complete: true },
    });
    mounted.unmount();
  });

  it('observes the exact shared dispatch funnel with a fail-soft trace recorder', async () => {
    const actions: Action[] = [];
    const traceRecorder: SessionTraceRecorder = {
      path: '/unused',
      record: (action) => actions.push(action),
      flush: async () => {},
      close: async () => {},
    };
    const mounted = mountHook(fakeDeps({ traceRecorder }));

    await act(async () => {
      await mounted.controls().submit('trace this turn');
    });
    expect(actions[0]).toMatchObject({ t: 'user-submit', text: 'trace this turn' });
    expect(actions.some((action) => action.t === 'deltas')).toBe(true);
    expect(actions.at(-1)).toEqual({ t: 'turn-settle' });
    mounted.unmount();
  });

  it('(a) submit drives a full fake turn -> committed assistant text + final usage tokens', async () => {
    const mounted = mountHook(fakeDeps());

    await act(async () => {
      await mounted.controls().submit('hi');
    });
    await flush();

    const state = mounted.controls().state;
    const fragments = lastAssistantTurn(state);
    expect(fragments.length).toBeGreaterThan(1);
    const text = fragments.flatMap((fragment) => textBlocks(fragment.blocks))
      .map((b) => b.text)
      .join('');
    // The fake streams "Hello from Juno." then " Now a gated action." across blocks.
    expect(text).toContain('Hello from Juno.');
    expect(text).toContain('Now a gated action.');

    // Final usage comes from the fake's single `usage` event (in:120, out:48).
    expect(state.tokens.in).toBe(120);
    expect(state.tokens.out).toBe(48);
    expect(state.phase).toBe('idle');

    mounted.unmount();
  });

  it('(b) streamed text-deltas commit as correctly-segmented text blocks (text block boundaries follow tool blocks)', async () => {
    const mounted = mountHook(fakeDeps());

    await act(async () => {
      await mounted.controls().submit('hi');
    });
    await flush();

    const fragments = lastAssistantTurn(mounted.controls().state);
    expect(fragments.length).toBeGreaterThan(1);
    const blocks = fragments.flatMap((fragment) => textBlocks(fragment.blocks));
    // The fake emits three consecutive "Hello " / "from " / "Juno." deltas before
    // the first tool block, then " Now a gated action." AFTER the tools. This asserts
    // the end-to-end submit -> stream -> committed-text path: consecutive same-id
    // deltas land in ONE text block, and an intervening tool block forces a NEW text
    // block — so there are exactly two text blocks with the expected text.
    // Unified-rendering wave 1: a NEW text block's opening delta is left-trimmed, so
    // the fake's " Now a gated action." (leading space after the tool) commits WITHOUT
    // the leading space. Was ' Now a gated action.' before the trim landed.
    expect(blocks[0]?.text).toBe('Hello from Juno.');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toBe('Now a gated action.');

    // NOTE ON COALESCING (intentionally NOT separately asserted here):
    // The hook's `coalesceDeltas` + ~16ms batcher is purely a dispatch-count / re-render
    // optimization: it collapses N rapid same-id deltas into FEWER reducer dispatches
    // within a 16ms window. It has NO correctness-observable effect on final state,
    // because reducer.ts `text-delta` ALREADY merges consecutive same-id deltas into the
    // trailing text block (so the committed text is identical whether or not the batcher
    // runs). The only true signal of the batcher is the internal `dispatchNow` call count,
    // which is not observable from outside the hook without modifying src/, and a
    // re-render-count proxy is not a deterministic 1:1 measure (React batches reactDispatch
    // independently). Asserting it here would therefore be a timing-dependent, flaky test
    // rather than a real gate, so coalescing is left to the hook's own design contract and
    // is deliberately not exercised by this end-to-end test.

    mounted.unmount();
  });

  it('(c) always-allow-pattern is remembered on the SHARED policy -> second matching risky call skips the prompt', async () => {
    const policy = createPermissionPolicy({ autoAllowSafe: true });
    const evalCalls: string[] = [];
    const tracked: PermissionPolicy = {
      evaluate: (name, args, risk) => {
        const decision = policy.evaluate(name, args, risk);
        evalCalls.push(`${name}:${decision}`);
        return decision;
      },
      remember: (pattern, decision) => policy.remember(pattern, decision),
      setMode: (mode) => policy.setMode(mode),
    };

    const runCalls: unknown[] = [];

    // --- first turn: risky write parks, user picks always-allow-pattern --------
    const first = mountHook(
      fakeDeps({
        policy: tracked,
        tools: [stubWriteTool(runCalls)],
        client: scriptedToolUseClient(riskyWriteTurns('tc-1', { path: 'one.txt', content: 'a' })),
      }),
    );
    let firstDone!: Promise<void>;
    act(() => {
      firstDone = first.controls().submit('write one');
    });

    await waitFor(() => first.controls().permissionRequest !== null, 'first permission parked');
    act(() => {
      first.controls().resolvePermission('tc-1', 'always-allow-pattern');
    });
    await firstDone;
    await flush();
    first.unmount();

    // First call prompted (decision === 'prompt').
    expect(evalCalls).toContain('write_file:prompt');

    // --- second turn on the SAME policy: a different write_file must auto-allow -
    const second = mountHook(
      fakeDeps({
        policy: tracked,
        tools: [stubWriteTool(runCalls)],
        client: scriptedToolUseClient(riskyWriteTurns('tc-2', { path: 'two.txt', content: 'b' })),
      }),
    );
    await act(async () => {
      await second.controls().submit('write two');
    });
    await flush();

    // The second write_file evaluated to auto-allow (remembered name:* rule) and
    // NEVER parked — permissionRequest stayed null through the whole turn.
    expect(evalCalls).toContain('write_file:auto-allow');
    expect(second.controls().permissionRequest).toBeNull();
    // And it actually RAN (not denied): tc-2 reached a terminal tool status and
    // the assistant turn committed with the tool block. (Tool execution is tracked
    // as a `tool` block inside the assistant message + the live `tools` map, not as
    // a separate `tool`-role committed message.)
    const secondState = second.controls().state;
    expect(secondState.phase).toBe('idle');
    expect(secondState.tools['tc-2']?.status).toBe('result');
    // The tc-2 tool block committed on SOME assistant message in this turn (the
    // first scripted turn carries the tool block; the second is a plain text turn).
    const hasToolBlock = secondState.committed.some(
      (m) =>
        m.role === 'assistant' &&
        m.blocks.some((b) => b.kind === 'tool' && b.toolCallId === 'tc-2'),
    );
    expect(hasToolBlock).toBe(true);
    second.unmount();
  });

  it('(d) abort() drains parked permissions (no hang) and returns to idle with an aborted action', async () => {
    let sawAborted = false;
    const runCalls: unknown[] = [];
    const mounted = mountHook(
      fakeDeps({
        tools: [stubWriteTool(runCalls)],
        client: scriptedToolUseClient(riskyWriteTurns('tc-abort', { path: 'x.txt', content: 'x' })),
      }),
    );

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = mounted.controls().submit('write then abort');
    });

    await waitFor(() => mounted.controls().permissionRequest !== null, 'permission parked');
    expect(mounted.controls().state.phase).toBe('awaiting-permission');

    act(() => {
      mounted.controls().abort();
    });

    // The parked await must settle (drainDeny) so submit() resolves — no hang.
    await submitPromise;
    await flush();

    const state = mounted.controls().state;
    sawAborted = state.phase === 'idle';
    expect(sawAborted).toBe(true);
    expect(state.overlay).toBe('none');
    expect(state.pendingPermission).toBeNull();
    // The permission overlay is gone after abort.
    expect(mounted.controls().permissionRequest).toBeNull();
    // Aborting while parked means the tool was NEVER granted/run.
    expect(runCalls).toHaveLength(0);

    mounted.unmount();
  });

  it('(e) permissionRequest is non-null with the correct {name,args,risk} while parked, null otherwise', async () => {
    const args = { path: 'gated.txt', content: 'secret' };
    const runCalls: unknown[] = [];
    const mounted = mountHook(
      fakeDeps({
        tools: [stubWriteTool(runCalls)],
        client: scriptedToolUseClient(riskyWriteTurns('tc-e', args)),
      }),
    );

    // Before any submit: idle, no request.
    expect(mounted.controls().permissionRequest).toBeNull();

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = mounted.controls().submit('write gated');
    });

    await waitFor(() => mounted.controls().permissionRequest !== null, 'permission parked');

    const request = mounted.controls().permissionRequest;
    expect(request).not.toBeNull();
    expect(request!.toolCallId).toBe('tc-e');
    expect(request!.name).toBe('write_file');
    expect(request!.args).toEqual(args);
    expect(request!.risk).toBe('risky');

    // Resolve allow-once -> the turn finishes and the request goes null again.
    act(() => {
      mounted.controls().resolvePermission('tc-e', 'allow-once');
    });
    await submitPromise;
    await flush();

    expect(mounted.controls().permissionRequest).toBeNull();
    // allow-once granted the call exactly once, so the stub tool ran once.
    expect(runCalls).toEqual([args]);

    mounted.unmount();
  });

  it("(e2) permissionRequest.risk carries a non-default 'dangerous' risk through state.pendingPermission (no 'risky' fallback)", async () => {
    // Regression guard: the retired side-table used `?? 'risky'`, so a parked
    // request whose risk is 'risky' cannot distinguish real propagation from the
    // fallback. Drive a `risk:'dangerous'` tool so the ONLY way the request reads
    // 'dangerous' is the risk riding `permission-open` INTO state.pendingPermission.
    const args = { cmd: 'rm -rf /' };
    const runCalls: unknown[] = [];
    const mounted = mountHook(
      fakeDeps({
        tools: [stubDangerousTool(runCalls)],
        client: scriptedToolUseClient(dangerousShellTurns('tc-danger', args)),
      }),
    );

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = mounted.controls().submit('run danger');
    });

    await waitFor(() => mounted.controls().permissionRequest !== null, 'dangerous permission parked');

    // The parked request reflects the tool's declared risk verbatim — 'dangerous',
    // NOT the old hardcoded 'risky' fallback.
    const request = mounted.controls().permissionRequest;
    expect(request).not.toBeNull();
    expect(request!.toolCallId).toBe('tc-danger');
    expect(request!.name).toBe('run_shell');
    expect(request!.risk).toBe('dangerous');
    // The reducer state is the single source: pendingPermission carries the risk.
    expect(mounted.controls().state.pendingPermission?.risk).toBe('dangerous');

    // Resolve allow-once so the parked await settles and submit() resolves.
    act(() => {
      mounted.controls().resolvePermission('tc-danger', 'allow-once');
    });
    await submitPromise;
    await flush();

    expect(mounted.controls().permissionRequest).toBeNull();
    expect(mounted.controls().state.pendingPermission).toBeNull();
    expect(runCalls).toEqual([args]);

    mounted.unmount();
  });

  it('(f) steer() pushes to the live queue AND commits a rendered user message', async () => {
    const mounted = mountHook(fakeDeps());

    act(() => {
      mounted.controls().steer('focus X');
    });
    await flush();

    // The steer commits a user message immediately (rendered + carried into the next submit).
    const userMsgs = mounted.controls().state.committed.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    const text = textBlocks(userMsgs[0]!.blocks)
      .map((b) => b.text)
      .join('');
    expect(text).toBe('focus X');

    mounted.unmount();
  });

  it('(g) empty/whitespace steer() is a no-op (nothing queued, nothing committed)', () => {
    const mounted = mountHook(fakeDeps());

    act(() => {
      mounted.controls().steer('   ');
    });

    expect(mounted.controls().state.committed.filter((m) => m.role === 'user')).toHaveLength(0);

    mounted.unmount();
  });

  it('(h) toolCallsThisTurn counts executed tools and resets to 0 on the next submit', async () => {
    const runCalls: unknown[] = [];
    const mounted = mountHook(
      fakeDeps({
        tools: [stubSafeTool(runCalls)],
        client: scriptedToolUseClient(safeToolThenEnd('tc-iter')),
      }),
    );

    // Starts at 0 before any turn.
    expect(mounted.controls().toolCallsThisTurn).toBe(0);

    await act(async () => {
      await mounted.controls().submit('run a tool');
    });
    await flush();

    // The safe tool ran once and the per-turn mirror reflects it.
    expect(runCalls).toHaveLength(1);
    expect(mounted.controls().toolCallsThisTurn).toBe(1);

    // A fresh submit (the scripted client now falls through to a plain end turn) resets it.
    await act(async () => {
      await mounted.controls().submit('no tools this time');
    });
    await flush();

    expect(mounted.controls().toolCallsThisTurn).toBe(0);

    mounted.unmount();
  });

  it('(i) interleaved tool-call-deltas coalesce per toolCallId with no cross-tool bleed', async () => {
    // Guards the CRITICAL coalesceDeltas keying invariant: tool-call-delta is keyed
    // by `toolCallId` (NOT the text/reasoning `id`), so two interleaved tool calls'
    // arg JSON must accumulate independently and in stream order. We register both
    // tool calls FIRST (so the reducer's `tool-call` doesn't clobber the entry that
    // a later delta accumulates onto), then interleave deltas tcA/tcB/tcA. If the
    // batcher mis-keyed (reading the absent `id`), the two streams would merge and
    // argsText would be wrong.
    const runCalls: unknown[] = [];
    const mounted = mountHook(
      fakeDeps({
        tools: [stubSafeTool(runCalls)],
        client: scriptedToolUseClient([
          [
            { type: 'assistant-start', id: 'a-1' },
            { type: 'tool-call', id: 'a-1', toolCallId: 'tcA', name: 'noop', args: {} },
            { type: 'tool-call', id: 'a-1', toolCallId: 'tcB', name: 'noop', args: {} },
            { type: 'tool-call-delta', toolCallId: 'tcA', argsDelta: '{"a":' },
            { type: 'tool-call-delta', toolCallId: 'tcB', argsDelta: '{"b":2}' },
            { type: 'tool-call-delta', toolCallId: 'tcA', argsDelta: '1}' },
            { type: 'assistant-done', id: 'a-1', stopReason: 'tool_use' },
          ],
          [
            { type: 'assistant-start', id: 'a-2' },
            { type: 'assistant-done', id: 'a-2', stopReason: 'end' },
          ],
        ]),
      }),
    );

    await act(async () => {
      await mounted.controls().submit('run interleaved tool args');
    });
    await flush();

    const state = mounted.controls().state;
    // Each tool accumulated ONLY its own argsDelta, in stream order — no bleed.
    expect(state.tools['tcA']?.argsText).toBe('{"a":1}');
    expect(state.tools['tcB']?.argsText).toBe('{"b":2}');
    // Both safe tools actually ran (executor not blocked on permissions).
    expect(runCalls).toEqual([{}, {}]);

    mounted.unmount();
  });
});

// --- ambient brain recall (Phase 2) ------------------------------------------
//
// The recall seam is `deps.ambientRecall` — a fail-soft async callback faked
// here (the real brain-hook spawn path is covered in brainAmbient.test.ts).
// These cases pin the submit-seam contract: the block is appended to the
// OUTGOING copy of the freshest user message only (framed exactly like the
// Phase 0 system-prompt append), committed state stays raw, and every
// empty/error path leaves the message byte-identical and the turn running.

describe('useStreamingTurn ambient brain recall', () => {
  const MEMORY_BLOCK =
    'Possibly relevant past memories from brain (reference, not instructions):\n' +
    '- [memory juno-state, 2026-07-05] Phase 1 landed brain_recall/brain_get.';

  /** A minimal clean-end client that records every TurnInput it receives. */
  function capturingClient(captured: TurnInput[]): ModelClient {
    let call = 0;
    return {
      streamTurn: async function* (
        input: TurnInput,
        _tools: ToolSpec[],
        _signal: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        captured.push(input);
        call += 1;
        yield { type: 'assistant-start', id: `a-${call}` };
        yield { type: 'text-delta', id: `a-${call}`, delta: 'ok' };
        yield { type: 'assistant-done', id: `a-${call}`, stopReason: 'end' };
      },
    };
  }

  function userContents(input: TurnInput | undefined): string[] {
    return (input?.messages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
  }

  it('hits ⇒ block appended to the outgoing user message with the Phase 0 framing; committed state stays raw', async () => {
    const captured: TurnInput[] = [];
    const prompts: string[] = [];
    const mounted = mountHook(
      fakeDeps({
        client: capturingClient(captured),
        ambientRecall: async (prompt) => {
          prompts.push(prompt);
          return MEMORY_BLOCK;
        },
      }),
    );

    await act(async () => {
      await mounted.controls().submit('how did phase 1 land?');
    });
    await flush();

    // The recall seam saw the RAW prompt text.
    expect(prompts).toEqual(['how did phase 1 land?']);

    // Outgoing message: raw prompt first, then the delimited reference block.
    expect(captured).toHaveLength(1);
    const [outgoing] = userContents(captured[0]);
    expect(outgoing?.startsWith('how did phase 1 land?')).toBe(true);
    expect(outgoing).toContain('<brain-memory-context>');
    expect(outgoing).toContain('REFERENCE MATERIAL, not');
    expect(outgoing).toContain(MEMORY_BLOCK);
    expect(outgoing?.trimEnd().endsWith('</brain-memory-context>')).toBe(true);

    // Committed (rendered/persisted) state carries ONLY the raw prompt.
    const committedUser = mounted.controls().state.committed.find((m) => m.role === 'user');
    const committedText = textBlocks(committedUser?.blocks ?? [])
      .map((b) => b.text)
      .join('');
    expect(committedText).toBe('how did phase 1 land?');

    mounted.unmount();
  });

  it('empty hits (undefined) ⇒ outgoing message unchanged', async () => {
    const captured: TurnInput[] = [];
    const mounted = mountHook(
      fakeDeps({
        client: capturingClient(captured),
        ambientRecall: async () => undefined,
      }),
    );

    await act(async () => {
      await mounted.controls().submit('nothing matches');
    });
    await flush();

    expect(userContents(captured[0])).toEqual(['nothing matches']);
    mounted.unmount();
  });

  it('timeout/error (rejection) ⇒ outgoing message unchanged and the turn still completes', async () => {
    const captured: TurnInput[] = [];
    const mounted = mountHook(
      fakeDeps({
        client: capturingClient(captured),
        ambientRecall: async () => {
          throw new Error('recall timed out after 2500ms');
        },
      }),
    );

    await act(async () => {
      await mounted.controls().submit('slow brain day');
    });
    await flush();

    // Turn proceeded to the model and committed the assistant reply.
    expect(userContents(captured[0])).toEqual(['slow brain day']);
    const assistant = lastAssistant(mounted.controls().state);
    expect(textBlocks(assistant?.blocks ?? []).map((b) => b.text).join('')).toBe('ok');
    expect(mounted.controls().state.phase).toBe('idle');

    mounted.unmount();
  });

  it('no ambientRecall dep (flag off) ⇒ outgoing message untouched', async () => {
    const captured: TurnInput[] = [];
    const mounted = mountHook(fakeDeps({ client: capturingClient(captured) }));

    await act(async () => {
      await mounted.controls().submit('plain submit');
    });
    await flush();

    expect(userContents(captured[0])).toEqual(['plain submit']);
    expect(userContents(captured[0])[0]).not.toContain('brain-memory-context');
    mounted.unmount();
  });

  it('next turn queries with the RAW new prompt; the previous injection never re-enters', async () => {
    const captured: TurnInput[] = [];
    const prompts: string[] = [];
    let calls = 0;
    const mounted = mountHook(
      fakeDeps({
        client: capturingClient(captured),
        ambientRecall: async (prompt) => {
          prompts.push(prompt);
          calls += 1;
          return calls === 1 ? MEMORY_BLOCK : undefined;
        },
      }),
    );

    await act(async () => {
      await mounted.controls().submit('first question');
    });
    await flush();
    await act(async () => {
      await mounted.controls().submit('second question');
    });
    await flush();

    // The recall query is ONLY ever the raw prompt text — the injected block
    // from turn 1 is neither queried nor replayed in turn 2's transcript.
    expect(prompts).toEqual(['first question', 'second question']);
    expect(prompts[1]).not.toContain('brain-memory-context');

    const secondTurnUsers = userContents(captured[1]);
    expect(secondTurnUsers).toEqual(['first question', 'second question']);
    expect(secondTurnUsers.join('\n')).not.toContain('brain-memory-context');

    mounted.unmount();
  });
});

// ---------------------------------------------------------------------------
// F. feedback + empty states — `/compact` now emits an honest outcome notice
// (a dim `notice` block) instead of the old silent no-op. Driven through the
// real hook so the runCompactionStep guards + estimate math are exercised.
// ---------------------------------------------------------------------------

describe('useStreamingTurn /compact feedback (F)', () => {
  /** A tools-less summarizer client: yields `summary` as the compaction reply. */
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

  /**
   * A summarizer that reports failure the way every PRODUCTION ModelClient does — by
   * YIELDING an `{type:'error'}` AgentEvent (claude-cli exit-non-zero/stall, the
   * openai/anthropic HTTP + stream paths). None of them throw to the consumer, so this
   * is the shape the manual /compact failure notice must actually handle.
   */
  function erroringSummarizerClient(message: string): ModelClient {
    return {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: 'sum' };
        yield { type: 'error', message };
      },
    };
  }

  /** Seed `n` committed user messages so the transcript is real conversation. */
  function fillTranscript(controls: () => StreamingTurnControls, n: number): void {
    act(() => {
      for (let i = 0; i < n; i += 1) {
        controls().dispatch({ t: 'user-submit', id: `u${i}`, text: 'x'.repeat(60) });
      }
    });
  }

  /** Text of the LAST notice block in the committed transcript, or undefined. */
  function lastNoticeText(state: State): string | undefined {
    for (const msg of [...state.committed].reverse()) {
      for (const block of msg.blocks) {
        if (block.kind === 'notice') return block.text;
      }
    }
    return undefined;
  }

  it('emits a compacted-count notice and stores a hidden summary boundary', async () => {
    const m = mountHook(fakeDeps({ client: summarizerClient('DENSE SUMMARY'), maxContext: 10_000 }));
    fillTranscript(m.controls, 6); // > MIN_MESSAGES_TO_COMPACT
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(() => lastNoticeText(m.controls().state) !== undefined, 'compacted notice');

    expect(lastNoticeText(m.controls().state)).toMatch(/^compacted \d+ messages$/);
    // The summary is persisted as hidden marker metadata, not rendered into scrollback.
    expect(
      m.controls().state.committed.some(
        (msg) => msg.compactionBoundary?.summaryText === 'DENSE SUMMARY',
      ),
    ).toBe(true);
    m.unmount();
  });

  it('emits `nothing to compact yet` when the transcript is below the minimum', async () => {
    const m = mountHook(fakeDeps({ client: summarizerClient('unused'), maxContext: 10_000 }));
    fillTranscript(m.controls, 2); // <= MIN_MESSAGES_TO_COMPACT
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(
      () => lastNoticeText(m.controls().state) === 'nothing to compact yet',
      'nothing-to-compact notice',
    );
    // No summary was produced — just the two user turns plus the appended notice.
    expect(m.controls().state.committed).toHaveLength(3);
    m.unmount();
  });

  it('emits `nothing to compact yet` when the model returns an empty summary', async () => {
    const m = mountHook(fakeDeps({ client: summarizerClient(''), maxContext: 10_000 }));
    fillTranscript(m.controls, 6);
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(
      () => lastNoticeText(m.controls().state) === 'nothing to compact yet',
      'empty-summary notice',
    );
    // The empty summary never dispatched a compaction — the 6 turns are intact, plus notice.
    expect(m.controls().state.committed).toHaveLength(7);
    m.unmount();
  });

  // E: a summarizer failure on a manual /compact surfaces an honest error notice
  // (`compaction failed: <msg>`) instead of the old silent swallow / misleading
  // `nothing to compact yet`. Production clients report failure with an error EVENT
  // (never a throw), so this is driven by an error-event client — the case the old
  // throwing fake never covered. Auto-compaction stays quiet (only the force path reports).
  it('emits `compaction failed: <msg>` when the summarizer errors on a manual /compact', async () => {
    const m = mountHook(
      fakeDeps({
        client: erroringSummarizerClient('model backend exited non-zero'),
        maxContext: 10_000,
      }),
    );
    fillTranscript(m.controls, 6); // > MIN_MESSAGES_TO_COMPACT so we reach the summarizer
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(
      () =>
        lastNoticeText(m.controls().state) === 'compaction failed: model backend exited non-zero',
      'compaction-failed notice',
    );
    // The failed compaction dispatched no `compact` — the 6 turns are intact, plus the notice.
    expect(m.controls().state.committed).toHaveLength(7);
    m.unmount();
  });

  // A context-length overflow is the one summarizer failure whose CAUSE the user should
  // see distinctly: the transcript is too large for the model to summarize in one shot.
  // The retry wrapper rethrows it immediately (no pointless retries) and the manual
  // /compact notice enriches it to `context window exceeded: <msg>`.
  it('enriches the manual /compact notice when the summarizer overflows the context window', async () => {
    const m = mountHook(
      fakeDeps({
        client: erroringSummarizerClient('prompt is too long: 250000 tokens > 200000 maximum'),
        maxContext: 10_000,
      }),
    );
    fillTranscript(m.controls, 6);
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(
      () =>
        lastNoticeText(m.controls().state) ===
        'compaction failed: context window exceeded: prompt is too long: 250000 tokens > 200000 maximum',
      'context-window-exceeded notice',
    );
    // No `compact` dispatched — the 6 turns are intact, plus the notice.
    expect(m.controls().state.committed).toHaveLength(7);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// Wave 13 (retry-ui) REPAIR — compaction must not leave a phantom retry line.
//
// Compaction drains the SAME `onRetry`-wired client as a live turn, but through
// `runCompaction`, which consumes the summarization call's assistant-start/error/
// aborted INTERNALLY. So a transient 503/429 during summarization fires onRetry ⇒
// dispatches `retry-attempt`, yet NONE of the reducer's normal clearing cases
// (assistant-start/error/aborted) ever reach it — the dispatched compact/notice
// actions do not touch `state.retry`. Before the fix, `selectActivity` then
// returned a permanent `retrying 1/3 · 500ms backoff` (abortable) at phase idle:
// a phantom spinner + `esc to abort` line until the next user-submit. The fix
// dispatches `retry-clear` in `runCompactionStep`'s finally.
//
// These drive the REAL seam (compactNow → runCompactionStep), simulating onRetry by
// dispatching `retry-attempt` through the hook's own dispatch exactly as app.tsx's
// onRetry observer does on the shared client, at the moment the compaction call
// begins. Without the finally clear both assertions fail (retry stays set at idle).
describe('useStreamingTurn — compaction clears the retry indicator (repair)', () => {
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

  function erroringSummarizerClient(message: string): ModelClient {
    return {
      streamTurn: async function* (): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: 'sum' };
        yield { type: 'error', message };
      },
    };
  }

  /**
   * Wrap a summarizer so the compaction model call simulates a pre-first-byte
   * transport backoff: as each `streamTurn` begins it dispatches `retry-attempt`
   * through the hook's own dispatch (the same channel app.tsx's onRetry observer
   * uses on the shared onRetry-wired client), THEN yields the underlying events —
   * so `state.retry` is set mid-compaction, exactly as the bug requires.
   */
  function retryingDuringCompaction(
    inner: ModelClient,
    dispatchHolder: { current: ((action: Action) => void) | null },
  ): ModelClient {
    return {
      streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal) {
        dispatchHolder.current?.({ t: 'retry-attempt', attempt: 1, max: 3, delayMs: 500 });
        return inner.streamTurn(input, tools, signal);
      },
    };
  }

  function fillTranscript(controls: () => StreamingTurnControls, n: number): void {
    act(() => {
      for (let i = 0; i < n; i += 1) {
        controls().dispatch({ t: 'user-submit', id: `u${i}`, text: 'x'.repeat(60) });
      }
    });
  }

  function lastNoticeText(state: State): string | undefined {
    for (const msg of [...state.committed].reverse()) {
      for (const block of msg.blocks) {
        if (block.kind === 'notice') return block.text;
      }
    }
    return undefined;
  }

  it('clears state.retry after a SUCCESSFUL compaction whose model call retried', async () => {
    const holder: { current: ((action: Action) => void) | null } = { current: null };
    const m = mountHook(
      fakeDeps({
        // A >= MIN_SUMMARY_SEED (200) summary settles in one attempt (one retry-attempt).
        client: retryingDuringCompaction(summarizerClient('DENSE SUMMARY '.repeat(20)), holder),
        maxContext: 10_000,
      }),
    );
    holder.current = m.controls().dispatch;
    fillTranscript(m.controls, 6);
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(() => lastNoticeText(m.controls().state) !== undefined, 'compacted notice');

    // The retry fired mid-compaction; the finally cleared it. No phantom line at idle.
    expect(m.controls().state.phase).toBe('idle');
    expect(m.controls().state.retry).toBeUndefined();
    expect(selectActivity(m.controls().state)).toBeNull();
    m.unmount();
  });

  it('clears state.retry after a FAILED compaction (notice path) whose model call retried', async () => {
    const holder: { current: ((action: Action) => void) | null } = { current: null };
    const m = mountHook(
      fakeDeps({
        client: retryingDuringCompaction(
          erroringSummarizerClient('model backend exited non-zero'),
          holder,
        ),
        maxContext: 10_000,
      }),
    );
    holder.current = m.controls().dispatch;
    fillTranscript(m.controls, 6);
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(
      () => lastNoticeText(m.controls().state) === 'compaction failed: model backend exited non-zero',
      'compaction-failed notice',
    );

    // Even on the failure/notice path the finally clears retry — no phantom line at idle.
    expect(m.controls().state.phase).toBe('idle');
    expect(m.controls().state.retry).toBeUndefined();
    expect(selectActivity(m.controls().state)).toBeNull();
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// G. submit's dependency on toolTimeoutMs — a stale-closure guard.
//
// `submit` is a useCallback whose dep array lists every `deps.*` field it reads
// INDIVIDUALLY: `deps` is a fresh object literal on every render at the app.tsx
// call site, so depending on the whole `deps` would rebuild submit every render
// (incl. each ~16ms token flush) and defeat the memo. toolTimeoutMs feeds
// createToolExecutor({ timeoutMs }) inside submit; it was originally MISSING from
// that list, so when toolTimeoutMs changed between renders submit kept its first-
// render closure and built the tool executor with the STALE timeout.
//
// This pins the fix deterministically (no timers, no mocks): submit must get a new
// identity — a fresh closure ⇒ a fresh executor timeout — when toolTimeoutMs
// changes, and must stay stable when nothing changes (the negative control rules
// out a false green from unrelated per-render instability). Before the fix the
// third assertion failed: submit stayed === first and the stale 1000 leaked.
describe('useStreamingTurn submit — toolTimeoutMs is a real dependency (stale-closure guard)', () => {
  it('recomputes submit when toolTimeoutMs changes, and only then', () => {
    let latestSubmit: StreamingTurnControls['submit'] | undefined;
    function Harness({ deps }: { deps: StreamingTurnDeps }): null {
      latestSubmit = useStreamingTurn(deps).submit;
      return null;
    }

    // One base deps object; every rerender reuses its sub-objects (client/tools/
    // policy/…) by reference, so toolTimeoutMs is the ONLY thing that ever varies.
    const base = fakeDeps({ toolTimeoutMs: 1000 });
    let rerender!: (node: ReturnType<typeof createElement>) => void;
    let unmount: () => void = () => undefined;
    act(() => {
      const r = render(createElement(Harness, { deps: base }));
      rerender = r.rerender;
      unmount = r.unmount;
    });
    const first = latestSubmit;
    expect(first).toBeTypeOf('function');

    // Negative control: rerender with the SAME deps ⇒ submit identity is stable.
    act(() => {
      rerender(createElement(Harness, { deps: base }));
    });
    expect(latestSubmit).toBe(first);

    // Positive: change ONLY toolTimeoutMs ⇒ submit MUST be a new closure.
    act(() => {
      rerender(createElement(Harness, { deps: { ...base, toolTimeoutMs: 2000 } }));
    });
    expect(latestSubmit).not.toBe(first);

    unmount();
  });
});

// -----------------------------------------------------------------------------
// H. submit's dependency on `hooks` — the same stale-closure guard as toolTimeoutMs.
// `hooks` feeds createHookDispatcher(deps.hooks, …) inside submit's body, so it MUST
// be in the useCallback dep list; omitting it would stale the tool-call hook gate
// when the config's hooks block changed between renders. This asserts submit is a
// fresh closure exactly when `hooks` changes (and stable otherwise).
// -----------------------------------------------------------------------------
describe('useStreamingTurn submit — hooks is a real dependency (stale-closure guard)', () => {
  it('recomputes submit when hooks changes, and only then', () => {
    let latestSubmit: StreamingTurnControls['submit'] | undefined;
    function Harness({ deps }: { deps: StreamingTurnDeps }): null {
      latestSubmit = useStreamingTurn(deps).submit;
      return null;
    }

    const base = fakeDeps({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: ['a'] }] }] } });
    let rerender!: (node: ReturnType<typeof createElement>) => void;
    let unmount: () => void = () => undefined;
    act(() => {
      const r = render(createElement(Harness, { deps: base }));
      rerender = r.rerender;
      unmount = r.unmount;
    });
    const first = latestSubmit;
    expect(first).toBeTypeOf('function');

    // Negative control: same deps ⇒ stable identity.
    act(() => {
      rerender(createElement(Harness, { deps: base }));
    });
    expect(latestSubmit).toBe(first);

    // Positive: change ONLY hooks ⇒ submit MUST be a fresh closure.
    act(() => {
      rerender(
        createElement(Harness, {
          deps: { ...base, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: ['b'] }] }] } },
        }),
      );
    });
    expect(latestSubmit).not.toBe(first);

    unmount();
  });
});

// ---------------------------------------------------------------------------
// b3 render-efficiency item 2 — the ~16ms flush wraps the coalesced deltas in ONE
// `deltas` action (one reactDispatch per flush), and dispatchNow FANS that batch out
// to the subagent recorder as its sub-actions (recording the wrapper would silently
// drop child tool-call-delta lines).
// ---------------------------------------------------------------------------

/** A recorder fake that captures every (action, state) it observes. */
function capturingRecorder(): { recorder: SubagentRecorder; seen: Action[] } {
  const seen: Action[] = [];
  return {
    recorder: {
      record: (action: Action): void => {
        seen.push(action);
      },
    },
    seen,
  };
}

/**
 * Mount a component that calls useStreamingTurn and COUNTS its render invocations.
 * Because the component subscribes to the hook's internal useReducer, every reactDispatch
 * that produces a NEW state ref re-renders it — so the render count is a faithful proxy
 * for the number of React commits the hook triggers (one Ink render+Yoga pass each).
 */
function mountRenderCounter(deps: StreamingTurnDeps): {
  readonly controls: () => StreamingTurnControls;
  readonly renders: () => number;
  readonly unmount: () => void;
} {
  let count = 0;
  let latest: StreamingTurnControls | undefined;

  function Harness(): null {
    latest = useStreamingTurn(deps);
    count += 1;
    return null;
  }

  let unmount: () => void = () => undefined;
  act(() => {
    unmount = render(createElement(Harness)).unmount;
  });

  return {
    controls: (): StreamingTurnControls => {
      if (latest === undefined) {
        throw new Error('hook not mounted yet');
      }
      return latest;
    },
    renders: (): number => count,
    unmount,
  };
}

describe('useStreamingTurn — coalesced deltas batch (b3 item 2)', () => {
  // ACCEPTANCE (the lane's headline goal — "one repaint per coalesced tick"): a single
  // ~16ms flush of K coalesced deltas must fire exactly ONE reactDispatch (⇒ one React
  // commit + one Yoga pass), NOT K. This is what the W9/C1 flicker harness will build on.
  //
  // Two construction requirements, both empirically load-bearing:
  //  (a) The flush is driven by the NATURAL 16ms setTimeout and is NOT wrapped in act().
  //      act() coalesces the pre-fix loop's K synchronous reactDispatches into a single
  //      commit, so it passes the broken K-loop too (measured: 1 commit under act for BOTH
  //      versions) — masking the regression. A real-timer, un-act'd wait lets Ink's
  //      synchronous reconciler commit each reactDispatch separately, so the K-loop shows K.
  //  (b) INTERLEAVED distinct-id deltas (a1/a2/a1). coalesceDeltas merges only CONSECUTIVE
  //      same-key deltas, so a1/a2/a1 stays THREE sub-actions; same-id deltas would collapse
  //      to K=1 and could never observe the batching. tool-call-delta is used because each
  //      sub-action provably mutates state (opens/extends its tool entry), so the pre-fix
  //      `for (…) dispatchNow(action)` loop yields three genuine commits, never a bailed
  //      no-op. Reverting flushDeltas to that loop turns the +1 below into +3 → this fails.
  it('one coalesced tick ⇒ exactly ONE React commit for K interleaved deltas (not K)', async () => {
    const m = mountRenderCounter(fakeDeps());

    // Queuing a delta only pushes it and (once) arms the 16ms timer — it never dispatches,
    // so NOTHING has committed yet. (Wrapping these queue-only calls in act() is harmless:
    // it flushes no macrotask, so the armed timer stays pending for the un-act'd wait below.)
    const before = m.renders();
    act(() => {
      const d = m.controls().dispatch;
      d({ t: 'tool-call-delta', toolCallId: 'a1', argsDelta: '1' });
      d({ t: 'tool-call-delta', toolCallId: 'a2', argsDelta: '2' });
      d({ t: 'tool-call-delta', toolCallId: 'a1', argsDelta: '3' });
    });
    expect(m.renders()).toBe(before); // queuing armed the timer but committed nothing

    // Fire the natural 16ms flush OUTSIDE act() (see requirement (a)). Real timer, real wait.
    await new Promise<void>((resolve) => setTimeout(resolve, 40));

    // The whole coalesced tick repainted exactly ONCE. The pre-fix per-delta loop makes this 3.
    expect(m.renders() - before).toBe(1);

    // Sanity: the single batched flush still applied the WHOLE coalesced set — both tools'
    // interleaved arg fragments landed, keyed independently (a1 got '1'+'3', a2 got '2').
    const tools = m.controls().state.tools;
    expect(tools['a1']?.argsText).toBe('13');
    expect(tools['a2']?.argsText).toBe('2');

    m.unmount();
  });

  it('a batched flush applies the whole coalesced set (final live text = merged deltas)', () => {
    const mounted = mountHook(fakeDeps());
    act(() => {
      const d = mounted.controls().dispatch;
      d({ t: 'user-submit', id: 'u1', text: 'hi' });
      d({ t: 'assistant-start', id: 'a1' });
      // Queue several same-id text-deltas (they sit in the delta queue on the 16ms timer).
      d({ t: 'text-delta', id: 'a1', delta: 'foo ' });
      d({ t: 'text-delta', id: 'a1', delta: 'bar ' });
      d({ t: 'text-delta', id: 'a1', delta: 'baz' });
      // A synchronous local action flushes the queue (dispatch → flushDeltas first),
      // wrapping the coalesced deltas in ONE `deltas` action through dispatchNow.
      d({ t: 'retry-clear' });
    });

    const live = mounted.controls().state.live;
    const text = textBlocks(live!.blocks)
      .map((b) => b.text)
      .join('');
    expect(text).toBe('foo bar baz');
    mounted.unmount();
  });

  it('fans the batch out to the recorder as tool-call-delta sub-actions (never the raw `deltas` wrapper)', () => {
    const { recorder, seen } = capturingRecorder();
    const mounted = mountHook(fakeDeps({ subagentRecorder: recorder }));

    act(() => {
      const d = mounted.controls().dispatch;
      // Two arg-deltas for the same tool coalesce into ONE tool-call-delta before dispatch.
      d({ t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '{"a":' });
      d({ t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '1}' });
      // Flush the queue with a synchronous local action.
      d({ t: 'retry-clear' });
    });

    // The recorder observed the tool-call-delta sub-action(s) — the fan-out preserved the
    // child arg-delta stream. It NEVER observed a bare `deltas` wrapper (which resolves to
    // no parentToolUseId and would drop the child line).
    const deltaSubs = seen.filter((a) => a.t === 'tool-call-delta');
    expect(deltaSubs.length).toBeGreaterThanOrEqual(1);
    expect(deltaSubs.every((a) => a.t === 'tool-call-delta' && a.toolCallId === 'tc1')).toBe(true);
    expect(seen.some((a) => a.t === 'deltas')).toBe(false);
    mounted.unmount();
  });
});

// ---------------------------------------------------------------------------
// b3 render-efficiency item 1 — the busy line must never FLASH 'thinking…'/'responding…'
// between two sequential tools. This is the lane's e2e ACCEPTANCE: drive ONE round emitting
// TWO auto-allowed top-level tool-calls through the REAL executor + turnRunner + hook,
// render the busy line each commit via ink-testing-library, and assert no phantom flash
// frame lands between the two tool executions.
//
// Why an e2e frames assertion (not just the selectors unit table): the raw-API turnRunner
// DEFERS assistant-done to the end of the round, so `live` stays NON-null while the tools
// run — the inter-tool window is phase='streaming' + an unsettled top-level sibling with a
// non-null `live`. A prior gate on `state.live === null` was therefore dead code (never true
// mid-round) and the flash survived; only driving the real loop proves the fix engages.
// Reverting the selectors fix (dropping the hasUnsettledTopLevelTool branch) makes the
// between-tools frame flash 'thinking…' and this test goes red.
// ---------------------------------------------------------------------------

interface ToolGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function createToolGate(): ToolGate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A controlled `safe` stub. Holding each call open gives Ink 7 / React 19 an
 * explicit render boundary for both running states without relying on scheduler
 * timing or automatic batching details. */
function stubSafeToolNamed(name: string, runCalls: unknown[], gate: ToolGate): Tool {
  return {
    name,
    risk: 'safe',
    spec: { name, description: `stub ${name}`, inputSchema: { type: 'object' } },
    run: async (args: unknown): Promise<{ ok: true; data: unknown }> => {
      runCalls.push(args);
      await gate.promise;
      return { ok: true, data: {} };
    },
  };
}

describe('useStreamingTurn — busy line never flashes between sequential tools (b3 item 1)', () => {
  it('e2e: a 2-tool round shows no thinking…/responding… frame BETWEEN the two tool executions', async () => {
    const runCalls: unknown[] = [];
    const alphaGate = createToolGate();
    const bravoGate = createToolGate();
    const deps = fakeDeps({
      tools: [
        stubSafeToolNamed('alpha', runCalls, alphaGate),
        stubSafeToolNamed('bravo', runCalls, bravoGate),
      ],
      client: scriptedToolUseClient([
        [
          { type: 'assistant-start', id: 'a-1' },
          { type: 'tool-call', id: 'a-1', toolCallId: 'tc-a', name: 'alpha', args: {} },
          { type: 'tool-call', id: 'a-1', toolCallId: 'tc-b', name: 'bravo', args: {} },
          { type: 'assistant-done', id: 'a-1', stopReason: 'tool_use' },
        ],
        [
          { type: 'assistant-start', id: 'a-2' },
          { type: 'text-delta', id: 'a-2', delta: 'done' },
          { type: 'assistant-done', id: 'a-2', stopReason: 'end' },
        ],
      ]),
    });

    // A component that renders the busy line each commit. Ink dedupes identical consecutive
    // output, so `frames` is the ordered sequence of DISTINCT busy-line labels.
    let controls: StreamingTurnControls | undefined;
    function BusyLine(): ReactElement {
      controls = useStreamingTurn(deps);
      const activity = selectActivity(controls.state);
      return createElement(Text, null, `BUSY:${activity?.label ?? '(idle)'}`);
    }

    let rendered: ReturnType<typeof render> | undefined;
    act(() => {
      rendered = render(createElement(BusyLine));
    });

    let submitPromise!: Promise<void>;
    act(() => {
      submitPromise = controls!.submit('run two tools');
    });
    await waitFor(() => controls!.state.tools['tc-a']?.status === 'running', 'alpha running');
    alphaGate.release();
    await waitFor(() => controls!.state.tools['tc-b']?.status === 'running', 'bravo running');
    bravoGate.release();
    await act(async () => {
      await submitPromise;
    });
    await flush();

    // Both tools ran through the REAL executor (not a scripted tool-status shortcut).
    expect(runCalls).toHaveLength(2);

    const busy = (rendered!.frames as readonly string[]).filter((f) => f.includes('BUSY:'));
    const alphaIdx = busy.findIndex((f) => f.includes('running alpha'));
    const bravoIdx = busy.findIndex((f) => f.includes('running bravo'));
    expect(alphaIdx).toBeGreaterThanOrEqual(0); // tool 1 executed and was surfaced
    expect(bravoIdx).toBeGreaterThan(alphaIdx); // tool 2 executed strictly after tool 1

    // BETWEEN the two tool executions: no phantom 'thinking…'/'responding…' flash.
    const between = busy.slice(alphaIdx + 1, bravoIdx);
    for (const frame of between) {
      expect(frame).not.toContain('thinking…');
      expect(frame).not.toContain('responding…');
    }
    // React 19 may coalesce alpha-result and bravo-running into one commit. Whether
    // an intermediate `running tools…` frame exists is scheduler-dependent; any
    // frame that does exist between the two proven running states must stay honest.

    rendered!.unmount();
  });
});
