// tests/resumedTurnSpinner.test.tsx
// Wave-3 UX — resumed-turn spinner gap. The activity indicator must mount
// OPTIMISTICALLY at submit time (before the provider's `assistant-start`), so a
// --resume turn — whose start event is DEFERRED to its first content, ~1.7-2.2s —
// shows the busy line as promptly as a fresh turn. The real, phase-derived activity
// then takes over on `assistant-start` with a seamless handover (no double spinner,
// no orphan glyph), and the indicator CLEARS on a failed turn start rather than
// lingering. Esc-to-abort must work throughout the optimistic window.
//
// Drives the REAL App seams: the InputBox onSubmit (app.submit → runSubmit →
// turn.submit) and useKeybinds (Esc via ink stdin). The InputBox is mocked (the
// established pattern) so the LiveTurn line is inspected in the rendered frame while
// a gated client holds `assistant-start` back to expose the pre-start window.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, waitFor } from './helpers/ink';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
  readonly focus?: boolean;
}

const inputBoxMock = vi.hoisted(() => ({
  latestProps: null as CapturedInputBoxProps | null,
}));

vi.mock('../src/ui/InputBox', () => ({
  InputBox: (props: CapturedInputBoxProps) => {
    inputBoxMock.latestProps = props;
    return <Text>mock-input</Text>;
  },
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ESC = String.fromCharCode(27);

function props(): CapturedInputBoxProps {
  const p = inputBoxMock.latestProps;
  if (p === null) {
    throw new Error('InputBox props were not captured');
  }
  return p;
}

/** Fire the composer's onSubmit with `value`, flushing the resulting re-render. */
async function submitComposer(value: string): Promise<void> {
  await act(async () => {
    props().onSubmit(value);
    await tick();
  });
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
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

/** Number of LiveTurn busy lines in a frame — one 'esc to abort' hint per line, so a
 * count > 1 would be a double-spinner regression. */
function busyLineCount(frame: string): number {
  return frame.split('esc to abort').length - 1;
}

/**
 * A client that DEFERS its whole stream behind a release gate — modelling the
 * --resume path where `assistant-start` does not arrive until the first content
 * event. While the gate is closed the turn is in flight but has emitted nothing, so
 * the reducer phase is still `idle`: exactly the pre-start window the optimistic
 * indicator exists to fill. `events` is the script yielded once released. Records
 * whether the turn was entered and whether the abort signal fired.
 */
function makeGatedClient(events: (input: TurnInput) => AgentEvent[]): {
  client: ModelClient;
  release: () => void;
  observedAbort: () => boolean;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observedAbort = false;
  const client: ModelClient = {
    streamTurn(input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      return (async function* (): AsyncGenerator<AgentEvent, void, unknown> {
        // Park until released OR aborted — assistant-start is withheld the whole time.
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
        if (signal.aborted) {
          observedAbort = true;
          yield { type: 'aborted' };
          return;
        }
        for (const event of events(input)) {
          if (signal.aborted) {
            observedAbort = true;
            return;
          }
          yield event;
        }
      })();
    },
  };
  return { client, release, observedAbort: () => observedAbort };
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('resumed-turn spinner — optimistic mount', () => {
  it('shows the busy line at submit BEFORE assistant-start (the resumed-turn gap)', async () => {
    const { client, release } = makeGatedClient((input) => [
      { type: 'assistant-start', id: input.id },
      { type: 'text-delta', id: input.id, delta: 'Hello.' },
      { type: 'assistant-done', id: input.id, stopReason: 'end' },
    ]);
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Submit a turn. The gated client withholds assistant-start, so the reducer phase
    // stays 'idle' — the ONLY thing that can be showing the busy line is the optimistic
    // mount at submit time.
    await submitComposer('resume me');

    const gap = lastFrame() ?? '';
    expect(gap).toContain('thinking…');
    expect(gap).toContain('esc to abort');
    // Exactly ONE busy line — no double spinner.
    expect(busyLineCount(gap)).toBe(1);

    // Release: the real stream drives the turn to completion, and the indicator clears.
    release();
    await waitFor(() => !(lastFrame() ?? '').includes('esc to abort'), {
      label: 'indicator cleared after the turn completed',
    });
    expect(lastFrame() ?? '').toContain('Hello.');

    unmount();
  });

  it('hands over to the real activity on assistant-start with a single busy line (no double spinner)', async () => {
    // Two-stage: release lets the client emit assistant-start + prose, then it parks
    // again so the mid-stream frame can be inspected. The real phase-derived activity
    // must OWN the line ('responding…' once prose exists) — still exactly one line.
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const { client, release } = makeGatedClient((input) => [
      { type: 'assistant-start', id: input.id },
      { type: 'text-delta', id: input.id, delta: 'Working on it' },
    ]);
    // Wrap the client so that after its scripted events it parks on `hold` (kept
    // in-flight) until we release it, then completes.
    const holdingClient: ModelClient = {
      async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal) {
        for await (const event of client.streamTurn(input, tools, signal)) {
          yield event;
        }
        await hold;
        yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
      },
    };

    const { lastFrame, unmount } = render(<App deps={fakeDeps(holdingClient)} />);
    await flushInk();

    await submitComposer('go');
    // Optimistic window: thinking, one line.
    expect(lastFrame() ?? '').toContain('thinking…');
    expect(busyLineCount(lastFrame() ?? '')).toBe(1);

    // Release the gate → assistant-start + prose stream. Real activity takes over.
    release();
    await waitFor(() => (lastFrame() ?? '').includes('responding…'), {
      label: 'real activity (responding…) took over from the optimistic line',
    });
    const handover = lastFrame() ?? '';
    // Still exactly one busy line — the optimistic line did not survive alongside the
    // real one (no double spinner, no orphan glyph).
    expect(busyLineCount(handover)).toBe(1);
    expect(handover).toContain('responding…');

    // Finish the turn → the line clears.
    releaseHold();
    await waitFor(() => !(lastFrame() ?? '').includes('esc to abort'), {
      label: 'indicator cleared at turn end',
    });

    unmount();
  });

  it('CLEARS the optimistic indicator when the turn FAILS to start (spawn/immediate error)', async () => {
    // Mirrors claudeCliClient's failed-start emission: an `error` event followed by a
    // terminal assistant-done. No real activity is ever produced, so the optimistic
    // flag must be cleared by the submit-settle path, not left spinning.
    const { client, release } = makeGatedClient((input) => [
      { type: 'error', message: 'claude spawn failed: ENOENT' },
      { type: 'assistant-done', id: input.id, stopReason: 'error' },
    ]);
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    await submitComposer('resume me');
    // The optimistic line IS shown during the pre-start gap (non-vacuous).
    expect(lastFrame() ?? '').toContain('thinking…');
    expect(lastFrame() ?? '').toContain('esc to abort');

    // Release → the turn immediately errors before any assistant-start.
    release();
    await waitFor(() => (lastFrame() ?? '').includes('claude spawn failed'), {
      label: 'error surfaced in the transcript',
    });
    // The indicator must be GONE — a failed start does not leave a lingering spinner.
    await waitFor(() => !(lastFrame() ?? '').includes('esc to abort'), {
      label: 'optimistic indicator cleared on failed turn start',
    });
    expect(lastFrame() ?? '').not.toContain('thinking…');

    unmount();
  });

  it('Esc aborts during the optimistic window (before assistant-start)', async () => {
    const { client, release, observedAbort } = makeGatedClient((input) => [
      { type: 'assistant-start', id: input.id },
      { type: 'assistant-done', id: input.id, stopReason: 'end' },
    ]);
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    await submitComposer('resume me');
    // In the optimistic window: busy line up, phase still idle (no assistant-start yet).
    expect(lastFrame() ?? '').toContain('esc to abort');

    // Esc → useKeybinds.onAbort → turn.abort → controller.abort. The controller was
    // taken at submit time, so the abort lands even though assistant-start never came.
    await act(async () => {
      stdin.write(ESC);
      await tick();
    });

    await waitFor(() => observedAbort(), {
      label: 'the turn observed the abort signal during the optimistic window',
    });
    // The indicator clears once the aborted turn settles — no lingering spinner.
    await waitFor(() => !(lastFrame() ?? '').includes('esc to abort'), {
      label: 'indicator cleared after abort',
    });

    // Guard against a stuck controller: the gate is still closed, but abort released it.
    release();
    unmount();
  });
});
