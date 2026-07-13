// src/ui/GroupedToolRows.tsx
// Grouped-tool-rows — the live/condensed presentation of a CONCURRENT tool batch (>= 2 tool
// calls the model issued together; see src/ui/toolGroups.ts + docs/UX-SPEC.md R5). It replaces
// the old "N independent cards in stream order" with ONE unit that speaks the same visual
// language as the agents panel (spinner / ✓ / ✗ glyphs, dim status rows, newest-row windowing,
// cell-accurate width clipping):
//
//   LIVE (>= 1 member still non-terminal) — an expanded group:
//     ⠋ 4 tools · 2 running, 2 done          header (spinner while any run, dim bucket summary)
//       ⠋ grep(juno) · 1s                     one status row per member (windowed to the newest
//       ✓ glob(src) · 3 files                 maxRows, an `↑ K earlier` head above the rest),
//       ✓ read_file(app.tsx)                  each row clipped to one terminal row, never wrapped
//       ✗ mcp__brain__recall(state) · down    (a failed row carries WHY, like the agents panel)
//
//   SETTLED (all members terminal) — one condensed committed line (the full per-tool detail
//   stays one Ctrl+O away in the tool-detail overlay — integrate, don't duplicate):
//     ✓ 4 tools · grep, glob, read_file, …     all ok  (green)
//     ✗ 4 tools · 1 failed · recall: server …  a failure (red, reason never dropped)
//
// A SOLO tool (a batch of one) never reaches here — Message.tsx keeps today's single card for it.
// Pure/presentational; the running clock lives at the render edge (injectable `now`), never the
// reducer. Width math routes through clipText (the one display-cell authority), so a CJK/emoji
// arg is measured in true cells and a row never wraps into Ink's scrollback-erase branch.
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { memo, type ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { clipCells, displayWidth } from './clipText';
import {
  humanizeArgs,
  humanizeResult,
  MAX_NEST_DEPTH,
  useRunningElapsedSeconds,
} from './ToolCallCard';
import { memberLifecycle, summarizeToolGroup, type MemberLifecycle } from './toolGroups';

const DEPTH: ColorDepth = detectColorDepth();

/** Default cap on expanded member rows before the group windows to its newest rows (mirrors the
 *  agents panel's SUBAGENT_MAX_VISIBLE_ROWS). The group lives inside the live turn, which
 *  liveWindow.ts already height-bounds, so this only guards a pathologically large single batch. */
export const GROUP_MAX_VISIBLE_ROWS = 8;

/** Fallback width when columns is not threaded (committed <Static> path): a generous cap so the
 *  condensed one-liner stays bounded without a real terminal width. */
const FALLBACK_WIDTH = 120;

export interface GroupedToolEntry {
  readonly toolCallId: string;
  readonly tool: ToolState;
}

export interface GroupedToolRowsProps {
  /** The concurrent group's members, in stream order (>= 2). */
  readonly entries: readonly GroupedToolEntry[];
  readonly depth?: ColorDepth;
  /** Terminal columns for cell-accurate clipping; falls back to FALLBACK_WIDTH when absent. */
  readonly columns?: number;
  /** Left indent (× 2), clamped at MAX_NEST_DEPTH — 0 for a top-level concurrency group. */
  readonly nestDepth?: number;
  readonly maxRows?: number;
  /** Injectable clock for the running rows' elapsed timer (tests pin it). Defaults to Date.now. */
  readonly now?: () => number;
}

/** lifecycle → status colour token (shared meaning with the agents panel / tool cards). */
function lifecycleToken(life: MemberLifecycle): FlatTokenName {
  switch (life) {
    case 'error':
      return 'toolError';
    case 'done':
      return 'toolResult';
    case 'running':
      return 'toolRunning';
    case 'pending':
      return 'toolPending';
  }
}

/** lifecycle → static glyph (running renders an animated spinner instead — see the row). */
function lifecycleGlyph(life: MemberLifecycle): string {
  switch (life) {
    case 'error':
      return '✗';
    case 'done':
      return '✓';
    case 'running':
      return '◐'; // unused (spinner rendered); kept for exhaustiveness
    case 'pending':
      return '◐';
  }
}

/** The trailing status detail for a member row (RAW, unclipped): elapsed while running, the
 *  humanized result tail when done, the first error line when failed, nothing while pending. */
function rowDetail(tool: ToolState, seconds: number | null): string {
  switch (memberLifecycle(tool.status)) {
    case 'running':
      return seconds !== null ? `${Math.floor(seconds)}s` : '';
    case 'done':
      return humanizeResult(tool.name, tool.result).text;
    case 'error':
      return (tool.error ?? 'failed').split('\n').find((l) => l.trim().length > 0) ?? 'failed';
    case 'pending':
      return '';
  }
}

/** The collapsed live-header summary — `2 running, 2 done, 1 failed`, non-zero buckets only
 *  (pending folds into running: both are in flight). Mirrors the agents strip's summary idiom. */
function headerSummary(inFlight: number, done: number, failed: number): string {
  const parts: string[] = [];
  if (inFlight > 0) parts.push(`${inFlight} running`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(', ');
}

/** One expanded member row. A child component so its running clock's hook count is stable as the
 *  window slides (rows mount/unmount as whole instances). Clipped to one terminal row. */
function GroupToolRow(props: {
  readonly entry: GroupedToolEntry;
  readonly width: number;
  readonly depth: ColorDepth;
  readonly indent: number;
  readonly now: () => number;
}): ReactElement {
  const { entry, width, depth: d, indent } = props;
  const life = memberLifecycle(entry.tool.status);
  const running = life === 'running';
  const seconds = useRunningElapsedSeconds(running, props.now);

  const dim = token('textDim', d);
  const glyphColor = token(lifecycleToken(life), d);
  // Error carries its meaning across the whole row (like the agents panel's error row); the other
  // states keep the label dim and let the glyph carry the colour.
  const labelColor = life === 'error' ? glyphColor : dim;

  const head = `${entry.tool.name}(${humanizeArgs(entry.tool.name, entry.tool.args)})`;
  const detail = rowDetail(entry.tool, seconds);
  const detailRender = detail.length > 0 ? ` · ${detail}` : '';

  // PREFIX = indent + glyph(1) + leading space(1); clip to width-1 (1 col slack) so the row
  // occupies exactly one terminal row. Give the head (the row's identity) priority and fit the
  // detail into the remainder; an ERROR reason is never dropped — it is clipped in (like the
  // agents panel), never blanked to read like a clean finish.
  const prefix = indent + 2;
  const content = Math.max(0, width - 1 - prefix);
  const detailW = displayWidth(detailRender);
  const showDetailWhole = detailRender.length > 0 && displayWidth(head) + detailW <= content;
  let detailText = showDetailWhole ? detailRender : '';
  let headMax = showDetailWhole ? content - detailW : content;
  if (!showDetailWhole && life === 'error' && detail.length > 0) {
    // Reserve room for a clipped reason rather than dropping it.
    const room = content - Math.min(displayWidth(head), Math.max(0, content - 6));
    if (room > 3) {
      detailText = ` · ${clipCells(detail, room - 3)}`;
      headMax = Math.max(0, content - displayWidth(detailText));
    }
  }
  const headText = clipCells(head, headMax);

  return (
    <Box marginLeft={indent}>
      {running ? (
        <Text color={glyphColor}>
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={glyphColor}>{lifecycleGlyph(life)}</Text>
      )}
      <Text color={labelColor}>{` ${headText}`}</Text>
      {detailText.length > 0 ? <Text color={labelColor}>{detailText}</Text> : null}
    </Box>
  );
}

function GroupedToolRowsView(props: GroupedToolRowsProps): ReactElement | null {
  if (props.entries.length === 0) return null;
  const d = props.depth ?? DEPTH;
  const dim = token('textDim', d);
  const width = props.columns !== undefined && props.columns > 0 ? props.columns : FALLBACK_WIDTH;
  const indent = Math.max(0, Math.min(props.nestDepth ?? 0, MAX_NEST_DEPTH)) * 2;
  const now = props.now ?? Date.now;

  const summary = summarizeToolGroup(props.entries.map((e) => e.tool));

  // SETTLED → one condensed committed line. Full per-tool detail stays in the Ctrl+O overlay.
  if (summary.allSettled) {
    const failure = summary.firstFailure;
    const glyph = failure !== undefined ? '✗' : '✓';
    const glyphColor = token(failure !== undefined ? 'toolError' : 'toolResult', d);
    const lead = `${summary.total} tools`;
    const rest =
      failure !== undefined
        ? `${summary.failed} failed · ${failure.name}: ${failure.reason}`
        : summary.names.join(', ');
    const failed = failure !== undefined;
    // indent + glyph(1) + space(1) + lead + ' · ' + rest, clipped to width-1 (one row in the
    // live region; harmless if it wraps once committed to <Static>). Error tints the whole line.
    const detailMax = Math.max(0, width - 1 - indent - 2 - displayWidth(lead) - 3);
    const restText = detailMax > 0 ? clipCells(rest, detailMax) : '';
    const lineColor = failed ? glyphColor : dim;
    return (
      <Box marginLeft={indent}>
        <Text color={glyphColor}>{glyph}</Text>
        <Text color={failed ? lineColor : token('text', d)}>{` ${lead}`}</Text>
        {restText.length > 0 ? <Text color={lineColor}>{` · ${restText}`}</Text> : null}
      </Box>
    );
  }

  // LIVE (expanded) → spinner header + one status row per member, windowed to the newest maxRows.
  const maxRows = props.maxRows ?? GROUP_MAX_VISIBLE_ROWS;
  const total = props.entries.length;
  const start = Math.max(0, total - maxRows);
  const shown = props.entries.slice(start);
  const earlier = start;

  const headerColor = summary.failed > 0 ? token('toolError', d) : token('toolRunning', d);
  const summaryText = headerSummary(summary.inFlight, summary.done, summary.failed);
  const headerLead = `${summary.total} tools`;
  const headerClipped = clipCells(
    summaryText.length > 0 ? `${headerLead} · ${summaryText}` : headerLead,
    Math.max(0, width - 1 - indent - 2),
  );

  return (
    <Box flexDirection="column">
      <Box marginLeft={indent}>
        <Text color={headerColor}>
          <Spinner type="dots" />
        </Text>
        <Text color={token('text', d)}>{` ${headerClipped}`}</Text>
      </Box>
      {earlier > 0 ? (
        <Text color={dim}>{`${' '.repeat(indent + 2)}${clipCells(`↑ ${earlier} earlier`, Math.max(0, width - 1 - indent - 2))}`}</Text>
      ) : null}
      {shown.map((entry) => (
        <GroupToolRow key={entry.toolCallId} entry={entry} width={width} depth={d} indent={indent + 2} now={now} />
      ))}
    </Box>
  );
}

/**
 * Memoized like the sibling tool/agent surfaces: the live turn hands a fresh `entries` array on
 * each mutation of the tools it references (a text delta does not), so the group re-renders on
 * exactly its own state changes and bails out otherwise. The running clock re-renders come from
 * `GroupToolRow`'s own interval, not a prop change.
 */
export const GroupedToolRows = memo(GroupedToolRowsView);
