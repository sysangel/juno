// tests/statusStrip.test.tsx
// Wave-1 item D — status-strip + composer + banner. Regression/acceptance tests
// for the boxed-header → single-dim-line redesign, the live turn area, the
// welcome banner, and the composer placeholder fix. Each asserts a behavior that
// FAILS on the pre-wave presentation.
import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../src/core/reducer';
import { reducer } from '../src/core/reducer';
import { selectActivity, selectStatusLine, type McpConnectionState } from '../src/core/selectors';
import { StatusLine, buildStatusChips, layoutStatusChips, type StatusChip } from '../src/ui/StatusLine';
import { LiveTurn } from '../src/ui/LiveTurn';
import { Banner } from '../src/ui/Banner';
import { InputBox, ComposerRule } from '../src/ui/InputBox';
import { abbreviateHome, basename } from '../src/ui/paths';
import { DEFAULT_SETTINGS } from '../src/services/config';

const baseState: State = {
  committed: [],
  live: null,
  tools: {},
  phase: 'idle',
  overlay: 'none',
  effort: 'medium',
  permissionMode: 'default',
  tokens: { in: 0, out: 0 },
  pendingPermission: null,
  errorMessage: null,
};

const liveMsg = (text: string): Msg => ({
  id: 'a1',
  role: 'assistant',
  blocks: text.length > 0 ? [{ kind: 'text', id: 'a1:block:1', text }] : [],
  done: false,
});

describe('selectActivity (live turn area — honest phase mapping)', () => {
  it('is null when idle or errored (nothing in flight)', () => {
    expect(selectActivity(baseState)).toBeNull();
    expect(selectActivity({ ...baseState, phase: 'error', errorMessage: 'boom' })).toBeNull();
  });

  it('streaming with no visible text yet → thinking…', () => {
    const a = selectActivity({ ...baseState, phase: 'streaming', live: liveMsg('') });
    expect(a?.label).toBe('thinking…');
    expect(a?.abortable).toBe(true);
    expect(a?.attention).toBe(false);
  });

  it('streaming once the live message has prose → responding…', () => {
    const a = selectActivity({ ...baseState, phase: 'streaming', live: liveMsg('Hello') });
    expect(a?.label).toBe('responding…');
  });

  it('running-tool names the running tool', () => {
    const tools: Record<string, ToolState> = {
      t1: { status: 'running', name: 'grep', args: {} },
    };
    const a = selectActivity({ ...baseState, phase: 'running-tool', tools });
    expect(a?.label).toBe('running grep…');
  });

  it('awaiting-permission is the amber "waiting on permission" state — never shown as running', () => {
    const a = selectActivity({ ...baseState, phase: 'awaiting-permission' });
    expect(a?.label).toBe('waiting on permission');
    expect(a?.attention).toBe(true);
  });
});

