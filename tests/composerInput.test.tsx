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
import { isControlChord } from '../src/ui/Composer';
import { useKeybinds } from '../src/hooks/useKeybinds';
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
// Plain (unmodified) left arrow — Ink classifies ESC[D as `leftArrow`, moving the
// cursor -1. Used to displace the cursor WITHOUT Ctrl+A, so the readline motion
// tests stay independent of the very chord they are proving.
const LEFT = `${ESC}[D`;
const ENTER = CR;
// Ctrl+O transmits the raw C0 byte 0x0f (SI). useKeybinds consumes it to open the
// tool-detail overlay; the composer must never insert its letter/byte into the draft.
const CTRL_O = String.fromCharCode(15);
// DEL (0x7f) — Ink classifies it as `delete`; the composer deletes the char at the cursor.
const DEL = String.fromCharCode(127);
// Readline control bytes — Ink's parseKeypress maps a lone C0 byte 0x01–0x1a to
// `ctrl+<letter>` (input = the letter, key.ctrl = true). Named here so the intent
// survives verbatim without literal control chars in the source.
const CTRL_A = String.fromCharCode(1); // line start
const CTRL_E = String.fromCharCode(5); // line end
const CTRL_K = String.fromCharCode(11); // kill to line end
const CTRL_U = String.fromCharCode(21); // kill to line start
const CTRL_W = String.fromCharCode(23); // delete previous word
// xterm modified-arrow sequences: ESC [ 1 ; 5 <letter> is ctrl+arrow (modifier bit 4).
const CTRL_LEFT = `${ESC}[1;5D`;
const CTRL_RIGHT = `${ESC}[1;5C`;

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
// Composer chord filter (wave-10, composer lane): the Ctrl+O detail-toggle chord
// must never echo its letter into the input buffer. `isControlChord` is the pure
// seam that decides insertability; the mounted assertion is a POSITIVE final-state
// check on the buffer (never absence-of-repaint).
// --------------------------------------------------------------------------

describe('Composer chord filter (wave-10)', () => {
  it('isControlChord flags ctrl chords + raw C0 bytes, never printable text', () => {
    // Ink maps Ctrl+O to input 'o' with key.ctrl set…
    expect(isControlChord('o', { ctrl: true })).toBe(true);
    // …and some terminals pass the raw 0x0f byte through with key.ctrl UNSET.
    expect(isControlChord(CTRL_O, { ctrl: false })).toBe(true);
    expect(isControlChord(String.fromCharCode(0x7f), { ctrl: false })).toBe(true); // DEL
    // Printable text is NEVER a chord — it must still insert.
    expect(isControlChord('o', { ctrl: false })).toBe(false);
    expect(isControlChord('/', { ctrl: false })).toBe(false);
    expect(isControlChord(' ', { ctrl: false })).toBe(false); // space (0x20) is printable
    expect(isControlChord('é', { ctrl: false })).toBe(false); // a non-ASCII printable
  });

  it('a Ctrl+O chord never leaks its letter into the composer buffer', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();

    await press(stdin, 'x');
    await press(stdin, CTRL_O); // the detail-toggle chord — must be swallowed, not inserted
    await press(stdin, 'y');

    // Positive FINAL-state assertion: the buffer is EXACTLY the two typed letters. A leaked
    // chord would read 'xoy' (or 'x\x0fy'); the fix keeps it 'xy'. No absence-of-repaint.
    await waitFor(() => hold.value === 'xy', { label: "composer shows 'xy' (chord swallowed)" });
    expect(hold.value).toBe('xy');
    expect(hold.submits).toEqual([]); // the chord is not an Enter either

    unmount();
  });
});

// --------------------------------------------------------------------------
// Composer readline keys (wave-13, disc-3): the standard emacs/readline motion +
// kill set, all LINE-scoped for multiline drafts. Pure motions (Ctrl+A/E, word
// jumps) carry no value change, so they are proven by where a subsequently typed
// marker lands — a POSITIVE final-state assertion on hold.value, never
// absence-of-repaint.
// --------------------------------------------------------------------------

