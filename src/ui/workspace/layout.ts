// src/ui/workspace/layout.ts
// PURE presentation math for the Observatory. Every function here maps view-model
// data + a cell budget to STYLED LINES — arrays of { text, token, bold, italic }
// segments whose summed display width never exceeds the budget. The components are
// thin: they turn these lines into <Text> rows one-for-one, which is what makes the
// workspace's bounded-height promise checkable (line count IS row count; no hidden
// wrapping can inflate it).
//
// Colour discipline: tokens are SEMANTIC ONLY (status, attention, focus, brand).
// Model/provider provenance is always textual and always dim — never coloured.
import {
  ARROW_UP,
  ARROW_DOWN,
  OK,
  BULLET,
  FAIL,
  PROMPT_LINE,
  RUNNING_HALF,
  SELECTED,
  THINKING,
  TOOL_PENDING,
  TOOL_WAITING,
  presentedStateGlyph,
  presentedStatusToken,
  isWholeLinePresented,
} from '../glyphs';
import { clipCells, displayWidth, sanitizeForDisplay, wrapCells } from '../clipText';
import type { FlatTokenName } from '../theme';
import type {
  OrbitAgentVM,
  SelectedAgentVM,
  WorkspaceAgentStatus,
  WorkspaceStreamEventVM,
} from './types';

/** One coloured run of text inside a rendered row. `token` undefined ⇒ default fg. */
export interface StyledSegment {
  readonly text: string;
  readonly token?: FlatTokenName;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/** One rendered terminal row: its segments, in order. Width sums to <= the budget
 *  the builder was given. */
export type StyledLine = readonly StyledSegment[];

/** Row caps for secondary event kinds. Assistant prose remains fully browsable. */
export const REASONING_MAX_ROWS = 2;
export const STEERING_MAX_ROWS = 2;

/** Total display width of a styled line (the invariant the tests pin). */
export function lineWidth(line: StyledLine): number {
  return line.reduce((n, seg) => n + displayWidth(seg.text), 0);
}

// ---------------------------------------------------------------------------
// Header summary — truthful counts derived ONLY from the agents array
// ---------------------------------------------------------------------------

/** Per-status tallies plus the attention count. Derived, never adapter-supplied,
 *  so the header can only ever say what the rail actually shows. */
export interface WorkspaceCounts {
  readonly total: number;
  readonly running: number;
  readonly queued: number;
  readonly waiting: number;
  readonly done: number;
  readonly error: number;
  readonly aborted: number;
  readonly declined: number;
  readonly attention: number;
}

export function summarizeAgents(agents: readonly OrbitAgentVM[]): WorkspaceCounts {
  const counts = {
    total: agents.length,
    running: 0,
    queued: 0,
    waiting: 0,
    done: 0,
    error: 0,
    aborted: 0,
    declined: 0,
    attention: 0,
  };
  for (const agent of agents) {
    counts[agent.status] += 1;
    if (agent.attention === true) counts.attention += 1;
  }
  return counts;
}

/**
 * The header's right-hand summary: `N agents` anchored dim, then only the NON-ZERO
 * state tallies, each tinted with its lifecycle token (`2 running` cyan, `1 waiting`
 * amber, …). Attention leads the line in warning so width clipping cannot discard
 * the one summary chip a user must never miss.
 */
export function summarySegments(counts: WorkspaceCounts): StyledLine {
  const sep: StyledSegment = { text: ' · ', token: 'textDim' };
  const chips: StyledSegment[] = [];
  if (counts.attention > 0) {
    chips.push({ text: `${counts.attention} need input`, token: 'warning', bold: true }, sep);
  }
  chips.push({ text: `${counts.total} ${counts.total === 1 ? 'agent' : 'agents'}`, token: 'textDim' });
  const states: ReadonlyArray<[number, string, FlatTokenName]> = [
    [counts.running, 'running', presentedStatusToken('running')],
    [counts.waiting, 'waiting', presentedStatusToken('waiting')],
    [counts.queued, 'queued', presentedStatusToken('queued')],
    [counts.done, 'done', presentedStatusToken('done')],
    [counts.error, 'failed', presentedStatusToken('error')],
    [counts.aborted, 'aborted', presentedStatusToken('aborted')],
    [counts.declined, 'declined', presentedStatusToken('declined')],
  ];
  for (const [n, word, tok] of states) {
    if (n > 0) chips.push(sep, { text: `${n} ${word}`, token: tok });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// Orbit rail
// ---------------------------------------------------------------------------

/** Rail width in the wide two-pane layout: about a third of the terminal, clamped
 *  so the rail stays scannable and the stream keeps the lion's share. */
export function railWidth(columns: number): number {
  return Math.max(30, Math.min(52, Math.floor(columns * 0.32)));
}

/** Static status glyph for an orbit row / stream card. Running is the STATIC ◐ here —
 *  the workspace's only animation is the selected stream header's spinner. */
export function workspaceStatusGlyph(status: WorkspaceAgentStatus): string {
  switch (status) {
    case 'running':
      return RUNNING_HALF;
    case 'queued':
      return TOOL_PENDING;
    case 'done':
      return OK;
    case 'waiting':
    case 'error':
    case 'aborted':
    case 'declined':
      return presentedStateGlyph(status);
  }
}

/** Human word for a status in the stream identity header. */
export function statusWord(status: WorkspaceAgentStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'waiting':
      return 'waiting on permission';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    case 'aborted':
      return 'aborted';
    case 'declined':
      return 'declined';
  }
}

/** The visible slice of the rail when there are more agents than rows: the selection
 *  stays in view, hidden neighbours are counted honestly above/below. */
export interface OrbitWindow {
  readonly above: number;
  readonly below: number;
  readonly visible: readonly OrbitAgentVM[];
}

export function orbitWindow(
  agents: readonly OrbitAgentVM[],
  selectedAgentId: string | undefined,
  capacity: number,
): OrbitWindow {
  if (capacity <= 0) return { above: agents.length, below: 0, visible: [] };
  if (agents.length <= capacity) return { above: 0, below: 0, visible: [...agents] };
  // Overflowing: reserve one row each for the ↑/↓ markers so the counts are shown.
  const slots = Math.max(1, capacity - 2);
  const selectedIndex = Math.max(
    0,
    agents.findIndex((a) => a.id === selectedAgentId),
  );
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(slots / 2)),
    agents.length - slots,
  );
  return {
    above: start,
    below: agents.length - (start + slots),
    visible: agents.slice(start, start + slots),
  };
}