describe('LiveTurn (single spinner home + elapsed + esc-to-abort)', () => {
  it('renders nothing while idle', () => {
    const frame = render(<LiveTurn activity={null} />).lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('shows the busy label, elapsed seconds, and the abort hint', () => {
    const now = () => 4000; // fixed clock → 0s at first render
    const frame =
      render(<LiveTurn activity={{ label: 'thinking…', abortable: true, attention: false }} now={now} />)
        .lastFrame() ?? '';
    expect(frame).toContain('thinking…');
    expect(frame).toContain('0s');
    expect(frame).toContain('esc to abort');
  });

  it('permission-wait shows the ◌ glyph and no elapsed clock (measures the user, not the model)', () => {
    const frame =
      render(
        <LiveTurn activity={{ label: 'waiting on permission', abortable: true, attention: true }} />,
      ).lastFrame() ?? '';
    expect(frame).toContain('◌');
    expect(frame).toContain('waiting on permission');
    expect(frame).toContain('esc to abort');
    expect(frame).not.toMatch(/\d+s/); // no elapsed readout in the wait state
  });
});

describe('StatusLine chip model (buildStatusChips / layoutStatusChips)', () => {
  it('assigns the spec drop order: skills < ctx < cwd < effort, and never drops model', () => {
    const status = selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      { model: 'm', cwd: '/w', maxContext: 200_000, skills: ['a', 'b'] },
    );
    const byKey = Object.fromEntries(buildStatusChips(status).map((c) => [c.key, c]));
    expect(byKey.model?.dropRank).toBeUndefined(); // anchor, never dropped
    expect(byKey.skills!.dropRank!).toBeLessThan(byKey.ctx!.dropRank!);
    expect(byKey.ctx!.dropRank!).toBeLessThan(byKey.cwd!.dropRank!);
    expect(byKey.cwd!.dropRank!).toBeLessThan(byKey.effort!.dropRank!);
  });

  it('drops whole chips by rank to fit — shrinking cwd to its basename before dropping it', () => {
    const chips: StatusChip[] = [
      { key: 'model', text: 'model', color: 'accent' },
      { key: 'cwd', text: '/a/very/long/path', color: 'textDim', dropRank: 6, shrink: 'path' },
      { key: 'ctx', text: 'ctx 1k (1%)', color: 'success', dropRank: 5 },
      { key: 'effort', text: 'medium', color: 'text', dropRank: 7 },
      { key: 'skills', text: 'skills:2', color: 'info', dropRank: 4 },
    ];
    const keysAt = (w: number): string[] => layoutStatusChips(chips, w).map((c) => c.key);
    const textAt = (w: number, key: string): string | undefined =>
      layoutStatusChips(chips, w).find((c) => c.key === key)?.text;

    // Wide: everything survives, cwd at full length.
    expect(keysAt(1000)).toEqual(['model', 'cwd', 'ctx', 'effort', 'skills']);
    expect(textAt(1000, 'cwd')).toBe('/a/very/long/path');

    // Tightening drops skills first (lowest rank among the core chips).
    expect(keysAt(50)).not.toContain('skills');
    expect(keysAt(50)).toContain('ctx');

    // Tighter still drops ctx; cwd shrinks to its basename rather than vanishing.
    expect(keysAt(25)).not.toContain('ctx');
    expect(textAt(25, 'cwd')).toBe('path');

    // At the extreme only the never-dropped model remains.
    expect(keysAt(3)).toEqual(['model']);
  });

  it('never wraps: the strip is a single line at both narrow and wide widths', () => {
    const status = selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      { model: 'a-fairly-long-model-name', cwd: '/some/deep/nested/path', maxContext: 200_000, skills: ['a'] },
    );
    const lines = (w: number): number =>
      (render(<StatusLine status={status} width={w} />).lastFrame() ?? '').split('\n').length;
    expect(lines(20)).toBe(1);
    expect(lines(120)).toBe(1);
  });

  // Enumerated acceptance fixture: 80-col. The spec's acceptance list names an
  // 80-column snapshot; the width table above covers 20/25/50/120/1000 but not 80.
  // A full chip set (model · cwd · ctx · effort · skills) with a long cwd at width 80
  // must stay a SINGLE line, keeping the core chips (model · cwd · ctx · effort) and
  // shedding only the lowest-rank chip (skills) — never wrapping, never truncating a chip.
  it('80-col: a full chip set with a long cwd stays one line, keeping the core chips', () => {
    const status = selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      {
        model: DEFAULT_SETTINGS.defaultModel,
        cwd: '/srv/projects/juno-ui/status-strip',
        maxContext: 200_000,
        skills: ['a', 'b'],
      },
    );

    // Pure layout: at 80 cols the four core chips survive; only skills (lowest rank) drops.
    const survivors = layoutStatusChips(buildStatusChips(status), 80).map((c) => c.key);
    expect(survivors).toEqual(['model', 'cwd', 'ctx', 'effort']);

    // Rendered: exactly one line, core chips present, the dropped skills chip absent.
    const frame = render(<StatusLine status={status} width={80} />).lastFrame() ?? '';
    expect(frame.split('\n').length).toBe(1);
    expect(frame).toContain(DEFAULT_SETTINGS.defaultModel);
    expect(frame).toContain('/srv/projects/juno-ui/status-strip');
    expect(frame).toContain('ctx 50k (25%)');
    expect(frame).toContain('medium');
    expect(frame).not.toContain('skills:');
  });

  // Enumerated acceptance fixture: after-clear. Guards the stale-counter-after-clear
  // tour bug at the STRIP boundary (not just the reducer). {t:'clear'} now (E) RESETS
  // cumulative `tokens`, resets contextWindowTokens, and empties committed — so the
  // live-occupancy ctx chip MUST vanish and any token-derived readout zeroes out.
  it('after-clear: the ctx chip is gone and only model · cwd · effort remain', () => {
    const context = { model: DEFAULT_SETTINGS.defaultModel, cwd: '/srv/projects/juno-ui', maxContext: 200_000 };

    // Pre-clear: a real window measurement is present → the ctx chip is visible.
    const before: State = { ...baseState, contextWindowTokens: 50_000, tokens: { in: 12_000, out: 8_000 } };
    const beforeChips = buildStatusChips(selectStatusLine(before, context)).map((c) => c.key);
    expect(beforeChips).toContain('ctx');

    // Apply {t:'clear'} through the real reducer, then render the strip from the result.
    const cleared = reducer(before, { t: 'clear' });
    expect(cleared.contextWindowTokens).toBeUndefined(); // measurement reset
    expect(cleared.tokens).toEqual({ in: 0, out: 0 }); // cumulative tokens RESET (E)

    const clearedStatus = selectStatusLine(cleared, context);
    expect(buildStatusChips(clearedStatus).map((c) => c.key)).toEqual(['model', 'cwd', 'effort']);

    const frame = render(<StatusLine status={clearedStatus} />).lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_SETTINGS.defaultModel);
    expect(frame).toContain('/srv/projects/juno-ui');
    expect(frame).toContain('medium');
    expect(frame).not.toContain('ctx'); // no live-occupancy chip after clear
  });

  it('home-abbreviates the cwd chip to ~', () => {
    const home = '/Users/tester';
    const status = selectStatusLine(baseState, { model: 'm', cwd: `${home}/src/juno` });
    // abbreviateHome reads $HOME; set it for this render.
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
      expect(frame).toContain('~/src/juno');
      expect(frame).not.toContain('/Users/tester');
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('StatusLine uniform-dim (E: model + skills go textDim, model loses its bold)', () => {
  const statusFor = (skills?: string[]): ReturnType<typeof selectStatusLine> =>
    selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      { model: DEFAULT_SETTINGS.defaultModel, cwd: '/w', maxContext: 200_000, skills },
    );

  it('renders the model chip as textDim, not the brand accent', () => {
    const model = buildStatusChips(statusFor()).find((c) => c.key === 'model');
    expect(model?.color).toBe('textDim'); // was 'accent'
  });

  it('renders the skills chip as textDim, not info', () => {
    const skills = buildStatusChips(statusFor(['a', 'b'])).find((c) => c.key === 'skills');
    expect(skills?.color).toBe('textDim'); // was 'info'
  });

  it('emits no bold SGR — the model chip anchor is no longer bolded', () => {
    const priorLevel = chalk.level;
    chalk.level = 3; // truecolor → ink emits real SGR escapes, so a bold code would surface
    try {
      const frame = render(<StatusLine status={statusFor(['a'])} depth="truecolor" />).lastFrame() ?? '';
      expect(frame).toContain(DEFAULT_SETTINGS.defaultModel); // the model text is present…
      expect(frame).not.toContain('[1m'); // …but never wrapped in a bold SGR
    } finally {
      chalk.level = priorLevel;
    }
  });
});

describe('StatusLine mcp chip (async-mcp connect state)', () => {
  // ctx present (a real window measurement) so the chip set is realistic and the
  // "drops first" layout assertion has a higher-rank neighbor to compare against.
  const withMcp = (mcp: McpConnectionState | undefined): ReturnType<typeof selectStatusLine> =>
    selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      { model: 'm', cwd: '/w', maxContext: 200_000, mcp },
    );
  const mcpChip = (mcp: McpConnectionState | undefined): StatusChip | undefined =>
    buildStatusChips(withMcp(mcp)).find((c) => c.key === 'mcp');

  it('shows an amber mcp:connecting… chip while the fleet connects in the background', () => {
    const chip = mcpChip({ state: 'connecting', connected: 0, total: 2 });
    expect(chip).toBeDefined();
    expect(chip?.text).toBe('mcp:connecting…');
    expect(chip?.color).toBe('warning'); // amber — state-carrying, not textDim
    expect(chip?.dropRank).toBe(0);
  });

  it('shows an amber partial chip with connected/total counts', () => {
    const chip = mcpChip({ state: 'partial', connected: 1, total: 2 });
    expect(chip?.text).toBe('mcp:1/2');
    expect(chip?.color).toBe('warning');
  });

  it('shows a red mcp:failed chip when no configured server connected', () => {
    const chip = mcpChip({ state: 'failed', connected: 0, total: 2 });
    expect(chip?.text).toBe('mcp:failed');
    expect(chip?.color).toBe('error');
  });

  it('elevates the drop-rank in an ERROR state (partial/failed) so an outage stays visible; connecting stays first-shed', () => {
    // A benign connecting chip is transient chrome → first shed (dropRank 0). A real
    // outage (partial/failed) must survive narrow widths above the auxiliaries + skills/
    // ctx, so it ranks 6 (below effort=7, which drops last).
    expect(mcpChip({ state: 'connecting', connected: 0, total: 2 })?.dropRank).toBe(0);
    expect(mcpChip({ state: 'partial', connected: 1, total: 2 })?.dropRank).toBe(6);
    expect(mcpChip({ state: 'failed', connected: 0, total: 2 })?.dropRank).toBe(6);
    // The error chip outranks the auxiliary + core-count chips (they shed first), but
    // effort still drops last.
    const chips = buildStatusChips(withMcp({ state: 'failed', connected: 0, total: 2 }));
    const mcp = chips.find((c) => c.key === 'mcp')!;
    const effort = chips.find((c) => c.key === 'effort')!;
    expect(mcp.dropRank!).toBeLessThan(effort.dropRank!);
    const ctx = chips.find((c) => c.key === 'ctx')!;
    expect(mcp.dropRank!).toBeGreaterThan(ctx.dropRank!);
  });

  it('renders NO chip once the fleet is fully ready (silent happy path)', () => {
    expect(mcpChip({ state: 'ready', connected: 2, total: 2 })).toBeUndefined();
  });

  it('renders no mcp chip when MCP is not configured (status.mcp undefined)', () => {
    expect(mcpChip(undefined)).toBeUndefined();
  });

  it('is state-carrying color (exempt from the uniform-dim rule) — never textDim', () => {
    expect(mcpChip({ state: 'connecting', connected: 0, total: 1 })?.color).not.toBe('textDim');
    expect(mcpChip({ state: 'partial', connected: 1, total: 3 })?.color).not.toBe('textDim');
    expect(mcpChip({ state: 'failed', connected: 0, total: 1 })?.color).not.toBe('textDim');
  });

  it('has the lowest drop-rank of any visible chip → sheds first on narrow widths', () => {
    const chips = buildStatusChips(withMcp({ state: 'connecting', connected: 0, total: 2 }));
    const mcp = chips.find((c) => c.key === 'mcp');
    expect(mcp?.dropRank).toBe(0);
    for (const c of chips) {
      if (c.key === 'mcp' || c.dropRank === undefined) continue;
      expect(mcp!.dropRank!).toBeLessThan(c.dropRank);
    }
    // In the actual layout, a width that forces a drop sheds mcp while the anchor stays.
    const survivors = layoutStatusChips(chips, 30).map((c) => c.key);
    expect(survivors).not.toContain('mcp');
    expect(survivors).toContain('model');
  });

  it('does not disturb the existing chip set when mcp is absent (after-clear invariant holds)', () => {
    // Regression guard: adding the mcp field must not change chips when unconfigured.
    const keys = buildStatusChips(
      selectStatusLine({ ...baseState, contextWindowTokens: 50_000 }, { model: 'm', cwd: '/w', maxContext: 200_000 }),
    ).map((c) => c.key);
    expect(keys).toEqual(['model', 'cwd', 'ctx', 'effort']);
  });
});

