// src/ui/workspace/OrchestrationWorkspace.tsx
// The Observatory — juno's full-screen orchestration surface. One selected agent
// stream at full fidelity; every other agent a one-line orbit row. The frame is
// flat on purpose (brand row, hairline rule, panes, command row — no bordered
// boxes, nothing nested inside a box) so it reads as its own product surface
// rather than a grown dropdown.
//
// Geometry contract:
//   - `rows` is the TOTAL budget; the workspace renders EXACTLY `rows - 1` lines
//     (fixed-height column, overflow hidden), never touching the terminal's final
//     row. Every pane receives an explicit row budget derived from that.
//   - `columns >= WIDE_MIN_COLUMNS` → two-pane overview (orbit rail + stream).
//     Below it → ONE pane, chosen by the `narrowPane` prop (the integrator owns
//     navigation); there is no third pane and no tab strip at any width.
//   - The only animation is the stream header's spinner (selected agent, visible
//     pane, running); everything else is static glyphs.
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from '../theme';
import { RULE_CHAR } from '../glyphs';
import { railWidth } from './layout';
import { WorkspaceHeader } from './WorkspaceHeader';
import { OrbitRail } from './OrbitRail';
import { AgentStream } from './AgentStream';
import { WorkspaceFooter } from './WorkspaceFooter';
import { WIDE_MIN_COLUMNS, type OrchestrationWorkspaceProps } from './types';

const DEPTH: ColorDepth = detectColorDepth();

/** Gutter cells between the orbit rail and the stream in the wide layout. */
const PANE_GAP = 2;

/** Chrome rows around the panes: header, rule, footer. */
const CHROME_ROWS = 3;

/**
 * Rendered-line count for a given `rows` budget: one less than granted (final-row
 * safety), floored so the chrome always fits. Exported so tests and the integrator
 * share the exact arithmetic.
 */
export function workspaceRenderedRows(rows: number): number {
  return Math.max(1, rows - 1);
}

/** Exact selected-stream width used by both rendering and scroll clamping. */
export function workspaceStreamWidth(columns: number): number {
  return columns >= WIDE_MIN_COLUMNS
    ? Math.max(1, columns - railWidth(columns) - PANE_GAP)
    : Math.max(1, columns);
}

export function OrchestrationWorkspace(props: OrchestrationWorkspaceProps): ReactElement {
  const d = props.depth ?? DEPTH;
  const totalRows = workspaceRenderedRows(props.rows);
  const bodyRows = Math.max(0, totalRows - CHROME_ROWS);
  const wide = props.columns >= WIDE_MIN_COLUMNS;

  const rail = wide ? railWidth(props.columns) : props.columns;
  const streamWidth = workspaceStreamWidth(props.columns);
  const streamVisible = wide || props.narrowPane === 'stream';

  return (
    <Box
      flexDirection="column"
      height={totalRows}
      width={props.columns}
      overflow="hidden"
    >
      <WorkspaceHeader
        agents={props.agents}
        columns={props.columns}
        sessionLabel={props.sessionLabel}
        depth={d}
      />
      <Text color={token('border', d)}>{RULE_CHAR.repeat(Math.max(1, props.columns))}</Text>
      <Box height={bodyRows} overflow="hidden">
        {wide ? (
          <>
            <OrbitRail
              agents={props.agents}
              selectedAgentId={props.selectedAgentId}
              width={rail}
              rowsBudget={bodyRows}
              focused={props.focus === 'orbit'}
              depth={d}
            />
            <Box width={PANE_GAP} />
            <AgentStream
              selected={props.selected}
              width={streamWidth}
              rowsBudget={bodyRows}
              focused={props.focus === 'stream'}
              showSpinner
              scrollOffsetRows={props.streamScrollRows}
              depth={d}
            />
          </>
        ) : streamVisible ? (
          <AgentStream
            selected={props.selected}
            width={streamWidth}
            rowsBudget={bodyRows}
            focused={props.focus === 'stream'}
            showSpinner
            scrollOffsetRows={props.streamScrollRows}
            depth={d}
          />
        ) : (
          <OrbitRail
            agents={props.agents}
            selectedAgentId={props.selectedAgentId}
            width={rail}
            rowsBudget={bodyRows}
            focused={props.focus === 'orbit'}
            depth={d}
          />
        )}
      </Box>
      <WorkspaceFooter
        keys={props.keys}
        width={props.columns}
        {...(props.notice !== undefined ? { notice: props.notice } : {})}
        depth={d}
      />
    </Box>
  );
}
