// tests/toolDetailOverlay.test.tsx
// Wave-7 lane C: the ctrl+o tool-detail overlay + its supporting seams.
//   - resultTail: the condensed one-line card tail.
//   - reducer: full results are RETAINED (no render-time truncation) but capped at
//     MAX_STORED_RESULT_BYTES with an explicit marker so memory can't grow unbounded.
//   - ToolDetailOverlay: list view (condensed rows, highlight) + detail view (FULL
//     args/result, scroll indicators), rendered with FORCE_COLOR=0-stable frames.
//   - useKeybinds: ctrl+o opens; up/down + enter route to the overlay callbacks;
//     Esc routes to the two-level back handler (never abort).
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import type { ReactElement } from 'react';
import {
  initialState,
  reducer,
  MAX_STORED_RESULT_BYTES,
  TRUNCATION_MARKER,
  type ToolState,
} from '../src/core/reducer';
import { resultTail } from '../src/ui/ToolCallCard';
import {
  ToolDetailOverlay,
  buildToolDetailLines,
  toolDetailViewportRows,
  type ToolDetailEntry,
} from '../src/ui/ToolDetailOverlay';
import { displayWidth } from '../src/ui/clipText';
import { TOOL_PENDING, TOOL_WAITING } from '../src/ui/glyphs';
import { useKeybinds } from '../src/hooks/useKeybinds';
import {
  useToolDetailOverlay,
  type ToolDetailOverlay as ToolDetailOverlayController,
} from '../src/hooks/useToolDetailOverlay';
import { flushInk } from './helpers/ink';

const called = (spy: { mock: { calls: unknown[][] } }, label: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (spy.mock.calls.length > 0) return resolve();
      if (Date.now() - started > 1000) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });

// ---------------------------------------------------------------------------
// resultTail — condensed one-line summary
// ---------------------------------------------------------------------------