describe('paths helpers', () => {
  it('abbreviateHome rewrites only a boundary home prefix', () => {
    expect(abbreviateHome('/Users/a/src/juno', '/Users/a')).toBe('~/src/juno');
    expect(abbreviateHome('/Users/a', '/Users/a')).toBe('~');
    expect(abbreviateHome('/Users/ab/x', '/Users/a')).toBe('/Users/ab/x'); // not a boundary match
    expect(abbreviateHome('/etc/hosts', '/Users/a')).toBe('/etc/hosts');
  });

  it('basename returns the trailing segment', () => {
    expect(basename('~/src/juno')).toBe('juno');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('/')).toBe('/');
  });
});

describe('Banner (welcome, fresh start)', () => {
  it('renders the ≤4-line version/model/cwd/hint banner', () => {
    const frame =
      render(<Banner version="0.1.0" model={DEFAULT_SETTINGS.defaultModel} cwd="/work" />).lastFrame() ?? '';
    expect(frame).toContain('juno v0.1.0');
    expect(frame).toContain(DEFAULT_SETTINGS.defaultModel);
    expect(frame).toContain('/ commands · ? shortcuts');
    expect(frame.split('\n').length).toBeLessThanOrEqual(4);
  });
});

describe('InputBox composer placeholder (cursor drawn OVER the first cell — no column jiggle)', () => {
  it('anchors the placeholder at the SAME column whether the composer is focused or not', () => {
    // Focused: the cursor is drawn OVER the first placeholder char (inverse), NOT as a spacer
    // block shoved in front of it — so with colors off the row is `❯ Message Juno` (ONE space).
    const focused =
      render(<InputBox value="" onChange={() => {}} onSubmit={() => {}} placeholder="Message Juno" focus />)
        .lastFrame() ?? '';
    // Unfocused (e.g. the agents dropdown holds focus): the whole placeholder is dim, no cursor.
    const unfocused =
      render(<InputBox value="" onChange={() => {}} onSubmit={() => {}} placeholder="Message Juno" focus={false} />)
        .lastFrame() ?? '';
    // Both render the placeholder at the same column — the pre-fix cursor block inserted a
    // spacer cell only when focused, so the text jumped `❯ Message Juno` → `❯  Message Juno`.
    expect(focused).toContain('❯ Message Juno');
    expect(unfocused).toContain('❯ Message Juno');
    expect(focused).not.toContain('❯  Message Juno');
    expect(unfocused).not.toContain('❯  Message Juno');
  });

  it('still shows the bare cursor block when empty+focused with NO placeholder', () => {
    // No placeholder ⇒ the composer keeps its own empty-value cursor block (showCursor true).
    const frame =
      render(<InputBox value="" onChange={() => {}} onSubmit={() => {}} focus />).lastFrame() ?? '';
    expect(frame).toContain('❯');
  });

  it('hides the placeholder once the composer has text', () => {
    const frame =
      render(<InputBox value="hi" onChange={() => {}} onSubmit={() => {}} placeholder="Message Juno" />)
        .lastFrame() ?? '';
    expect(frame).toContain('hi');
    expect(frame).not.toContain('Message Juno');
  });
});

