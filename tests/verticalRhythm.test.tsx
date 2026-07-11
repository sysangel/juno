// tests/verticalRhythm.test.tsx
// Wave-5 item 4 (UX track 3 — within-turn vertical rhythm). `Message.renderBlocks`
// inserts exactly ONE blank line before each top-level tool group when something
// already rendered above it — i.e. between consecutive top-level tool groups AND at
// a text→tool boundary — but NEVER before the first block and NEVER inside a nested
// (subagent) group. The gap is a bare `<Box height={1} />` (no colour), so it is
// palette-independent; the structural invariants are asserted under BOTH the dark
// and light palettes. The gap depends only on block ORDER + KIND, which is identical
// for the live (tools map) and committed (toolSnapshot) render paths, so a turn's
// spacing does not shift when it commits to <Static> — the parity test locks that in.
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { Message } from '../src/ui/Message';
import { initialState, reducer, type State } from '../src/core/reducer';
import { setActiveTheme } from '../src/ui/theme';

afterEach(() => setActiveTheme('dark'));

/** Drive the real reducer through an action script; return the resulting state. */
function drive(actions: Parameters<typeof reducer>[1][]): State {
  return actions.reduce((s, a) => reducer(s, a), initialState());
}

/** First frame line index whose text contains `needle`, or -1. */
function lineOf(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

const THEMES = ['dark', 'light'] as const;

describe('within-turn vertical rhythm — blank line between top-level tool groups', () => {
  it.each(THEMES)('[%s] text→tool and tool→tool each get exactly one blank line', (bg) => {
    setActiveTheme(bg);
    // blocks: text "hello world", tool tc1 (echo aaa), tool tc2 (echo bbb).
    const s = drive([
      { t: 'assistant-start', id: 'm1' },
      { t: 'text-delta', id: 'm1', delta: 'hello world' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: { command: 'echo aaa' } },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'ok1' },
      { t: 'tool-call', toolCallId: 'tc2', name: 'run_shell', args: { command: 'echo bbb' } },
      { t: 'tool-status', toolCallId: 'tc2', status: 'result', result: 'ok2' },
    ]);
    const frame = render(<Message msg={s.live!} depth="ansi16" tools={s.tools} />).lastFrame() ?? '';
    const lines = frame.split('\n');

    const iText = lineOf(lines, 'hello world');
    const iA = lineOf(lines, 'echo aaa');
    const iB = lineOf(lines, 'echo bbb');
    expect(iText).toBeGreaterThanOrEqual(0);
    expect(iA).toBeGreaterThan(iText);
    expect(iB).toBeGreaterThan(iA);

    // text→tool boundary: the line immediately above the first tool group is blank.
    expect(lines[iA - 1].trim()).toBe('');
    // …and it is the ONLY blank in the text→tool gap (exactly one blank line).
    expect(lines.slice(iText + 1, iA).filter((l) => l.trim() === '')).toHaveLength(1);

    // tool→tool boundary: exactly one blank line between the two groups.
    expect(lines[iB - 1].trim()).toBe('');
    expect(lines.slice(iA + 1, iB).filter((l) => l.trim() === '')).toHaveLength(1);

    // No blank line leads the turn (first block is text, rendered at the top).
    expect(lines[0].trim()).not.toBe('');
  });

  it.each(THEMES)('[%s] no blank line before the FIRST block when it is a tool group', (bg) => {
    setActiveTheme(bg);
    const s = drive([
      { t: 'assistant-start', id: 'm1' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: { command: 'echo solo' } },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'ok' },
    ]);
    const frame = render(<Message msg={s.live!} depth="ansi16" tools={s.tools} />).lastFrame() ?? '';
    const lines = frame.split('\n');
    // The tool line is the very first rendered row — nothing (blank or otherwise) above it.
    expect(lines[0]).toContain('echo solo');
  });

  it.each(THEMES)('[%s] blank line between subagent GROUPS, never inside a group', (bg) => {
    setActiveTheme(bg);
    // Two parent Agent groups, each with one child (parentToolUseId → parent).
    const s = drive([
      { t: 'assistant-start', id: 'm1' },
      { t: 'tool-call', toolCallId: 'p1', name: 'Agent', args: { subagent_type: 'alpha' } },
      { t: 'tool-call', toolCallId: 'c1', name: 'run_shell', args: { command: 'child one' }, parentToolUseId: 'p1' },
      { t: 'tool-status', toolCallId: 'c1', status: 'result', result: 'r1' },
      { t: 'tool-status', toolCallId: 'p1', status: 'result', result: 'done a' },
      { t: 'tool-call', toolCallId: 'p2', name: 'Agent', args: { subagent_type: 'beta' } },
      { t: 'tool-call', toolCallId: 'c2', name: 'run_shell', args: { command: 'child two' }, parentToolUseId: 'p2' },
      { t: 'tool-status', toolCallId: 'c2', status: 'result', result: 'r2' },
      { t: 'tool-status', toolCallId: 'p2', status: 'result', result: 'done b' },
    ]);
    const frame = render(<Message msg={s.live!} depth="ansi16" tools={s.tools} />).lastFrame() ?? '';
    const lines = frame.split('\n');

    const iP1 = lineOf(lines, 'alpha');
    const iC1 = lineOf(lines, 'child one');
    const iP2 = lineOf(lines, 'beta');
    const iC2 = lineOf(lines, 'child two');
    expect(iP1).toBeGreaterThanOrEqual(0);
    expect(iC1).toBeGreaterThan(iP1);
    expect(iP2).toBeGreaterThan(iC1);
    expect(iC2).toBeGreaterThan(iP2);

    // NO blank line inside a group (parent → its own child).
    expect(lines.slice(iP1 + 1, iC1).every((l) => l.trim() !== '')).toBe(true);
    expect(lines.slice(iP2 + 1, iC2).every((l) => l.trim() !== '')).toBe(true);

    // Exactly ONE blank line between the two groups (after group 1's child, before group 2).
    expect(lines.slice(iC1 + 1, iP2).filter((l) => l.trim() === '')).toHaveLength(1);

    // No leading blank line before the first group.
    expect(lines[0].trim()).not.toBe('');
  });

  it('streaming and committed frames are identical (append-only <Static> invariant)', () => {
    const script = [
      { t: 'assistant-start', id: 'm1' },
      { t: 'text-delta', id: 'm1', delta: 'preamble' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: { command: 'echo aaa' } },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'ok1' },
      { t: 'tool-call', toolCallId: 'tc2', name: 'run_shell', args: { command: 'echo bbb' } },
      { t: 'tool-status', toolCallId: 'tc2', status: 'result', result: 'ok2' },
    ] as Parameters<typeof reducer>[1][];

    const live = drive(script);
    const liveFrame = render(<Message msg={live.live!} depth="ansi16" tools={live.tools} />).lastFrame() ?? '';

    // Commit the turn: it moves to `committed` with a frozen toolSnapshot; the
    // committed render path reads that snapshot, not the live tools map.
    const done = reducer(live, { t: 'assistant-done', id: 'm1', stopReason: 'end' });
    const committed = done.committed.at(-1)!;
    const committedFrame = render(<Message msg={committed} depth="ansi16" />).lastFrame() ?? '';

    expect(committedFrame).toBe(liveFrame);
    // Sanity: the gap is actually present in what we compared.
    expect(liveFrame.split('\n').some((l) => l.trim() === '')).toBe(true);
  });
});