describe('resultTail', () => {
  it('returns the first non-blank line and counts the hidden remainder', () => {
    const raw = '\n\n1082 passed\n5 skipped\n57 files';
    expect(resultTail(raw)).toEqual({ text: '1082 passed', hidden: 4 });
  });

  it('single-line result → no hidden lines', () => {
    expect(resultTail('12 files')).toEqual({ text: '12 files', hidden: 0 });
  });

  it('empty result → empty text', () => {
    expect(resultTail('')).toEqual({ text: '', hidden: 0 });
    expect(resultTail(undefined)).toEqual({ text: '', hidden: 0 });
  });

  it('caps a very long first line with an ellipsis', () => {
    const { text } = resultTail('x'.repeat(500));
    expect(text.length).toBeLessThanOrEqual(48);
    expect(text.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reducer — store full result, capped
// ---------------------------------------------------------------------------

describe('reducer — stored-result cap', () => {
  function withResult(result: unknown): ToolState {
    let s = initialState();
    s = reducer(s, { t: 'assistant-start', id: 'm1' });
    s = reducer(s, { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: { command: 'x' } });
    s = reducer(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result });
    return s.tools['tc1']!;
  }

  it('retains a normal (multi-line, sub-cap) result IN FULL — no render-time truncation', () => {
    const full = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(withResult(full).result).toBe(full);
  });

  it('caps a giant string result at MAX_STORED_RESULT_BYTES with an explicit marker', () => {
    const giant = 'a'.repeat(MAX_STORED_RESULT_BYTES + 5000);
    const stored = withResult(giant).result as string;
    expect(stored.length).toBe(MAX_STORED_RESULT_BYTES + TRUNCATION_MARKER.length);
    expect(stored.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('caps an oversized error string too', () => {
    let s = initialState();
    s = reducer(s, { t: 'assistant-start', id: 'm1' });
    s = reducer(s, { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: {} });
    s = reducer(s, {
      t: 'tool-status',
      toolCallId: 'tc1',
      status: 'error',
      error: 'e'.repeat(MAX_STORED_RESULT_BYTES + 100),
    });
    const err = s.tools['tc1']!.error!;
    expect(err.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('leaves a structured (object) result untouched', () => {
    const obj = { ok: true, rows: 3 };
    expect(withResult(obj).result).toEqual(obj);
  });
});

// ---------------------------------------------------------------------------
// buildToolDetailLines — the full detail body
// ---------------------------------------------------------------------------

/** Join a detail body to text, dropping tone — for the "content is present" assertions. */
const bodyText = (lines: ReadonlyArray<{ text: string; tone: string }>): string =>
  lines.map((l) => l.text).join('\n');

describe('buildToolDetailLines', () => {
  it('includes the tool name, FULL args, and FULL result (every line)', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'big.ts', limit: 500 },
      result: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
    };
    const lines = buildToolDetailLines(tool, 80);
    const joined = bodyText(lines);
    expect(joined).toContain('read_file');
    expect(joined).toContain('args:');
    expect(joined).toContain('"path": "big.ts"');
    expect(joined).toContain('result:');
    // The FULL result — not just the first 3 lines the transcript card would show.
    expect(joined).toContain('line 1');
    expect(joined).toContain('line 40');
    // A non-file-mutating tool keeps every row in the plain 'text' tone.
    expect(lines.every((l) => l.tone === 'text')).toBe(true);
  });

  it('renders an error tool with its error body', () => {
    const tool: ToolState = { status: 'error', name: 'run_shell', args: {}, error: 'permission denied' };
    const joined = bodyText(buildToolDetailLines(tool, 80));
    expect(joined).toContain('error:');
    expect(joined).toContain('permission denied');
  });
});

// ---------------------------------------------------------------------------
// buildToolDetailLines — real diff for committed edits (re-scoped: markers +
// tones, NO hunks; truthful line numbers only where knowable). These are the
// core of the wave-12 change: after an edit lands, the detail body must render a
// readable -/+ diff (never a raw JSON.stringify of {path, oldString, newString}).
// ---------------------------------------------------------------------------

describe('buildToolDetailLines — edit_file / write_file diff', () => {
  it('edit_file renders marker-prefixed -/+ lines with correct tones and NO raw JSON', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'edit_file',
      args: { path: 'src/a.ts', oldString: 'const a = 1', newString: 'const a = 2' },
      result: 'edited',
    };
    const lines = buildToolDetailLines(tool, 80);
    // The '@ edit <path>' header, the removed old line, the added new line — each
    // with the tone that colors it (meta=dim, remove=red, add=green).
    expect(lines).toContainEqual({ text: '@ edit src/a.ts', tone: 'meta' });
    expect(lines).toContainEqual({ text: '- const a = 1', tone: 'remove' });
    expect(lines).toContainEqual({ text: '+ const a = 2', tone: 'add' });
    // The raw args JSON is GONE — no `args:` label, no oldString/newString/path keys.
    const joined = bodyText(lines);
    expect(joined).not.toContain('args:');
    expect(joined).not.toContain('oldString');
    expect(joined).not.toContain('newString');
    expect(joined).not.toContain('"path"');
  });

  it('edit_file shared leading/trailing lines render as two-space context, tone meta', () => {
    // The most common visual path for a real edit: a shared prefix/suffix around the
    // changed middle. lineDiff emits those shared lines as `context`, which renders in
    // the two-space gutter (diffMarker('context') === ' ') and dim `meta` tone — the
    // same bucket PermissionPrompt gives context lines.
    const tool: ToolState = {
      status: 'result',
      name: 'edit_file',
      args: { path: 'src/a.ts', oldString: 'keep\nold\ntail', newString: 'keep\nnew\ntail' },
      result: 'edited',
    };
    const lines = buildToolDetailLines(tool, 80);
    // Shared prefix + suffix: two-space marker, meta tone — pins diffKindToTone's
    // context→meta branch and the two-space context marker.
    expect(lines).toContainEqual({ text: '  keep', tone: 'meta' });
    expect(lines).toContainEqual({ text: '  tail', tone: 'meta' });
    // The divergent middle still renders as remove-then-add.
    expect(lines).toContainEqual({ text: '- old', tone: 'remove' });
    expect(lines).toContainEqual({ text: '+ new', tone: 'add' });
  });

  it('replaceAll surfaces the "(applies to all occurrences)" meta line', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'edit_file',
      args: { path: 'x.ts', oldString: 'a', newString: 'b', replaceAll: true },
      result: 'edited',
    };
    const lines = buildToolDetailLines(tool, 80);
    expect(lines).toContainEqual({ text: '@ edit x.ts', tone: 'meta' });
    expect(lines).toContainEqual({ text: '@ (applies to all occurrences)', tone: 'meta' });
  });

  it('write_file renders numbered all-adds lines (truthful new-file line numbers)', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'write_file',
      args: { path: 'new.ts', content: 'line one\nline two\nline three' },
      result: 'ok',
    };
    const lines = buildToolDetailLines(tool, 80);
    expect(lines).toContainEqual({ text: '@ write new.ts (new content)', tone: 'meta' });
    expect(lines).toContainEqual({ text: '1 + line one', tone: 'add' });
    expect(lines).toContainEqual({ text: '2 + line two', tone: 'add' });
    expect(lines).toContainEqual({ text: '3 + line three', tone: 'add' });
    expect(bodyText(lines)).not.toContain('"content"');
  });

  it('write_file right-aligns the number gutter when the file crosses 10 lines', () => {
    const content = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n');
    const tool: ToolState = {
      status: 'result',
      name: 'write_file',
      args: { path: 'big.ts', content },
      result: 'ok',
    };
    const lines = buildToolDetailLines(tool, 80);
    // Gutter is width-2 (N=12): the single-digit rows are space-padded so the
    // numbers align, and every add row keeps tone 'add'.
    expect(lines).toContainEqual({ text: ' 1 + l1', tone: 'add' });
    expect(lines).toContainEqual({ text: '12 + l12', tone: 'add' });
  });

  it('malformed edit_file args (missing oldString) fall back to prettyArgs, tone text', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'edit_file',
      args: { path: 'a.ts', newString: 'z' }, // no oldString → buildDiff returns null
      result: 'ok',
    };
    const lines = buildToolDetailLines(tool, 80);
    const joined = bodyText(lines);
    expect(joined).toContain('args:');
    expect(joined).toContain('"path": "a.ts"');
    expect(joined).toContain('"newString": "z"');
    // The fallback JSON is plain text — no diff coloring leaks in.
    expect(lines.find((l) => l.text === 'args:')?.tone).toBe('text');
    expect(lines.every((l) => l.tone === 'text')).toBe(true);
  });

  it('an error-status edit_file still shows the diff, then the error section', () => {
    const tool: ToolState = {
      status: 'error',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'x', newString: 'y' },
      error: 'file changed on disk',
    };
    const lines = buildToolDetailLines(tool, 80);
    expect(lines).toContainEqual({ text: '- x', tone: 'remove' });
    expect(lines).toContainEqual({ text: '+ y', tone: 'add' });
    const joined = bodyText(lines);
    expect(joined).toContain('error:');
    expect(joined).toContain('file changed on disk');
  });

  it('a result body line starting with "+" is NOT classified as a diff add', () => {
    // Proof the tone comes from the line's SECTION, not its leading char: a plain
    // tool whose result text starts with '+'/'-' must stay tone 'text'.
    const tool: ToolState = {
      status: 'result',
      name: 'run_shell',
      args: { command: 'git diff' },
      result: '+ added line\n- removed line\n  context line',
    };
    const lines = buildToolDetailLines(tool, 80);
    expect(lines.find((l) => l.text === '+ added line')?.tone).toBe('text');
    expect(lines.find((l) => l.text === '- removed line')?.tone).toBe('text');
    expect(lines.every((l) => l.tone === 'text')).toBe(true);
  });

  it('a long add line hard-wraps, keeping tone "add" on every continuation row', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'x', newString: 'z'.repeat(200) },
      result: 'edited',
    };
    const lines = buildToolDetailLines(tool, 40); // max cells = 36 → the 202-cell add wraps
    const addRows = lines.filter((l) => /z/.test(l.text));
    expect(addRows.length).toBeGreaterThan(1); // it really did wrap
    expect(addRows.every((l) => l.tone === 'add')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CJK / emoji clipping — the wave-9 fix. These FAIL against the old UTF-16
// `.slice()` hard-wrap / oneLineClip (wide glyphs overflow the budget and a
// surrogate pair splits at the cut into a lone-surrogate `�`) and pass once the
// overlay clips through clipText's cell-correct wrapCells / clipCells.
// ---------------------------------------------------------------------------

// An unpaired UTF-16 surrogate — the garble a raw `.slice()` emits mid-astral-glyph.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('ToolDetailOverlay — wide-glyph clipping (no UTF-16 garble)', () => {
  it('hard-wraps a wide CJK result so no rendered line overflows the panel width', () => {
    const width = 20; // buildToolDetailLines caps content to Math.max(8, width - 4) = 16 cells
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: '字'.repeat(20), // one 40-cell source line
    };
    // Old hardWrap sliced 16 UTF-16 units = 16 CJK = 32 cells onto one row, overflowing
    // the panel and corrupting the scroll math. Every wrapped line must fit the budget.
    for (const line of buildToolDetailLines(tool, width)) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(16);
    }
  });

  it('never splits an emoji surrogate pair when hard-wrapping the detail body', () => {
    const width = 20;
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: 'x' + '👍'.repeat(20), // the odd offset lands a UTF-16 slice mid-pair
    };
    for (const line of buildToolDetailLines(tool, width)) {
      expect(line.text).not.toMatch(LONE_SURROGATE);
    }
  });

  it('list view clips a wide emoji row without emitting a lone surrogate', () => {
    const entries: ToolDetailEntry[] = [
      { id: 'tc1', tool: { status: 'error', name: 'x', args: {}, error: '👍'.repeat(30) } },
    ];
    const frame =
      render(
        <ToolDetailOverlay
          view="list"
          entries={entries}
          selectedIndex={0}
          scroll={0}
          rows={40}
          width={20}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).not.toMatch(LONE_SURROGATE);
    expect(frame).not.toContain('�');
  });
});

