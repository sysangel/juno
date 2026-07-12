// tests/subagentBrowser.test.tsx
// LANE B — the subagent-browser panel. Covers: the pure selectors that roll `state.tools`
// into browsable subagents + one subagent's transcript; the reducer's 'subagents' overlay
// variant; the SubagentPanel strip (collapsed + focused, both themes) and the
// SubagentTranscriptOverlay; the useKeybinds 'subagents' branch; the composer down-arrow
// focus handoff; and an App-level drive of the full down → enter → esc → esc loop against a
// scripted fake subagent turn.
import { useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { App, type AppDeps } from '../src/app';
import { InputBox } from '../src/ui/InputBox';
import { SubagentPanel } from '../src/ui/SubagentPanel';
import { SubagentTranscriptOverlay } from '../src/ui/SubagentTranscriptOverlay';
import { useKeybinds } from '../src/hooks/useKeybinds';
import {
  initialState,
  reducer,
  type Action,
  type State,
  type ToolState,
} from '../src/core/reducer';
import {
  isSubagentToolName,
  selectSubagents,
  selectSubagentTranscript,
  type SubagentEntry,
} from '../src/core/selectors';
import { setActiveTheme } from '../src/ui/theme';
import { FakeModelClient } from '../src/core/fakeClient';
import type { ModelClient } from '../src/core/contracts';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService, type Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press, waitFor } from './helpers/ink';

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ENTER = String.fromCharCode(13);

afterEach(() => setActiveTheme('dark'));

/** Drive the real reducer through an action script; return the resulting state. */
function drive(actions: Action[]): State {
  return actions.reduce((s, a) => reducer(s, a), initialState());
}

/** A parent spawn + two children (one of them still running) — the canonical fixture. */
function subagentState(): State {
  return drive([
    { t: 'assistant-start', id: 'm1' },
    { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'summarize the repo', model: 'fable-mini' } },
    { t: 'tool-status', toolCallId: 'p1', status: 'running' },
    { t: 'tool-call', toolCallId: 'c1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'p1' },
    { t: 'tool-status', toolCallId: 'c1', status: 'result', result: ['a.ts', 'b.ts'] },
    { t: 'tool-call', toolCallId: 'c2', name: 'run_shell', args: { command: 'echo hi' }, parentToolUseId: 'p1' },
    { t: 'tool-status', toolCallId: 'c2', status: 'running' },
  ]);
}

// ---------------------------------------------------------------------------
// selectors
// ---------------------------------------------------------------------------

describe('selectSubagents / selectSubagentTranscript (pure)', () => {
  it('isSubagentToolName matches Agent / Task / spawn_subagent (case-insensitive), nothing else', () => {
    expect(isSubagentToolName('Agent')).toBe(true);
    expect(isSubagentToolName('task')).toBe(true);
    expect(isSubagentToolName('spawn_subagent')).toBe(true);
    expect(isSubagentToolName('Bash')).toBe(false);
    expect(isSubagentToolName('run_shell')).toBe(false);
  });

  it('rolls a spawn card + its children into one entry (description, model, status, childCount)', () => {
    const entries = selectSubagents(subagentState());
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.id).toBe('p1');
    expect(e.name).toBe('spawn_subagent');
    expect(e.description).toBe('summarize the repo');
    expect(e.model).toBe('fable-mini');
    // The parent card is still 'running' → the subagent rolls up as running.
    expect(e.status).toBe('running');
    // Two direct children.
    expect(e.childCount).toBe(2);
    // A running child exists → the rollup names the newest running descendant.
    expect(e.runningLabel).toBe('running run_shell…');
  });

  it('reports a settled subagent as done, and a failed parent as error', () => {
    const done = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'Agent', args: { subagent_type: 'reviewer' } },
        { t: 'tool-call', toolCallId: 'c1', name: 'Bash', args: {}, parentToolUseId: 'p1' },
        { t: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' },
        { t: 'tool-status', toolCallId: 'p1', status: 'result', result: 'done' },
      ]),
    );
    expect(done[0]).toMatchObject({ id: 'p1', status: 'done', model: 'reviewer', childCount: 1 });

    const failed = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'Task', args: {} },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: 'boom' },
      ]),
    );
    // A subagent with no children yet still lists (named like a spawn), status error.
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: 'p1', status: 'error', childCount: 0 });
  });

  it('returns no subagents for a plain (non-subagent) tool turn', () => {
    const plain = drive([
      { t: 'assistant-start', id: 'm1' },
      { t: 'tool-call', toolCallId: 't1', name: 'run_shell', args: { command: 'ls' } },
      { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'ok' },
    ]);
    expect(selectSubagents(plain)).toEqual([]);
  });

  it('selectSubagentTranscript returns the subagent descendants in creation order', () => {
    const rows = selectSubagentTranscript(subagentState(), 'p1');
    expect(rows.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(rows[0]!.tool.name).toBe('list_files');
    expect(rows[1]!.tool.name).toBe('run_shell');
  });
});

