// src/ui/GroupedToolRows.tsx
// Grouped-tool-rows — the live/condensed presentation of a CONCURRENT tool batch (>= 2 tool
// calls the model issued together; see src/ui/toolGroups.ts + docs/UX-SPEC.md R5). It replaces
// the old "N independent cards in stream order" with ONE unit that speaks the same visual
// language as the agents panel (spinner / ✓ / ✗ glyphs, dim status rows, newest-row windowing,
// cell-accurate width clipping):
//
//   LIVE (>= 1 member still non-terminal) — an expanded group:
//     ⠋ 4 tools · 1 running, 1 queued, 2 done   header (spinner while in flight; TRUTHFUL buckets
//       ⠋ grep(juno) · 1s                        — `queued` = issued together but not yet
//       ● glob(src)                              executing; the raw-API executor runs a batch
//       ✓ read_file(app.tsx)                     sequentially, so the header must never claim
//       ✗ mcp__brain__recall(state) · down       "N running" over rows showing one spinner), one
//                                                status row per member (windowed to the newest
//                                                maxRows, `↑ K earlier` head), each clipped to one
//                                                terminal row; a failed row carries WHY; and a
//     ◌ write_file(x.txt) · waiting on permission  gated member presents as WAITING (amber, the
//                                                solo card's honest state mapping), never running
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
import {
  OK,
  FAIL,
  TOOL_PENDING,
  TOOL_WAITING,
  RUNNING_HALF,
  ABORTED,
  ARROW_UP,
  presentedStateGlyph,
  presentedStatusToken,
  isWholeLinePresented,
} from './glyphs';
import { viaCliLabel, type ProviderKind } from './providerKind';
import { clipCells, displayWidth } from './clipText';
import {
  humanizeArgs,
  humanizeResult,
  MAX_NEST_DEPTH,
  useRunningElapsedSeconds,
} from './ToolCallCard';
import { summarizeToolGroup, type ToolGroupSummary } from './toolGroups';
import { presentedStatus, type PresentedStatus } from '../core/selectors';

const DEPTH: ColorDepth = detectColorDepth();

/** Default cap on expanded member rows before the group windows to its newest rows (mirrors the
 *  agents panel's SUBAGENT_MAX_VISIBLE_ROWS). The group lives inside the live turn, which
 *  liveWindow.ts already height-bounds, so this only guards a pathologically large single batch. */
export const GROUP_MAX_VISIBLE_ROWS = 8;

/**
 * Rendered terminal-row count of a live grouped unit's HEADER: the `⠋ N tools · …`
 * summary is one `<Box>` row. The full expanded unit is GROUP_HEADER_ROWS + an optional
 * `↑ K earlier` head + up to GROUP_MAX_VISIBLE_ROWS member rows. Exported so the live-
 * window height estimator (src/ui/liveWindow.ts) reserves the group's REAL height from
 * the renderer, drift-free.
 */
export const GROUP_HEADER_ROWS = 1;

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
  /**
   * The tool call whose permission prompt is open (`state.pendingPermissionToolCallId`). A gated
   * MEMBER renders `◌ name(args) · waiting on permission` (amber) and is counted in the header's
   * `waiting on permission` bucket — never as running or queued (the honest state mapping the
   * solo ToolCallCard already applies). Only meaningful for the LIVE turn; committed groups carry
   * resolved tools, so this never matches there.
   */
  readonly pendingPermissionToolCallId?: string;
  /** Injectable clock for the running rows' elapsed timer (tests pin it). Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * The rendering CLASS of the backend that ran this batch (mirrors the solo ToolCallCard's
   * `providerKind`): a delegate CLI (`claude-cli` / `codex-cli`) tags the condensed committed
   * line ` · via <x> cli`; `api` (or undefined) leaves it unmarked (juno-executor tools are
   * unmarked). Only the condensed line carries the tag — the live per-member rows do not,
   * parity with the solo card which tags exactly one line (ToolCallCard.tsx:429-433).
   */
  readonly providerKind?: ProviderKind;
}

/**
 * The static glyph for a member's presented status (running renders an animated spinner
 * instead — see the row). `done`→✓ (OK), `queued`→● (TOOL_PENDING) — the unified defaults.
 * Only waiting/error/aborted/declined delegate to the shared {@link presentedStateGlyph}.
 */
function groupRowGlyph(p: PresentedStatus): string {
  switch (p) {
    case 'running':
      return RUNNING_HALF; // unused (spinner rendered); kept for exhaustiveness
    case 'queued':
      return TOOL_PENDING; // ●
    case 'done':
      return OK; // ✓
    case 'waiting':
    case 'error':
    case 'aborted':
    case 'declined':
      return presentedStateGlyph(p);
  }
}

/** The trailing status detail for a member row (RAW, unclipped): elapsed while running, the
 *  humanized result tail when done, the first error/abort/deny line for a settled-not-clean
 *  member, the wait notice while gated, nothing while queued. */
