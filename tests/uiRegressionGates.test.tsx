import React from 'react';
import { render } from 'ink-testing-library';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Msg, ToolState } from '../src/core/reducer';
import type { StatusLineState, SubagentEntry } from '../src/core/selectors';
import { StatusLine } from '../src/ui/StatusLine';
import { GroupedToolRows, type GroupedToolEntry } from '../src/ui/GroupedToolRows';
import { PermissionPrompt } from '../src/ui/PermissionPrompt';
import { SubagentPanel } from '../src/ui/SubagentPanel';
import { SubagentViewer } from '../src/ui/SubagentViewer';
import { OverlayHost } from '../src/ui/OverlayHost';
import { LiveTurn } from '../src/ui/LiveTurn';
import { StreamingMessage } from '../src/ui/StreamingMessage';
import chalk from './helpers/inkChalk';

const ansi = (value: string): string => value.replace(/\u001b\[38;2;\d+;\d+;\d+m/gu, '<TRUECOLOR>');
const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/gu, '');
const noForbiddenFrames = (frames: readonly string[], forbidden: readonly RegExp[]): void => {
  for (const [index, frame] of frames.entries()) {
    for (const pattern of forbidden) expect(frame, `frame ${index} contains ${pattern}`).not.toMatch(pattern);
  }
};

const status: StatusLineState = {
  model: 'fable-mini', cwd: '/workspace/juno', effort: 'medium', skills: ['review'],
  contextWindow: { used: 48_500, max: 200_000, fraction: 0.2425, estimated: true },
  cost: { usd: 0.0123 }, permissionMode: 'acceptEdits', compactions: 1,
};
const roster: SubagentEntry[] = [
  { id: 'a1', name: 'spawn_subagent', description: 'review durability', model: 'fable', provider: 'claude-cli', status: 'running', childCount: 2, runningLabel: 'Reading src/app.tsx' },
  { id: 'a2', name: 'spawn_subagent', description: 'check tests', model: 'codex', provider: 'codex-cli', status: 'done', childCount: 3, runningLabel: '' },
];
const grouped: GroupedToolEntry[] = [
  { toolCallId: 't1', tool: { name: 'grep', args: { pattern: 'TODO' }, status: 'result', result: { matches: 12 } } },
  { toolCallId: 't2', tool: { name: 'write_file', args: { path: 'a.ts' }, status: 'running' } },
];

beforeAll(() => { chalk.level = 1; });
afterAll(() => { chalk.level = 0; });

describe('curated ANSI fixed-width baselines', () => {
  it('pins status and semantic grouped-tool lines at 80 columns', () => {
    const statusFrame = render(<StatusLine status={status} width={80} depth="ansi16" />).lastFrame() ?? '';
    const toolsFrame = render(<GroupedToolRows entries={grouped} columns={80} depth="ansi16" now={() => 1000} />).lastFrame() ?? '';
    expect(plain(statusFrame)).toContain('fable-mini · /workspace/juno');
    expect(plain(toolsFrame)).toContain('Searching for “TODO”');
    expect(plain(toolsFrame)).not.toContain('{"pattern"');
    expect(ansi(`${statusFrame}\n---\n${toolsFrame}`)).toMatchInlineSnapshot(`
      "[37mfable-mini · /workspace/juno · [92mctx ~48.5k (24%)[37m · [97mmedium[37m · skills:1[39m
      ---
      [96m⠋[97m 2 tools active · 1 running, 1 done[39m
        [92m✓[37m Searching for “TODO” · 12 matches[39m
        [96m⠋[37m Writing a.ts · 0s[39m"
    `);
  });

  it('pins permission, roster, viewer, and help overlays at curated widths', () => {
    const permission = render(<PermissionPrompt request={{ toolCallId: 'p1', name: 'write_file', args: { path: 'src/a.ts', content: 'hello' }, risk: 'risky' }} onDecision={vi.fn()} width={40} rows={24} />).lastFrame() ?? '';
    const panel = render(<SubagentPanel entries={roster} focused selectedIndex={0} width={80} maxRows={4} depth="ansi16" />).lastFrame() ?? '';
    const child: ToolState = { name: 'read_file', args: { path: 'src/app.tsx' }, status: 'result', result: 'ok', parentToolUseId: 'a1' };
    const viewer = render(<SubagentViewer entry={roster[0]} tools={{ child }} rows={24} width={80} scroll={0} depth="ansi16" />).lastFrame() ?? '';
    const help = render(<OverlayHost overlay="help" help={{ columns: 80, rows: 24, depth: 'ansi16' }} />).lastFrame() ?? '';
    expect(plain(permission)).toContain('permission required');
    expect(plain(panel)).toContain('enter open · m message');
    expect(plain(viewer)).toContain('Reading src/app.tsx');
    expect(plain(help)).toContain('keyboard shortcuts');
    expect(ansi([permission, panel, viewer, help].join('\n---\n'))).toMatchInlineSnapshot(`
      "[93m╭──────────────────────────────────────╮[39m
      [93m│[39m [1m[93m⚠ permission required[39m[22m                [93m│[39m
      [93m│[39m [1m[97mwrite_file[39m[22m [37mrisk:[39m [1m[93mrisky[39m[22m               [93m│[39m
      [93m│[39m [37m@ write src/a.ts (new content)[39m       [93m│[39m
      [93m│[39m [92m+ hello[39m                              [93m│[39m
      [93m│[39m [97m[y] allow once   [a] always allow   [39m [93m│[39m
      [93m│[39m [97m[d] deny   [!] dangerous bypass · [39m   [93m│[39m
      [93m│[39m [97mesc abort turn[39m                       [93m│[39m
      [93m╰──────────────────────────────────────╯[39m
      ---
      [96m▾ agents[39m
      [96m› ◐[37m review durability  fable · via claude cli · Reading src/app.tsx[39m
      [37m  [92m✓[37m check tests  codex · via codex cli · 3 steps[39m
      [37m↑↓ select · enter open · m message · x cancel · esc collapse[39m
      ---
      [90m╭──────────────────────────────────────────────────────────────────────────────────────────────────╮[39m
      [90m│[39m [96mreview durability[39m                                                                                [90m│[39m
      [90m│[39m [37mrunning · fable · via claude cli[39m                                                                 [90m│[39m
      [90m│[39m [92m✓[97m Reading src/app.tsx[37m  1 line[39m                                                                    [90m│[39m
      [90m│[39m [37m↑↓ scroll · m message · x cancel · esc back[39m                                                      [90m│[39m
      [90m╰──────────────────────────────────────────────────────────────────────────────────────────────────╯[39m
      ---
      [90m╭──────────────────────────────────────────────────────────────────────────────╮[39m
      [90m│[39m [37mkeyboard shortcuts[39m                                                           [90m│[39m
      [90m│[39m [37m [39m [97mEsc[39m [37mAbort turn (including permission) / close overlay[39m                      [90m│[39m
      [90m│[39m [37m [39m [97mCtrl+C[39m [37mAbort turn / press twice to exit[39m                                    [90m│[39m
      [90m│[39m [37m [39m [97mTab[39m [37mCycle effort level[39m                                                     [90m│[39m
      [90m│[39m [37m [39m [97m/[39m [37mOpen the command palette (empty input)[39m                                   [90m│[39m
      [90m│[39m [37m [39m [97m?[39m [37mShow this help (empty input)[39m                                             [90m│[39m
      [90m│[39m [37m [39m [97m↓[39m [37mFocus agents when history is at newest[39m                                   [90m│[39m
      [90m│[39m [37m [39m [97mCtrl+O[39m [37mOpen the tool-call detail overlay[39m                                   [90m│[39m
      [90m│[39m [37m [39m [97m↑ ↓ Enter[39m [37mNavigate / accept in pickers[39m                                     [90m│[39m
      [90m│[39m [37m [39m [97my a d ![39m [37mPermission prompt: once / always / deny / bypass[39m                   [90m│[39m
      [90m│[39m [37m [39m [97mCtrl+A / Ctrl+E[39m [37mMove to line start / end[39m                                   [90m│[39m
      [90m│[39m [37m↓ 2 more[39m                                                                     [90m│[39m
      [90m│[39m [37mesc close[39m                                                                    [90m│[39m
      [90m╰──────────────────────────────────────────────────────────────────────────────╯[39m"
    `);
  });
});

