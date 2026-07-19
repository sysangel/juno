// tests/liveWindowHeights.test.tsx
// W3 item 1 (measurement truth) — the live-window height ESTIMATOR (src/ui/liveWindow.ts
// estimatedRows) must reserve the REAL rendered height of every tool unit, drift-free from the
// renderer. The proof renders the COMPOSED <Message> — the actual transcript renderer, INCLUDING
// the one-row gap it pushes before every top-level tool unit and the word-wrap of un-clipped solo
// cards / status rows — counts the real frame rows, and asserts estimatedRows(msg, W, tools) is an
// UPPER bound (>=) at both a wide (80) and a NARROW (32) width. An earlier version pinned bare
// <ToolCallCard>/<GroupedToolRows> leaves to `TOOL_CARD_ROWS + WRAP_HEADROOM`, which is exactly why
// the uncounted gap row and the word-wrap under-count slipped through CI (the narrow selftest pty
// then erased scrollback). Under-counting fires Ink's \x1b[3J repaint, so the bound must never dip
// below the truth.
import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import type { Msg, ToolState } from '../src/core/reducer';
import { estimatedRows } from '../src/ui/liveWindow';
import { Message } from '../src/ui/Message';

const WIDTHS = [80, 32] as const;
const rowCount = (frame: string): number => (frame.length === 0 ? 0 : frame.split('\n').length);

/** Render the REAL transcript renderer for a live assistant turn at a fixed width and return the
 *  rendered row count. Wrapping in a width-pinned Box makes Ink wrap the un-clipped cards exactly
 *  as the live dynamic region would at that terminal width; `columns` threads the same width to the
 *  grouped-unit clipper (Message → GroupedToolRows). */
function renderedMessageRows(msg: Msg, tools: Record<string, ToolState>, width: number): number {
  const frame =
    render(
      <Box width={width}>
        <Message msg={msg} tools={tools} columns={width} depth="ansi16" />
      </Box>,
    ).lastFrame() ?? '';
  return rowCount(frame);
}

/** A leading assistant paragraph so EVERY tool unit below it renders its top-level gap row (the
 *  gap is only pushed when something already rendered above — text+tool is the real live shape). */
const LEAD_TEXT = { kind: 'text' as const, id: 'b:text', text: 'here is what I found:' };

function msgOf(blocks: Msg['blocks']): Msg {
  return { id: 'live', role: 'assistant', done: false, blocks };
}

/** Assert the estimate is a true upper bound on the composed render at every swept width. */
function expectBounds(msg: Msg, tools: Record<string, ToolState>, label: string): void {
  for (const width of WIDTHS) {
    const actual = renderedMessageRows(msg, tools, width);
    const estimate = estimatedRows(msg, width, tools);
    expect(
      estimate,
      `${label} @ ${width}cols: estimate ${estimate} must be >= actual ${actual}`,
    ).toBeGreaterThanOrEqual(actual);
  }
}

describe('estimatedRows bounds the COMPOSED <Message> render (gap rows + word wrap included)', () => {
  it('text + a solo running card', () => {
    const tools: Record<string, ToolState> = {
      t0: { status: 'running', name: 'grep', args: { pattern: 'concurrencyGroupId' } },
    };
    const msg = msgOf([LEAD_TEXT, { kind: 'tool', id: 'b0', toolCallId: 't0' }]);
    expectBounds(msg, tools, 'text+solo-running');
  });

  it('text + a settled card with args AND a result tail at the caps (word-wraps at narrow width)', () => {
    // Args near the 60-cell cap + a first result line near the 48-cell cap + overflow: this is the
    // fixture that renders 2–3 rows at 80 and 4+ at 32, where the old flat `2` under-counted.
    const tools: Record<string, ToolState> = {
      t0: {
        status: 'result',
        name: 'read_file',
        args: { path: 'src/very/deeply/nested/module/with/a/long/path/handler.ts' },
        result: `export function handleTheRequestWithAVeryLongName(input) {\n  return input;\n}\n// trailing`,
      },
    };
    const msg = msgOf([LEAD_TEXT, { kind: 'tool', id: 'b0', toolCallId: 't0' }]);
    expectBounds(msg, tools, 'text+solo-settled-long');
  });

  it('text + an errored card whose first error line is long', () => {
    const tools: Record<string, ToolState> = {
      t0: {
        status: 'error',
        name: 'run_shell',
        args: { command: 'npm run build --workspace @juno/core --if-present' },
        error: 'Error: the build failed because a dependency could not be resolved at load time',
      },
    };
    const msg = msgOf([LEAD_TEXT, { kind: 'tool', id: 'b0', toolCallId: 't0' }]);
    expectBounds(msg, tools, 'text+solo-error-long');
  });

  it('text + a subagent spawn card AND its per-agent status row', () => {
    const tools: Record<string, ToolState> = {
      t0: {
        status: 'running',
        name: 'spawn_subagent',
        args: { task: 'refactor the authentication module end to end', model: 'fake-model-id' },
      },
    };
    const msg = msgOf([LEAD_TEXT, { kind: 'tool', id: 'b0', toolCallId: 't0' }]);
    expectBounds(msg, tools, 'text+spawn');
  });

  it.each([3, 12] as const)('text + a concurrent group of %i', (n) => {
    const tools: Record<string, ToolState> = {};
    const blocks: Msg['blocks'] = [LEAD_TEXT];
    for (let i = 0; i < n; i++) {
      tools[`t${i}`] = { status: 'running', name: 'grep', args: { pattern: `pattern-number-${i}` }, concurrencyGroupId: 'g1' };
      blocks.push({ kind: 'tool', id: `b${i}`, toolCallId: `t${i}` });
    }
    // A windowed group of 12 shows header + `↑ 4 earlier` + 8 rows; the estimator must cover it.
    expectBounds(msgOf(blocks), tools, `text+group-${n}`);
  });

  it('text + a group of 3 THEN a solo spawn (two top-level units, two gaps)', () => {
    const tools: Record<string, ToolState> = {
      g0: { status: 'running', name: 'grep', args: { pattern: 'a' }, concurrencyGroupId: 'g1' },
      g1: { status: 'result', name: 'read_file', args: { path: 'b.ts' }, result: 'ok', concurrencyGroupId: 'g1' },
      g2: { status: 'running', name: 'grep', args: { pattern: 'c' }, concurrencyGroupId: 'g1' },
      s0: { status: 'running', name: 'Agent', args: { description: 'audit the dependency tree for cycles' } },
    };
    const msg = msgOf([
      LEAD_TEXT,
      { kind: 'tool', id: 'bg0', toolCallId: 'g0' },
      { kind: 'tool', id: 'bg1', toolCallId: 'g1' },
      { kind: 'tool', id: 'bg2', toolCallId: 'g2' },
      { kind: 'tool', id: 'bs0', toolCallId: 's0' },
    ]);
    expectBounds(msg, tools, 'text+group3+spawn');
  });
});
