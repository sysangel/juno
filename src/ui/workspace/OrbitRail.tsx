// src/ui/workspace/OrbitRail.tsx
// The compact one-line-per-agent orbit: every agent that is NOT the selected stream
// keeps exactly one row of presence — status glyph, concise label, textual
// model/provider provenance, elapsed/terminal time, and the warning `!` attention
// mark. No borders, no nesting: a dim/accent caption over flat rows, with honest
// ↑/↓ counts when the fleet outgrows the viewport.
import { Box } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, type ColorDepth } from '../theme';
import {
  orbitOverflowLine,
  orbitRowSegments,
  orbitWindow,
  type StyledLine,
} from './layout';
import { StyledLineText } from './StyledLineText';
import type { OrbitAgentVM } from './types';

const DEPTH: ColorDepth = detectColorDepth();

export interface OrbitRailProps {
  readonly agents: readonly OrbitAgentVM[];
  readonly selectedAgentId?: string;
  /** Cell budget for every row (the rail's pane width). */
  readonly width: number;
  /** Total row budget INCLUDING the caption row. Never exceeded. */
  readonly rowsBudget: number;
  /** Focus is shown restrained: an accent caption, nothing louder. */
  readonly focused: boolean;
  readonly depth?: ColorDepth;
}

/** All rail rows (caption + windowed agent rows + overflow markers) as styled
 *  lines — pure and exported so tests can pin the windowing without rendering. */
export function orbitRailLines(
  agents: readonly OrbitAgentVM[],
  selectedAgentId: string | undefined,
  width: number,
  rowsBudget: number,
  focused: boolean,
): StyledLine[] {
  if (rowsBudget <= 0) return [];
  const caption: StyledLine = [
    { text: 'agents', token: focused ? 'accent' : 'textDim', bold: focused },
    { text: ` · ${agents.length}`, token: 'textDim' },
  ];
  const lines: StyledLine[] = [caption];
  if (agents.length === 0) {
    if (rowsBudget >= 2) lines.push([{ text: '  no agents yet', token: 'textDim' }]);
    if (rowsBudget >= 3) lines.push([{ text: '  delegate in chat to begin', token: 'textDim' }]);
    return lines;
  }
  const window = orbitWindow(agents, selectedAgentId, rowsBudget - 1);
  if (window.above > 0) lines.push(orbitOverflowLine('above', window.above));
  for (const agent of window.visible) {
    lines.push(orbitRowSegments(agent, width, agent.id === selectedAgentId));
  }
  if (window.below > 0) lines.push(orbitOverflowLine('below', window.below));
  return lines.slice(0, rowsBudget);
}

export function OrbitRail({
  agents,
  selectedAgentId,
  width,
  rowsBudget,
  focused,
  depth,
}: OrbitRailProps): ReactElement {
  const d = depth ?? DEPTH;
  const lines = orbitRailLines(agents, selectedAgentId, width, rowsBudget, focused);
  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      {lines.map((line, i) => (
        <StyledLineText key={i} line={line} depth={d} />
      ))}
    </Box>
  );
}
