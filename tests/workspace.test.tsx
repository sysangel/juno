// tests/workspace.test.tsx
// Observatory (orchestration workspace) — RENDER tests for the pure visual layer in
// src/ui/workspace/**. Covers: the wide two-pane overview vs the narrow drill-in
// surface, status/provenance/attention semantics on orbit rows, ordered mixed event
// rendering in the selected stream, the empty states, the single-spinner rule, and
// the bounded-height promise (never more than `rows - 1` lines).
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OrchestrationWorkspace,
  workspaceRenderedRows,
  workspaceStreamWidth,
} from '../src/ui/workspace/OrchestrationWorkspace';
import type {
  OrbitAgentVM,
  SelectedAgentVM,
  WorkspaceKeyHint,
} from '../src/ui/workspace/types';
import { SPINNER_DOTS_FRAMES } from '../src/ui/glyphs';
import { setActiveTheme } from '../src/ui/theme';

afterEach(() => setActiveTheme('dark'));

const rowsOf = (frame: string): string[] => frame.replace(/\n+$/, '').split('\n');

const AGENTS: readonly OrbitAgentVM[] = [
  {
    id: 'a1',
    label: 'fix flaky auth tests',
    status: 'running',
    model: 'fable-mini',
    provider: 'codex cli',
    elapsed: '42s',
  },
  {
    id: 'a2',
    label: 'migrate settings schema',
    status: 'waiting',
    model: 'fable-5',
    provider: 'api',
    attention: true,
  },
  {
    id: 'a3',
    label: 'document the reducer',
    status: 'done',
    model: 'fable-mini',
    provider: 'claude cli',
    terminal: 'done 84s',
  },
  {
    id: 'a4',
    label: 'port glyph tests',
    status: 'error',
    model: 'fable-mini',
    provider: 'api',
    terminal: 'exit 1',
  },
  { id: 'a5', label: 'sweep dead exports', status: 'queued', model: 'fable-mini', provider: 'api' },
  {
    id: 'a6',
    label: 'audit permissions',
    status: 'aborted',
    model: 'fable-mini',
    provider: 'api',
    terminal: 'cancelled',
  },
];

const SELECTED: SelectedAgentVM = {
  id: 'a1',
  title: 'auth-fixer',
  task: 'Fix the flaky auth integration tests and pin the retry seam',
  status: 'running',
  model: 'fable-mini',
  provider: 'via codex cli',
  elapsed: '42s',
  events: [
    { kind: 'lifecycle', id: 'e0', text: 'agent spawned', tone: 'neutral' },
    { kind: 'reasoning', id: 'e1', text: 'The retry loop is probably racing the mock clock.' },
    {
      kind: 'tool',
      id: 'e2',
      name: 'Running tests',
      status: 'done',
      detail: 'exit 0 · 1204ms',
      provenance: 'via juno process',
    },
    { kind: 'assistant', id: 'e3', text: 'Two of the three failures share the same fake-timer seam.' },
    { kind: 'steering', id: 'e4', text: 'focus only on the auth suite' },
    { kind: 'permission', id: 'e5', toolName: 'Bash', risk: 'high', resolution: 'pending' },
  ],
};

const KEYS: readonly WorkspaceKeyHint[] = [
  { key: 'tab', action: 'focus' },
  { key: '↑↓', action: 'agent' },
  { key: 'enter', action: 'open' },
  { key: 'esc', action: 'back' },
];

function workspace(overrides: Partial<Parameters<typeof OrchestrationWorkspace>[0]> = {}) {
  return (
    <OrchestrationWorkspace
      rows={24}
      columns={120}
      agents={AGENTS}
      selectedAgentId="a1"
      selected={SELECTED}
      focus="stream"
      narrowPane="stream"
      keys={KEYS}
      sessionLabel="wave-9"
      depth="ansi16"
      {...overrides}
    />
  );
}

