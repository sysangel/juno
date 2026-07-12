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
 *  stripped, mirroring how Ink counts the dynamic region). `focused`/`maxRows` default to the
 *  expanded case; pass `focused: false` to exercise the collapsed one-liner. */
function renderedHeight(
  entries: SubagentEntry[],
  width: number,
  opts: { focused?: boolean; maxRows?: number } = {},
): number {
  const focused = opts.focused ?? true;
  const maxRows = opts.maxRows ?? 8;
  const stdout = new FixedStdout(width) as unknown as NodeJS.WriteStream;
  const stdin = new NoopStdin() as unknown as NodeJS.ReadStream;
  const instance = render(
    createElement(SubagentPanel, { entries, focused, width, maxRows, depth: 'ansi16' }),
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

/** N running agents with long CJK descriptions — every han char is 2 DISPLAY CELLS, so a
 *  code-unit-based clip (flat.length/flat.slice) under-clips and the row overflows to 2+ terminal
 *  rows. Pins the one-row invariant in display cells. */
function cjkAgents(n: number): SubagentEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: 'spawn_subagent',
    description: `调查整个代码库中的模块编号${i}并彻底检查所有相关的源文件与依赖关系`,
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    childCount: 0,
    runningLabel: 'running mcp__brain__recall…',
  }));
}

/** N running agents with emoji-laden descriptions (each emoji is 2 display cells) — same
 *  overflow risk as CJK for a length-based clip. Uses only long-established width-2 emoji so the
 *  width Ink measures matches the width string-width measures. */
function emojiAgents(n: number): SubagentEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: 'spawn_subagent',
    description: `🔍 investigate 🚀 module 📦 number ${i} 🔧 across 🎯 the whole 📁 repository 😀 thoroughly`,
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    childCount: 0,
    runningLabel: 'running mcp__brain__recall…',
  }));
}

/** A mixed roster (2 running, 1 done, 1 failed) whose collapsed one-liner
 *  `▾ agents (2 running, 1 done, 1 failed)` is ~38 cols — wide enough to wrap a narrow strip. */
function mixedAgents(): SubagentEntry[] {
  const mk = (id: string, status: SubagentEntry['status']): SubagentEntry => ({
    id,
    name: 'spawn_subagent',
    description: 'investigate a module',
    model: 'claude-sonnet-4-5',
    status,
    childCount: 0,
    runningLabel: 'running mcp__brain__recall…',
  });
  return [mk('m0', 'running'), mk('m1', 'running'), mk('m2', 'done'), mk('m3', 'error')];
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

  it('CJK descriptions still occupy exactly one row each (display cells, not code units)', () => {
    // Pre-fix, 3 CJK-description agents rendered 8–11 rows against a 5-row budget at 40/60/80,
    // re-entering Ink's \x1b[3J erase branch. A width-aware clip pins them at one row.
    for (const width of [40, 60, 80]) {
      for (const count of [1, 2, 3, 6]) {
        const entries = cjkAgents(count);
        expect(renderedHeight(entries, width)).toBe(subagentPanelRows(count, true, 8));
      }
    }
  });

  it('emoji descriptions still occupy exactly one row each', () => {
    for (const width of [40, 60, 80]) {
      for (const count of [1, 2, 3, 6]) {
        const entries = emojiAgents(count);
        expect(renderedHeight(entries, width)).toBe(subagentPanelRows(count, true, 8));
      }
    }
  });
});

describe('SubagentPanel expanded chrome lines stay one row on ultra-narrow panes', () => {
  it('header, `↑ N earlier`, and the collapse hint each occupy exactly one row below ~14 cols', () => {
    // maxRows=2 with 6 entries forces the `↑ 4 earlier` head to render (entries > shown), so all
    // three chrome lines are exercised. Pre-fix the header `▾ agents` (8 cells), `↑ 4 earlier`
    // (11 cells), and `↑/esc collapse` (14 cells) rendered UNclipped and wrapped to 2 rows each at
    // these widths while subagentPanelRows() budgeted exactly 1 apiece — under-reserving the
    // dynamic region and re-opening the \x1b[3J erase branch. A width-1 clip pins them at one row.
    for (const width of [8, 10, 12, 13]) {
      expect(renderedHeight(runningAgents(6), width, { maxRows: 2 })).toBe(
        subagentPanelRows(6, true, 2),
      );
    }
  });
});

describe('SubagentPanel collapsed one-liner never wraps the strip', () => {
  it('clips to exactly one row across narrow widths (subagentPanelRows budgets 1)', () => {
    // `▾ agents (2 running, 1 done, 1 failed)` is ~38 cols and pre-fix wrapped to 2 rows at
    // widths 24/30 while subagentPanelRows() reserved 1 — a single-authority height violation.
    const entries = mixedAgents();
    for (const width of [20, 24, 30, 40, 60, 100]) {
      expect(renderedHeight(entries, width, { focused: false })).toBe(
        subagentPanelRows(entries.length, false, 8),
      );
    }
  });
});
