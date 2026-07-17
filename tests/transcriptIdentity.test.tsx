// tests/transcriptIdentity.test.tsx
// Wave-1 item E (transcript-identity). The transcript drops the literal
// `user`/`assistant` label lines: a user turn is identified by a `❯ ` prefix in
// dim gray (composer continuity, NOT the old yellow roleUser tint), assistant
// prose is unlabeled default text, and code blocks render at NORMAL prose
// brightness (never dimmer than surrounding prose). Each assertion fails on the
// pre-wave code (bold role headings, yellow user text, dim code blocks).
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import type { Msg } from '../src/core/reducer';
import { Message } from '../src/ui/Message';
import { Transcript } from '../src/ui/Transcript';
import { Markdown } from '../src/ui/MarkdownView';

// Colour assertions are only meaningful when ink actually emits SGR escapes. In
// the vitest env supports-color reports level 0 (ink emits nothing), so force
// chalk to a real level for THIS file; the depth="ansi16" renders then carry the
// named-16 colour codes (yellowBright=93, white=37, whiteBright=97, dim=2).
let priorChalkLevel: typeof chalk.level;
beforeAll(() => {
  priorChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = priorChalkLevel;
});

// SGR escapes emitted by chalk for the ansi16 downsample targets used below.
const YELLOW_BRIGHT = '\x1b[93m'; // old roleUser user-text tint (#E6DB74)
const WHITE = '\x1b[37m'; // textDim downsample (#8F908A) — dim gray
const WHITE_BRIGHT = '\x1b[97m'; // text downsample (#F8F8F2) — prose brightness
const DIM = '\x1b[2m'; // dimColor attribute

/** The rendered line (ANSI escapes included) that carries a substring, or ''. */
const lineWith = (frame: string, needle: string): string =>
  frame.split('\n').find((line) => line.includes(needle)) ?? '';

/** Strip SGR escapes so text content can be matched word-boundary-exactly. */
// eslint-disable-next-line no-control-regex
const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;]*m/g, '');

const userMsg: Msg = {
  id: 'u1',
  role: 'user',
  done: true,
  blocks: [{ kind: 'text', id: 'u1:block:1', text: 'greetings juno' }],
};

const asstMsg: Msg = {
  id: 'a1',
  role: 'assistant',
  done: true,
  blocks: [{ kind: 'text', id: 'a1:block:1', text: 'acknowledged' }],
};

describe('transcript-identity (E) — no role labels', () => {
  it('renders a user + assistant transcript with NO bare user/assistant label lines', () => {
    const frame = render(<Transcript committed={[userMsg, asstMsg]} depth="ansi16" />).lastFrame() ?? '';
    const text = plain(frame);
    // The message CONTENT is still present…
    expect(text).toContain('greetings juno');
    expect(text).toContain('acknowledged');
    // …but the literal role-label headings are gone (old code drew bold `user` /
    // `assistant` lines above each message).
    expect(text).not.toMatch(/\buser\b/);
    expect(text).not.toMatch(/\bassistant\b/);
  });
});

describe('transcript-identity (E) + echo-brightness — dim `❯` marker, text at prose brightness', () => {
  it('keeps the ❯ marker dim gray but renders the echoed user text at normal foreground (no double-dim)', () => {
    const frame = render(<Message msg={userMsg} depth="ansi16" />).lastFrame() ?? '';
    const line = lineWith(frame, 'greetings juno');
    expect(line).not.toBe('');
    // Composer-continuity prompt marker precedes the text; content unchanged.
    expect(plain(line)).toContain('❯ greetings juno');
    // The line carries the old yellow roleUser tint nowhere.
    expect(line).not.toContain(YELLOW_BRIGHT);
    // Split the line at the text token's brightness escape: everything before is the
    // `❯ ` marker, everything from it on is the echoed text.
    const cut = line.lastIndexOf(WHITE_BRIGHT);
    expect(cut).toBeGreaterThan(-1);
    const marker = line.slice(0, cut);
    const echoedText = line.slice(cut);
    // Marker stays dim gray (textDim → white + dim) — the composer-prompt look.
    expect(marker).toContain('❯');
    expect(marker).toContain(WHITE);
    expect(marker).toContain(DIM);
    // echo-brightness: the echoed text renders at NORMAL prose foreground
    // (text → whiteBright) and carries NEITHER dimmer — no token('textDim') AND no
    // Ink dimColor. Previously it stacked both and read faint.
    expect(echoedText).toContain('greetings juno');
    expect(echoedText).toContain(WHITE_BRIGHT);
    expect(echoedText).not.toContain(DIM);
  });
});

describe('transcript-identity (E) — code blocks at prose brightness', () => {
  it('renders a fenced code block at NORMAL prose brightness (not dimmer than prose)', () => {
    // A paragraph (prose) followed by a fenced code block. Both must render at the
    // same `text` brightness; the code block must carry NO dim attribute (old code
    // rendered it textDim + dimColor — dimmer than the prose above it).
    const frame =
      render(<Markdown text={'prose sentence\n\n```\ncode statement\n```'} depth="ansi16" />).lastFrame() ?? '';
    const proseLine = lineWith(frame, 'prose sentence');
    const codeLine = lineWith(frame, 'code statement');
    expect(proseLine).not.toBe('');
    expect(codeLine).not.toBe('');
    // Prose renders at full text brightness…
    expect(proseLine).toContain(WHITE_BRIGHT);
    // …and the code block matches it (>= prose brightness) with no dim attribute.
    expect(codeLine).toContain(WHITE_BRIGHT);
    expect(codeLine).not.toContain(DIM);
    // Gutter affordance: each body line is prefixed with the '│ ' gutter (the
    // blockquote pattern) instead of the old 2-space indent — the body text still
    // renders at full `text` brightness (asserted above), only the framing changed.
    expect(plain(codeLine).startsWith('│ code statement')).toBe(true);
  });
});
