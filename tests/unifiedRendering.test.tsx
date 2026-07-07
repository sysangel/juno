// tests/unifiedRendering.test.tsx
// Wave-1 item A (unified-rendering): a block renders identically while streaming
// (live path) and after commit (committed path), except the explicitly-live
// elements owned by the status strip. These acceptance/regression tests fail on
// the pre-wave code, which flipped assistant prose cyan→white on commit and drew
// an orphan spinner line below the live message.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import type { Msg } from '../src/core/reducer';
import { Message } from '../src/ui/Message';
import { StreamingMessage } from '../src/ui/StreamingMessage';

// The colour acceptance criterion ('streaming prose renders in the FINAL prose
// colour from the first delta') can only be checked if frames actually carry
// ANSI colour escapes. In the vitest env supports-color reports level 0, so ink
// (via chalk) emits NO escapes and any colour comparison is vacuous — reverting
// the Message.tsx colour hunk would leave the suite green. Force chalk to a
// truecolor level for THIS file so the cyan/white difference is real, and assert
// escapes are present so the guard itself can never silently regress.
let priorChalkLevel: typeof chalk.level;
beforeAll(() => {
  priorChalkLevel = chalk.level;
  chalk.level = 3; // truecolor — ink now emits real SGR escapes
});
afterAll(() => {
  chalk.level = priorChalkLevel;
});

/** True iff the string carries at least one ANSI SGR (colour) escape sequence. */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\[[0-9;]*m/;

/** The rendered line (ANSI escapes included) that carries a substring, or ''. */
const lineWith = (frame: string, needle: string): string =>
  frame.split('\n').find((line) => line.includes(needle)) ?? '';

/** A plain-prose assistant message (no markdown syntax) so the raw streaming path
 *  and the committed markdown path collapse to the same single paragraph. */
function assistantMsg(done: boolean): Msg {
  return {
    id: 'a1',
    role: 'assistant',
    done,
    blocks: [{ kind: 'text', id: 'a1:block:1', text: 'Hello from Juno.' }],
  };
}

describe('unified-rendering — live path === committed path', () => {
  it('renders a plain text block identically while streaming and after commit', () => {
    // Same content, streamed (live, done:false) vs committed (done:true). On the
    // OLD code the live frame is cyan (roleAssistant) and the committed frame is
    // white (markdown `text`) — the frames differ. Unified, they are byte-equal.
    const live = render(<StreamingMessage live={assistantMsg(false)} depth="ansi16" />).lastFrame() ?? '';
    const committed = render(<Message msg={assistantMsg(true)} depth="ansi16" />).lastFrame() ?? '';
    // Guard: frames must actually carry colour escapes, else the byte-equality
    // below is vacuous (it would pass even if the streaming prose were re-tinted
    // cyan while committed stayed white). See the chalk.level forcing above.
    expect(ANSI_ESCAPE.test(live)).toBe(true);
    expect(live).toBe(committed);
  });

  it('streams assistant prose in the FINAL prose colour (kills the cyan→white flip)', () => {
    // Isolate the prose line (excluding the role label) in each path and compare
    // its FULL rendered form, ANSI colour escapes included. On the OLD code the
    // streaming line is cyan (roleAssistant) and the committed line is white
    // (`text`), so the escapes differ. Unified, the prose line is identical.
    const streamingFrame = render(<Message msg={assistantMsg(false)} depth="ansi16" />).lastFrame() ?? '';
    const committedFrame = render(<Message msg={assistantMsg(true)} depth="ansi16" />).lastFrame() ?? '';
    const streamingProse = lineWith(streamingFrame, 'Hello from Juno.');
    const committedProse = lineWith(committedFrame, 'Hello from Juno.');
    expect(streamingProse).not.toBe('');
    // Guard: the prose line must be wrapped in colour escapes, otherwise this
    // asserts nothing about colour and a revert of the Message.tsx `text`-tint
    // hunk (streaming prose back to `roleAssistant` cyan) would pass unnoticed.
    expect(ANSI_ESCAPE.test(streamingProse)).toBe(true);
    expect(streamingProse).toBe(committedProse);
  });

  it('draws NO orphan spinner line below the streaming message', () => {
    // The live progress spinner belongs to the status strip (item D), not on its
    // own line under the message. StreamingMessage must therefore add nothing to
    // the <Message> output. OLD code appended a spinner Box → an extra line.
    const live = assistantMsg(false);
    const streamed = render(<StreamingMessage live={live} depth="ansi16" />).lastFrame() ?? '';
    const plain = render(<Message msg={live} depth="ansi16" />).lastFrame() ?? '';
    expect(streamed).toBe(plain);
  });

  it('returns null for a null live message (no stray frame)', () => {
    expect(render(<StreamingMessage live={null} />).lastFrame() ?? '').toBe('');
  });
});
