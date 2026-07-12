// src/ui/SubagentTranscriptOverlay.tsx
// LANE B — the full-height overlay opened by Enter on a subagent row. It shows THAT
// subagent's transcript: every recorded child tool call (the same activity the
// per-subagent recorder persists to `<sessionId>.subagents/<id>.jsonl`), one condensed
// line each — glyph + name(args) + result tail — scrollable, live-updating while the
// subagent runs (the rows come from the live `tools` map via `selectSubagentTranscript`,
// so a new child card re-renders here for free). Esc backs out to the panel.
//
// Minimal chrome per the lane mandate: a dim title + a single hairline rule, NO border
// box (unlike McpPanel/ToolDetailOverlay). Pure/presentational; both themes via token().
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import type { SubagentEntry } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { humanizeArgs, resultTail } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

/** One recorded child tool call of the subagent, in creation (chronological) order. */
export interface SubagentActivityRow {
  readonly id: string;
  readonly tool: ToolState;
}

export interface SubagentTranscriptOverlayProps {
  /** The subagent whose transcript this is (drives the header). */
  readonly entry: SubagentEntry;
  /** Its recorded child tool activity, chronological. */
  readonly activity: ReadonlyArray<SubagentActivityRow>;
  /** Scroll offset in rows (one row per tool). Clamped by the app. */
  readonly scroll: number;
  /** Terminal rows — drives how many activity rows the body shows. */
  readonly rows: number;
  /** Terminal columns — clips each row so nothing wraps. */
  readonly width: number;
  readonly depth?: ColorDepth;
}

/**
 * How many activity rows the body shows for a given terminal height. Bounded so a tiny
 * terminal still shows a few and a huge one leaves the transcript visible above. Shared
 * with the app's scroll clamp so the two never disagree about the viewport.
 */
export function subagentTranscriptViewportRows(rows: number): number {
  return Math.max(4, Math.min(rows - 8, 40));
}

function statusGlyph(status: ToolState['status']): string {
  switch (status) {
    case 'error':
      return '✗';
    case 'running':
      return '◐';
    case 'pending':
      return '◌';
    case 'result':
      return '●';
  }
}

function statusToken(status: ToolState['status']): FlatTokenName {
  switch (status) {
    case 'error':
      return 'toolError';
    case 'running':
      return 'toolRunning';
    case 'pending':
      return 'toolPending';
    case 'result':
      return 'toolResult';
  }
}

/** One-line condensed summary of a recorded tool call (matches the transcript card). */
function rowSummary(tool: ToolState): string {
  const head = `${tool.name}(${humanizeArgs(tool.name, tool.args)})`;
  if (tool.status === 'error') {
    const first = (tool.error ?? 'failed').split('\n')[0] ?? '';
    return `${head}  ${first}`;
  }
  const { text } = resultTail(tool.result);
  return text.length > 0 ? `${head}  ${text}` : head;
}

/** Trim + single-space-collapse + clip to `max` with an ellipsis. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export function SubagentTranscriptOverlay(props: SubagentTranscriptOverlayProps): ReactElement {
  const d = props.depth ?? DEPTH;
  const dim = token('textDim', d);
  const border = token('border', d);
  const ruleWidth = Math.max(8, Math.min(props.width, 80));

  const modelBit = props.entry.model !== undefined ? `  ·  ${props.entry.model}` : '';
  const title = `subagent · ${clip(props.entry.description, Math.max(8, props.width - 12))}${modelBit}`;

  const total = props.activity.length;
  const viewport = subagentTranscriptViewportRows(props.rows);
  const maxScroll = Math.max(0, total - viewport);
  const scroll = Math.max(0, Math.min(props.scroll, maxScroll));
  const shown = props.activity.slice(scroll, scroll + viewport);
  const rowMax = Math.max(8, props.width - 4);

  return (
    <Box flexDirection="column">
      <Text color={dim}>{title}</Text>
      <Text color={border}>{'─'.repeat(ruleWidth)}</Text>
      {total === 0 ? (
        <Text color={dim}>No recorded activity yet.</Text>
      ) : (
        <>
          {scroll > 0 ? <Text color={dim}>{`  ↑ ${scroll} more`}</Text> : null}
          {shown.map((row) => (
            <Box key={row.id}>
              <Text color={token(statusToken(row.tool.status), d)}>{statusGlyph(row.tool.status)}</Text>
              <Text color={token('text', d)}>{` ${clip(rowSummary(row.tool), rowMax)}`}</Text>
            </Box>
          ))}
          {scroll < maxScroll ? <Text color={dim}>{`  ↓ ${maxScroll - scroll} more`}</Text> : null}
        </>
      )}
      <Text color={dim}>↑↓ scroll · esc back</Text>
    </Box>
  );
}
