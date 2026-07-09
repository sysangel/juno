// tests/composerInput.test.tsx
// G (composer-input) — bracketed paste, input history, arrow-key coalescing, and
// the dead-Ctrl+M removal. Control bytes are built via String.fromCharCode so the
// intent survives verbatim in source (no literal ESC/CR/LF in the file).
import { useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App, INPUT_PLACEHOLDER } from '../src/app';
import type { AppDeps } from '../src/app';
import { InputBox } from '../src/ui/InputBox';
import { countArrowKeys, useKeybinds } from '../src/hooks/useKeybinds';
import type { State } from '../src/core/reducer';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press, waitFor, waitForFrame } from './helpers/ink';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const PASTE_OPEN = `${ESC}[200~`;
const PASTE_CLOSE = `${ESC}[201~`;
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = CR;

// The composer input is the LAST `❯` line — committed user messages in the
// transcript ALSO render with a `❯ ` prefix (Message.tsx), and they come first.
const composerLine = (frame: string): string =>
  frame.split('\n').filter((line) => line.includes('❯')).at(-1) ?? '';

// --------------------------------------------------------------------------
// Composer-level: bracketed paste assembly (real InputBox → real Composer).
// --------------------------------------------------------------------------

interface Hold {
  value: string;
  submits: string[];
}

function InputHarness({ hold }: { hold: Hold }): ReactElement {
  const [value, setValue] = useState('');
  hold.value = value;
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={(v) => hold.submits.push(v)}
      placeholder="type here"
      focus
    />
  );
}

describe('Composer bracketed paste (G)', () => {
  it('inserts a whole multiline paste as one value and does NOT submit', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();

    // A single-chunk bracketed paste with embedded newlines.
    await press(stdin, `${PASTE_OPEN}L1${LF}L2${LF}L3${PASTE_CLOSE}`);

    expect(hold.value).toBe(`L1${LF}L2${LF}L3`);
    // The embedded newlines must NOT have fired Enter.
    expect(hold.submits).toEqual([]);

    unmount();
  });

  it('assembles a paste whose markers/content span multiple chunks (no premature submit)', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();

    // Start marker + 'L1' in one chunk, then a bare CR, then 'L2', then the close
    // marker — the CR arrives as a return keypress but, inside an open paste, is
    // buffered as content, never a submit.
    await press(stdin, `${PASTE_OPEN}L1`);
    expect(hold.submits).toEqual([]);
    await press(stdin, CR);
    expect(hold.submits).toEqual([]);
    await press(stdin, 'L2');
    await press(stdin, PASTE_CLOSE);

    expect(hold.value).toBe(`L1${LF}L2`);
    expect(hold.submits).toEqual([]);

    unmount();
  });

  it('normalizes CRLF/CR in a paste to LF', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();

    await press(stdin, `${PASTE_OPEN}a${CR}${LF}b${CR}c${PASTE_CLOSE}`);

    expect(hold.value).toBe(`a${LF}b${LF}c`);
    expect(hold.submits).toEqual([]);

    unmount();
  });

  it('Enter OUTSIDE a paste still submits', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();

    await press(stdin, 'h');
    await press(stdin, 'i');
    await waitFor(() => hold.value === 'hi', { label: "composer shows 'hi'" });
    await press(stdin, ENTER);

    expect(hold.submits).toEqual(['hi']);

    unmount();
  });
});

// --------------------------------------------------------------------------
// App-level: '/'-leading paste is one plain message (never a slash command),
// input-history ring, and the dead-Ctrl+M characterization.
// --------------------------------------------------------------------------

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

function createRecordingClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn(input: TurnInput, _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<AgentEvent> {
      requests.push(input);
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return (async function* emptyStream(): AsyncGenerator<AgentEvent, void, unknown> {})();
    },
  };
  return { client, requests };
}

describe('App multiline paste routing (G)', () => {
  it('a "/"-leading multiline paste never opens the palette and submits as ONE plain message', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    const pasted = `/etc/hosts${LF}second line`;
    await press(stdin, `${PASTE_OPEN}${pasted}${PASTE_CLOSE}`);

    // The palette (its '/clear' row) must NOT be open — a paste is not the empty
    // single-'/' keystroke that seeds the slash overlay.
    expect(lastFrame() ?? '').not.toContain('/clear');
    // The paste itself did not submit.
    expect(requests).toHaveLength(0);

    // Enter now sends the whole multiline value as a single plain message — the
    // leading '/' does NOT route it through slash dispatch.
    await press(stdin, ENTER);
    await waitFor(() => requests.length === 1, { label: 'multiline message sent' });
    expect(requests[0]?.messages.at(-1)?.content).toBe(pasted);

    unmount();
  });
});