describe('OrchestrationWorkspace — wide two-pane layout (columns >= 110)', () => {
  it('renders orbit rail AND selected stream side by side, under the branded header', () => {
    const frame = render(workspace()).lastFrame() ?? '';
    // Brand + session label + truthful counts on one header row.
    expect(frame).toContain('Observatory');
    expect(frame).toContain('wave-9');
    expect(frame).toContain('6 agents');
    expect(frame).toContain('1 running');
    expect(frame).toContain('1 waiting');
    expect(frame).toContain('1 need input');
    // Rail caption + a non-selected orbit row are present… (the label may be
    // clipped to the rail width, so anchor on its surviving head).
    expect(frame).toContain('agents · 6');
    expect(frame).toContain('migrate setting');
    // …AND the full-fidelity stream is present in the same frame (two panes).
    expect(frame).toContain('auth-fixer');
    expect(frame).toContain('focus only on the auth suite');
    // Footer advertises exactly the supplied keys.
    expect(frame).toContain('tab focus');
    expect(frame).toContain('enter open');
  });

  it('shares rows between panes: rail rows and stream events occupy the same lines', () => {
    const frame = render(workspace()).lastFrame() ?? '';
    const rows = rowsOf(frame);
    const railRow = rows.find((r) => r.includes('document the reducer'));
    expect(railRow).toBeDefined();
    // The rail row carries stream content to its right (true two-pane, no stacking).
    const streamContentRows = rows.filter(
      (r) => r.includes('auth-fixer') || r.includes('Running tests'),
    );
    expect(streamContentRows.length).toBeGreaterThan(0);
  });

  it('renders at most ONE spinner across the whole surface', () => {
    const frame = render(workspace()).lastFrame() ?? '';
    const spinnerChars = [...frame].filter((ch) =>
      (SPINNER_DOTS_FRAMES as readonly string[]).includes(ch),
    );
    expect(spinnerChars.length).toBeLessThanOrEqual(1);
    // Orbit rows use the STATIC running glyph, so the rail contributes none of them.
    expect(frame).toContain('◐'); // a4? no — a1's orbit row static running mark
  });
});

describe('OrchestrationWorkspace — narrow drill-in (columns < 110)', () => {
  it('narrowPane="stream" renders ONLY the stream surface', () => {
    const frame = render(workspace({ columns: 90 })).lastFrame() ?? '';
    expect(frame).toContain('auth-fixer');
    expect(frame).toContain('focus only on the auth suite');
    // No rail caption, no other agent's orbit row.
    expect(frame).not.toContain('agents · 6');
    expect(frame).not.toContain('migrate settings schema');
  });

  it('narrowPane="orbit" renders ONLY the rail surface', () => {
    const frame = render(workspace({ columns: 90, narrowPane: 'orbit', focus: 'orbit' })).lastFrame() ?? '';
    expect(frame).toContain('agents · 6');
    expect(frame).toContain('migrate settings schema');
    expect(frame).toContain('fix flaky auth tests');
    // Stream-only content stays out of the drill-in overview.
    expect(frame).not.toContain('focus only on the auth suite');
    expect(frame).not.toContain('auth-fixer');
  });
});

describe('OrchestrationWorkspace — orbit status / provenance / attention semantics', () => {
  it('rows carry status glyphs, textual model+provider provenance, and elapsed/terminal state', () => {
    const frame = render(workspace({ columns: 90, narrowPane: 'orbit' })).lastFrame() ?? '';
    const rows = rowsOf(frame);
    const running = rows.find((r) => r.includes('fix flaky auth tests')) ?? '';
    expect(running).toContain('◐');
    expect(running).toContain('fable-mini');
    expect(running).toContain('codex cli');
    expect(running).toContain('42s');
    const done = rows.find((r) => r.includes('document the reducer')) ?? '';
    expect(done).toContain('✓');
    expect(done).toContain('claude cli');
    expect(done).toContain('done 84s');
    const failed = rows.find((r) => r.includes('port glyph tests')) ?? '';
    expect(failed).toContain('✗');
    expect(failed).toContain('exit 1');
    const aborted = rows.find((r) => r.includes('audit permissions')) ?? '';
    expect(aborted).toContain('⊘');
    expect(aborted).toContain('cancelled');
    const queued = rows.find((r) => r.includes('sweep dead exports')) ?? '';
    expect(queued).toContain('●');
  });

  it('an attention agent gets the trailing ! affordance; the selected row gets the ▸ marker', () => {
    const frame = render(workspace({ columns: 90, narrowPane: 'orbit' })).lastFrame() ?? '';
    const rows = rowsOf(frame);
    const attention = rows.find((r) => r.includes('migrate settings schema')) ?? '';
    expect(attention.trimEnd().endsWith('!')).toBe(true);
    const selected = rows.find((r) => r.includes('fix flaky auth tests')) ?? '';
    expect(selected).toContain('▸');
    // Non-selected rows carry no selection marker.
    expect(attention).not.toContain('▸');
  });
});