describe('Composer readline keys (wave-13)', () => {
  it('Ctrl+A jumps to line start — single-line and (line-scoped) multiline', async () => {
    const single: Hold = { value: '', submits: [] };
    const s = render(<InputHarness hold={single} />);
    await flushInk();
    await press(s.stdin, 'hello');
    await waitFor(() => single.value === 'hello', { label: "typed 'hello'" });
    await press(s.stdin, CTRL_A); // cursor 5 → 0
    await press(s.stdin, 'x');
    await waitFor(() => single.value === 'xhello', { label: 'Ctrl+A → start (xhello)' });
    s.unmount();

    // Multiline: Ctrl+A lands at the start of the CURRENT logical line, not the buffer.
    const multi: Hold = { value: '', submits: [] };
    const m = render(<InputHarness hold={multi} />);
    await flushInk();
    await press(m.stdin, `${PASTE_OPEN}foo${LF}bar${PASTE_CLOSE}`);
    await waitFor(() => multi.value === `foo${LF}bar`, { label: 'multiline draft pasted' });
    await press(m.stdin, CTRL_A); // cursor at end of 'bar' → start of the 'bar' line (offset 4)
    await press(m.stdin, 'x');
    await waitFor(() => multi.value === `foo${LF}xbar`, { label: 'Ctrl+A → line start (foo\\nxbar)' });
    m.unmount();
  });

  it('Ctrl+E jumps to line end — single-line and (line-scoped) multiline', async () => {
    // Displace the cursor with PLAIN LEFT arrows, never Ctrl+A: a full revert (whose
    // backstop swallows both chords) would then paint 'xhi' here, not 'hix', so the
    // test genuinely pins Ctrl+E rather than passing on an already-at-end cursor.
    const single: Hold = { value: '', submits: [] };
    const s = render(<InputHarness hold={single} />);
    await flushInk();
    await press(s.stdin, 'hi');
    await waitFor(() => single.value === 'hi', { label: "typed 'hi'" });
    await press(s.stdin, LEFT); // cursor 2 → 1
    await press(s.stdin, LEFT); // cursor 1 → 0
    await press(s.stdin, CTRL_E); // → end (offset 2)
    await press(s.stdin, 'x');
    await waitFor(() => single.value === 'hix', { label: 'Ctrl+E → end (hix)' });
    s.unmount();

    // Multiline: with the cursor parked INSIDE line 1, Ctrl+E must land at that line's
    // end (the '\n', offset 3), NOT the buffer end — proving the motion is line-scoped.
    // A buffer-scoped End would yield 'foo\nbarx'; a reverted backstop would yield
    // 'fxoo\nbar'. Only line-scoped Ctrl+E produces 'foox\nbar'.
    const multi: Hold = { value: '', submits: [] };
    const m = render(<InputHarness hold={multi} />);
    await flushInk();
    await press(m.stdin, `${PASTE_OPEN}foo${LF}bar${PASTE_CLOSE}`);
    await waitFor(() => multi.value === `foo${LF}bar`, { label: 'multiline draft pasted' });
    for (let i = 0; i < 6; i++) await press(m.stdin, LEFT); // cursor 7 → 1 (inside 'foo')
    await press(m.stdin, CTRL_E); // → end of the 'foo' line (offset 3, the newline)
    await press(m.stdin, 'x');
    await waitFor(() => multi.value === `foox${LF}bar`, { label: 'Ctrl+E → line end (foox\\nbar)' });
    m.unmount();
  });

  it('Ctrl+W deletes the previous word, bounded at the line start', async () => {
    // Cursor mid-buffer: 'foo bar |baz' → 'foo |baz' (removes 'bar ').
    const mid: Hold = { value: '', submits: [] };
    const a = render(<InputHarness hold={mid} />);
    await flushInk();
    await press(a.stdin, 'foo bar baz');
    await waitFor(() => mid.value === 'foo bar baz', { label: "typed 'foo bar baz'" });
    await press(a.stdin, CTRL_LEFT); // word-left over 'baz' → cursor before 'baz'
    await press(a.stdin, CTRL_W); // delete the trailing space + the word 'bar'
    await waitFor(() => mid.value === 'foo baz', { label: "Ctrl+W → 'foo baz'" });
    a.unmount();

    // Cursor at end with a trailing space: 'foo bar |' → 'foo |'.
    const end: Hold = { value: '', submits: [] };
    const b = render(<InputHarness hold={end} />);
    await flushInk();
    await press(b.stdin, 'foo bar ');
    await waitFor(() => end.value === 'foo bar ', { label: "typed 'foo bar '" });
    await press(b.stdin, CTRL_W);
    await waitFor(() => end.value === 'foo ', { label: "Ctrl+W → 'foo '" });
    b.unmount();
  });

  it('Ctrl+U kills from the line start to the cursor (line-scoped)', async () => {
    const single: Hold = { value: '', submits: [] };
    const s = render(<InputHarness hold={single} />);
    await flushInk();
    await press(s.stdin, 'hello');
    await waitFor(() => single.value === 'hello', { label: "typed 'hello'" });
    await press(s.stdin, CTRL_U);
    await waitFor(() => single.value === '', { label: 'Ctrl+U → empty' });
    s.unmount();

    // Multiline: Ctrl+U at the end of line 2 removes only line 2's content, keeping 'ab\n'.
    const multi: Hold = { value: '', submits: [] };
    const m = render(<InputHarness hold={multi} />);
    await flushInk();
    await press(m.stdin, `${PASTE_OPEN}ab${LF}cd${PASTE_CLOSE}`);
    await waitFor(() => multi.value === `ab${LF}cd`, { label: 'multiline draft pasted' });
    await press(m.stdin, CTRL_U); // cursor at end of 'cd' → kill back to the line start
    await waitFor(() => multi.value === `ab${LF}`, { label: 'Ctrl+U keeps line 1 (ab\\n)' });
    m.unmount();
  });

  it('Ctrl+K kills from the cursor to the line end (line-scoped)', async () => {
    // Multiline: Ctrl+A to the start of line 2, then Ctrl+K removes 'cd', keeping 'ab\n'.
    const multi: Hold = { value: '', submits: [] };
    const m = render(<InputHarness hold={multi} />);
    await flushInk();
    await press(m.stdin, `${PASTE_OPEN}ab${LF}cd${PASTE_CLOSE}`);
    await waitFor(() => multi.value === `ab${LF}cd`, { label: 'multiline draft pasted' });
    await press(m.stdin, CTRL_A); // → start of the 'cd' line
    await press(m.stdin, CTRL_K); // kill to line end (drops 'cd', keeps the newline)
    await waitFor(() => multi.value === `ab${LF}`, { label: 'Ctrl+K keeps line 1 (ab\\n)' });
    m.unmount();

    // Cursor on line 1 (not the last line) so lineEnd is the '\n', NOT value.length:
    // this pins line-scoping. From 'ab\ncd' end, four plain LEFTs land at offset 1
    // (mid line 1). Ctrl+K must stop at the newline → 'a\ncd'. A buffer-scoped kill
    // (value.slice(0, cursor) with no lineEnd bound) would wrongly yield 'a'.
    const inner: Hold = { value: '', submits: [] };
    const n = render(<InputHarness hold={inner} />);
    await flushInk();
    await press(n.stdin, `${PASTE_OPEN}ab${LF}cd${PASTE_CLOSE}`);
    await waitFor(() => inner.value === `ab${LF}cd`, { label: 'multiline draft pasted' });
    for (let i = 0; i < 4; i++) await press(n.stdin, LEFT); // cursor 5 → 1 (inside line 1)
    await press(n.stdin, CTRL_K); // kill to the line-1 end (drops 'b', keeps '\ncd')
    await waitFor(() => inner.value === `a${LF}cd`, { label: 'Ctrl+K line-scoped (a\\ncd)' });
    n.unmount();
  });

  it('Ctrl+Left jumps left by word over "foo bar baz"', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();
    await press(stdin, 'foo bar baz');
    await waitFor(() => hold.value === 'foo bar baz', { label: "typed 'foo bar baz'" });
    await press(stdin, CTRL_LEFT); // from end → before 'baz'
    await press(stdin, '|'); // a marker proves the offset
    await waitFor(() => hold.value === 'foo bar |baz', { label: 'Ctrl+Left → before baz' });
    unmount();
  });

  it('Ctrl+Right from the line start jumps to the end of the first word', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();
    await press(stdin, 'foo bar baz');
    await waitFor(() => hold.value === 'foo bar baz', { label: "typed 'foo bar baz'" });
    await press(stdin, CTRL_A); // → offset 0
    await press(stdin, CTRL_RIGHT); // → end of 'foo' (offset 3)
    await press(stdin, '|');
    await waitFor(() => hold.value === 'foo| bar baz', { label: 'Ctrl+Right → after foo' });
    unmount();
  });

  it('Ctrl+O still inserts nothing (an unclaimed chord stays swallowed by the backstop)', async () => {
    const hold: Hold = { value: '', submits: [] };
    const { stdin, unmount } = render(<InputHarness hold={hold} />);
    await flushInk();
    await press(stdin, 'a');
    await press(stdin, CTRL_O); // not a readline chord → the isControlChord backstop swallows it
    await press(stdin, 'b');
    await waitFor(() => hold.value === 'ab', { label: 'Ctrl+O swallowed (ab)' });
    expect(hold.submits).toEqual([]);
    unmount();
  });
});