// ---------------------------------------------------------------------------
// ToolDetailOverlay — list + detail rendering
// ---------------------------------------------------------------------------

const ENTRIES: ToolDetailEntry[] = [
  { id: 'tc3', tool: { status: 'error', name: 'write_file', args: { path: 'z.ts' }, error: 'nope' } },
  { id: 'tc2', tool: { status: 'result', name: 'grep', args: { pattern: 'TODO' }, result: '7 matches' } },
  { id: 'tc1', tool: { status: 'result', name: 'read_file', args: { path: 'a.ts' }, result: 'ok' } },
];

describe('ToolDetailOverlay — list view', () => {
  it('renders one condensed row per tool call with the highlight on the selected row', () => {
    const frame =
      render(
        <ToolDetailOverlay
          view="list"
          entries={ENTRIES}
          selectedIndex={1}
          scroll={0}
          rows={40}
          width={80}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('tool calls');
    expect(frame).toContain('write_file(z.ts)');
    expect(frame).toContain('grep(TODO)');
    expect(frame).toContain('read_file(a.ts)');
    // The selected row (index 1 = grep) carries the ▸ marker.
    const grepLine = frame.split('\n').find((l) => l.includes('grep(TODO)')) ?? '';
    expect(grepLine).toContain('▸');
    // The nav hint is present.
    expect(frame).toContain('enter open');
  });

  it('renders a pending (queued) row with the filled ● dot, never the permission-gated ◌', () => {
    // A queued-but-not-started tool is NOT blocked on a permission prompt: the overlay's
    // ToolState status union (pending/running/error/result) has no permission concept, so
    // the list must render TOOL_PENDING (●) for `pending`, and the permission-gated
    // TOOL_WAITING (◌) must appear NOWHERE in the overlay output.
    const entries: ToolDetailEntry[] = [
      { id: 'tc4', tool: { status: 'pending', name: 'run_shell', args: { command: 'npm test' } } },
      { id: 'tc3', tool: { status: 'running', name: 'grep', args: { pattern: 'TODO' } } },
      { id: 'tc2', tool: { status: 'result', name: 'read_file', args: { path: 'a.ts' }, result: 'ok' } },
      { id: 'tc1', tool: { status: 'error', name: 'write_file', args: { path: 'z.ts' }, error: 'nope' } },
    ];
    const frame =
      render(
        <ToolDetailOverlay
          view="list"
          entries={entries}
          selectedIndex={0}
          scroll={0}
          rows={40}
          width={80}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    const pendingRow = frame.split('\n').find((l) => l.includes('run_shell(npm test)')) ?? '';
    expect(pendingRow).toContain(TOOL_PENDING); // ● — queued, not permission-gated
    expect(pendingRow).not.toContain(TOOL_WAITING); // not ◌
    // ◌ has no meaning in this overlay — it must appear nowhere across every status row.
    expect(frame).not.toContain(TOOL_WAITING);
  });

  it('shows an empty state when there are no tool calls', () => {
    const frame =
      render(
        <ToolDetailOverlay view="list" entries={[]} selectedIndex={0} scroll={0} rows={40} width={80} depth="ansi16" />,
      ).lastFrame() ?? '';
    expect(frame).toContain('No tool calls yet');
  });
});

describe('ToolDetailOverlay — detail view', () => {
  it('renders the FULL args and result of the selected call', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: 'first\nsecond\nthird',
    };
    const frame =
      render(
        <ToolDetailOverlay
          view="detail"
          entries={[{ id: 'tc1', tool }]}
          selectedIndex={0}
          scroll={0}
          rows={40}
          width={80}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('tool detail');
    expect(frame).toContain('"path": "a.ts"');
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).toContain('third');
    expect(frame).toContain('esc back');
  });

  it('shows a "↓ more" indicator when the body overflows the viewport, and scrolls', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n'),
    };
    const entry: ToolDetailEntry[] = [{ id: 'tc1', tool }];
    const top =
      render(
        <ToolDetailOverlay view="detail" entries={entry} selectedIndex={0} scroll={0} rows={20} width={80} depth="ansi16" />,
      ).lastFrame() ?? '';
    expect(top).toMatch(/↓ \d+ more/);
    expect(top).not.toMatch(/↑ \d+ more/); // at the top, no up-indicator
    // Scrolled well past the top: an up-indicator appears.
    const viewport = toolDetailViewportRows(20);
    const scrolled =
      render(
        <ToolDetailOverlay view="detail" entries={entry} selectedIndex={0} scroll={viewport + 3} rows={20} width={80} depth="ansi16" />,
      ).lastFrame() ?? '';
    expect(scrolled).toMatch(/↑ \d+ more/);
  });
});

