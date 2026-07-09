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

// The `▸` marker precedes the highlighted palette row (UnifiedCommandPalette); the
// selected row's primary text lives on the same rendered line.
const selectedRow = (frame: string): string =>
  frame.split('\n').find((line) => line.includes('▸')) ?? '';

// --------------------------------------------------------------------------
// App-level: a coalesced arrow burst LARGER than the picker list must wrap
// sign-safely, not produce a negative index (finding F/G-1). The coalescing test
// above only bursts 3 vs a 9-command list, never crossing the list length.
// --------------------------------------------------------------------------

describe('App overlay wrap with a coalesced arrow burst longer than the list (F/G)', () => {
  it('an up-burst past the model list wraps sign-safely instead of crashing', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Open the model picker via a typed /model + Enter. Selection starts at the
    // configured default 'gpt-4.1' (index 0 of BUILTIN_MODELS).
    await press(stdin, '/');
    for (const ch of 'model') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'models');

    // 8 up-arrows in ONE chunk coalesce to a single move(-8). With 6 models at index
    // 0 the pre-fix `(i + d + n) % n` yields (0 - 8 + 6) % 6 = -2 → models[-2] →
    // TypeError → Ink render crash (this press would REJECT). Sign-safe modulo wraps
    // ((0 - 8) mod 6) = 4.
    await press(stdin, UP.repeat(8));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('models'); // still rendering — no crash
    expect(selectedRow(frame)).toContain('Claude Sonnet 4 via OpenRouter'); // models[4]

    unmount();
  });

  it('an up-burst past the permission-mode list stores a valid mode, never undefined', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    await press(stdin, '/');
    for (const ch of 'permissions') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'permission mode');

    // PERMISSION_MODES has 2 entries; selection starts at 'default' (index 0). A 3-up
    // burst under the pre-fix modulo gives (0 - 3 + 2) % 2 = -1 → PERMISSION_MODES[-1]
    // === undefined (which accept would dispatch as an undefined mode, and the picker
    // paints as 'default' via its ?? fallback). Sign-safe wrap lands on index 1.
    await press(stdin, UP.repeat(3));

    expect(selectedRow(lastFrame() ?? '')).toContain('acceptEdits');

    unmount();
  });
});

// --------------------------------------------------------------------------
// App-level: the palette accept path (Enter → acceptSlash) must respect paste /
// multiline state — the shared root cause of findings F/G-2 and F/G-3. Both cases
// end in the same failure on df5bc24: /clear (the default highlight) fires and wipes
// the transcript. The fix makes acceptSlash newline-aware AND useKeybinds
// paste-aware, so a pasted or multiline value never mis-routes to command dispatch.
// --------------------------------------------------------------------------

describe('App palette accept respects paste/multiline state (F/G)', () => {
  it('Enter on a "/"-leading MULTILINE value in the open palette submits once and runs no command', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Palette open (seeds '/'), then paste 'clear\nfoo' after it → value '/clear\nfoo'.
    await press(stdin, '/');
    await press(stdin, `${PASTE_OPEN}clear${LF}foo${PASTE_CLOSE}`);
    await waitFor(() => (lastFrame() ?? '').includes('foo'), { label: 'multiline pasted into composer' });

    await press(stdin, ENTER);

    // Pre-fix acceptSlash parsed '/clear\nfoo' → 'clear' and ran /clear on the SAME
    // Enter that submit() sent the text, aborting + wiping the just-sent turn. The
    // newline guard routes both listeners to the plain-submit path (deduped): the
    // text is sent exactly once and /clear never fires.
    await waitFor(() => requests.length === 1, { label: 'multiline message sent once' });
    expect(requests[0]?.messages.at(-1)?.content).toBe(`/clear${LF}foo`);
    expect(lastFrame() ?? '').not.toContain('session cleared');

    unmount();
  });

  it('a bare CR chunk mid-paste in the open palette does NOT fire the highlighted command', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    await press(stdin, '/'); // palette open; default highlight is /clear

    // A chunk-split paste whose middle chunk is a bare CR (parses as Enter). Pre-fix,
    // useKeybinds — blind to Composer's paste buffer — saw the CR as return and ran
    // the highlighted /clear MID-paste (abort + transcript wipe). The shared paste
    // flag makes useKeybinds ignore keys while the paste is still assembling.
    await press(stdin, `${PASTE_OPEN}L1`);
    await press(stdin, CR);
    await press(stdin, 'L2');
    await press(stdin, PASTE_CLOSE);

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('session cleared'); // /clear never fired mid-paste
    expect(requests).toHaveLength(0); // nothing submitted
    // The palette is still open — the paste assembled onto the seed as '/L1\nL2'.
    expect(frame).toContain('commands');

    unmount();
  });
});