// --------------------------------------------------------------------------
// App-level: '/'-leading paste is one plain message (never a slash command),
// input-history ring, and the dead-Ctrl+M characterization.
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

  it('records a plain line submitted with the slash palette OPEN in the history ring', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Open the slash palette (seeds '/'), then backspace the seed and type a PLAIN line.
    // The palette stays open (a null query lists every command), but the line no longer
    // leads with '/', so Enter routes it through the slash-overlay plain-submit path.
    await press(stdin, '/');
    await waitForFrame(lastFrame, '/clear'); // palette open
    await press(stdin, DEL); // remove the seed '/'
    for (const ch of 'plainmsg') await press(stdin, ch);
    await waitFor(() => composerLine(lastFrame() ?? '').includes('plainmsg'), { label: "composer 'plainmsg'" });

    await press(stdin, ENTER);
    // Sent exactly once as a plain message (not parsed as a command).
    await waitFor(() => requests.length === 1, { label: 'plain line sent' });
    expect(requests[0]?.messages.at(-1)?.content).toBe('plainmsg');

    // The fix: the slash-overlay plain-submit path now pushes to the ring, so Up recalls it.
    // (Pre-fix this path skipped pushHistory and Up recalled nothing.)
    await press(stdin, UP);
    await waitFor(() => composerLine(lastFrame() ?? '').includes('plainmsg'), {
      label: 'Up recalls the slash-overlay-submitted line',
    });

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

describe('useKeybinds repeated arrow input (G)', () => {
  it('applies every arrow in a burst (Ink 7 splits the input chunk)', async () => {
    const onMoveSlash = vi.fn();
    const { stdin, unmount } = render(<KeybindsHarness overlay="slash" onMoveSlash={onMoveSlash} />);
    await flushInk();

    await press(stdin, `${UP}${UP}${UP}`);

    expect(onMoveSlash).toHaveBeenCalledTimes(3);
    expect(onMoveSlash).toHaveBeenNthCalledWith(1, -1);
    expect(onMoveSlash).toHaveBeenNthCalledWith(2, -1);
    expect(onMoveSlash).toHaveBeenNthCalledWith(3, -1);

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
// App-level: a coalesced arrow burst LARGER than the picker list must clamp
// safely, not produce a negative index (finding F/G-1). The coalescing test
// above only bursts 3 vs a 9-command list, never crossing the list length.
// --------------------------------------------------------------------------

describe('App overlay clamp with a coalesced arrow burst longer than the list (F/G)', () => {
  it('an up-burst past the model list clamps safely instead of crashing', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Open the model picker via a typed /model + Enter. Selection starts at the
    // configured default 'claude-fable-5' (index 0 of BUILTIN_MODELS).
    await press(stdin, '/');
    for (const ch of 'model') await press(stdin, ch);
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'models');

    // 11 up-arrows in ONE chunk coalesce to a single move(-11) — a burst LONGER than
    // the list. With 7 models at index 0 the pre-fix `(i + d + n) % n` yields
    // (0 - 11 + 7) % 7 = -4 → models[-4] → TypeError → Ink render crash (this press
    // would REJECT). Sign-safe modulo wraps ((0 - 11) mod 7) = 3.
    await press(stdin, UP.repeat(11));

    const frame = lastFrame() ?? '';
    expect(frame).toContain('models'); // still rendering — no crash
    expect(selectedRow(frame)).toContain('Claude Fable 5');

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
    // paints as 'default' via its ?? fallback). Shared picker navigation clamps at index 0.
    await press(stdin, UP.repeat(3));

    expect(selectedRow(lastFrame() ?? '')).toContain('default');

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
