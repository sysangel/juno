// tests/workspaceLayout.test.tsx
// Observatory PURE layer — the layout math in src/ui/workspace/layout.ts. These pin
// the decisions the render tests can only observe: truthful count derivation, the
// orbit row's width fit + provenance shed order + whole-line status tint, the rail
// window, per-kind event row caps, the stream tail cut, and the width invariant
// (no styled line ever exceeds its cell budget — the bounded-height contract).
import { describe, expect, it } from 'vitest';
import {
  REASONING_MAX_ROWS,
  eventLines,
  lineWidth,
  orbitRowSegments,
  orbitWindow,
  railWidth,
  statusWord,
  streamHeaderLines,
  streamTail,
  streamViewport,
  summarizeAgents,
  summarySegments,
  workspaceStatusGlyph,
  type StyledLine,
} from '../src/ui/workspace/layout';
import { headerSides } from '../src/ui/workspace/WorkspaceHeader';
import { footerText } from '../src/ui/workspace/WorkspaceFooter';
import { workspaceKeyHints } from '../src/ui/workspace/keyHints';
import type { OrbitAgentVM, WorkspaceStreamEventVM } from '../src/ui/workspace/types';

const textOf = (line: StyledLine): string => line.map((s) => s.text).join('');

const agent = (overrides: Partial<OrbitAgentVM>): OrbitAgentVM => ({
  id: 'x',
  label: 'sample agent task',
  status: 'running',
  ...overrides,
});

describe('summarizeAgents / summarySegments — truthful counts', () => {
  const agents: OrbitAgentVM[] = [
    agent({ id: '1', status: 'running' }),
    agent({ id: '2', status: 'running' }),
    agent({ id: '3', status: 'waiting', attention: true }),
    agent({ id: '4', status: 'done' }),
    agent({ id: '5', status: 'error' }),
  ];

  it('tallies derive only from the agents array', () => {
    const counts = summarizeAgents(agents);
    expect(counts).toMatchObject({
      total: 5,
      running: 2,
      waiting: 1,
      done: 1,
      error: 1,
      queued: 0,
      aborted: 0,
      declined: 0,
      attention: 1,
    });
  });

  it('renders only non-zero states, coloured by lifecycle token, attention in warning', () => {
    const text = textOf(summarySegments(summarizeAgents(agents)));
    expect(text).toBe('1 need input · 5 agents · 2 running · 1 waiting · 1 done · 1 failed');
    const segments = summarySegments(summarizeAgents(agents));
    const attention = segments[0];
    expect(attention.token).toBe('warning');
    expect(attention.bold).toBe(true);
  });

  it('an empty fleet reads 0 agents with no state chips', () => {
    expect(textOf(summarySegments(summarizeAgents([])))).toBe('0 agents');
  });
});

