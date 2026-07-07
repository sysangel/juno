// tests/transcriptStatic.test.tsx
// Regression: Ink's <Static> is append-only — it tracks an internal `index` that
// only ever advances to items.length, so each render it prints only
// items.slice(index). When `committed` is REPLACED wholesale (resume / compact /
// clear) rather than appended to, the settled index would slice off the leading
// messages of the new array, dropping them permanently. Transcript guards this by
// passing `state.transcriptEpoch` as <Static key>, remounting Static (index → 0) so
// the whole replaced transcript re-renders. This test drives the exact scenario:
// render an array (index settles to its length), then replace it and assert every
// message of the replacement is rendered — the leading ones would vanish without
// the key-driven remount.
import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { Transcript } from '../src/ui/Transcript';
import type { Msg } from '../src/core/reducer';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function msg(id: string, text: string): Msg {
  return { id, role: 'user', blocks: [{ kind: 'text', id: `${id}:block:1`, text }], done: true };
}

async function flush(): Promise<void> {
  // Let Static's useLayoutEffect (setIndex → items.length) settle before we replace.
  await act(async () => {
    await tick();
  });
}

describe('Transcript — <Static> remount on wholesale committed replacement', () => {
  it('renders ALL messages of a replaced (resumed) transcript, not just the tail', async () => {
    const first = [msg('m1', 'FIRST-LINE'), msg('m2', 'SECOND-LINE')];
    const { lastFrame, rerender } = render(<Transcript committed={first} epoch={0} depth="truecolor" />);
    await flush();
    expect(lastFrame() ?? '').toContain('FIRST-LINE');

    // Replace committed wholesale with a longer, different array (resume-session):
    // epoch bumps 0 → 1, so <Static key> changes and Static remounts (index → 0).
    const replaced = [msg('m3', 'ALPHA-MSG'), msg('m4', 'BRAVO-MSG'), msg('m5', 'CHARLIE-MSG')];
    await act(async () => {
      rerender(<Transcript committed={replaced} epoch={1} depth="truecolor" />);
      await tick();
    });
    await flush();

    const frame = lastFrame() ?? '';
    // Without the remount, Static's settled index (2) slices off ALPHA + BRAVO and
    // only CHARLIE survives. All three must appear.
    expect(frame).toContain('ALPHA-MSG');
    expect(frame).toContain('BRAVO-MSG');
    expect(frame).toContain('CHARLIE-MSG');
  });

  it('leaves more leading messages dropped the more were committed (epoch fixes it)', async () => {
    // Prior transcript of 3 messages → Static index settles to 3.
    const prior = [msg('p1', 'PRIOR-1'), msg('p2', 'PRIOR-2'), msg('p3', 'PRIOR-3')];
    const { lastFrame, rerender } = render(<Transcript committed={prior} epoch={0} depth="truecolor" />);
    await flush();

    // Resume a 2-message session: index 3 would slice(3) → NOTHING renders. With the
    // epoch-keyed remount both resumed messages appear.
    const resumed = [msg('x1', 'RESUMED-USER'), msg('x2', 'RESUMED-REPLY')];
    await act(async () => {
      rerender(<Transcript committed={resumed} epoch={1} depth="truecolor" />);
      await tick();
    });
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('RESUMED-USER');
    expect(frame).toContain('RESUMED-REPLY');
  });
});