describe('ComposerRule (composer-framing hairlines + mode tag)', () => {
  // Interior rows only — the trailing framebuffer newline is dropped so a bare
  // single-row rule reads as one line.
  const rowsOf = (frame: string): string[] => frame.replace(/\n+$/, '').split('\n');

  it('renders a dim horizontal hairline — a single row, never a full border box', () => {
    const frame = render(<ComposerRule width={40} />).lastFrame() ?? '';
    expect(frame).toContain('─');
    // A rule, not a box: no vertical sides or corners.
    expect(frame).not.toMatch(/[│╭╮╰╯┌┐└┘]/);
    expect(rowsOf(frame)).toHaveLength(1);
  });

  it('right-anchors the current mode tag on the (top) rule for a non-default mode', () => {
    const frame = render(<ComposerRule width={40} mode="acceptEdits" />).lastFrame() ?? '';
    expect(frame).toContain('mode:acceptEdits');
    const row = rowsOf(frame)[0] ?? '';
    // Dashes fill the LEFT, the tag rides the RIGHT edge (dashes precede the tag).
    expect(row.startsWith('─')).toBe(true);
    expect(row.lastIndexOf('─')).toBeLessThan(row.indexOf('mode:'));
    expect(rowsOf(frame)).toHaveLength(1);
  });

  it('shows a bare hairline (no tag) for the default mode — the silent happy path', () => {
    const frame = render(<ComposerRule width={40} mode="default" />).lastFrame() ?? '';
    expect(frame).toContain('─');
    expect(frame).not.toContain('mode:');
  });

  it('shows a bare hairline (no tag) when no mode is given (the bottom rule)', () => {
    const frame = render(<ComposerRule width={40} />).lastFrame() ?? '';
    expect(frame).toContain('─');
    expect(frame).not.toContain('mode:');
  });

  it('spaceAbove prepends exactly one blank line (the single transcript↔composer gap)', () => {
    const withGap = render(<ComposerRule width={40} spaceAbove />).lastFrame() ?? '';
    const noGap = render(<ComposerRule width={40} />).lastFrame() ?? '';
    // One extra leading row over the bare rule, and it is blank.
    expect(withGap.split('\n').length).toBe(noGap.split('\n').length + 1);
    expect(withGap.startsWith('\n')).toBe(true);
  });

  it('stays a single row across widths so a resize can never grow the line count', () => {
    const wide = render(<ComposerRule width={60} mode="acceptEdits" />).lastFrame() ?? '';
    const narrow = render(<ComposerRule width={30} mode="acceptEdits" />).lastFrame() ?? '';
    expect(rowsOf(wide)).toHaveLength(1);
    expect(rowsOf(narrow)).toHaveLength(1);
  });
});
