// src/ui/workspace/AgentStream.tsx
// The FULL-fidelity surface for the one selected agent: a three-row identity/task
// header (title + status word, task, textual provenance) over the ordered event
// stream — assistant prose, restrained reasoning, tool cards, steering messages,
// permission checkpoints, and lifecycle notices, tail-windowed to the row budget
// with an honest `↑ N earlier` cut marker.
//
// This component may render the WHOLE workspace's only spinner: the status slot on
// the identity row animates only while `showSpinner` is true and the agent runs;
// every other running mark in the surface is the static ◐.
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from '../theme';
import { presentedStatusToken } from '../glyphs';
import {
  streamHeaderLines,
  streamViewport,
  workspaceStatusGlyph,
  type StyledLine,
} from './layout';
import { StyledLineText } from './StyledLineText';
import type { SelectedAgentVM } from './types';

const DEPTH: ColorDepth = detectColorDepth();

/** Identity rows (3) + the blank breath row between header and stream. */
export const STREAM_HEADER_ROWS = 4;

export interface AgentStreamProps {
  /** Undefined when nothing is selected — renders the no-selection placeholder. */
  readonly selected?: SelectedAgentVM;
  /** Cell budget for every row (the stream's pane width). */
  readonly width: number;
  /** Total row budget INCLUDING the identity header. Never exceeded. */
  readonly rowsBudget: number;
  /** Focus is shown restrained: the title tints accent, nothing louder. */
  readonly focused: boolean;
  /** True only when this pane is visible AND may animate the sole spinner. */
  readonly showSpinner: boolean;
  /** Rows back from the live tail. Zero follows new events. */
  readonly scrollOffsetRows?: number;
  readonly depth?: ColorDepth;
}

/** The stream's empty-state rows (agent selected, nothing recorded yet). */
export function emptyStreamLines(): StyledLine[] {
  return [
    [{ text: 'no activity yet', token: 'textDim' }],
    [{ text: 'events stream here as the agent works', token: 'textDim' }],
  ];
}

export function AgentStream({
  selected,
  width,
  rowsBudget,
  focused,
  showSpinner,
  scrollOffsetRows = 0,
  depth,
}: AgentStreamProps): ReactElement {
  const d = depth ?? DEPTH;
  const dim = token('textDim', d);
  if (rowsBudget <= 0) return <Box width={width} />;

  if (selected === undefined) {
    return (
      <Box flexDirection="column" width={width} overflow="hidden">
        <Text color={focused ? token('accent', d) : dim} bold={focused}>
          stream
        </Text>
        {rowsBudget >= 2 ? <Text color={dim}>no agent selected</Text> : null}
      </Box>
    );
  }

  const header = streamHeaderLines(selected, width, focused);
  const statusColor = token(presentedStatusToken(selected.status), d);
  const spinning = showSpinner && selected.status === 'running';
  const eventCapacity = Math.max(0, rowsBudget - STREAM_HEADER_ROWS);
  const tail =
    selected.events.length === 0
      ? { hiddenEvents: 0, lines: emptyStreamLines().slice(0, eventCapacity) }
      : streamViewport(selected.events, width, eventCapacity, scrollOffsetRows);

  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      <Box height={1} overflow="hidden">
        <Text color={statusColor}>
          {spinning ? <Spinner type="dots" /> : workspaceStatusGlyph(selected.status)}{' '}
        </Text>
        <StyledLineText line={header.title} depth={d} />
      </Box>
      {rowsBudget >= 2 ? <StyledLineText line={header.task} depth={d} /> : null}
      {rowsBudget >= 3 ? <StyledLineText line={header.provenance} depth={d} /> : null}
      {rowsBudget >= STREAM_HEADER_ROWS ? <Text> </Text> : null}
      {tail.lines.map((line, i) => (
        <StyledLineText key={i} line={line} depth={d} />
      ))}
    </Box>
  );
}