describe('App input history ring (G)', () => {
  it('Up recalls older, Down recalls newer, Down past newest restores the draft', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Submit two messages so the ring holds [one, two].
    for (const ch of 'one') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'one');
    for (const ch of 'two') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'two');

    // Type an in-progress draft, then navigate.
    for (const ch of 'dr') await press(stdin, ch);
    await waitFor(() => composerLine(lastFrame() ?? '').includes('dr'), { label: "draft 'dr'" });

    await press(stdin, UP); // → newest: 'two'
    await waitFor(() => composerLine(lastFrame() ?? '').includes('two'), { label: 'Up → two' });
    await press(stdin, UP); // → older: 'one'
    await waitFor(() => composerLine(lastFrame() ?? '').includes('one'), { label: 'Up → one' });
    await press(stdin, DOWN); // → newer: 'two'
    await waitFor(() => composerLine(lastFrame() ?? '').includes('two'), { label: 'Down → two' });
    await press(stdin, DOWN); // → past newest: restore draft 'dr'
    await waitFor(() => composerLine(lastFrame() ?? '').includes('dr'), { label: 'Down → draft' });

    unmount();
  });
});

describe('Dead Ctrl+M removal (G) — characterization', () => {
  // Ctrl+M physically transmits CR, which parseKeypress classifies as `return`, so
  // the old `key.ctrl && 'm'` binding was never reachable — removing it changes no
  // runtime behavior. This locks in the honest contract: Enter submits, the model
  // picker is reached only via /model.
  it('Enter submits and never opens the model picker; /model opens it', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    for (const ch of 'hey') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitFor(() => requests.length === 1, { label: 'Enter submitted' });
    expect(lastFrame() ?? '').not.toContain('models'); // no model picker

    // /model is still discoverable in the palette (the picker route survives).
    await press(stdin, '/');
    await waitForFrame(lastFrame, '/model');

    unmount();
  });
});

// --------------------------------------------------------------------------
// useKeybinds arrow coalescing.
// --------------------------------------------------------------------------

function KeybindsHarness({
  overlay,
  onMoveSlash,
}: {
  overlay: State['overlay'];
  onMoveSlash: (delta: number) => void;
}): ReactElement {
  useKeybinds({
    overlay,
    value: '',
    slashCommandCount: 9,
    modelCount: 0,
    onAbort: vi.fn(),
    onCycleEffort: vi.fn(),
    onOpenSlash: vi.fn(),
    onCloseOverlay: vi.fn(),
    onMoveSlash,
    onAcceptSlash: vi.fn(),
    onMoveModel: vi.fn(),
    onAcceptModel: vi.fn(),
  });
  return <Text>harness</Text>;
}

describe('useKeybinds arrow-key coalescing (G)', () => {
  it('countArrowKeys tallies every arrow sequence in a burst chunk', () => {
    expect(countArrowKeys(`${UP}${UP}${UP}`)).toEqual({ up: 3, down: 0 });
    expect(countArrowKeys(`${DOWN}${DOWN}`)).toEqual({ up: 0, down: 2 });
    expect(countArrowKeys(DOWN)).toEqual({ up: 0, down: 1 });
    expect(countArrowKeys('')).toEqual({ up: 0, down: 0 });
  });

  it('applies a 3-up burst as ONE move of -3 (not a single lost-repeat step)', async () => {
    const onMoveSlash = vi.fn();
    const { stdin, unmount } = render(<KeybindsHarness overlay="slash" onMoveSlash={onMoveSlash} />);
    await flushInk();

    await press(stdin, `${UP}${UP}${UP}`);

    expect(onMoveSlash).toHaveBeenCalledTimes(1);
    expect(onMoveSlash).toHaveBeenCalledWith(-3);

    unmount();
  });

  it('a single arrow still moves exactly one step', async () => {
    const onMoveSlash = vi.fn();
    const { stdin, unmount } = render(<KeybindsHarness overlay="slash" onMoveSlash={onMoveSlash} />);
    await flushInk();

    await press(stdin, DOWN);

    expect(onMoveSlash).toHaveBeenCalledTimes(1);
    expect(onMoveSlash).toHaveBeenCalledWith(1);

    unmount();
  });
});
