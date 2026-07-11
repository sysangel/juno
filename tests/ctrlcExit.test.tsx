// tests/ctrlcExit.test.tsx
// Double-press Ctrl+C interrupt/exit (useCtrlCExit).
//
// Two layers:
//   1. decideCtrlC — the PURE state machine (no Ink, no timers): first/second
//      press, busy-vs-idle branching, and the second-press window boundary.
//   2. <App> integration — drives the REAL useInput/stdin seam with a \x03 byte
//      (ink-testing-library renders with exitOnCtrlC:false, so the hook — not
//      Ink — owns ctrl+c) and asserts the end-to-end behaviour: abort while
//      streaming keeps the app alive; idle clears input + arms the hint; a
//      second press within the window invokes the GRACEFUL quit path (an
//      injected exit spy standing in for useApp().exit — NOT a process.exit);
//      the window lapse and any other key disarm.
//
// Timing is driven by an INJECTED clock (deps.clock), not vi.useFakeTimers():
// fake timers stall Ink's effect scheduler (the `act`/tick helper), so a mutable
// `now` is the deterministic way to move the second-press window. The exit
// DECISION is a pure Date.now() comparison, so this fully controls it.
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { AppDeps } from '../src/app';
import {
  decideCtrlC,
  CTRLC_WINDOW_MS,
  CTRLC_HINT_EXIT,
  CTRLC_HINT_INTERRUPTED,
} from '../src/hooks/useCtrlCExit';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press, waitFor, waitForFrame } from './helpers/ink';

const CTRL_C = String.fromCharCode(3); // \x03 (ETX) → ink parses as { name:'c', ctrl:true }
const ENTER = String.fromCharCode(13);

// The composer input is the LAST `❯` line (committed user messages share the glyph).
const composerLine = (frame: string): string =>
  frame.split('\n').filter((line) => line.includes('❯')).at(-1) ?? '';

// --------------------------------------------------------------------------
// 1. Pure state machine — decideCtrlC
// --------------------------------------------------------------------------
describe('decideCtrlC — Ctrl+C state machine (pure)', () => {
  const W = CTRLC_WINDOW_MS;

  it('first press while a turn is in flight → abort (app stays alive), interrupted hint', () => {
    expect(
      decideCtrlC({ lastPressAt: null, now: 1000, windowMs: W, isBusy: true, hasValue: false }),
    ).toEqual({ action: 'abort', hint: CTRLC_HINT_INTERRUPTED });
  });

  it('first press while idle WITH input text → clear-input, exit hint', () => {
    expect(
      decideCtrlC({ lastPressAt: null, now: 1000, windowMs: W, isBusy: false, hasValue: true }),
    ).toEqual({ action: 'clear-input', hint: CTRLC_HINT_EXIT });
  });

  it('first press while idle with EMPTY input → arm only, exit hint', () => {
    expect(
      decideCtrlC({ lastPressAt: null, now: 1000, windowMs: W, isBusy: false, hasValue: false }),
    ).toEqual({ action: 'arm', hint: CTRLC_HINT_EXIT });
  });

  it('second press strictly inside the window → exit (regardless of busy/value)', () => {
    expect(
      decideCtrlC({ lastPressAt: 1000, now: 1000 + W - 1, windowMs: W, isBusy: true, hasValue: true }),
    ).toEqual({ action: 'exit', hint: '' });
  });

  it('second press AT/BEYOND the window boundary → treated as a fresh first press (no exit)', () => {
    // Exactly at the boundary is NOT armed (strict <).
    expect(
      decideCtrlC({ lastPressAt: 1000, now: 1000 + W, windowMs: W, isBusy: false, hasValue: false }),
    ).toEqual({ action: 'arm', hint: CTRLC_HINT_EXIT });
    // Well past the window → first-press semantics resume.
    expect(
      decideCtrlC({ lastPressAt: 1000, now: 1000 + W + 500, windowMs: W, isBusy: true, hasValue: false }),
    ).toEqual({ action: 'abort', hint: CTRLC_HINT_INTERRUPTED });
  });
});

// --------------------------------------------------------------------------
// 2. <App> integration — the real stdin/useInput seam
// --------------------------------------------------------------------------
function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'claude-cli',
    defaultModel: 'claude-fable-5',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient, extra: Partial<AppDeps> = {}): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
    ...extra,
  };
}

/**
 * A client that streams a marker of partial text and then HANGS until its turn
 * is aborted. Keeps the turn `isBusy()` in a stable, race-free state so the abort
 * press has a deterministic target, and records that the provider request's
 * AbortSignal actually fired (the provider-cancel half of the interrupt).
 */