// ---------------------------------------------------------------------------
// reducer overlay variant
// ---------------------------------------------------------------------------

describe("reducer 'subagents' overlay variant", () => {
  it('opens and closes the subagents overlay', () => {
    const opened = reducer(initialState(), { t: 'set-overlay', overlay: 'subagents' });
    expect(opened.overlay).toBe('subagents');
    const closed = reducer(opened, { t: 'set-overlay', overlay: 'none' });
    expect(closed.overlay).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// SubagentPanel render (both themes)
// ---------------------------------------------------------------------------

const THEMES = ['dark', 'light'] as const;

const runningEntry: SubagentEntry = {
  id: 'p1',
  name: 'spawn_subagent',
  description: 'summarize the repo',
  model: 'fable-mini',
  status: 'running',
  childCount: 2,
  runningLabel: 'running run_shell…',
};
const doneEntry: SubagentEntry = {
  id: 'p2',
  name: 'Agent',
  description: 'review the diff',
  status: 'done',
  childCount: 3,
  runningLabel: 'working…',
};

describe('SubagentPanel', () => {
  it('renders NOTHING when the session has no subagents', () => {
    const { lastFrame } = render(
      <SubagentPanel entries={[]} focused={false} selectedIndex={-1} width={80} depth="ansi16" />,
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it.each(THEMES)('[%s] collapsed: one dim line with running/done counts', (bg) => {
    setActiveTheme(bg);
    const { lastFrame } = render(
      <SubagentPanel
        entries={[runningEntry, doneEntry]}
        focused={false}
        selectedIndex={0}
        width={80}
        depth="ansi16"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▾ agents');
    expect(frame).toContain('1 running');
    expect(frame).toContain('1 done');
    // Collapsed shows a single line — no per-row descriptions.
    expect(frame).not.toContain('summarize the repo');
  });

  it.each(THEMES)('[%s] focused: expands into rows with a ▸ highlight + hint', (bg) => {
    setActiveTheme(bg);
    const { lastFrame } = render(
      <SubagentPanel
        entries={[runningEntry, doneEntry]}
        focused
        selectedIndex={1}
        width={80}
        depth="ansi16"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('summarize the repo');
    expect(frame).toContain('review the diff');
    // The highlight marker sits on the selected (second) row.
    const marked = frame.split('\n').find((l) => l.includes('▸')) ?? '';
    expect(marked).toContain('review the diff');
    // Running row shows its live rollup; done row shows a step count.
    expect(frame).toContain('running run_shell…');
    expect(frame).toContain('3 steps');
    expect(frame).toContain('enter open');
  });
});

// ---------------------------------------------------------------------------
// SubagentTranscriptOverlay render
// ---------------------------------------------------------------------------

describe('SubagentTranscriptOverlay', () => {
  const activity = selectSubagentTranscript(subagentState(), 'p1');

  it.each(THEMES)('[%s] shows the subagent header + one condensed line per child tool', (bg) => {
    setActiveTheme(bg);
    const { lastFrame } = render(
      <SubagentTranscriptOverlay
        entry={runningEntry}
        activity={activity}
        scroll={0}
        rows={30}
        width={80}
        depth="ansi16"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('subagent · summarize the repo');
    expect(frame).toContain('list_files(src)');
    expect(frame).toContain('run_shell(echo hi)');
    expect(frame).toContain('esc back');
  });

  it('renders an empty-state line when the subagent has no recorded activity yet', () => {
    const { lastFrame } = render(
      <SubagentTranscriptOverlay
        entry={{ ...runningEntry, childCount: 0 }}
        activity={[]}
        scroll={0}
        rows={30}
        width={80}
        depth="ansi16"
      />,
    );
    expect(lastFrame() ?? '').toContain('No recorded activity yet.');
  });

  it('shows a "↓ N more" indicator when the body overflows the viewport', () => {
    // Build many rows so the viewport (rows-8 clamp) overflows.
    const many: Array<{ id: string; tool: ToolState }> = Array.from({ length: 30 }, (_, i) => ({
      id: `x${i}`,
      tool: { status: 'result', name: `tool${i}`, args: {}, result: 'ok' },
    }));
    const { lastFrame } = render(
      <SubagentTranscriptOverlay
        entry={runningEntry}
        activity={many}
        scroll={0}
        rows={20}
        width={80}
        depth="ansi16"
      />,
    );
    expect(lastFrame() ?? '').toMatch(/↓ \d+ more/);
  });
});

// ---------------------------------------------------------------------------
// useKeybinds 'subagents' branch
// ---------------------------------------------------------------------------

function SubagentKeybindsHarness(props: {
  onMoveSubagent: (delta: number) => void;
  onAcceptSubagent: () => void;
  onSubagentBack: () => void;
}): ReactElement {
  useKeybinds({
    overlay: 'subagents',
    value: '',
    slashCommandCount: 0,
    modelCount: 0,
    onAbort: vi.fn(),
    onCycleEffort: vi.fn(),
    onOpenSlash: vi.fn(),
    onCloseOverlay: vi.fn(),
    onMoveSlash: vi.fn(),
    onAcceptSlash: vi.fn(),
    onMoveModel: vi.fn(),
    onAcceptModel: vi.fn(),
    subagentCount: 3,
    onMoveSubagent: props.onMoveSubagent,
    onAcceptSubagent: props.onAcceptSubagent,
    onSubagentBack: props.onSubagentBack,
  });
  return <Text>harness</Text>;
}

describe("useKeybinds 'subagents' branch", () => {
  it('routes up/down to onMoveSubagent, Enter to onAccept, Esc to onBack', async () => {
    const onMoveSubagent = vi.fn();
    const onAcceptSubagent = vi.fn();
    const onSubagentBack = vi.fn();
    const { stdin, unmount } = render(
      <SubagentKeybindsHarness
        onMoveSubagent={onMoveSubagent}
        onAcceptSubagent={onAcceptSubagent}
        onSubagentBack={onSubagentBack}
      />,
    );
    await flushInk();

    await press(stdin, DOWN);
    expect(onMoveSubagent).toHaveBeenLastCalledWith(1);
    await press(stdin, `${ESC}[A`); // up
    expect(onMoveSubagent).toHaveBeenLastCalledWith(-1);
    await press(stdin, ENTER);
    expect(onAcceptSubagent).toHaveBeenCalledTimes(1);
    await press(stdin, ESC);
    expect(onSubagentBack).toHaveBeenCalledTimes(1);
    // Esc routed to onBack, NEVER the turn abort.
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Composer down-arrow focus handoff (InputBox)
// ---------------------------------------------------------------------------

function DownHarness({
  onHistoryNext,
  onArrowDownAtBottom,
}: {
  onHistoryNext?: () => boolean | void;
  onArrowDownAtBottom?: () => void;
}): ReactElement {
  const [value, setValue] = useState('');
  return (
    <InputBox
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      focus
      onHistoryNext={onHistoryNext}
      onArrowDownAtBottom={onArrowDownAtBottom}
    />
  );
}

describe('Composer down-arrow focus handoff', () => {
  it('hands off when history recall is a no-op (returns false)', async () => {
    const handoff = vi.fn();
    const { stdin, unmount } = render(
      <DownHarness onHistoryNext={() => false} onArrowDownAtBottom={handoff} />,
    );
    await flushInk();
    await press(stdin, DOWN);
    expect(handoff).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does NOT hand off when history CONSUMED the Down (returns true)', async () => {
    const handoff = vi.fn();
    const { stdin, unmount } = render(
      <DownHarness onHistoryNext={() => true} onArrowDownAtBottom={handoff} />,
    );
    await flushInk();
    await press(stdin, DOWN);
    expect(handoff).not.toHaveBeenCalled();
    unmount();
  });

  it('hands off when there is no history handler at all', async () => {
    const handoff = vi.fn();
    const { stdin, unmount } = render(<DownHarness onArrowDownAtBottom={handoff} />);
    await flushInk();
    await press(stdin, DOWN);
    expect(handoff).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// App-level: the full browse loop (down → enter → esc → esc) over a fake subagent turn
// ---------------------------------------------------------------------------

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'claude-cli',
    defaultModel: 'claude-fable-5',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
}

describe('App — subagent browse loop', () => {
  it('down focuses the panel, enter opens the transcript, esc backs out, esc returns to composer', async () => {
    const client = new FakeModelClient({ subagent: true, tickMs: 0 });
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Submit a prompt → the scripted subagent turn runs and settles.
    for (const ch of 'go') await press(stdin, ch);
    await press(stdin, ENTER);

    // The collapsed strip appears once the subagent lands in state.tools.
    await waitFor(() => (lastFrame() ?? '').includes('▾ agents'), { label: 'agents strip' });

    // Down at the bottom of the (now empty) composer hands focus into the panel: it
    // expands into rows + the browse hint.
    await press(stdin, DOWN);
    await waitFor(() => (lastFrame() ?? '').includes('enter open'), { label: 'panel focused' });
    expect(lastFrame() ?? '').toContain('summarize the repo');

    // Enter opens the full transcript overlay (child tool activity).
    await press(stdin, ENTER);
    await waitFor(() => (lastFrame() ?? '').includes('subagent · summarize the repo'), {
      label: 'transcript overlay',
    });
    expect(lastFrame() ?? '').toContain('list_files(src)');

    // Esc backs out to the list (panel still focused: the browse hint is back).
    await press(stdin, ESC);
    await waitFor(() => (lastFrame() ?? '').includes('enter open'), { label: 'back to list' });
    expect(lastFrame() ?? '').not.toContain('subagent · summarize the repo');

    // Esc again returns focus to the composer: the panel collapses to its one-liner.
    await press(stdin, ESC);
    await waitFor(() => !(lastFrame() ?? '').includes('enter open'), { label: 'back to composer' });
    expect(lastFrame() ?? '').toContain('▾ agents');

    unmount();
  });
});