// ---------------------------------------------------------------------------
// useKeybinds — ctrl+o open + tool-detail routing
// ---------------------------------------------------------------------------

interface HarnessProps {
  readonly overlay: 'none' | 'tool-detail';
  readonly onOpenToolDetail?: () => void;
  readonly onMoveTool?: () => void;
  readonly onAcceptTool?: () => void;
  readonly onToolBack?: () => void;
  readonly onAbort?: () => void;
  readonly onCycleEffort?: () => void;
}

function Harness(props: HarnessProps): ReactElement {
  useKeybinds({
    overlay: props.overlay,
    value: '',
    slashCommandCount: 0,
    modelCount: 0,
    onAbort: props.onAbort ?? vi.fn(),
    onCycleEffort: props.onCycleEffort ?? vi.fn(),
    onOpenSlash: vi.fn(),
    onCloseOverlay: vi.fn(),
    onMoveSlash: vi.fn(),
    onAcceptSlash: vi.fn(),
    onMoveModel: vi.fn(),
    onAcceptModel: vi.fn(),
    onOpenToolDetail: props.onOpenToolDetail,
    onMoveTool: props.onMoveTool,
    onAcceptTool: props.onAcceptTool,
    onToolBack: props.onToolBack,
  });
  return <Text>harness</Text>;
}

