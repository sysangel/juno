// tests/useStableCallback.test.tsx
// b3 render-efficiency item 3 — the useStableCallback trampoline + its acceptance
// criterion: the memoized InputBox no longer re-renders on a mid-turn token flush,
// because app.tsx now feeds STABLE-identity onChange/onSubmit props.
//
//   1. useStableCallback keeps a stable identity across re-renders AND always calls the
//      LATEST closure (unit).
//   2. Render the REAL App and compare InputBox's render count for a STREAMING turn against
//      an otherwise-identical turn that streams ZERO text-deltas. Equal counts prove the
//      mid-turn flushes contribute ZERO InputBox renders (the composer's memo bails on every
//      flush because onChange/onSubmit are now stabilized). With the trampoline reverted,
//      onChange/onSubmit re-identify on every App render, so each flush commit re-renders
//      InputBox and the streaming count EXCEEDS the delta-free baseline.
import { describe, it, expect, vi } from 'vitest';
import {
  createElement,
  memo,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { render } from 'ink-testing-library';
import { useStableCallback } from '../src/hooks/useStableCallback';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';

// --- module-level InputBox render counter, incremented by the mock wrapper ----
let inputBoxRenders = 0;

// Wrap the REAL InputBox in a memo() with the SAME default shallow-compare, so this
// wrapper's render count is a faithful proxy for how often App feeds InputBox CHANGED
// props (identical props ⇒ both this wrapper and the inner memo bail). ComposerRule and
// every other export are preserved so app.tsx's imports are unaffected.
vi.mock('../src/ui/InputBox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/InputBox')>();
  const Counted = memo(function CountedInputBox(
    props: ComponentProps<typeof actual.InputBox>,
  ): ReactElement {
    inputBoxRenders += 1;
    return createElement(actual.InputBox, props);
  });
  return { ...actual, InputBox: Counted };
});

// These imports must come AFTER the vi.mock call textually; vitest hoists vi.mock above
// them regardless, so App resolves the mocked InputBox.
import { App, type AppDeps } from '../src/app';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService, type Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press, waitForFrame } from './helpers/ink';

describe('useStableCallback (b3 item 3, trampoline)', () => {
  it('keeps a stable identity across re-renders and always invokes the LATEST fn', () => {
    const calls: number[] = [];
    let stable: (() => number) | undefined;

    function Harness({ fn }: { fn: () => number }): null {
      stable = useStableCallback(fn);
      return null;
    }

    const { rerender, unmount } = render(<Harness fn={() => { calls.push(1); return 1; }} />);
    const first = stable;
    expect(first).toBeDefined();

    // Re-render with a DIFFERENT closure.
    rerender(<Harness fn={() => { calls.push(2); return 2; }} />);
    // Identity is stable across the re-render (this is what lets InputBox's memo bail).
    expect(stable).toBe(first);

    // Invoking the stable callback runs the LATEST fn (not the one captured at first render)
    // and forwards its return value.
    const ret = stable!();
    expect(ret).toBe(2);
    expect(calls).toEqual([2]);

    unmount();
  });
});

// --- App-level acceptance: InputBox render count is invariant to the delta count -------

function fakeSettings(): Settings {
  return {
    defaultProvider: 'claude-cli',
    defaultModel: 'claude-fable-5',
    cwd: '/work',
    maxContext: 200_000,
  };
}

function fakeDeps(client: ModelClient): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
}

/**
 * A client that streams `n` text-deltas (each a mid-turn flush), then a parent `usage`
 * event, then ends the turn. `usage` measures the context window (→ the `ctx ` chip) and
 * is the completion signal for BOTH the streaming (n>0) and the delta-free (n=0) run: it
 * is a NON-delta action, so it commits identically in both, and the two runs are byte-
 * identical EXCEPT for the mid-turn text-delta flush(es). n=0 streams ZERO deltas.
 */
function streamClient(n: number): ModelClient {
  return {
    async *streamTurn(_input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: 'a1' };
      for (let k = 0; k < n; k += 1) {
        if (signal.aborted) return;
        yield { type: 'text-delta', id: 'a1', delta: 'x' };
        await Promise.resolve();
      }
      yield { type: 'usage', tokensIn: 120, tokensOut: 48 };
      yield { type: 'assistant-done', id: 'a1', stopReason: 'end' };
    },
  };
}

/** Mount App, submit one message via stdin, drive the turn to completion (the `ctx ` chip,
 *  emitted by the shared usage event, is the completion marker for BOTH runs), and return
 *  how many times the InputBox render fn ran across the whole run. */
async function inputBoxRendersForTurn(deltaCount: number): Promise<number> {
  inputBoxRenders = 0;
  const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(streamClient(deltaCount))} />);
  await flushInk();
  // Identical typing/submit across runs (so those legit renders cancel in the comparison).
  await press(stdin, 'hi');
  await press(stdin, '\r');
  // The `ctx ` chip appears once the usage event measures the window; by then the streaming
  // run's mid-turn flush(es) have already committed, and the post-usage tail (assistant-done)
  // is identical in both runs.
  await waitForFrame(lastFrame, 'ctx ');
  const count = inputBoxRenders;
  unmount();
  return count;
}

describe('InputBox memo — a streaming turn adds ZERO InputBox renders over a delta-free turn (b3 item 3)', () => {
  it('streams 12 deltas and re-renders InputBox the SAME number of times as a turn streaming ZERO deltas', async () => {
    // Baseline: an identical submit → turn → completion that streams ZERO text-deltas
    // (assistant-start, usage, assistant-done). Its InputBox renders come ONLY from the
    // mount + typing 'hi' + the submit-clear — none from streaming.
    const zeroDeltas = await inputBoxRendersForTurn(0);
    // The SAME run but streaming 12 text-deltas: each ~16ms flush is an extra App commit.
    const streaming = await inputBoxRendersForTurn(12);

    // The acceptance criterion: the streaming flushes contribute EXACTLY ZERO extra InputBox
    // renders, because app.tsx now feeds STABLE-identity onChange/onSubmit (useStableCallback),
    // so the composer's memo bails on every mid-turn flush. Comparing against the delta-free
    // baseline — rather than a bare magic bound — isolates the streaming-flush contribution to
    // zero. Revert the trampoline and onChange/onSubmit re-identify on every App render, so
    // each mid-turn flush commit re-renders InputBox and `streaming` EXCEEDS `zeroDeltas`.
    expect(streaming).toBe(zeroDeltas);
  });
});