describe('orbitRowSegments — width fit, provenance shed order, status semantics', () => {
  const full = agent({
    label: 'refactor the permission pipeline',
    model: 'fable-mini',
    provider: 'codex cli',
    elapsed: '42s',
  });

  it('keeps every row within its cell budget at any width', () => {
    for (const width of [24, 30, 36, 44, 60, 90]) {
      expect(lineWidth(orbitRowSegments(full, width, false))).toBeLessThanOrEqual(width);
      expect(lineWidth(orbitRowSegments(full, width, true))).toBeLessThanOrEqual(width);
    }
  });

  it('shows model · provider · timing in order at a comfortable width', () => {
    const text = textOf(orbitRowSegments(full, 72, false));
    expect(text).toContain('refactor the permission pipeline');
    expect(text).toContain('· fable-mini · codex cli · 42s');
  });

  it('sheds provider first, then model, keeping elapsed the longest', () => {
    const at40 = textOf(orbitRowSegments(full, 44, false));
    expect(at40).toContain('42s');
    expect(at40).toContain('fable-mini');
    expect(at40).not.toContain('codex cli');
    const at30 = textOf(orbitRowSegments(full, 30, false));
    expect(at30).toContain('42s');
    expect(at30).not.toContain('fable-mini');
  });

  it('a settled agent shows its terminal state instead of elapsed', () => {
    const done = agent({ status: 'done', terminal: 'done 84s', elapsed: '9s' });
    expect(textOf(orbitRowSegments(done, 60, false))).toContain('done 84s');
  });

  it('selection is the ▸ accent marker + bold label; provenance stays textual dim', () => {
    const line = orbitRowSegments(full, 60, true);
    expect(line[0].text).toBe('▸ ');
    expect(line[0].token).toBe('accent');
    expect(line[2].bold).toBe(true);
    const provenance = line.filter((s) => s.text.includes('fable-mini'));
    expect(provenance.every((s) => s.token === 'textDim')).toBe(true);
  });

  it('whole-line states tint the label; a cancel stays neutral', () => {
    const failed = orbitRowSegments(agent({ status: 'error', terminal: 'exit 1' }), 60, false);
    expect(failed[1].token).toBe('toolError'); // glyph
    expect(failed[2].token).toBe('toolError'); // label shouts too
    const aborted = orbitRowSegments(agent({ status: 'aborted', terminal: 'cancelled' }), 60, false);
    expect(aborted[1].token).toBe('textDim');
    expect(aborted[2].token).toBeUndefined(); // label stays default text — not a failure
  });

  it('attention appends the warning ! and still respects the budget', () => {
    const line = orbitRowSegments(agent({ attention: true, elapsed: '5s' }), 30, false);
    const last = line[line.length - 1];
    expect(last.text).toBe(' !');
    expect(last.token).toBe('warning');
    expect(lineWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe('orbitWindow — the rail viewport', () => {
  const fleet = Array.from({ length: 12 }, (_, i) => agent({ id: `a${i}`, label: `task ${i}` }));

  it('fits everything when capacity allows (no markers)', () => {
    const window = orbitWindow(fleet, 'a3', 12);
    expect(window).toMatchObject({ above: 0, below: 0 });
    expect(window.visible).toHaveLength(12);
  });

  it('keeps the selected agent visible and counts hidden neighbours honestly', () => {
    const window = orbitWindow(fleet, 'a9', 6);
    expect(window.visible.some((a) => a.id === 'a9')).toBe(true);
    expect(window.above + window.below + window.visible.length).toBe(12);
    expect(window.above).toBeGreaterThan(0);
  });

  it('an unknown selection falls back to the top of the fleet', () => {
    const window = orbitWindow(fleet, undefined, 6);
    expect(window.visible[0].id).toBe('a0');
  });
});

describe('eventLines — per-kind rendering and row bounds', () => {
  const WIDTH = 70;

  it('keeps every wrapped assistant row available for stream browsing', () => {
    const lines = eventLines(
      { kind: 'assistant', id: 'e', text: 'lorem ipsum dolor sit amet '.repeat(60) },
      WIDTH,
    );
    expect(lines.length).toBeGreaterThan(6);
    expect(textOf(lines.at(-1)!)).toContain('amet');
    for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(WIDTH);
  });

  it('wraps ordinary prose between words on narrow streams', () => {
    const lines = eventLines(
      { kind: 'assistant', id: 'e', text: 'The focused suite is stable; I am checking the adjacent timeout path now.' },
      32,
    ).map(textOf);
    expect(lines).toEqual([
      'The focused suite is stable; I',
      'am checking the adjacent timeout',
      'path now.',
    ]);
  });

  it('reasoning is restrained: ✻ marker, dim italic, at most two rows', () => {
    const lines = eventLines(
      { kind: 'reasoning', id: 'e', text: 'thinking hard about the retry seam '.repeat(30) },
      WIDTH,
    );
    expect(lines.length).toBeLessThanOrEqual(REASONING_MAX_ROWS);
    expect(textOf(lines[0]).startsWith('✻ ')).toBe(true);
    expect(lines[0][1].italic).toBe(true);
    expect(lines[0][1].token).toBe('textDim');
  });

  it('a tool card is ONE row: glyph, name, compressed detail, dim provenance', () => {
    const lines = eventLines(
      {
        kind: 'tool',
        id: 'e',
        name: 'Running tests',
        status: 'done',
        detail: 'exit 0 · 1204ms',
        provenance: 'via juno process',
      },
      WIDTH,
    );
    expect(lines).toHaveLength(1);
    const text = textOf(lines[0]);
    expect(text).toContain('✓ Running tests');
    expect(text).toContain('via juno process');
    expect(lineWidth(lines[0])).toBeLessThanOrEqual(WIDTH);
    const provenance = lines[0].find((s) => s.text.includes('via juno process'));
    expect(provenance?.token).toBe('textDim');
  });

  it('a waiting tool shouts amber whole-line with the permission suffix', () => {
    const [line] = eventLines(
      { kind: 'tool', id: 'e', name: 'Bash', status: 'waiting' },
      WIDTH,
    );
    expect(textOf(line)).toContain('waiting on permission');
    expect(line[0].token).toBe('warning');
    expect(line[1].token).toBe('warning');
  });

  it('permission checkpoints render pending/granted/denied with distinct semantics', () => {
    const pending = eventLines(
      { kind: 'permission', id: 'e', toolName: 'Bash', risk: 'high', resolution: 'pending' },
      WIDTH,
    )[0];
    expect(textOf(pending)).toBe('◌ permission · Bash (high) · awaiting decision');
    expect(pending.every((s) => s.token === 'warning')).toBe(true);

    const granted = eventLines(
      { kind: 'permission', id: 'e', toolName: 'Bash', resolution: 'granted' },
      WIDTH,
    )[0];
    expect(textOf(granted)).toBe('✓ permission · Bash · granted');
    expect(granted[0].token).toBe('toolResult');
    expect(granted[1].token).toBe('textDim');

    const denied = eventLines(
      { kind: 'permission', id: 'e', toolName: 'Bash', resolution: 'denied' },
      WIDTH,
    )[0];
    expect(textOf(denied)).toBe('⊘ permission · Bash · denied');
    expect(denied.every((s) => s.token === 'warning')).toBe(true);
  });

  it('lifecycle notices carry tone glyphs: ✓ success, ✗ error, ◦ neutral', () => {
    expect(textOf(eventLines({ kind: 'lifecycle', id: 'e', text: 'agent completed', tone: 'success' }, WIDTH)[0]))
      .toBe('✓ agent completed');
    expect(textOf(eventLines({ kind: 'lifecycle', id: 'e', text: 'agent crashed', tone: 'error' }, WIDTH)[0]))
      .toBe('✗ agent crashed');
    expect(textOf(eventLines({ kind: 'lifecycle', id: 'e', text: 'agent spawned', tone: 'neutral' }, WIDTH)[0]))
      .toBe('◦ agent spawned');
  });

  it('steering renders under the ❯ prompt in the user role tint', () => {
    const [line] = eventLines({ kind: 'steering', id: 'e', text: 'focus on auth' }, WIDTH);
    expect(textOf(line)).toBe('❯ focus on auth');
    expect(line.every((s) => s.token === 'roleUser')).toBe(true);
  });

  it('strips terminal-unsafe input before rendering', () => {
    const [line] = eventLines(
      { kind: 'assistant', id: 'e', text: 'safe[31m text' },
      WIDTH,
    );
    expect(textOf(line)).toBe('safe text');
  });
});

describe('streamTail — the bounded event viewport', () => {
  const events: WorkspaceStreamEventVM[] = Array.from({ length: 10 }, (_, i) => ({
    kind: 'lifecycle',
    id: `e${i}`,
    text: `note ${i}`,
    tone: 'neutral',
  }));

  it('shows everything when it fits, with no marker', () => {
    const tail = streamTail(events, 60, 20);
    expect(tail.hiddenEvents).toBe(0);
    expect(tail.lines).toHaveLength(10);
  });

  it('cuts oldest-first, spends one row on the honest marker, never exceeds capacity', () => {
    const tail = streamTail(events, 60, 5);
    expect(tail.lines.length).toBeLessThanOrEqual(5);
    expect(tail.hiddenEvents).toBe(6);
    expect(textOf(tail.lines[0])).toBe('↑ 6 earlier');
    expect(textOf(tail.lines[tail.lines.length - 1])).toContain('note 9');
  });

  it('a single event taller than the viewport shows its tail rows', () => {
    const tall: WorkspaceStreamEventVM[] = [
      { kind: 'assistant', id: 'big', text: 'alpha beta gamma delta '.repeat(40) },
    ];
    const tail = streamTail(tall, 20, 3);
    expect(tail.lines.length).toBeLessThanOrEqual(3);
    expect(textOf(tail.lines[0])).toContain('↑ earlier');
  });

  it('never overflows a one-row viewport', () => {
    const tall: WorkspaceStreamEventVM[] = [
      { kind: 'assistant', id: 'big', text: 'alpha beta gamma delta '.repeat(40) },
    ];
    const tail = streamTail(tall, 20, 1);
    expect(tail.lines).toHaveLength(1);
    expect(tail.hiddenEvents).toBe(1);
    expect(textOf(tail.lines[0])).toBe('↑ 1 earlier');
  });

  it('browses away from the live tail with bounded earlier/newer markers', () => {
    const viewport = streamViewport(events, 60, 5, 3);
    expect(viewport.lines).toHaveLength(5);
    expect(textOf(viewport.lines[0])).toMatch(/^↑ \d+ rows earlier$/);
    expect(textOf(viewport.lines.at(-1)!)).toBe('↓ 3 rows newer');
    expect(viewport.newerRows).toBe(3);
    expect(viewport.lines.some((line) => textOf(line).includes('note 9'))).toBe(false);
  });
});

describe('chrome helpers', () => {
  it('statusWord and workspaceStatusGlyph cover the full vocabulary', () => {
    expect(statusWord('error')).toBe('failed');
    expect(statusWord('waiting')).toBe('waiting on permission');
    expect(workspaceStatusGlyph('running')).toBe('◐');
    expect(workspaceStatusGlyph('queued')).toBe('●');
    expect(workspaceStatusGlyph('declined')).toBe('⊘');
  });

  it('streamHeaderLines keeps title+status on one bounded row and provenance textual', () => {
    const header = streamHeaderLines(
      {
        id: 'a',
        title: 'a very long agent identity that will not fit on a tight pane',
        task: 'do the thing',
        status: 'running',
        model: 'fable-mini',
        provider: 'via codex cli',
        elapsed: '7s',
        events: [],
      },
      40,
      true,
    );
    expect(lineWidth(header.title)).toBeLessThanOrEqual(40 - 2); // glyph slot is separate
    expect(textOf(header.title)).toContain('· running');
    expect(textOf(header.provenance)).toBe('fable-mini · via codex cli · 7s');
    expect(header.title[0].token).toBe('accent'); // focused treatment
  });

  it('railWidth clamps to a scannable band', () => {
    expect(railWidth(110)).toBeGreaterThanOrEqual(30);
    expect(railWidth(160)).toBe(51);
    expect(railWidth(300)).toBeLessThanOrEqual(52);
  });

  it('headerSides sheds the session label before any truthful count', () => {
    const agents = [agent({ id: '1' }), agent({ id: '2', status: 'done' })];
    const wide = headerSides(agents, 120, 'wave-9');
    expect(textOf(wide.left)).toContain('wave-9');
    const tight = headerSides(agents, 40, 'wave-9');
    expect(textOf(tight.left)).not.toContain('wave-9');
    expect(textOf(tight.left)).toContain('Observatory');
  });

  it('headerSides never strands a separator when the next summary chip cannot fit', () => {
    const agents = [agent({ id: '1' }), agent({ id: '2', status: 'done' })];
    for (const width of [28, 32, 36, 40]) {
      expect(textOf(headerSides(agents, width, 'polish-loop').right)).not.toMatch(/·\s*$/);
    }
  });

  it('footerText advertises only the supplied keys, clipped to width', () => {
    expect(footerText([{ key: 'tab', action: 'focus' }, { key: 'esc', action: 'back' }], 60)).toBe(
      'tab focus · esc back',
    );
    expect(footerText([], 60)).toBe('');
  });

  it('footerText fits whole bindings under pressure instead of cutting an action in half', () => {
    const text = footerText(
      [{ key: 'esc', action: 'chat' }, { key: 'g/d', action: 'allow/deny' }, { key: '↑↓', action: 'agent' }],
      32,
    );
    expect(text).toContain('g/d allow/deny');
    expect(text).not.toMatch(/·\s*$/);
    expect(text).not.toContain('allow/…');
  });

  it('capability hints hide dead actions and prioritize an active permission gate', () => {
    expect(workspaceKeyHints({
      messageMode: false,
      wide: false,
      narrowPane: 'orbit',
      focus: 'orbit',
      agentCount: 0,
    })).toEqual([{ key: 'esc', action: 'chat' }]);

    const waiting = workspaceKeyHints({
      messageMode: false,
      wide: false,
      narrowPane: 'orbit',
      focus: 'orbit',
      agentCount: 2,
      capabilities: { cancel: true, resolvePermission: true },
    });
    expect(waiting.slice(0, 3)).toEqual([
      { key: 'esc', action: 'chat' },
      { key: 'g/d', action: 'allow/deny' },
      { key: 'x', action: 'cancel' },
    ]);
  });
});
