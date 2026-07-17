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
import { memo, type ReactElement } from 'react';
import type { SubagentEntry } from '../core/selectors';
import { SUBAGENT_MAX_VISIBLE_ROWS } from './liveBudget';
import { providerKindOf, viaCliLabel } from './providerKind';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
// The one shared single-line display-cell clip (also used by ToolCallCard.oneLine +
// Message.firstLineClipped), so every line this panel paints — rows AND chrome — is
// measured in terminal cells, not UTF-16 code units.
import { clipCells as clip, displayWidth } from './clipText';

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

/** status → list glyph (no spinner — the strip never animates a per-row clock). Mirrors the
 *  spawn-card sub-line's set (SubagentStatusRow.glyphOf) so a given lifecycle reads with ONE
 *  glyph across both surfaces: ◐ running / ✓ done / ✗ error. (The card animates a spinner for
 *  running where this static strip shows ◐, but the settled states must match — a done agent
 *  that renders ✓ on its card and a bare ● here read as two different outcomes, ambiguous next
 *  to a ✗ row where ● could be misread as neutral/still-running.) */
function statusGlyph(status: SubagentEntry['status']): string {
  switch (status) {
    case 'error':
      return '✗';
    case 'running':
      return '◐';
    case 'done':
      return '✓';
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

/** The live/step status portion of a row's trailing detail (failure reason, running rollup,
 *  or step count), or undefined when there is none. Kept SEPARATE from the model tag so the
 *  model (a constant source tag, e.g. `fake`) can be dropped BEFORE this meaningful status on
 *  a narrow row. For an ERRORED subagent this is the failure reason, NEVER the step count —
 *  a `✗` row that read `fake · 1 step` was formatted identically to a clean finish (finding:
 *  the dropdown must carry the exit reason, like the transcript spawn card). */
function rowStatusDetail(entry: SubagentEntry): string | undefined {
  if (entry.status === 'error') return entry.reason ?? 'failed';
  if (entry.status === 'running') return entry.runningLabel;
  if (entry.childCount > 0) return entry.childCount === 1 ? '1 step' : `${entry.childCount} steps`;
  return undefined;
}

/**
 * Fit a focused row's trailing detail into `budget` cells alongside the FULL description
 * (2-cell gap), dropping the source tag BEFORE the live status so the row's UNIQUE part —
 * the description — always survives at narrow widths. The source tag is the child model plus,
 * for a delegate-CLI subagent, the honest `via <x> cli` marker (decision d) — so a rehydrated
 * cross-provider subagent reads e.g. `fable-mini · via codex cli`; an api or still-running
 * subagent keeps just the model (or nothing). Candidates, richest → poorest: `source · status`,
 * `status` (source dropped), `source` (only when there is no status), ``. Returns the richest
 * one that fits after the description; the caller only clips the description once every
 * droppable detail is gone.
 */
function fitRowDetail(entry: SubagentEntry, descWidth: number, budget: number): string {
  const status = rowStatusDetail(entry);
  const via = viaCliLabel(providerKindOf(entry.provider));
  const model =
    entry.model !== undefined
      ? via !== undefined
        ? `${entry.model} · ${via}`
        : entry.model
      : via;
  const candidates: string[] = [];
  if (model !== undefined && status !== undefined) candidates.push(`${model} · ${status}`);
  if (status !== undefined) candidates.push(status);
  if (model !== undefined && status === undefined) candidates.push(model);
  for (const cand of candidates) {
    if (descWidth + 2 + displayWidth(cand) <= budget) return cand;
  }
  // ERROR rows: the failure reason IS the row's point — never drop it to a bare blank (which
  // would read like a clean finish). When nothing fits whole, clip the reason (model tag
  // already dropped) into the remaining cells so a `✗` row always carries WHY it failed,
  // truncated to fit the one-row budget.
  if (entry.status === 'error' && status !== undefined) {
    const room = budget - descWidth - 2;
    if (room > 0) return clip(status, room);
  }
  return '';
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

  // Chrome lines (header / earlier-head / collapse hint) are clipped to the SAME width-1
  // budget as the agent rows: on an ultra-narrow split pane `▾ agents` / `↑ N earlier` /
  // `↑/esc collapse` would otherwise wrap to 2 terminal rows each, growing the panel past
  // the height subagentPanelRows() reserved and re-opening the \x1b[3J scrollback-erase
  // branch this lane exists to close.
  const chromeWidth = props.width - 1;
  return (
    <Box flexDirection="column">
      <Text color={token('accent', d)}>{clip('▾ agents', chromeWidth)}</Text>
      {earlier > 0 ? <Text color={dim}>{`  ${clip(`↑ ${earlier} earlier`, chromeWidth - 2)}`}</Text> : null}
      {shown.map((entry) => {
        // Each expanded row MUST occupy exactly one terminal row: subagentPanelRows() (the
        // budget's single authority) counts it as 1, and a row that wraps to 2 grows the
        // dynamic region past what liveBudget reserved, re-entering Ink's \x1b[3J erase branch
        // on a narrow/split-pane terminal. The row is `indent(2) + glyph(1) + ' ' + desc + '  ' +
        // detail`, clipped to width-1 cols (1 col slack).
        //
        // PRIORITY (finding 3): the DESCRIPTION is the row's unique identity (task 1 / task 2 /
        // …) — the detail is mostly a constant source tag (`fake ·`) + a live-status word. So we
        // give the description its FULL width first and fit the detail into the remainder,
        // dropping the model source tag before the status (fitRowDetail); only when no detail
        // remains do we clip the description itself. Previously the detail was clipped to a fixed
        // budget while the description was floored at 8 cols, so at ~32 cols every row collapsed
        // to the IDENTICAL `subagent …  fake · working…` — the distinguishing label was cut while
        // the constant tag survived.
        const PREFIX = 4; // indent(2) + glyph(1) + leading space(1)
        const content = Math.max(0, props.width - 1 - PREFIX); // cols for desc + ('  ' + detail)
        const descWidth = displayWidth(entry.description);
        const detail =
          descWidth <= content ? fitRowDetail(entry, descWidth, content) : '';
        const detailBlock = detail.length > 0 ? displayWidth(detail) + 2 : 0;
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
      <Text color={dim}>{clip('↑/esc collapse', chromeWidth)}</Text>
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