describe('forbidden transient frames', () => {
  it('thinking → text never paints both activity labels or serialized state', () => {
    const activity = render(<LiveTurn activity={{ label: 'thinking…', abortable: true, attention: false }} now={() => 1000} />);
    activity.rerender(<LiveTurn activity={{ label: 'responding…', abortable: true, attention: false }} now={() => 1000} />);
    const text: Msg = { id: 'm', role: 'assistant', blocks: [{ kind: 'text', id: 'b', text: 'Ready.' }], done: false };
    const message = render(<StreamingMessage live={text} columns={80} depth="ansi16" />);
    noForbiddenFrames([...activity.frames, ...message.frames], [/thinking….*responding…/su, /\[object Object\]/u, /\{"blocks":/u]);
    expect(plain(message.lastFrame() ?? '')).toContain('Ready.');
  });

  it('sequential tools never misreport parallel execution or leak args during handoff', () => {
    const first = grouped.map((item, index) => index === 0 ? { ...item, tool: { ...item.tool, status: 'running' as const } } : { ...item, tool: { ...item.tool, status: 'pending' as const } });
    const view = render(<GroupedToolRows entries={first} columns={80} depth="ansi16" now={() => 1000} />);
    view.rerender(<GroupedToolRows entries={grouped} columns={80} depth="ansi16" now={() => 1000} />);
    noForbiddenFrames(view.frames, [/2 running/u, /\{"(?:pattern|path)":/u, /undefined/u]);
    expect(plain(view.lastFrame() ?? '')).toContain('1 running, 1 done');
  });

  it('permission resolution never leaves prompt and resolved content in one frame', () => {
    const prompt = <PermissionPrompt request={{ toolCallId: 'p', name: 'write_file', args: { path: 'a.ts' }, risk: 'risky' }} onDecision={vi.fn()} width={40} />;
    const view = render(prompt);
    view.rerender(<StreamingMessage live={{ id: 'm', role: 'assistant', blocks: [{ kind: 'text', id: 'b', text: 'Permission accepted.' }], done: false }} columns={40} />);
    noForbiddenFrames(view.frames, [/permission required[\s\S]*Permission accepted\./u, /\{"path":/u]);
  });

  it('resumed and steered turns never expose persistence envelopes or duplicate live chrome', () => {
    const resumed: Msg = { id: 'resume-a', role: 'assistant', blocks: [{ kind: 'text', id: 'resume-b', text: 'Resumed answer.' }], done: false };
    const steered: Msg = { id: 'steer-a', role: 'assistant', blocks: [{ kind: 'text', id: 'steer-b', text: 'Adjusted direction.' }], done: false };
    const view = render(<StreamingMessage live={resumed} columns={80} />);
    view.rerender(<StreamingMessage live={steered} columns={80} />);
    noForbiddenFrames(view.frames, [/transcriptEpoch/u, /pendingPermission/u, /\{"role":/u, /thinking….*thinking…/su]);
    expect(plain(view.lastFrame() ?? '')).toContain('Adjusted direction.');
  });
});