function rowDetail(p: PresentedStatus, tool: ToolState, seconds: number | null): string {
  switch (p) {
    case 'running':
      return seconds !== null ? `${Math.floor(seconds)}s` : '';
    case 'done':
      return humanizeResult(tool.name, tool.result).text;
    case 'error':
    case 'aborted':
    case 'declined':
      return (tool.error ?? 'failed').split('\n').find((l) => l.trim().length > 0) ?? 'failed';
    case 'waiting':
      return 'waiting on permission';
    case 'queued':
      return '';
  }
}

/** The live header's bucket summary — `1 running, 2 queued, 1 done`, non-zero buckets only (the
 *  agents strip's summary idiom) and each counted TRUTHFULLY: `running` is only members actually
 *  executing; a not-yet-started member is `queued` (the raw-API executor runs a batch
 *  sequentially, so mid-execution the batch is 1 running + N queued — a folded "N running" would
 *  contradict the member rows directly below, which show one spinner + N pending glyphs); and a
 *  permission-gated member is `waiting on permission`, never running or queued (the solo card's
 *  honest state mapping, ToolCallCard.presentationOf). */
function headerSummary(s: ToolGroupSummary): string {
  const parts: string[] = [];
  if (s.running > 0) parts.push(`${s.running} running`);
  if (s.pending > 0) parts.push(`${s.pending} queued`);
  if (s.waiting > 0) parts.push(`${s.waiting} waiting on permission`);
  if (s.done > 0) parts.push(`${s.done} done`);
  // A cancel/decline that lands mid-batch (e.g. a policy-deny on one member while siblings run)
  // gets its own honest bucket — never folded into `failed`.
  if (s.cancelled > 0) parts.push(`${s.cancelled} cancelled`);
  if (s.declined > 0) parts.push(`${s.declined} declined`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  return parts.join(', ');
}

/** One expanded member row. A child component so its running clock's hook count is stable as the
 *  window slides (rows mount/unmount as whole instances). Clipped to one terminal row. */
function GroupToolRow(props: {
  readonly entry: GroupedToolEntry;
  readonly width: number;
  readonly depth: ColorDepth;
  readonly indent: number;
  /** True when a permission prompt is open for THIS member — presents as waiting (amber ◌ +
   *  `waiting on permission`), never running/queued; a settled status wins over a stale flag. */
  readonly waitingOnPermission: boolean;
  readonly now: () => number;
}): ReactElement {
  const { entry, width, depth: d, indent } = props;
  // The ONE shared classifier (mirrors the solo ToolCallCard): a gated member is WAITING — no
  // spinner, no elapsed clock — a settled result/error wins over a stale flag, and a mid-batch
  // policy-deny lands `declined` while siblings still run.
  const p = presentedStatus(entry.tool, { waitingOnPermission: props.waitingOnPermission });
  const running = p === 'running';
  const seconds = useRunningElapsedSeconds(running, props.now);

  const dim = token('textDim', d);
  const glyphColor = token(presentedStatusToken(p), d);
  // error (red) / waiting + declined (amber) carry their meaning across the WHOLE row; every
  // other state — including an `aborted` cancel, whose glyphColor is already dim — keeps the
  // label dim, glyph carries the color.
  const labelColor = isWholeLinePresented(p) ? glyphColor : dim;
  // Which states carry a reason/notice the clipper must never DROP (distinct from the whole-line
  // COLOR question above): a settled-not-clean member (error/aborted/declined) always shows WHY it
  // exited, and a gated member shows the wait notice — never blanked to read like a clean state.
  const reasonBearing = p === 'error' || p === 'waiting' || p === 'aborted' || p === 'declined';

  const head = `${entry.tool.name}(${humanizeArgs(entry.tool.name, entry.tool.args)})`;
  const detail = rowDetail(p, entry.tool, seconds);
  const detailRender = detail.length > 0 ? ` · ${detail}` : '';

  // PREFIX = indent + glyph(1) + leading space(1); clip to width-1 (1 col slack) so the row
  // occupies exactly one terminal row. Give the head (the row's identity) priority and fit the
  // detail into the remainder; an ERROR/ABORT/DENY reason or the WAITING notice is never dropped
  // — it is clipped in (like the agents panel), never blanked to read like a clean/queued state.
  const prefix = indent + 2;
  const content = Math.max(0, width - 1 - prefix);
  const detailW = displayWidth(detailRender);
  const showDetailWhole = detailRender.length > 0 && displayWidth(head) + detailW <= content;
  let detailText = showDetailWhole ? detailRender : '';
  let headMax = showDetailWhole ? content - detailW : content;
  if (!showDetailWhole && reasonBearing && detail.length > 0) {
    // Reserve room for a clipped reason/notice rather than dropping it.
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
        <Text color={glyphColor}>{groupRowGlyph(p)}</Text>
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

  const summary = summarizeToolGroup(
    props.entries.map((e) => ({
      tool: e.tool,
      waitingOnPermission: props.pendingPermissionToolCallId === e.toolCallId,
    })),
  );

  // SETTLED → one condensed committed line. Full per-tool detail stays in the Ctrl+O overlay.
  if (summary.allSettled) {
    // Priority: (a) any GENUINE failure → red ✗ + reason; (b) else any CANCEL/DECLINE → neutral
    // ⊘ + dim (a cancelled batch is not a crash — never a ✗ or a "failed" count); (c) else
    // all-ok → green ✓ + names. Item 1's core: cancelled/declined members never redden the group.
    const failed = summary.failed > 0;
    const neutral = summary.cancelled + summary.declined;
    const cancelledOnly = !failed && neutral > 0;
    let glyph: string;
    let glyphTokenName: FlatTokenName;
    let rest: string;
    if (failed) {
      const failure = summary.firstFailure;
      glyph = FAIL;
      glyphTokenName = 'toolError';
      rest =
        failure !== undefined
          ? `${summary.failed} failed · ${failure.name}: ${failure.reason}`
          : `${summary.failed} failed`;
    } else if (cancelledOnly) {
      glyph = ABORTED; // ⊘
      glyphTokenName = 'textDim';
      // "declined" only when every neutral member is a decline (no cancels); a mix (or any
      // cancel) reads "cancelled". `word` alone when the WHOLE batch is neutral, else `${n} word`.
      const word = summary.declined > 0 && summary.cancelled === 0 ? 'declined' : 'cancelled';
      rest = neutral === summary.total ? word : `${neutral} ${word}`;
    } else {
      glyph = OK; // ✓
      glyphTokenName = 'toolResult';
      rest = summary.names.join(', ');
    }
    const glyphColor = token(glyphTokenName, d);
    const lead = `${summary.total} tools`;
    // A delegate-CLI backend tags the condensed line ` · via <x> cli` (parity with the solo
    // ToolCallCard, honesty item C); `api`/undefined leaves it unmarked. The tag is ALWAYS dim
    // — even on a failure-tinted line — mirroring ToolCallCard.tsx:429-433.
    const via = viaCliLabel(props.providerKind);
    const viaSuffix = via !== undefined ? ` · ${via}` : '';
    // indent + glyph(1) + space(1) + lead + ' · ' + rest + viaSuffix, clipped to width-1 (one
    // row in the live region; harmless if it wraps once committed to <Static>). Reserve the
    // suffix's cells so the tagged line still fits one row. Error tints the whole line.
    const detailMax = Math.max(
      0,
      width - 1 - indent - 2 - displayWidth(lead) - 3 - displayWidth(viaSuffix),
    );
    const restText = detailMax > 0 ? clipCells(rest, detailMax) : '';
    const lineColor = failed ? glyphColor : dim;
    return (
      <Box marginLeft={indent}>
        <Text color={glyphColor}>{glyph}</Text>
        <Text color={failed ? lineColor : token('text', d)}>{` ${lead}`}</Text>
        {restText.length > 0 ? <Text color={lineColor}>{` · ${restText}`}</Text> : null}
        {via !== undefined ? (
          <Text color={dim}>
            {viaSuffix}
          </Text>
        ) : null}
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
  const summaryText = headerSummary(summary);
  const headerLead = `${summary.total} tools`;
  const headerClipped = clipCells(
    summaryText.length > 0 ? `${headerLead} · ${summaryText}` : headerLead,
    Math.max(0, width - 1 - indent - 2),
  );
  // Honest header glyph (parity with the solo card / LiveTurn.tsx:105-107, ToolCallCard.tsx:203):
  // when NOTHING is executing and the batch is blocked on the user's permission decision
  // (running 0 + queued 0 + waiting > 0), the header carries the STATIC amber ◌ — a spinner
  // would falsely imply work in flight. A concurrent failure alongside the wait keeps the ◌
  // (still blocked on the user). Any running or queued member restores the spinner.
  const blockedOnUser = summary.running === 0 && summary.pending === 0 && summary.waiting > 0;

  return (
    <Box flexDirection="column">
      <Box marginLeft={indent}>
        {blockedOnUser ? (
          <Text color={token('warning', d)}>{TOOL_WAITING}</Text>
        ) : (
          <Text color={headerColor}>
            <Spinner type="dots" />
          </Text>
        )}
        <Text color={token('text', d)}>{` ${headerClipped}`}</Text>
      </Box>
      {earlier > 0 ? (
        <Text color={dim}>{`${' '.repeat(indent + 2)}${clipCells(`${ARROW_UP} ${earlier} earlier`, Math.max(0, width - 1 - indent - 2))}`}</Text>
      ) : null}
      {shown.map((entry) => (
        <GroupToolRow
          key={entry.toolCallId}
          entry={entry}
          width={width}
          depth={d}
          indent={indent + 2}
          waitingOnPermission={props.pendingPermissionToolCallId === entry.toolCallId}
          now={now}
        />
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
