// src/ui/workspace/WorkspaceHeader.tsx
// The Observatory's compact brand row + truthful status summary — ONE row, no box:
//
//   ✻ Observatory · wave-9          6 agents · 2 running · 1 waiting · 1 need input
//
// The left side is the only place the surface brands itself (accent is FOCUS/BRAND
// semantics, never model identity); the right side is derived from the agents array
// by summarizeAgents, so the header can only report what the rail actually holds.
// Under width pressure the session label sheds first, then the summary clips —
// the brand never does.
import { Box } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, type ColorDepth } from '../theme';
import { THINKING } from '../glyphs';
import { clipCells, displayWidth } from '../clipText';
import {
  lineWidth,
  summarizeAgents,
  summarySegments,
  type StyledLine,
  type StyledSegment,
} from './layout';
import { StyledLineText } from './StyledLineText';
import type { OrbitAgentVM } from './types';

const DEPTH: ColorDepth = detectColorDepth();

export interface WorkspaceHeaderProps {
  readonly agents: readonly OrbitAgentVM[];
  readonly columns: number;
  readonly sessionLabel?: string;
  readonly depth?: ColorDepth;
}

/** Pure builder for the header's two sides, width-fitted to `columns`. Exported so
 *  the shed order (session label first, summary clip second) is testable directly. */
export function headerSides(
  agents: readonly OrbitAgentVM[],
  columns: number,
  sessionLabel?: string,
): { left: StyledLine; right: StyledLine } {
  const brand: StyledLine = [
    { text: `${THINKING} `, token: 'accent' },
    { text: 'Observatory', token: 'accent', bold: true },
  ];
  const label =
    sessionLabel !== undefined && sessionLabel.length > 0
      ? ([{ text: ` · ${clipCells(sessionLabel, 32)}`, token: 'textDim' }] as StyledLine)
      : ([] as StyledLine);
  let left: StyledLine = [...brand, ...label];
  let right = summarySegments(summarizeAgents(agents));

  const GAP = 2;
  if (lineWidth(left) + GAP + lineWidth(right) > columns && label.length > 0) {
    left = brand; // session label sheds before any truthful count does
  }
  const rightBudget = Math.max(0, columns - lineWidth(left) - GAP);
  if (lineWidth(right) > rightBudget) {
    // Clip the summary from the RIGHT edge inward, keeping the leading chips whole.
    const kept: StyledSegment[] = [];
    let used = 0;
    for (const seg of right) {
      const w = displayWidth(seg.text);
      if (used + w > rightBudget) break;
      kept.push(seg);
      used += w;
    }
    right = kept;
  }
  return { left, right };
}

export function WorkspaceHeader({
  agents,
  columns,
  sessionLabel,
  depth,
}: WorkspaceHeaderProps): ReactElement {
  const d = depth ?? DEPTH;
  const { left, right } = headerSides(agents, columns, sessionLabel);
  return (
    <Box height={1} width={columns} justifyContent="space-between" overflow="hidden">
      <StyledLineText line={left} depth={d} />
      <StyledLineText line={right} depth={d} />
    </Box>
  );
}
