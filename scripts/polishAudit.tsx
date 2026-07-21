// Deterministic Observatory visual QA. This is deliberately renderer-level (fast,
// exhaustive size/state matrix); scripts/selftest.ts remains the real-PTY lifecycle
// proof. Both surfaces are run by `npm run verify:polish`.
import { render } from 'ink-testing-library';
import React from 'react';
import { displayWidth } from '../src/ui/clipText';
import { SPINNER_DOTS_FRAMES } from '../src/ui/glyphs';
import {
  OrchestrationWorkspace,
  WIDE_MIN_COLUMNS,
  workspaceKeyHints,
  type OrbitAgentVM,
  type OrchestrationWorkspaceProps,
  type SelectedAgentVM,
} from '../src/ui/workspace';

export interface PolishInvariant {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface PolishAuditCase {
  readonly name: string;
  readonly state: 'empty' | 'permission' | 'active-stream' | 'history';
  readonly columns: number;
  readonly rows: number;
  readonly props: OrchestrationWorkspaceProps;
}

export interface PolishAuditResult {
  readonly name: string;
  readonly state: PolishAuditCase['state'];
  readonly columns: number;
  readonly rows: number;
  readonly frame: string;
  readonly invariants: readonly PolishInvariant[];
}

const AGENTS: readonly OrbitAgentVM[] = [
  {
    id: 'auth',
    label: 'stabilize authentication tests',
    status: 'running',
    model: 'fable-mini',
    provider: 'codex cli',
    elapsed: '42s',
  },
  {
    id: 'schema',
    label: 'migrate settings schema',
    status: 'waiting',
    model: 'fable-5',
    provider: 'api',
    attention: true,
  },
  {
    id: 'docs',
    label: 'document the reducer',
    status: 'done',
    model: 'fable-mini',
    provider: 'claude cli',
    terminal: 'done 84s',
  },
  {
    id: 'glyphs',
    label: 'repair terminal glyph snapshots',
    status: 'error',
    model: 'fable-mini',
    provider: 'api',
    terminal: 'exit 1',
  },
  { id: 'exports', label: 'sweep dead exports', status: 'queued', model: 'fable-mini' },
  { id: 'policy', label: 'audit permission policy', status: 'aborted', terminal: 'cancelled' },
];

const ACTIVE: SelectedAgentVM = {
  id: 'auth',
  title: 'auth-fixer',
  task: 'Stabilize the authentication integration suite without broadening retry behavior',
  status: 'running',
  model: 'fable-mini',
  provider: 'via codex cli',
  elapsed: '42s',
  events: [
    { kind: 'lifecycle', id: 'a0', text: 'agent spawned', tone: 'neutral' },
    { kind: 'reasoning', id: 'a1', text: 'The retry loop and fake clock advance on different turns.' },
    {
      kind: 'tool',
      id: 'a2',
      name: 'Running auth tests',
      status: 'done',
      detail: '18 passed · 1204ms',
      provenance: 'via juno process',
    },
    { kind: 'assistant', id: 'a3', text: 'The focused suite is stable; I am checking the adjacent timeout path now.' },
    { kind: 'steering', id: 'a4', text: 'keep the patch scoped to the retry seam' },
  ],
};

const WAITING: SelectedAgentVM = {
  id: 'schema',
  title: 'schema-migrator',
  task: 'Migrate the settings schema and preserve backward-compatible reads',
  status: 'waiting',
  model: 'fable-5',
  provider: 'via api',
  events: [
    { kind: 'lifecycle', id: 'w0', text: 'agent spawned', tone: 'neutral' },
    { kind: 'permission', id: 'w1', toolName: 'Write', risk: 'high', resolution: 'pending' },
  ],
};

const HISTORY: SelectedAgentVM = {
  ...ACTIVE,
  status: 'done',
  terminal: 'done 84s',
  events: Array.from({ length: 30 }, (_, index) => ({
    kind: 'assistant' as const,
    id: `history-${index}`,
    text: `verified checkpoint ${index}`,
  })),
};

const HISTORY_AGENTS: readonly OrbitAgentVM[] = AGENTS.map((agent) =>
  agent.id === HISTORY.id
    ? { ...agent, status: 'done', elapsed: undefined, terminal: HISTORY.terminal }
    : agent,
);

const SIZES = [
  { columns: 32, rows: 18 },
  { columns: 80, rows: 24 },
  { columns: 120, rows: 30 },
  { columns: 160, rows: 36 },
] as const;

function baseProps(columns: number, rows: number): Pick<OrchestrationWorkspaceProps, 'columns' | 'rows' | 'sessionLabel' | 'depth'> {
  return { columns, rows, sessionLabel: 'polish-loop', depth: 'ansi16' };
}

export const POLISH_CASES: readonly PolishAuditCase[] = SIZES.flatMap(({ columns, rows }) => {
  const wide = columns >= WIDE_MIN_COLUMNS;
  return [
    {
      name: `empty-${columns}`,
      state: 'empty' as const,
      columns,
      rows,
      props: {
        ...baseProps(columns, rows),
        agents: [],
        focus: 'orbit',
        narrowPane: 'orbit',
        keys: workspaceKeyHints({
          messageMode: false,
          wide,
          narrowPane: 'orbit',
          focus: 'orbit',
          agentCount: 0,
        }),
      },
    },
    {
      name: `permission-${columns}`,
      state: 'permission' as const,
      columns,
      rows,
      props: {
        ...baseProps(columns, rows),
        agents: AGENTS,
        selectedAgentId: WAITING.id,
        selected: WAITING,
        focus: 'orbit',
        narrowPane: 'orbit',
        keys: workspaceKeyHints({
          messageMode: false,
          wide,
          narrowPane: 'orbit',
          focus: 'orbit',
          agentCount: AGENTS.length,
          capabilities: { cancel: true, resolvePermission: true },
        }),
      },
    },
    {
      name: `active-stream-${columns}`,
      state: 'active-stream' as const,
      columns,
      rows,
      props: {
        ...baseProps(columns, rows),
        agents: AGENTS,
        selectedAgentId: ACTIVE.id,
        selected: ACTIVE,
        focus: 'stream',
        narrowPane: 'stream',
        keys: workspaceKeyHints({
          messageMode: false,
          wide,
          narrowPane: 'stream',
          focus: 'stream',
          agentCount: AGENTS.length,
          capabilities: { steer: true, cancel: true },
        }),
      },
    },
    {
      name: `history-${columns}`,
      state: 'history' as const,
      columns,
      rows,
      props: {
        ...baseProps(columns, rows),
        agents: HISTORY_AGENTS,
        selectedAgentId: HISTORY.id,
        selected: HISTORY,
        focus: 'stream',
        narrowPane: 'stream',
        streamScrollRows: 8,
        keys: workspaceKeyHints({
          messageMode: false,
          wide,
          narrowPane: 'stream',
          focus: 'stream',
          agentCount: AGENTS.length,
        }),
      },
    },
  ];
});

function frameLines(frame: string): string[] {
  return frame.replace(/\n+$/, '').split('\n');
}

function invariant(name: string, pass: boolean, detail: string): PolishInvariant {
  return { name, pass, detail };
}

function evaluate(auditCase: PolishAuditCase, frame: string): PolishInvariant[] {
  const lines = frameLines(frame);
  const widths = lines.map(displayWidth);
  const footer = lines.at(-1)?.trimEnd() ?? '';
  const spinnerCount = [...frame].filter((char) =>
    (SPINNER_DOTS_FRAMES as readonly string[]).includes(char),
  ).length;
  const wide = auditCase.columns >= WIDE_MIN_COLUMNS;
  const checks: PolishInvariant[] = [
    invariant('brand-visible', frame.includes('Observatory'), 'Observatory brand remains visible'),
    invariant(
      'final-row-safe',
      lines.length <= auditCase.rows - 1,
      `${lines.length} rendered rows within ${auditCase.rows - 1} row budget`,
    ),
    invariant(
      'cell-width-safe',
      widths.every((width) => width <= auditCase.columns),
      `widest row ${Math.max(...widths)} cells within ${auditCase.columns} columns`,
    ),
    invariant('single-spinner', spinnerCount <= 1, `${spinnerCount} animated spinner glyphs`),
    invariant(
      'sanitized-output',
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\{"(?:description|task|summary)":/.test(frame),
      'no control bytes or raw orchestration JSON',
    ),
    invariant(
      'complete-footer-hints',
      !footer.endsWith('·') && !/\b(?:allow|pgup)\/$/.test(footer),
      `footer ends on a complete action group: ${JSON.stringify(footer)}`,
    ),
  ];

  if (auditCase.state === 'empty') {
    checks.push(
      invariant('empty-route-visible', frame.includes('delegate in chat to begin'), 'empty state explains where agents start'),
      invariant('empty-escape-visible', footer.includes('esc chat'), 'empty state keeps a visible route back to chat'),
      invariant(
        'empty-no-dead-actions',
        !/(tab focus|↑↓ agent|enter stream|m steer|x cancel|g\/d allow)/.test(footer),
        'empty state advertises no inert agent actions',
      ),
    );
  } else if (auditCase.state === 'permission') {
    checks.push(
      invariant('attention-visible', frame.includes('need input'), 'permission state remains visible in the header'),
      invariant('permission-action-visible', footer.includes('g/d allow/deny'), 'allow/deny survives even at 32 columns'),
      invariant('selected-agent-visible', frame.includes('migrate setting'), 'selected waiting agent remains visible'),
      invariant(
        'permission-layout',
        wide ? frame.includes('schema-migrator') : !frame.includes('schema-migrator'),
        wide ? 'wide view shows rail and selected stream' : 'narrow orbit does not leak the stream pane',
      ),
    );
  } else {
    checks.push(
      invariant('stream-identity-visible', frame.includes('auth-fixer'), 'selected stream identity remains visible'),
      invariant(
        'responsive-pane-contract',
        wide ? frame.includes('agents · 6') : !frame.includes('agents · 6'),
        wide ? 'wide view shows rail plus stream' : 'narrow stream does not leak the rail',
      ),
    );
    if (auditCase.state === 'active-stream') {
      checks.push(
        invariant('steer-action-visible', footer.includes('m steer'), 'steer survives even at 32 columns'),
        invariant(
          'active-count-consistent',
          frame.includes('auth-fixer · running') && (!wide || frame.includes('1 running')),
          'selected stream and visible wide-fleet tally agree the agent is running',
        ),
      );
    } else {
      checks.push(
        invariant('history-position-visible', frame.includes('rows newer'), 'browsed history shows a newer-content marker'),
        invariant(
          'history-count-consistent',
          frame.includes('auth-fixer · done') && (!wide || (!frame.includes('1 running') && frame.includes('2 done'))),
          'selected stream and visible wide-fleet tally agree the agent is settled',
        ),
      );
    }
  }
  return checks;
}

export function runPolishAuditCase(auditCase: PolishAuditCase): PolishAuditResult {
  const screen = render(<OrchestrationWorkspace {...auditCase.props} />);
  const frame = screen.lastFrame() ?? '';
  screen.unmount();
  return {
    name: auditCase.name,
    state: auditCase.state,
    columns: auditCase.columns,
    rows: auditCase.rows,
    frame,
    invariants: evaluate(auditCase, frame),
  };
}

export function runPolishAudit(): PolishAuditResult[] {
  return POLISH_CASES.map(runPolishAuditCase);
}
