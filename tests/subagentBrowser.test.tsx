// tests/subagentBrowser.test.tsx
// LANE B (wave-8 agent-ui) — the subagent panel is now EXPAND/COLLAPSE only; transcript
// browsing was removed. Covers: the pure selector that rolls `state.tools` into browsable
// subagents; the reducer's 'subagents' overlay variant; the SubagentPanel strip (collapsed
// + expanded, both themes); the useKeybinds 'subagents' branch (up collapses, no Enter);
// the composer down-arrow focus handoff; and an App-level drive of down → expand → esc →
// collapse against a scripted fake subagent turn.
import { useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { App, type AppDeps } from '../src/app';
import { InputBox } from '../src/ui/InputBox';
import { SubagentPanel, statusGlyph, statusToken } from '../src/ui/SubagentPanel';
import { ABORTED, FAIL } from '../src/ui/glyphs';
import { useKeybinds } from '../src/hooks/useKeybinds';
import {
  initialState,
  reducer,
  type Action,
  type State,
} from '../src/core/reducer';
import {
  isSubagentToolName,
  selectSubagents,
  type SubagentEntry,
} from '../src/core/selectors';
import { INTERRUPTED_NOTICE, SUBAGENT_ABORTED } from '../src/core/abort';
import { reconstructSubagentTools } from '../src/services/subagentReader';
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

describe('selectSubagents (pure)', () => {
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
    // The error's first line is carried as `reason` so the dropdown row can print WHY it
    // failed instead of a step count that reads like a clean finish (finding 1).
    expect(failed[0]).toMatchObject({ id: 'p1', status: 'error', childCount: 0, reason: 'boom' });

    // A multiline error keeps only its first line; running/done rows carry no `reason`.
    const multiline = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'Task', args: {} },
        { t: 'tool-call', toolCallId: 'c1', name: 'Bash', args: {}, parentToolUseId: 'p1' },
        { t: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: 'worker exited (code 1)\nstack trace line' },
      ]),
    );
    expect(multiline[0]).toMatchObject({ status: 'error', childCount: 1, reason: 'worker exited (code 1)' });
    // A settled (done) subagent carries no `reason` — the failure tag is error-only.
    expect(done[0]?.reason).toBeUndefined();
  });

  it('classifies an abort (user cancel) as `aborted`, not `error` — off the shared abort markers', () => {
    // A turn-level Esc/Ctrl+C settles in-flight members to { status:'error', error:'interrupted' }.
    const interrupted = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'Task', args: {} },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: INTERRUPTED_NOTICE },
      ]),
    );
    // The card is ToolStatus 'error', but the abort marker splits it out to a neutral 'aborted'
    // with the reason preserved (so the row still shows WHY it stopped).
    expect(interrupted[0]).toMatchObject({ id: 'p1', status: 'aborted', reason: INTERRUPTED_NOTICE });

    // A subagent-tool parent-abort cascade lands the same way with 'sub-agent aborted'.
    const cascaded = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'audit' } },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: SUBAGENT_ABORTED },
      ]),
    );
    expect(cascaded[0]).toMatchObject({ id: 'p1', status: 'aborted', reason: SUBAGENT_ABORTED });

    // THIRD funnel: the codex spawn bridge — on runSignal.aborted it settles the outer
    // spawn_subagent card to error. It MUST emit the shared SUBAGENT_ABORTED marker (see
    // codexSpawnBridge.ts) so it classifies as a neutral `aborted`, exactly like the cascade.
    const bridgeAbort = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'audit' } },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: SUBAGENT_ABORTED },
      ]),
    );
    expect(bridgeAbort[0]).toMatchObject({ id: 'p1', status: 'aborted', reason: SUBAGENT_ABORTED });

    // ...and this is WHY the bridge cannot emit a bare 'aborted': it is not an abort marker,
    // so it would leak through as a red ✗ error. Locks the bridge to the shared constant.
    const bareAborted = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'audit' } },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: 'aborted' },
      ]),
    );
    expect(bareAborted[0]).toMatchObject({ id: 'p1', status: 'error', reason: 'aborted' });

    // A GENUINE failure (any other error text) stays `error` — the split is abort-markers-only.
    const genuine = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'Task', args: {} },
        { t: 'tool-status', toolCallId: 'p1', status: 'error', error: 'ENOENT: no such file or directory' },
      ]),
    );
    expect(genuine[0]).toMatchObject({ id: 'p1', status: 'error', reason: 'ENOENT: no such file or directory' });
  });

  it('surfaces the subagent provider from the settled spawn result (live) and card.provider (resume)', () => {
    // LIVE: subagentTool stamps entry.provider into the spawn card's { summary, model, provider }
    // result; selectSubagents reads it off the settled parent card.
    const live = selectSubagents(
      drive([
        { t: 'assistant-start', id: 'm1' },
        { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'audit', model: 'gpt-5.6-sol' } },
        { t: 'tool-call', toolCallId: 'c1', name: 'shell', args: { command: 'ls' }, parentToolUseId: 'p1' },
        { t: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' },
        { t: 'tool-status', toolCallId: 'p1', status: 'result', result: { summary: 'done', model: 'gpt-5.6-sol', provider: 'codex-cli' } },
      ]),
    );
    expect(live[0]).toMatchObject({ id: 'p1', provider: 'codex-cli' });

    // RESUME: the reader rehydrates the spawn card with a top-level `provider` field.
    const resumed = selectSubagents({
      tools: {
        p1: { status: 'result', name: 'spawn_subagent', args: { description: 'audit' }, provider: 'claude-cli' },
        c1: { status: 'result', name: 'shell', args: {}, parentToolUseId: 'p1' },
      },
    });
    expect(resumed[0]).toMatchObject({ id: 'p1', provider: 'claude-cli' });

    // A still-running subagent (no result yet, no rehydrated field) carries no provider.
    expect(selectSubagents(subagentState())[0]?.provider).toBeUndefined();
  });

  it('returns no subagents for a plain (non-subagent) tool turn', () => {
    const plain = drive([
      { t: 'assistant-start', id: 'm1' },
      { t: 'tool-call', toolCallId: 't1', name: 'run_shell', args: { command: 'ls' } },
      { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'ok' },
    ]);
    expect(selectSubagents(plain)).toEqual([]);
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

describe('SubagentPanel status mapping (glyph + colour token)', () => {
  it('aborted → the neutral ⊘ glyph (distinct from the ✗ FAIL) and the textDim token (never toolError)', () => {
    expect(statusGlyph('aborted')).toBe(ABORTED);
    expect(statusGlyph('aborted')).not.toBe(FAIL);
    expect(statusGlyph('aborted')).not.toBe(statusGlyph('error'));
    // A cancel is muted, NOT the failure red and NOT the success green.
    expect(statusToken('aborted')).toBe('textDim');
    expect(statusToken('aborted')).not.toBe('toolError');
    expect(statusToken('aborted')).not.toBe('toolResult');
  });

  it('error still maps to ✗ / toolError — regression guard on the split', () => {
    expect(statusGlyph('error')).toBe(FAIL);
    expect(statusToken('error')).toBe('toolError');
  });
});

describe('SubagentPanel', () => {
  it('renders NOTHING when the session has no subagents', () => {
    const { lastFrame } = render(
      <SubagentPanel entries={[]} focused={false} width={80} depth="ansi16" />,
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it.each(THEMES)('[%s] collapsed: one dim line with running/done counts', (bg) => {
    setActiveTheme(bg);
    const { lastFrame } = render(
      <SubagentPanel
        entries={[runningEntry, doneEntry]}
        focused={false}
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

  it.each(THEMES)('[%s] expanded: one row per subagent + a collapse hint, NO browse affordance', (bg) => {
    setActiveTheme(bg);
    const { lastFrame } = render(
      <SubagentPanel entries={[runningEntry, doneEntry]} focused width={80} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('summarize the repo');
    expect(frame).toContain('review the diff');
    // Running row shows its live rollup; done row shows a step count.
    expect(frame).toContain('running run_shell…');
    expect(frame).toContain('3 steps');
    // Expand/collapse ONLY: no row highlight marker, no "enter open" transcript affordance.
    expect(frame).not.toContain('▸');
    expect(frame).not.toContain('enter open');
    expect(frame).toContain('↑/esc collapse');
  });

  it.each(THEMES)('[%s] expanded: a delegate-CLI subagent shows the honest `via <x> cli` source tag', (bg) => {
    setActiveTheme(bg);
    const codexEntry: SubagentEntry = {
      id: 'p5',
      name: 'spawn_subagent',
      description: 'cross-provider audit',
      model: 'gpt-5.6-sol',
      provider: 'codex-cli',
      status: 'done',
      childCount: 2,
      runningLabel: 'working…',
    };
    const { lastFrame } = render(
      <SubagentPanel entries={[codexEntry]} focused width={80} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('gpt-5.6-sol');
    expect(frame).toContain('via codex cli');
  });

  it('renders NO `via … cli` tag for an api subagent (unmarked, like a juno-executor turn)', () => {
    const apiEntry: SubagentEntry = {
      id: 'p6',
      name: 'spawn_subagent',
      description: 'local audit',
      model: 'gpt-5.6-sol',
      provider: 'openai', // classifies to `api` → unmarked
      status: 'done',
      childCount: 1,
      runningLabel: 'working…',
    };
    const { lastFrame } = render(
      <SubagentPanel entries={[apiEntry]} focused width={80} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('gpt-5.6-sol');
    expect(frame).not.toMatch(/via .* cli/);
  });

  it.each(THEMES)('[%s] expanded: an errored row shows the failure reason, NOT a step count', (bg) => {
    setActiveTheme(bg);
    const erroredEntry: SubagentEntry = {
      id: 'p3',
      name: 'spawn_subagent',
      description: 'audit dependencies',
      model: 'fake',
      status: 'error',
      // childCount 1 ⇒ the OLD code rendered `fake · 1 step`, formatted identically to a clean
      // finish; the reason must replace it so a ✗ row reads as a failure with its exit reason.
      childCount: 1,
      runningLabel: 'working…',
      reason: 'worker exited (code 1): dependency audit crashed',
    };
    const { lastFrame } = render(
      <SubagentPanel entries={[erroredEntry]} focused width={80} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('worker exited (code 1): dependency audit crashed');
    // The masquerading step count is gone from the failed row.
    expect(frame).not.toContain('1 step');
  });

  it('clips a long failure reason to fit rather than dropping it back to a bare glyph row', () => {
    const erroredEntry: SubagentEntry = {
      id: 'p4',
      name: 'spawn_subagent',
      description: 'audit dependencies',
      model: 'fake',
      status: 'error',
      childCount: 1,
      runningLabel: 'working…',
      reason: 'worker exited (code 1): dependency audit crashed hard with a very long tail message',
    };
    // At a narrow width the whole reason cannot fit; it must be TRUNCATED (a visible prefix
    // survives), never dropped to just `✗ audit dependencies` and certainly never `1 step`.
    const { lastFrame } = render(
      <SubagentPanel entries={[erroredEntry]} focused width={50} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✗');
    expect(frame).toContain('worker exited');
    expect(frame).not.toContain('1 step');
  });

  it.each(THEMES)('[%s] expanded: an aborted (cancel) row shows ⊘ distinct from a failed ✗, with its reason', (bg) => {
    setActiveTheme(bg);
    const abortedEntry: SubagentEntry = {
      id: 'pA',
      name: 'spawn_subagent',
      description: 'cancelled audit',
      model: 'fake',
      status: 'aborted',
      childCount: 2,
      runningLabel: 'working…',
      reason: 'interrupted',
    };
    const failedEntry: SubagentEntry = {
      id: 'pF',
      name: 'spawn_subagent',
      description: 'broken audit',
      model: 'fake',
      status: 'error',
      childCount: 1,
      runningLabel: 'working…',
      reason: 'worker exited (code 1)',
    };
    const frame =
      render(
        <SubagentPanel entries={[failedEntry, abortedEntry]} focused width={80} depth="ansi16" />,
      ).lastFrame() ?? '';
    // The cancel glyph is present AND distinct from the failure cross — both rows read differently.
    expect(frame).toContain(ABORTED); // ⊘
    expect(frame).toContain('✗');
    // The aborted row still carries WHY it stopped (the abort marker), NEVER a step count.
    expect(frame).toContain('interrupted');
    expect(frame).not.toContain('2 steps');
  });

  it('collapsed: reports a `cancelled` bucket SEPARATE from `failed` (and running/done)', () => {
    const abortedEntry: SubagentEntry = {
      id: 'pA',
      name: 'spawn_subagent',
      description: 'cancelled audit',
      status: 'aborted',
      childCount: 1,
      runningLabel: 'working…',
      reason: 'interrupted',
    };
    const failedEntry: SubagentEntry = {
      id: 'pF',
      name: 'spawn_subagent',
      description: 'broken audit',
      status: 'error',
      childCount: 1,
      runningLabel: 'working…',
      reason: 'boom',
    };
    const frame =
      render(
        <SubagentPanel
          entries={[runningEntry, doneEntry, abortedEntry, failedEntry]}
          focused={false}
          width={80}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('1 running');
    expect(frame).toContain('1 done');
    // A cancel is its OWN bucket — not folded into `done` and not counted as `failed`.
    expect(frame).toContain('1 cancelled');
    expect(frame).toContain('1 failed');
  });

  it('an aborted row survives a NARROW width with its reason clipped (fitRowDetail abort branch)', () => {
    const abortedEntry: SubagentEntry = {
      id: 'pA',
      name: 'spawn_subagent',
      description: 'cancelled audit',
      model: 'fake',
      status: 'aborted',
      childCount: 1,
      runningLabel: 'working…',
      reason: 'sub-agent aborted by the parent turn before it finished its work',
    };
    // At a narrow width the whole reason cannot fit; a visible prefix must survive rather than
    // dropping the row back to a bare `⊘ cancelled audit` (which would read like a clean finish),
    // and it must NEVER show a step count.
    const frame =
      render(
        <SubagentPanel entries={[abortedEntry]} focused width={46} depth="ansi16" />,
      ).lastFrame() ?? '';
    expect(frame).toContain(ABORTED);
    expect(frame).toContain('sub-agent aborted');
    expect(frame).not.toContain('1 step');
  });

  it('windows a long list to the NEWEST rows with an "↑ N earlier" head', () => {
    const many: SubagentEntry[] = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: 'Agent',
      description: `agent ${i}`,
      // The newest entry is still running — exactly the row that must stay visible when a
      // multi-agent loop pushes the count past MAX_VISIBLE_ROWS.
      status: i === 11 ? 'running' : 'done',
      childCount: 1,
      runningLabel: 'working…',
    }));
    const { lastFrame } = render(
      <SubagentPanel entries={many} focused width={80} depth="ansi16" />,
    );
    const frame = lastFrame() ?? '';
    // 12 entries, window of 8 → agents 4..11 shown, 0..3 windowed out behind an earlier head.
    expect(frame).toMatch(/↑ 4 earlier/);
    // The newest (running) agent is visible…
    expect(frame).toContain('agent 11');
    // …while the oldest is windowed out — and NEVER behind a "↓ more" tail (regression guard).
    expect(frame).not.toContain('agent 0');
    expect(frame).not.toMatch(/↓ \d+ more/);
  });
});

// ---------------------------------------------------------------------------
// useKeybinds 'subagents' branch (expand/collapse only)
// ---------------------------------------------------------------------------

function SubagentKeybindsHarness(props: {
  onMoveSubagent: (delta: number) => void;
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
    onMoveSubagent: props.onMoveSubagent,
    onSubagentBack: props.onSubagentBack,
  });
  return <Text>harness</Text>;
}

describe("useKeybinds 'subagents' branch", () => {
  it('routes up/down to onMoveSubagent and Esc to onBack; Enter is swallowed (no browse)', async () => {
    const onMoveSubagent = vi.fn();
    const onSubagentBack = vi.fn();
    const { stdin, unmount } = render(
      <SubagentKeybindsHarness
        onMoveSubagent={onMoveSubagent}
        onSubagentBack={onSubagentBack}
      />,
    );
    await flushInk();

    await press(stdin, DOWN);
    expect(onMoveSubagent).toHaveBeenLastCalledWith(1);
    await press(stdin, `${ESC}[A`); // up
    expect(onMoveSubagent).toHaveBeenLastCalledWith(-1);
    // Enter no longer opens anything — it is swallowed, never routed to a handler.
    await press(stdin, ENTER);
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
// App-level: down → expand → esc → collapse over a fake subagent turn
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

describe('App — subagent panel expand/collapse', () => {
  it('down expands the panel, esc collapses it back to the composer', async () => {
    const client = new FakeModelClient({ subagent: true, tickMs: 0 });
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);
    await flushInk();

    // Submit a prompt → the scripted subagent turn runs and settles.
    for (const ch of 'go') await press(stdin, ch);
    await press(stdin, ENTER);

    // The collapsed strip appears once the subagent lands in state.tools.
    await waitFor(() => (lastFrame() ?? '').includes('▾ agents'), { label: 'agents strip' });

    // Down at the bottom of the (now empty) composer expands the panel into rows + the
    // collapse hint. No transcript browsing anymore.
    await press(stdin, DOWN);
    await waitFor(() => (lastFrame() ?? '').includes('↑/esc collapse'), { label: 'panel expanded' });
    expect(lastFrame() ?? '').toContain('summarize the repo');

    // Esc collapses the panel back to its one-liner (focus returns to the composer).
    await press(stdin, ESC);
    await waitFor(() => !(lastFrame() ?? '').includes('↑/esc collapse'), { label: 'collapsed' });
    expect(lastFrame() ?? '').toContain('▾ agents');

    unmount();
  });

  it('rehydrates subagents from the recorder JSONL when the live tools map is empty (resume path)', async () => {
    // The resume end-state: no live subagent turn (state.tools = {}), but the durable
    // per-subagent JSONL still holds a settled subagent. The injected reader stands in
    // for the on-disk `<id>.subagents/*.jsonl`, reconstructed via the real reader core.
    const diskTools = reconstructSubagentTools([
      [
        JSON.stringify({ kind: 'meta', toolUseId: 'p9', name: 'spawn_subagent', description: 'resumed audit', model: 'fable-mini', startRef: 'x' }),
        JSON.stringify({ kind: 'event', event: { type: 'tool-call', toolCallId: 'c9', name: 'read_file', args: { path: 'a.ts' }, parentToolUseId: 'p9' } }),
        JSON.stringify({ kind: 'event', event: { type: 'tool-status', toolCallId: 'c9', status: 'result', result: 'contents' } }),
      ].join('\n'),
    ]);
    const deps: AppDeps = {
      ...fakeDeps(new FakeModelClient({ tickMs: 0 })),
      readSubagentTranscripts: async () => diskTools,
    };
    const { stdin, lastFrame, unmount } = render(<App deps={deps} />);

    // With NO live turn, the collapsed strip appears purely from the disk-loaded records.
    await waitFor(() => (lastFrame() ?? '').includes('▾ agents'), { label: 'disk agents strip' });

    // Down expands the panel — the disk-loaded row is present.
    await press(stdin, DOWN);
    await waitFor(() => (lastFrame() ?? '').includes('↑/esc collapse'), { label: 'panel expanded' });
    expect(lastFrame() ?? '').toContain('resumed audit');

    unmount();
  });
});