describe('useKeybinds — tool-detail overlay routing', () => {
  it('Ctrl+O opens the tool-detail overlay when no overlay is up', async () => {
    const onOpenToolDetail = vi.fn();
    const { stdin, unmount } = render(<Harness overlay="none" onOpenToolDetail={onOpenToolDetail} />);
    await flushInk();
    stdin.write('\x0f'); // Ctrl+O
    await called(onOpenToolDetail, 'onOpenToolDetail called');
    expect(onOpenToolDetail).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('up/down move, Enter accepts, and Tab is swallowed while the overlay is open', async () => {
    const onMoveTool = vi.fn();
    const onAcceptTool = vi.fn();
    const onCycleEffort = vi.fn();
    const { stdin, unmount } = render(
      <Harness overlay="tool-detail" onMoveTool={onMoveTool} onAcceptTool={onAcceptTool} onCycleEffort={onCycleEffort} />,
    );
    await flushInk();
    stdin.write('[B'); // Down
    await called(onMoveTool, 'onMoveTool called');
    stdin.write('\r'); // Enter
    await called(onAcceptTool, 'onAcceptTool called');
    stdin.write('\t'); // Tab must NOT cycle effort behind the overlay
    await flushInk();
    expect(onCycleEffort).not.toHaveBeenCalled();
    unmount();
  });

  it('Esc routes to onToolBack (two-level back), never abort', async () => {
    const onToolBack = vi.fn();
    const onAbort = vi.fn();
    const { stdin, unmount } = render(<Harness overlay="tool-detail" onToolBack={onToolBack} onAbort={onAbort} />);
    await flushInk();
    stdin.write(''); // Esc
    await called(onToolBack, 'onToolBack called');
    expect(onToolBack).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useToolDetailOverlay — the detail-scroll clamp still works now that
// buildToolDetailLines returns {text, tone}[] instead of string[]. The clamp
// reads only `.length`, so the retype is behavior-compatible; this pins that.
// ---------------------------------------------------------------------------

function mountToolDetail(
  tools: Record<string, ToolState>,
  columns: number,
  rows: number,
): { out: () => ToolDetailOverlayController } {
  const holder: { current: ToolDetailOverlayController | null } = { current: null };
  function Probe(): ReactElement {
    holder.current = useToolDetailOverlay({
      tools,
      dispatch: vi.fn(),
      closeOverlay: vi.fn(),
      columns,
      rows,
    });
    return <Text>probe</Text>;
  }
  render(<Probe />);
  return {
    out: () => {
      if (holder.current === null) throw new Error('hook return was not captured');
      return holder.current;
    },
  };
}

describe('useToolDetailOverlay — detail scroll clamp (retyped buildToolDetailLines)', () => {
  it('clamps a big downward scroll to the wrapped-line count minus the viewport', async () => {
    const columns = 80;
    const rows = 20;
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n'),
    };
    const probe = mountToolDetail({ tc1: tool }, columns, rows);
    await flushInk();
    probe.out().open();
    await flushInk();
    probe.out().accept(); // open the detail view pinned to tc1
    await flushInk();
    probe.out().move(10_000); // try to scroll far past the end
    await flushInk();

    const maxScroll = Math.max(
      0,
      buildToolDetailLines(tool, columns).length - toolDetailViewportRows(rows),
    );
    expect(maxScroll).toBeGreaterThan(0);
    expect(probe.out().scroll).toBe(maxScroll);
  });
});
