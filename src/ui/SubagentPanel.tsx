// src/ui/SubagentPanel.tsx
// LANE B — the always-available subagent-browser strip, rendered BELOW the composer
// (after the bottom ComposerRule, beside the StatusLine). Two states behind one
// component:
//
//   COLLAPSED (default, not focused): ONE dim line — `▾ agents (2 running, 1 done)` —
//     shown ONLY when the session has subagents; renders nothing otherwise, so a plain
//     session's chrome is unchanged.
//   FOCUSED (overlay 'subagents'): the strip expands into one row per subagent — status
//     glyph + description + provider/model + step count / live rollup. EXPAND/COLLAPSE
//     ONLY: there is no row highlight and no transcript browsing (the per-subagent record
//     is still written to disk, the UI just no longer opens it). Esc / Up returns focus
//     to the composer, collapsing the strip.
//
// Minimal chrome per the lane mandate: dim text + a single ▾ marker, NO border box.
// Pure/presentational — focus is owned by app.tsx; both themes via token(). It is a NEW
// sibling in the app stack and touches no StatusLine/InputBox prop, so their memo
// bail-outs are unaffected.
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { memo, type ReactElement } from 'react';
import type { SubagentEntry } from '../core/selectors';
import { SUBAGENT_MAX_VISIBLE_ROWS } from './liveBudget';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface SubagentPanelProps {
  /** The session's subagents, creation order (from `selectSubagents`). */
  readonly entries: ReadonlyArray<SubagentEntry>;
  /** True when the panel is expanded (overlay 'subagents'). */
  readonly focused: boolean;
  /** Terminal columns — clips row text so a long description never wraps the strip. */
  readonly width: number;
  /**
   * Max agent rows the EXPANDED list may show before it windows to the newest rows.
   * app.tsx derives this from the live-turn budget (src/ui/liveBudget.ts) so the expanded
   * panel can never grow the dynamic region past the viewport (scrollback-erasing repaint).
   * `< 1` ⇒ the viewport is too short to expand, so the panel degrades to its collapsed
   * one-liner. Defaults to SUBAGENT_MAX_VISIBLE_ROWS for isolated (non-app) callers.
   */
  readonly maxRows?: number;
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

/**
 * Trim + single-space-collapse + clip to `max` DISPLAY CELLS with an ellipsis. Measures with
 * string-width (like liveBudget.ts/liveWindow.ts), NOT UTF-16 code units — a CJK/emoji char is
 * 2 cells, so a length-based clip lets those overflow the one-terminal-row-per-row budget. When
 * clipping we reserve 1 cell for the trailing ellipsis and accumulate whole code points until
 * the next one would exceed the budget (a 2-cell char stops a cell early rather than splitting),
 * so the result's display width is always <= `max`.
 */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (stringWidth(flat) <= max) return flat;
  let out = '';
  let used = 0;
  for (const ch of flat) {
    const w = stringWidth(ch);
    if (used + w > max - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
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

  const maxRows = props.maxRows ?? SUBAGENT_MAX_VISIBLE_ROWS;
  // Collapsed when unfocused, OR when the viewport is too short to host even one expanded
  // agent row (maxRows < 1) — a single dim line the down-arrow hands focus into. The
  // < 1 fallback MUST match src/ui/liveBudget.ts:subagentPanelRows so the height app.tsx
  // reserved equals the height rendered here.
  if (!props.focused || maxRows < 1) {
    return (
      <Text color={dim}>{clip(`▾ agents (${collapsedSummary(props.entries)})`, props.width - 1)}</Text>
    );
  }

  // Focused: expand into rows (expand/collapse only — no highlight, no browsing). Window to
  // the NEWEST `maxRows` in creation order so the still-running agents (always the newest,
  // and the ones a multi-agent loop actually cares about) stay visible; a longer list keeps
  // an `↑ N earlier` head, never hiding the tail behind a `↓ more`. The full per-subagent
  // record still lives on disk; the UI just no longer opens it.
  const total = props.entries.length;
  const start = Math.max(0, total - maxRows);
  const shown = props.entries.slice(start);
  const earlier = start;

  return (
    <Box flexDirection="column">
      <Text color={token('accent', d)}>▾ agents</Text>
      {earlier > 0 ? <Text color={dim}>{`  ↑ ${earlier} earlier`}</Text> : null}
      {shown.map((entry) => {
        // Each expanded row MUST occupy exactly one terminal row: subagentPanelRows() (the
        // budget's single authority) counts it as 1, and a row that wraps to 2 grows the
        // dynamic region past what liveBudget reserved, re-entering Ink's \x1b[3J erase branch
        // on a narrow/split-pane terminal. The row is `indent(2) + glyph(1) + ' ' + desc + '  ' +
        // detail`; the detail (model + runningLabel, e.g. 'claude-sonnet-4-5 · running mcp__…')
        // was never clipped, so once the description hit its floor the row overflowed. Clip BOTH
        // parts so the whole row fits in width-1 cols (1 col slack, matching the prior unfloored
        // budget), keeping the colored status glyph as its own Text.
        const PREFIX = 4; // indent(2) + glyph(1) + leading space(1)
        const content = Math.max(0, props.width - 1 - PREFIX); // cols for desc + ('  ' + detail)
        // Reserve >= 8 cols for the description; the detail takes what's left after its 2 leading
        // spaces, and is dropped entirely when nothing remains for it.
        const detailMax = content - 8 - 2;
        const detail = detailMax > 0 ? clip(rowDetail(entry), detailMax) : '';
        const detailBlock = detail.length > 0 ? stringWidth(detail) + 2 : 0;
        const descMax = Math.max(0, content - detailBlock);
        return (
          <Box key={entry.id}>
            <Text color={dim}>{'  '}</Text>
            <Text color={token(statusToken(entry.status), d)}>{statusGlyph(entry.status)}</Text>
            <Text color={dim}>{` ${clip(entry.description, descMax)}`}</Text>
            {detail.length > 0 ? <Text color={dim}>{`  ${detail}`}</Text> : null}
          </Box>
        );
      })}
      <Text color={dim}>↑/esc collapse</Text>
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
