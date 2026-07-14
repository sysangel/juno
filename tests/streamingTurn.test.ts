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

  it('emits a compacted-with-counts notice on a successful manual /compact', async () => {
    const m = mountHook(fakeDeps({ client: summarizerClient('DENSE SUMMARY'), maxContext: 10_000 }));
    fillTranscript(m.controls, 6); // > MIN_MESSAGES_TO_COMPACT
    await flush();

    act(() => {
      m.controls().compactNow();
    });
    await waitFor(() => lastNoticeText(m.controls().state) !== undefined, 'compacted notice');

    expect(lastNoticeText(m.controls().state)).toMatch(
      /^compacted: \d+ messages → summary \(\d+ → \d+ tokens\)$/,
    );
    // A real compaction summary landed too (system text message from the reducer).
    expect(
      m.controls().state.committed.some(
        (msg) => msg.role === 'system' && msg.blocks.some((b) => b.kind === 'text'),
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
