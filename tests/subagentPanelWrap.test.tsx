// tests/subagentPanelWrap.test.tsx
// LANE scrollback (wave 8) — regression: an EXPANDED SubagentPanel row must occupy exactly ONE
// terminal row, because subagentPanelRows() (liveBudget's single authority) counts it as 1 and
// reserves the live-turn budget accordingly. Before the fix the trailing `detail` (model +
// runningLabel, e.g. 'claude-sonnet-4-5 · running mcp__brain__recall…') was never clipped, so on a
// narrow/split-pane terminal the row wrapped to 2 rows and the real panel grew past what the budget
// reserved — re-entering Ink's \x1b[3J native-scrollback erase branch.
//
// ink-testing-library hardcodes stdout.columns = 100, so it can NEVER reproduce wrapping at a
// smaller width. We drive Ink's own `render` with a stdout stub whose `columns` we control, and
// measure the rendered height of the committed frame.
import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentPanel } from '../src/ui/SubagentPanel';
import { subagentPanelRows } from '../src/ui/liveBudget';
import type { SubagentEntry } from '../src/core/selectors';

class FixedStdout extends EventEmitter {
  columns: number;
  rows = 60;
  lastFrame = '';
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  write = (frame: string): void => {
    this.lastFrame = frame;
  };
}
class NoopStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

/** Rendered terminal-row count of the panel at an exact terminal width (ANSI + trailing blank
 *  stripped, mirroring how Ink counts the dynamic region). */
function renderedHeight(entries: SubagentEntry[], width: number): number {
  const stdout = new FixedStdout(width) as unknown as NodeJS.WriteStream;
  const stdin = new NoopStdin() as unknown as NodeJS.ReadStream;
  const instance = render(
    createElement(SubagentPanel, { entries, focused: true, width, maxRows: 8, depth: 'ansi16' }),
    { stdout, stdin, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const frame = (stdout as unknown as FixedStdout).lastFrame
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+$/, '');
  instance.unmount();
  return frame.split('\n').length;
}

/** N running agents whose long model + running label force the row toward the terminal edge. */
function runningAgents(n: number): SubagentEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: 'spawn_subagent',
    description: `investigate module number ${i} across the whole repository thoroughly`,
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    childCount: 0,
    runningLabel: 'running mcp__brain__recall…',
  }));
}

describe('SubagentPanel expanded-row height mirrors subagentPanelRows()', () => {
  it('does not wrap a long-detail row at width 60 (the named split-pane case)', () => {
    const entries = runningAgents(6);
    // Pre-fix this rendered 14 rows against a budget of 8 — a 6-row unbudgeted overflow.
    expect(renderedHeight(entries, 60)).toBe(subagentPanelRows(entries.length, true, 8));
  });

  it('rendered height equals the budget across a matrix of realistic widths & counts', () => {
    for (const width of [20, 24, 30, 40, 50, 60, 65, 70, 80, 100]) {
      for (const count of [1, 2, 3, 6]) {
        const entries = runningAgents(count);
        expect(renderedHeight(entries, width)).toBe(subagentPanelRows(count, true, 8));
      }
    }
  });
});
