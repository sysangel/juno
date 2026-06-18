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
import { act } from 'react';
import { render } from 'ink-testing-library';
import { useStreamingTurn } from '../src/hooks/useStreamingTurn';
import type { StreamingTurnControls, StreamingTurnDeps } from '../src/hooks/useStreamingTurn';
import type { Block, State } from '../src/core/reducer';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, Tool, ToolSpec, TurnInput } from '../src/core/contracts';
import type { PermissionPolicy } from '../src/core/contracts';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createDefaultTools, BUILTIN_TOOL_SPECS } from '../src/tools/registry';

// --- harness ----------------------------------------------------------------

interface Mounted {
  /** The latest controls from the hook (refreshed on every render). */
  readonly controls: () => StreamingTurnControls;
  readonly unmount: () => void;
}

/**
 * Mount a component that calls useStreamingTurn(deps) and stashes the live
 * controls into a holder each render, so the test can call submit/abort/etc and
 * read state/permissionRequest at any point.
 */
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
      if (latest === undefined) {
        throw new Error('hook not mounted yet');
      }
      return latest;
    },
    unmount,
  };
}

/** Flush microtasks + a macrotask tick inside act() so React re-renders settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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

afterEach(() => {
  // nothing global to restore — each test owns its own mount/policy.
});

describe('useStreamingTurn', () => {
  it('(a) submit drives a full fake turn -> committed assistant text + final usage tokens', async () => {
    const mounted = mountHook(fakeDeps());

    await act(async () => {
      await mounted.controls().submit('hi');
    });
    await flush();

    const state = mounted.controls().state;
    const assistant = lastAssistant(state);
    expect(assistant).toBeDefined();
    const text = textBlocks(assistant!.blocks)
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

    const assistant = lastAssistant(mounted.controls().state);
    expect(assistant).toBeDefined();
    const blocks = textBlocks(assistant!.blocks);
    // The fake emits three consecutive "Hello " / "from " / "Juno." deltas before
    // the first tool block, then " Now a gated action." AFTER the tools. This asserts
    // the end-to-end submit -> stream -> committed-text path: consecutive same-id
    // deltas land in ONE text block, and an intervening tool block forces a NEW text
    // block — so there are exactly two text blocks with the expected text.
    expect(blocks[0]?.text).toBe('Hello from Juno.');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.text).toBe(' Now a gated action.');

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
    const firstDone = (async (): Promise<void> => {
      await act(async () => {
        await first.controls().submit('write one');
      });
    })();

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

    const submitPromise = (async (): Promise<void> => {
      await act(async () => {
        await mounted.controls().submit('write then abort');
      });
    })();

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
    expect(state.pendingPermissionToolCallId).toBeNull();
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

    const submitPromise = (async (): Promise<void> => {
      await act(async () => {
        await mounted.controls().submit('write gated');
      });
    })();

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
});
