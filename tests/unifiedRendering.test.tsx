// tests/unifiedRendering.test.tsx
// Wave-1 item A (unified-rendering): a block renders identically while streaming
// (live path) and after commit (committed path), except the explicitly-live
// elements owned by the status strip. These acceptance/regression tests fail on
// the pre-wave code, which flipped assistant prose cyan→white on commit and drew
// an orphan spinner line below the live message.
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { Msg } from '../src/core/reducer';
import { Message } from '../src/ui/Message';
import { StreamingMessage } from '../src/ui/StreamingMessage';

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
