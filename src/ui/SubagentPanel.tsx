// src/ui/SubagentPanel.tsx
// LANE B — the always-available subagent-browser strip, rendered BELOW the composer
// (after the bottom ComposerRule, beside the StatusLine). Two states behind one
// component:
//
//   COLLAPSED (default, not focused): ONE dim line — `▾ agents (2 running, 1 done)` —
//     shown ONLY when the session has subagents; renders nothing otherwise, so a plain
//     session's chrome is unchanged.
//   FOCUSED (overlay 'subagents', list view): the strip expands into one row per
//     subagent — status glyph + description + provider/model + step count / live rollup
//     — with a `▸` highlight the arrow keys move. Enter opens a row's full transcript
//     (a separate overlay); Esc / Up-past-top returns focus to the composer.
//
// Minimal chrome per the lane mandate: dim text + a single ▾ marker, NO border box.
// Pure/presentational — all state (focus, selection) is owned by app.tsx; both themes
// via token(). It is a NEW sibling in the app stack and touches no StatusLine/InputBox
// prop, so their memo bail-outs are unaffected.
import { Box, Text } from 'ink';
import { memo, type ReactElement } from 'react';
import type { SubagentEntry } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

/** How many subagent rows the expanded list shows before it windows (keeps the strip
 *  short — it sits under the composer, not a full-screen overlay). */
const MAX_VISIBLE_ROWS = 8;

export interface SubagentPanelProps {
  /** The session's subagents, creation order (from `selectSubagents`). */
  readonly entries: ReadonlyArray<SubagentEntry>;
  /** True when the panel holds keyboard focus (overlay 'subagents', list view). */
  readonly focused: boolean;
  /** Highlighted row index while focused; ignored when collapsed. */
  readonly selectedIndex: number;
  /** Terminal columns — clips row text so a long description never wraps the strip. */
  readonly width: number;
  readonly depth?: ColorDepth;
}

/** status → list glyph (no spinner — the strip never animates a per-row clock). */
function statusGlyph(status: SubagentEntry['status']): string {
  switch (status) {
    case 'error':
      return '✗';
    case 'running':
      return '◐';
    case 'done':
      return '●';
  }
}

function statusToken(status: SubagentEntry['status']): FlatTokenName {
  switch (status) {
    case 'error':
      return 'toolError';
    case 'running':
      return 'toolRunning';
    case 'done':
      return 'toolResult';
  }
}

/** Trim + single-space-collapse + clip to `max` with an ellipsis. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** The collapsed one-liner's `(2 running, 1 done)` summary. Only non-zero buckets show. */
function collapsedSummary(entries: ReadonlyArray<SubagentEntry>): string {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.status === 'running') running += 1;
    else if (entry.status === 'error') failed += 1;
    else done += 1;
  }
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  // At least one bucket is non-zero (entries is non-empty here).
  return parts.join(', ');
}

/** The trailing dim detail on a focused row: provider/model + step count or live rollup. */
function rowDetail(entry: SubagentEntry): string {
  const bits: string[] = [];
  if (entry.model !== undefined) bits.push(entry.model);
  if (entry.status === 'running') {
    bits.push(entry.runningLabel);
  } else if (entry.childCount > 0) {
    bits.push(entry.childCount === 1 ? '1 step' : `${entry.childCount} steps`);
  }
  return bits.join(' · ');
}

function SubagentPanelView(props: SubagentPanelProps): ReactElement | null {
  const d = props.depth ?? DEPTH;
  const dim = token('textDim', d);
  if (props.entries.length === 0) return null;

  if (!props.focused) {
    // Collapsed: a single dim line the down-arrow hands focus into.
    return (
      <Text color={dim}>{`▾ agents (${collapsedSummary(props.entries)})`}</Text>
    );
  }

  // Focused: expand into rows, windowed around the highlight so a long list stays short.
  const total = props.entries.length;
  const viewport = Math.min(MAX_VISIBLE_ROWS, total);
  const half = Math.floor(viewport / 2);
  const start = Math.max(0, Math.min(props.selectedIndex - half, Math.max(0, total - viewport)));
  const end = Math.min(total, start + viewport);
  const shown = props.entries.slice(start, end);
  const textCol = token('text', d);

  return (
    <Box flexDirection="column">
      <Text color={token('accent', d)}>▾ agents</Text>
      {start > 0 ? <Text color={dim}>{`  ↑ ${start} more`}</Text> : null}
      {shown.map((entry, i) => {
        const index = start + i;
        const selected = index === props.selectedIndex;
        const detail = rowDetail(entry);
        // Budget: marker(2) + glyph(1) + space + description + detail; clip description
        // to leave room for the detail so the row never wraps.
        const detailWidth = detail.length > 0 ? detail.length + 3 : 0;
        const descMax = Math.max(8, props.width - 4 - detailWidth);
        return (
          <Box key={entry.id}>
            <Text color={selected ? textCol : dim}>{selected ? '▸ ' : '  '}</Text>
            <Text color={token(statusToken(entry.status), d)}>{statusGlyph(entry.status)}</Text>
            <Text color={selected ? textCol : dim} bold={selected}>
              {` ${clip(entry.description, descMax)}`}
            </Text>
            {detail.length > 0 ? <Text color={dim}>{`  ${detail}`}</Text> : null}
          </Box>
        );
      })}
      {end < total ? <Text color={dim}>{`  ↓ ${total - end} more`}</Text> : null}
      <Text color={dim}>↑↓ select · enter open · esc back</Text>
    </Box>
  );
}

/**
 * Memoized: app.tsx feeds `entries` from a `useMemo` keyed on `state.tools` (stable
 * across token flushes — a text delta does not change the tools map ref) and the other
 * props are primitives, so a mid-stream re-render bails out exactly like the adjacent
 * StatusLine/InputBox.
 */
export const SubagentPanel = memo(SubagentPanelView);