/**
 * One orbit row, head-priority fitted to `width` cells:
 *
 *   ▸ ◐ fix flaky auth tests · fable-mini · codex cli · 42s !
 *
 * The marker (selection), glyph (status colour), and attention `!` are fixed; the
 * timing / model / provider suffixes shed IN THAT reverse order (provider first,
 * timing last) when the label would otherwise fall below a readable minimum. Label
 * colour follows the shared whole-line rule: error/waiting/declined tint the label
 * with their status token; everything else keeps default text (bold when selected).
 */
export function orbitRowSegments(
  agent: OrbitAgentVM,
  width: number,
  selected: boolean,
): StyledLine {
  // Readable-label floor: suffixes shed until the label keeps at least this many
  // cells — the rail is scanned BY label, so provenance gives way before the label
  // crushes into an unreadable stub.
  const MIN_LABEL = 16;
  const glyphToken = presentedStatusToken(agent.status);
  const labelToken: FlatTokenName | undefined = isWholeLinePresented(agent.status)
    ? presentedStatusToken(agent.status)
    : undefined;

  const timing = agent.status === 'running' ? agent.elapsed : agent.terminal ?? agent.elapsed;
  // Shed order under width pressure: provider → model → timing (timing survives longest).
  const suffixes: Array<{ text: string; rank: number }> = [];
  if (agent.model !== undefined && agent.model.length > 0) {
    suffixes.push({ text: ` · ${sanitizeForDisplay(agent.model)}`, rank: 1 });
  }
  if (agent.provider !== undefined && agent.provider.length > 0) {
    suffixes.push({ text: ` · ${sanitizeForDisplay(agent.provider)}`, rank: 0 });
  }
  if (timing !== undefined && timing.length > 0) {
    suffixes.push({ text: ` · ${sanitizeForDisplay(timing)}`, rank: 2 });
  }

  const attention = agent.attention === true;
  const avail = Math.max(0, width - 4 - (attention ? 2 : 0)); // '▸ ' + '◐ ' (+' !')
  const label = sanitizeForDisplay(agent.label);
  const labelW = Math.max(Math.min(displayWidth(label), MIN_LABEL), 1);

  const kept = [...suffixes];
  const reserveOf = (list: typeof kept): number =>
    list.reduce((n, s) => n + displayWidth(s.text), 0);
  kept.sort((a, b) => a.rank - b.rank);
  while (kept.length > 0 && reserveOf(kept) + labelW > avail) kept.shift();
  // Display order is model · provider · timing (provenance before time).
  const ordered = [...kept].sort((a, b) => (a.rank === 2 ? 1 : b.rank === 2 ? -1 : b.rank - a.rank));

  const labelMax = Math.max(0, avail - reserveOf(ordered));
  const segments: StyledSegment[] = [
    selected
      ? { text: `${SELECTED} `, token: 'accent', bold: true }
      : { text: '  ' },
    { text: `${workspaceStatusGlyph(agent.status)} `, token: glyphToken },
    { text: clipCells(label, labelMax), token: labelToken, bold: selected },
  ];
  for (const suffix of ordered) segments.push({ text: suffix.text, token: 'textDim' });
  if (attention) segments.push({ text: ' !', token: 'warning', bold: true });
  return segments;
}

