// tests/toolLines.test.tsx
// Wave-1 item C (tool-lines): tool calls render as COMPACT LINES, not bordered
// boxes. Covers arg humanization, the honest waiting-on-permission mapping driven
// through the real reducer, the claude-cli replay marker, and the no-box invariant.
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { humanizeArgs, humanizeResult, ToolCallCard } from '../src/ui/ToolCallCard';
import { Message } from '../src/ui/Message';
import { displayWidth } from '../src/ui/clipText';
import { initialState, reducer, type Msg, type State, type ToolState } from '../src/core/reducer';

const BOX_GLYPHS = /[╭╮╰╯│─┌┐└┘]/;

describe('humanizeArgs — one meaningful field per tool', () => {
  it('shell → command', () => {
    expect(humanizeArgs('run_shell', { command: 'npm test' })).toBe('npm test');
    expect(humanizeArgs('bash', { command: 'git status' })).toBe('git status');
  });

  it('write_file / edit_file / read_file → path', () => {
    expect(humanizeArgs('write_file', { path: 'src/a.ts', content: 'x' })).toBe('src/a.ts');
    expect(humanizeArgs('edit_file', { path: 'src/b.ts', oldString: 'a', newString: 'b' })).toBe('src/b.ts');
    expect(humanizeArgs('read_file', { path: 'src/c.ts' })).toBe('src/c.ts');
  });

  it('list_files → dir (defaults to ".")', () => {
    expect(humanizeArgs('list_files', { dir: 'src' })).toBe('src');
    expect(humanizeArgs('list_files', {})).toBe('.');
  });

  it('grep → pattern', () => {
    expect(humanizeArgs('grep', { pattern: 'TODO', dir: 'src' })).toBe('TODO');
  });

  it('MCP tool (mcp__…) → primary (first scalar) arg', () => {
    expect(humanizeArgs('mcp__brain__recall', { query: 'juno state', k: 5 })).toBe('juno state');
  });

  it('unknown tool → first STRING arg (claude-cli PascalCase Read/Glob/Edit/LS), not a raw JSON blob', () => {
    // The complaint's ugly cards: `Glob({...})` / `Read({...})` now condense to their salient arg.
    expect(humanizeArgs('Read', { file_path: 'src/app.tsx' })).toBe('src/app.tsx');
    expect(humanizeArgs('Glob', { pattern: 'src/**/*.ts' })).toBe('src/**/*.ts');
    expect(humanizeArgs('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toBe('a.ts');
    expect(humanizeArgs('LS', { path: '/tmp' })).toBe('/tmp');
  });

  it('unknown tool with NO string arg → one-line truncated JSON fallback (keyless numbers stay JSON)', () => {
    expect(humanizeArgs('mystery', { a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('truncates a long value to a single ellipsized line', () => {
    const long = 'x'.repeat(200);
    const out = humanizeArgs('run_shell', { command: long });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('\n');
  });
});

describe('humanizeResult — condensed result tails, never raw JSON on the card', () => {
  it('list_files → a file count, never the raw array', () => {
    expect(humanizeResult('list_files', ['a.txt', 'b.txt'])).toEqual({ text: '2 files', hidden: 0 });
    expect(humanizeResult('list_files', ['only.txt'])).toEqual({ text: '1 file', hidden: 0 });
  });

  it('write_file / edit_file → humanized outcome, never `skippedRealIo` verbatim', () => {
    expect(humanizeResult('write_file', { ok: true, skippedRealIo: true })).toEqual({
      text: 'ok · real io skipped',
      hidden: 0,
    });
    expect(humanizeResult('edit_file', { ok: false })).toEqual({ text: 'failed', hidden: 0 });
  });

  it('strings / content blocks / {summary} still condense to clean text', () => {
    expect(humanizeResult('read_file', 'line one\nline two').text).toBe('line one');
    expect(humanizeResult('Agent', [{ type: 'text', text: 'done' }]).text).toBe('done');
    expect(humanizeResult('spawn_subagent', { summary: 'wrapped up' }).text).toBe('wrapped up');
  });

  it('an unclaimed structured result never renders as a raw JSON blob', () => {
    // A generic object no humanizer claims → nothing (the glyph carries "done"); the full
    // structure is still reachable via Ctrl+O (toDisplay keeps the raw shape there).
    expect(humanizeResult('mystery', { a: 1, b: 2 })).toEqual({ text: '', hidden: 0 });
    // A generic array → a neutral count, never `["x","y"]`.
    expect(humanizeResult('mystery', ['x', 'y', 'z'])).toEqual({ text: '3 items', hidden: 0 });
  });
});

describe('tool lines — no bordered boxes (item C invariant)', () => {
  it('renders zero box-drawing glyphs across every state', () => {
    const states: ToolState[] = [
      { status: 'pending', name: 'read_file', args: { path: 'a.ts' } },
      { status: 'running', name: 'grep', args: { pattern: 'x' } },
      { status: 'result', name: 'read_file', args: { path: 'a.ts' }, result: 'ok' },
      { status: 'error', name: 'write_file', args: { path: 'a.ts' }, error: 'nope' },
    ];
    for (const tool of states) {
      const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
      expect(frame).not.toMatch(BOX_GLYPHS);
    }
  });
});

describe('honest state mapping — permission-open ⇒ waiting, never running', () => {
  // Build real reducer state: register a tool call, then open a permission prompt
  // for it. The tool status stays 'pending' (never flips to running) and the app
  // marks it via state.pendingPermissionToolCallId.
  function gatedState(): { live: Msg; tools: State['tools']; pending: string | null } {
    let s = initialState();
    s = reducer(s, { t: 'assistant-start', id: 'm1' });
    s = reducer(s, { t: 'tool-call', toolCallId: 'tc1', name: 'run_shell', args: { command: 'rm -rf /' } });
    s = reducer(s, { t: 'permission-open', toolCallId: 'tc1', name: 'run_shell', args: { command: 'rm -rf /' }, risk: 'dangerous' });
    return { live: s.live!, tools: s.tools, pending: s.pendingPermission?.toolCallId ?? null };
  }

  it('renders the gated tool line as amber `◌ …· waiting on permission`, with no spinner-driven running affordance', () => {
    const { live, tools, pending } = gatedState();
    expect(tools['tc1']!.status).toBe('pending'); // reducer never lied it was running
    const frame =
      render(
        <Message msg={live} depth="ansi16" tools={tools} pendingPermissionToolCallId={pending} />,
      ).lastFrame() ?? '';
    expect(frame).toContain('◌ run_shell(rm -rf /)');
    expect(frame).toContain('waiting on permission');
    // Not shown as running: no elapsed `· Ns` readout on the gated line.
    expect(frame).not.toMatch(/·\s*\d+s/);
  });

  it('a non-gated pending tool in the SAME message is unaffected', () => {
    const { live, tools, pending } = gatedState();
    // Add a second, ungated tool block.
    const live2: Msg = {
      ...live,
      blocks: [...live.blocks, { kind: 'tool', id: 'm1:block:9', toolCallId: 'tc2' }],
    };
    const tools2 = { ...tools, tc2: { status: 'pending', name: 'read_file', args: { path: 'a.ts' } } as ToolState };
    const frame =
      render(
        <Message msg={live2} depth="ansi16" tools={tools2} pendingPermissionToolCallId={pending} />,
      ).lastFrame() ?? '';
    // Only tc1 carries the waiting label; tc2 renders as a plain pending line.
    expect(frame).toContain('read_file(a.ts)');
    expect((frame.match(/waiting on permission/g) ?? []).length).toBe(1);
  });
});

describe('transcript — an aborted subagent spawn renders the neutral ⊘ row', () => {
  it('an interrupted subagent spawn is followed by the aborted status row (⊘ + reason), mirroring the panel', () => {
    // Build real reducer state: a spawn card that a turn-level Esc/Ctrl+C settled to
    // { status:'error', error:'interrupted' } (exactly what normalizeInterruptedTools writes).
    let s = initialState();
    s = reducer(s, { t: 'assistant-start', id: 'm1' });
    s = reducer(s, { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'audit the repo' } });
    s = reducer(s, { t: 'tool-status', toolCallId: 'p1', status: 'error', error: 'interrupted' });

    const frame = render(<Message msg={s.live!} depth="ansi16" tools={s.tools} />).lastFrame() ?? '';
    // The spawn card line is present…
    expect(frame).toContain('audit the repo');
    // …followed by the per-agent status row rendered as a CANCEL, not a failure: the neutral
    // ⊘ glyph (the aborted subagent SPAWN card now ALSO renders ⊘ — its glyph flipped from ✗
    // to ⊘ once the solo card routes through the shared classifier) plus the preserved abort
    // reason.
    expect(frame).toContain('⊘');
    expect(frame).toContain('interrupted');
  });
});

describe('plain (non-subagent) tool cards — abort/deny read neutral ⊘, never a red ✗', () => {
  it('a plain tool settled { status:error, error:interrupted } renders ⊘ + interrupted, no ✗', () => {
    const tool: ToolState = { status: 'error', name: 'shell', args: { command: 'sleep 100' }, error: 'interrupted' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(frame).toContain('⊘');
    expect(frame).toContain('interrupted');
    expect(frame).not.toContain('✗');
  });

  it('a plain tool settled { status:error, error:denied } renders ⊘ + denied, no ✗', () => {
    const tool: ToolState = { status: 'error', name: 'shell', args: { command: 'rm -rf /' }, error: 'denied' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(frame).toContain('⊘');
    expect(frame).toContain('denied');
    expect(frame).not.toContain('✗');
  });

  it('a GENUINE failure still renders the red ✗ cross (not reclassified)', () => {
    const tool: ToolState = { status: 'error', name: 'shell', args: { command: 'false' }, error: 'nope' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('nope');
    expect(frame).not.toContain('⊘');
  });
});

describe('delegate-CLI replay marker', () => {
  it('tags claude-cli replayed tool lines with `· via claude cli`', () => {
    const tool: ToolState = { status: 'result', name: 'read_file', args: { path: 'a.ts' }, result: 'ok' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" providerKind="claude-cli" />).lastFrame() ?? '';
    expect(frame).toContain('· via claude cli');
  });

  it('tags codex-cli replayed tool lines with `· via codex cli`', () => {
    const tool: ToolState = { status: 'result', name: 'shell', args: { command: 'ls' }, result: 'ok' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" providerKind="codex-cli" />).lastFrame() ?? '';
    expect(frame).toContain('· via codex cli');
    expect(frame).not.toContain('via claude cli');
  });

  it('leaves juno-executor (api) tools unmarked', () => {
    const tool: ToolState = { status: 'result', name: 'read_file', args: { path: 'a.ts' }, result: 'ok' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" providerKind="api" />).lastFrame() ?? '';
    expect(frame).not.toContain('via claude cli');
    expect(frame).not.toContain('via codex cli');
  });
});

// ---------------------------------------------------------------------------
// W5 — width-clip: the solo ToolCallCard bounds the WHOLE line to `columns - 1`
// DISPLAY CELLS on ONE terminal row when `columns` is present (never wrapping
// into Ink's scrollback-erase branch), and keeps its char-cap output byte-for-
// byte when `columns` is absent (the committed-fallback / unit-test path).
// ink-testing-library renders at 100 cols, so a card clipped to ≤ 40/30 cells
// lands on a single row there — the clip is measured in cells, not the surface.
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const rowsOf = (frame: string): string[] => frame.replace(/\n+$/, '').split('\n');
const widthsWithin = (frame: string, max: number): void => {
  for (const line of rowsOf(frame)) expect(displayWidth(stripSgr(line))).toBeLessThanOrEqual(max);
};

describe('ToolCallCard — width-clip to one terminal row (columns present)', () => {
  it('bounds a long name+args+result line to columns cells on a single row', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'src/' + 'deep/'.repeat(20) + 'widget.tsx' },
      result: 'x'.repeat(200),
    };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" columns={40} now={() => 0} />).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1); // never wraps into the erase-scrollback branch
    widthsWithin(frame, 40);
  });

  it('clips a wide-CJK args line in DISPLAY CELLS — a 2-cell glyph never overflows the budget', () => {
    const tool: ToolState = { status: 'running', name: 'grep', args: { pattern: '字'.repeat(60) } };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" columns={40} now={() => 0} />).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1);
    widthsWithin(frame, 40);
    expect(frame).toContain('grep(');
  });

  it('clips a wide-emoji error tail without splitting a surrogate pair or emitting a `�`', () => {
    const tool: ToolState = { status: 'error', name: 'grep', args: { pattern: 'x' }, error: '👍'.repeat(40) };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" columns={30} now={() => 0} />).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1);
    widthsWithin(frame, 30);
    expect(frame).not.toMatch(LONE_SURROGATE);
    expect(frame).not.toContain('�');
  });

  it('reserves the short semantic suffixes: `waiting on permission` + the `via` tag survive an args squeeze', () => {
    // The gated card compresses args first, but the waiting notice and the runtime tag are
    // reserved (never dropped) — the original hard-wrap-orphaning-`cli` bug on a full line.
    const tool: ToolState = { status: 'pending', name: 'write_file', args: { path: 'x'.repeat(90) } };
    const frame =
      render(
        <ToolCallCard tool={tool} depth="ansi16" columns={60} waitingOnPermission providerKind="claude-cli" now={() => 0} />,
      ).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1);
    expect(frame).toContain('waiting on permission');
    expect(frame).toContain('via claude cli');
    widthsWithin(frame, 60);
  });

  it('keeps the `via` tag on a FAILING card and still clips to one row', () => {
    const tool: ToolState = { status: 'error', name: 'grep', args: { pattern: 'p'.repeat(80) }, error: 'boom' };
    const frame =
      render(<ToolCallCard tool={tool} depth="ansi16" columns={50} providerKind="claude-cli" now={() => 0} />).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1);
    expect(frame).toContain('via claude cli');
    expect(frame).toContain('boom'); // the tail (reason) is clipped in, not dropped
    widthsWithin(frame, 50);
  });

  it('width-bounds a subagent SPAWN card (no tail) to one row', () => {
    const tool: ToolState = { status: 'running', name: 'spawn_subagent', args: { task: 'audit ' + 'x'.repeat(80) } };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" columns={50} now={() => 0} />).lastFrame() ?? '';
    expect(rowsOf(frame)).toHaveLength(1);
    expect(frame).toContain('spawn_subagent(');
    widthsWithin(frame, 50);
  });

  it('columns ABSENT ⇒ the char-cap path is unchanged (regression guard)', () => {
    // Content within the 60/48 char caps renders IN FULL when no width is threaded — proof the
    // width math never touched the width-less committed-fallback / unit-test path.
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'src/components/widget/thing.ts' },
      result: 'compiled successfully',
    };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(frame).toContain('read_file(src/components/widget/thing.ts)');
    expect(frame).toContain('compiled successfully');
  });
});

describe('Message — threads columns into the solo tool card (W5)', () => {
  it('clips a solo card at a narrow width, and leaves it unclipped when no columns is given', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'src/' + 'z'.repeat(90) + '.ts' },
      result: 'ok',
    };
    const msg: Msg = { id: 'm1', role: 'assistant', blocks: [{ kind: 'tool', id: 'm1:block:1', toolCallId: 'tc1' }], done: false };
    const tools = { tc1: tool };
    const clipped = render(<Message msg={msg} depth="ansi16" tools={tools} columns={40} />).lastFrame() ?? '';
    expect(rowsOf(clipped)).toHaveLength(1);
    widthsWithin(clipped, 40);
    // Width-less: the char-cap path renders the (60-cell-capped) args, which exceed 40 cells.
    const wide = render(<Message msg={msg} depth="ansi16" tools={tools} />).lastFrame() ?? '';
    expect(displayWidth(stripSgr(rowsOf(wide)[0] ?? ''))).toBeGreaterThan(40);
  });
});