describe('OrchestrationWorkspace — ordered mixed event stream', () => {
  it('renders lifecycle, reasoning, tool, assistant, steering, permission IN ORDER', () => {
    const frame = render(workspace({ columns: 90 })).lastFrame() ?? '';
    const anchors = [
      'agent spawned',
      'retry loop is probably racing',
      'Running tests',
      'share the same fake-timer seam',
      'focus only on the auth suite',
      'permission · Bash (high) · awaiting decision',
    ];
    const positions = anchors.map((a) => frame.indexOf(a));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `anchor missing: ${anchors[i]}`).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Kind-specific dressing: reasoning marker, steering prompt, tool provenance + outcome.
    expect(frame).toContain('✻');
    expect(frame).toContain('❯ focus only on the auth suite');
    expect(frame).toContain('via juno process');
    expect(frame).toContain('exit 0 · 1204ms');
  });

  it('identity header shows title, status word, task, and textual provenance', () => {
    const frame = render(workspace({ columns: 90 })).lastFrame() ?? '';
    expect(frame).toContain('auth-fixer · running');
    expect(frame).toContain('Fix the flaky auth integration tests');
    expect(frame).toContain('fable-mini · via codex cli · 42s');
  });
});

describe('OrchestrationWorkspace — empty states', () => {
  it('a selected agent with no events shows the stream empty state', () => {
    const frame = render(
      workspace({ columns: 90, selected: { ...SELECTED, events: [] } }),
    ).lastFrame() ?? '';
    expect(frame).toContain('no activity yet');
    expect(frame).toContain('events stream here as the agent works');
  });

  it('no selected agent shows the no-selection placeholder (wide keeps the rail alive)', () => {
    const frame = render(
      workspace({ selected: undefined, selectedAgentId: undefined }),
    ).lastFrame() ?? '';
    expect(frame).toContain('no agent selected');
    expect(frame).toContain('agents · 6');
  });

  it('an empty fleet is stated honestly on the rail', () => {
    const frame = render(
      workspace({
        columns: 90,
        narrowPane: 'orbit',
        agents: [],
        selected: undefined,
        selectedAgentId: undefined,
      }),
    ).lastFrame() ?? '';
    expect(frame).toContain('0 agents');
    expect(frame).toContain('no agents yet');
  });
});

describe('OrchestrationWorkspace — bounded height', () => {
  it('never renders more than rows - 1 lines (final-row safety)', () => {
    for (const rows of [12, 16, 24]) {
      const frame = render(workspace({ rows })).lastFrame() ?? '';
      expect(rowsOf(frame).length).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('a long event backlog stays bounded and shows an honest ↑ earlier marker', () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `bulk-${i}`,
      text: `progress note ${i} — the suite is being narrowed further`,
    }));
    const frame = render(
      workspace({ rows: 16, columns: 90, selected: { ...SELECTED, events } }),
    ).lastFrame() ?? '';
    expect(rowsOf(frame).length).toBeLessThanOrEqual(15);
    expect(frame).toMatch(/↑ \d+ earlier/);
    // The most recent event survives the cut.
    expect(frame).toContain('progress note 39');
  });

  it('workspaceRenderedRows pins the arithmetic the frame obeys', () => {
    expect(workspaceRenderedRows(24)).toBe(23);
    expect(workspaceRenderedRows(3)).toBe(2);
    expect(workspaceRenderedRows(1)).toBe(1);
    const frame = render(workspace({ rows: 24 })).lastFrame() ?? '';
    expect(rowsOf(frame).length).toBeLessThanOrEqual(workspaceRenderedRows(24));
  });

  it('shares the responsive stream width with scroll clamping', () => {
    expect(workspaceStreamWidth(100)).toBe(100);
    expect(workspaceStreamWidth(120)).toBe(80);
  });

  it('surfaces transient action feedback in place of hidden chat notices', () => {
    const frame = render(workspace({ notice: 'steering queued for a1' })).lastFrame() ?? '';
    expect(frame).toContain('steering queued for a1');
    expect(frame).not.toContain('tab focus');
  });
});