/** Overflow marker rows for the rail window. */
export function orbitOverflowLine(direction: 'above' | 'below', count: number): StyledLine {
  const arrow = direction === 'above' ? ARROW_UP : ARROW_DOWN;
  return [{ text: `  ${arrow} ${count} more`, token: 'textDim' }];
}

// ---------------------------------------------------------------------------
// Stream identity header
// ---------------------------------------------------------------------------

/**
 * The selected agent's THREE identity rows (fixed height keeps the stream rhythm
 * stable): title+status word, task, textual provenance. The status glyph slot is
 * rendered by the component (it may be the workspace's one spinner), so line one
 * here starts AFTER that two-cell slot.
 */
export function streamHeaderLines(
  selected: SelectedAgentVM,
  width: number,
  focused: boolean,
): { title: StyledLine; task: StyledLine; provenance: StyledLine } {
  const word = statusWord(selected.status);
  const wordText = ` · ${word}`;
  const titleMax = Math.max(1, width - 2 - displayWidth(wordText));
  const title: StyledLine = [
    {
      text: clipCells(sanitizeForDisplay(selected.title), titleMax),
      token: focused ? 'accent' : undefined,
      bold: true,
    },
    { text: wordText, token: presentedStatusToken(selected.status) },
  ];
  const task: StyledLine = [
    { text: clipCells(sanitizeForDisplay(selected.task), Math.max(1, width)), token: 'textDim' },
  ];
  const timing = selected.status === 'running' ? selected.elapsed : selected.terminal ?? selected.elapsed;
  const provenanceText = [selected.model, selected.provider, timing]
    .filter((p): p is string => p !== undefined && p.length > 0)
    .join(' · ');
  const provenance: StyledLine = [
    {
      text: clipCells(sanitizeForDisplay(provenanceText.length > 0 ? provenanceText : word), Math.max(1, width)),
      token: 'textDim',
    },
  ];
  return { title, task, provenance };
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

/** Wrap one prose line on words, hard-splitting only a token wider than the pane. */
function wrapProseLine(text: string, width: number): string[] {
  const budget = Math.max(1, width);
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [''];

  const rows: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      rows.push(current);
      current = '';
    }
    if (displayWidth(word) <= budget) {
      current = word;
      continue;
    }
    const pieces = wrapCells(word, budget);
    rows.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Sanitize + word-wrap prose into rows of <= width cells, tab-expanded. */
function wrappedRows(text: string, width: number): string[] {
  const clean = sanitizeForDisplay(text).replace(/\t/g, '  ');
  const rows: string[] = [];
  for (const logical of clean.split(/\r?\n/)) {
    rows.push(...wrapProseLine(logical, width));
  }
  return rows;
}

/** Cap wrapped rows at `cap`, folding the overflow into a clipped final row so the
 *  truncation is visible (…) instead of silent. */
function cappedRows(rows: string[], cap: number, width: number): string[] {
  if (cap <= 0) return [];
  if (rows.length <= cap) return rows;
  const kept = rows.slice(0, cap - 1);
  const tail = rows.slice(cap - 1).join(' ');
  return [...kept, clipCells(`${tail} …`, Math.max(1, width))];
}

/**
 * Render one stream event to its styled rows at `width`. Row counts are bounded per
 * kind (tool/permission/lifecycle: 1; reasoning/steering: <= 2; assistant: <= 6) so
 * the tail window's arithmetic — and therefore the workspace's height bound — holds.
 */
export function eventLines(event: WorkspaceStreamEventVM, width: number): StyledLine[] {
  switch (event.kind) {
    case 'assistant':
      // Do not fold prose here: streamTail keeps the newest rows visible and
      // streamViewport lets the user browse every earlier row. Capping at this
      // layer permanently discarded the middle of long agent responses.
      return wrappedRows(event.text, width).map(
        (row) => [{ text: row }],
      );
    case 'reasoning': {
      const rows = cappedRows(wrappedRows(event.text, width - 2), REASONING_MAX_ROWS, width - 2);
      return rows.map((row, i) => [
        { text: i === 0 ? `${THINKING} ` : '  ', token: 'textDim' },
        { text: row, token: 'textDim', italic: true },
      ]);
    }
    case 'steering': {
      const rows = cappedRows(wrappedRows(event.text, width - 2), STEERING_MAX_ROWS, width - 2);
      return rows.map((row, i) => [
        { text: i === 0 ? PROMPT_LINE : '  ', token: 'roleUser' },
        { text: row, token: 'roleUser' },
      ]);
    }
    case 'tool': {
      const glyphToken = presentedStatusToken(event.status);
      const shout = isWholeLinePresented(event.status);
      const nameToken: FlatTokenName | undefined = shout ? glyphToken : undefined;
      const name = sanitizeForDisplay(event.name);
      const provenance =
        event.provenance !== undefined && event.provenance.length > 0
          ? ` · ${sanitizeForDisplay(event.provenance)}`
          : '';
      const waiting = event.status === 'waiting' ? ' · waiting on permission' : '';
      // Head-priority fit: name + short suffixes reserved whole, detail compresses.
      const avail = Math.max(0, width - 2);
      const reserve = displayWidth(provenance) + displayWidth(waiting);
      const nameClipped = clipCells(name, Math.max(1, avail - reserve));
      const detailRoom = avail - displayWidth(nameClipped) - reserve - 3;
      const detail =
        event.detail !== undefined && event.detail.length > 0 && detailRoom > 1
          ? ` · ${clipCells(sanitizeForDisplay(event.detail), detailRoom)}`
          : '';
      const line: StyledSegment[] = [
        { text: `${workspaceStatusGlyph(event.status)} `, token: glyphToken },
        { text: nameClipped, token: nameToken },
      ];
      if (detail.length > 0) line.push({ text: detail, token: shout ? nameToken : 'textDim' });
      if (provenance.length > 0) line.push({ text: provenance, token: 'textDim' });
      if (waiting.length > 0) line.push({ text: waiting, token: glyphToken });
      return [line];
    }
    case 'permission': {
      const risk =
        event.risk !== undefined && event.risk.length > 0 ? ` (${sanitizeForDisplay(event.risk)})` : '';
      const body = `permission · ${sanitizeForDisplay(event.toolName)}${risk}`;
      if (event.resolution === 'pending') {
        const text = clipCells(`${body} · awaiting decision`, Math.max(1, width - 2));
        return [[
          { text: `${TOOL_WAITING} `, token: 'warning' },
          { text, token: 'warning' },
        ]];
      }
      if (event.resolution === 'granted') {
        return [[
          { text: `${OK} `, token: 'toolResult' },
          { text: clipCells(`${body} · granted`, Math.max(1, width - 2)), token: 'textDim' },
        ]];
      }
      return [[
        { text: `${presentedStateGlyph('declined')} `, token: 'warning' },
        { text: clipCells(`${body} · denied`, Math.max(1, width - 2)), token: 'warning' },
      ]];
    }
    case 'lifecycle': {
      const glyph =
        event.tone === 'success' ? OK : event.tone === 'error' ? FAIL : BULLET;
      const glyphToken: FlatTokenName =
        event.tone === 'success' ? 'toolResult' : event.tone === 'error' ? 'toolError' : 'textDim';
      return [[
        { text: `${glyph} `, token: glyphToken },
        {
          text: clipCells(sanitizeForDisplay(event.text), Math.max(1, width - 2)),
          token: event.tone === 'error' ? 'toolError' : 'textDim',
        },
      ]];
    }
  }
}

/** The stream viewport: the most-recent events that fit `capacity` rows, with one
 *  honest `↑ N earlier` marker when older events were cut. */
export interface StreamTail {
  readonly hiddenEvents: number;
  readonly lines: readonly StyledLine[];
}

export interface StreamViewport extends StreamTail {
  /** Rendered rows hidden below the viewport, toward the live tail. */
  readonly newerRows: number;
}

export function streamTail(
  events: readonly WorkspaceStreamEventVM[],
  width: number,
  capacity: number,
): StreamTail {
  if (capacity <= 0) return { hiddenEvents: events.length, lines: [] };
  const built = events.map((event) => eventLines(event, width));
  const total = built.reduce((n, lines) => n + lines.length, 0);
  if (total <= capacity) return { hiddenEvents: 0, lines: built.flat() };

  // A one-row viewport cannot fit both a cut marker and event content. Prefer an
  // explicit count over silently overflowing (and over implying that a partial
  // event is complete). `slice(-0)` would otherwise return the entire event.
  if (capacity === 1) {
    return {
      hiddenEvents: events.length,
      lines: [[{ text: `${ARROW_UP} ${events.length} earlier`, token: 'textDim' }]],
    };
  }

  // Overflowing: keep whole events from the end, reserving one row for the marker.
  const budget = capacity - 1;
  const kept: StyledLine[][] = [];
  let used = 0;
  let firstKept = built.length;
  for (let i = built.length - 1; i >= 0; i--) {
    if (used + built[i].length > budget) break;
    used += built[i].length;
    kept.unshift(built[i]);
    firstKept = i;
  }
  if (kept.length === 0) {
    // A single event taller than the viewport: show its tail rows.
    const last = built[built.length - 1] ?? [];
    return {
      hiddenEvents: Math.max(0, events.length - 1),
      lines: [
        [{ text: `${ARROW_UP} earlier`, token: 'textDim' }],
        ...last.slice(-budget),
      ],
    };
  }
  return {
    hiddenEvents: firstKept,
    lines: [
      [{ text: `${ARROW_UP} ${firstKept} earlier`, token: 'textDim' }],
      ...kept.flat(),
    ],
  };
}

/**
 * Browse an agent stream by rendered rows while preserving the bounded-height
 * contract. Offset zero follows the live tail. Positive offsets reveal earlier
 * rows and add explicit markers on both cut edges; a tiny viewport prioritizes
 * truthful navigation state over partial, ambiguous content.
 */
export function streamViewport(
  events: readonly WorkspaceStreamEventVM[],
  width: number,
  capacity: number,
  offsetRows: number,
): StreamViewport {
  if (offsetRows <= 0) return { ...streamTail(events, width, capacity), newerRows: 0 };
  if (capacity <= 0) return { hiddenEvents: events.length, newerRows: 0, lines: [] };

  const built = events.map((event) => eventLines(event, width));
  const flat = built.flatMap((lines, eventIndex) =>
    lines.map((line) => ({ line, eventIndex })),
  );
  if (flat.length <= capacity) {
    return { hiddenEvents: 0, newerRows: 0, lines: flat.map(({ line }) => line) };
  }

  const newerRows = Math.min(Math.max(0, Math.floor(offsetRows)), flat.length - 1);
  const end = flat.length - newerRows;
  if (capacity === 1) {
    return {
      hiddenEvents: new Set(flat.slice(0, end).map(({ eventIndex }) => eventIndex)).size,
      newerRows,
      lines: [[{ text: clipCells(`${ARROW_DOWN} ${newerRows} rows newer`, width), token: 'textDim' }]],
    };
  }

  // Reserve the bottom marker first, then a top marker when the remaining
  // content window does not reach the beginning.
  let contentRows = capacity - 1;
  let start = Math.max(0, end - contentRows);
  if (start > 0) {
    contentRows = Math.max(0, contentRows - 1);
    start = Math.max(0, end - contentRows);
  }
  const earlierRows = start;
  const hiddenEvents = new Set(flat.slice(0, start).map(({ eventIndex }) => eventIndex)).size;
  const lines: StyledLine[] = [];
  if (earlierRows > 0) {
    lines.push([{ text: clipCells(`${ARROW_UP} ${earlierRows} rows earlier`, width), token: 'textDim' }]);
  }
  lines.push(...flat.slice(start, end).map(({ line }) => line));
  lines.push([{ text: clipCells(`${ARROW_DOWN} ${newerRows} rows newer`, width), token: 'textDim' }]);
  return { hiddenEvents, newerRows, lines: lines.slice(0, capacity) };
}