function createHangingClient(): { client: ModelClient; wasAborted: () => boolean } {
  let aborted = false;
  const client: ModelClient = {
    async *streamTurn(
      _input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: 'turn-1' };
      yield { type: 'text-delta', id: 'turn-1', delta: 'PARTIAL_STREAM_TEXT' };
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  return { client, wasAborted: () => aborted };
}

/** Empty-stream client for idle-state tests (no turn is ever driven). */
function createIdleClient(): ModelClient {
  return {
    streamTurn(): AsyncIterable<AgentEvent> {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return (async function* empty(): AsyncGenerator<AgentEvent, void, unknown> {})();
    },
  };
}

describe('App Ctrl+C — first press while STREAMING aborts but the app stays alive', () => {
  it('cancels the in-flight turn (provider signal fires), surfaces the interrupt hint, and does NOT exit', async () => {
    const { client, wasAborted } = createHangingClient();
    const onExit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, { onExit })} />);
    await flushInk();

    // Drive a turn: type + Enter → the hanging client streams partial text then parks.
    for (const ch of 'hi') await press(stdin, ch); // eslint-disable-line no-await-in-loop
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'PARTIAL_STREAM_TEXT'); // the turn is now in flight

    // First Ctrl+C → abort. The "interrupted" hint proves the press was routed to
    // the abort branch (isBusy() was true at press time).
    await press(stdin, CTRL_C);
    await waitForFrame(lastFrame, CTRLC_HINT_INTERRUPTED);

    // The provider request's AbortSignal actually fired (turn.abort → controller.abort).
    await waitFor(() => wasAborted(), { label: 'provider AbortSignal fired' });

    // App is still alive: the composer is still rendered and NO exit happened.
    expect(composerLine(lastFrame() ?? '')).toContain('❯');
    expect(onExit).not.toHaveBeenCalled();

    unmount();
  });
});

describe('App Ctrl+C — first press while IDLE clears the input and arms the exit hint', () => {
  it('wipes the composer text, shows the exit hint, and does NOT exit', async () => {
    const client = createIdleClient();
    const onExit = vi.fn();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, { onExit })} />);
    await flushInk();

    for (const ch of 'draft text') await press(stdin, ch); // eslint-disable-line no-await-in-loop
    await waitFor(() => composerLine(lastFrame() ?? '').includes('draft text'), {
      label: 'composer holds the typed draft',
    });

    await press(stdin, CTRL_C);
    await waitForFrame(lastFrame, CTRLC_HINT_EXIT);

    // Input cleared, hint armed, still alive.
    expect(composerLine(lastFrame() ?? '')).not.toContain('draft text');
    expect(onExit).not.toHaveBeenCalled();

    unmount();
  });
});

describe('App Ctrl+C — second press within the window exits via the graceful quit path', () => {
  it('invokes the injected exit (useApp().exit stand-in), NOT a raw process.exit', async () => {
    const client = createIdleClient();
    const onExit = vi.fn();
    // Constant clock → the two presses are 0ms apart, well inside the window.
    const { stdin, unmount } = render(
      <App deps={fakeDeps(client, { onExit, clock: () => 5_000 })} />,
    );
    await flushInk();

    await press(stdin, CTRL_C); // arm
    expect(onExit).not.toHaveBeenCalled();
    await press(stdin, CTRL_C); // exit

    await waitFor(() => onExit.mock.calls.length === 1, { label: 'graceful exit invoked once' });
    expect(onExit).toHaveBeenCalledTimes(1);

    unmount();
  });
});

describe('App Ctrl+C — the second-press window lapses (disarm by time)', () => {
  it('a Ctrl+C after the window has elapsed is a fresh first press, not an exit', async () => {
    const client = createIdleClient();
    const onExit = vi.fn();
    let nowMs = 10_000;
    const { stdin, lastFrame, unmount } = render(
      <App deps={fakeDeps(client, { onExit, clock: () => nowMs })} />,
    );
    await flushInk();

    await press(stdin, CTRL_C); // arm at t=10_000
    await waitForFrame(lastFrame, CTRLC_HINT_EXIT);

    // Advance the injected clock PAST the window before the second press.
    nowMs = 10_000 + CTRLC_WINDOW_MS + 1;
    await press(stdin, CTRL_C); // t is now beyond the window → re-arm, do NOT exit

    // Give any (erroneous) exit a chance to land, then assert it never did.
    await flushInk();
    expect(onExit).not.toHaveBeenCalled();
    // Still armed (fresh hint present), app alive.
    expect(lastFrame() ?? '').toContain(CTRLC_HINT_EXIT);

    unmount();
  });
});

describe('App Ctrl+C — any other key disarms the window', () => {
  it('a keystroke between the two presses cancels the armed exit', async () => {
    const client = createIdleClient();
    const onExit = vi.fn();
    // Constant clock: if disarm did NOT happen, the second press (0ms later) would
    // be inside the window and exit — so onExit-not-called cleanly proves disarm.
    const { stdin, unmount } = render(
      <App deps={fakeDeps(client, { onExit, clock: () => 7_000 })} />,
    );
    await flushInk();

    await press(stdin, CTRL_C); // arm
    await press(stdin, 'x'); // any other key → disarm
    await press(stdin, CTRL_C); // would exit IF still armed; must not

    await flushInk();
    expect(onExit).not.toHaveBeenCalled();

    unmount();
  });
});

// The hint line is absent on a fresh mount (no ctrl+c pressed yet) — it must not
// perturb the base layout.
describe('App Ctrl+C — no hint line before any press', () => {
  it('does not render the exit hint on a fresh mount', async () => {
    const { lastFrame, unmount } = render(
      <App deps={fakeDeps(createFakeModelClient({ tickMs: 0 }))} />,
    );
    await flushInk();
    expect(lastFrame() ?? '').not.toContain(CTRLC_HINT_EXIT);
    unmount();
  });
});
