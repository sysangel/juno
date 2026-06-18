import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { EffortBadge } from './EffortBadge';

const DEPTH: ColorDepth = detectColorDepth();
const BAR_WIDTH = 10;

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
}

/** Render a 0..1 fraction as a bracketed bar, e.g. `[####------]`. */
function contextBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

export function StatusLine({ status, depth }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={token('border', d)} paddingLeft={1} paddingRight={1}>
      <Box gap={1}>
        <Text color={token('accent', d)} bold>
          {status.model}
        </Text>
        <Text color={token('textDim', d)}>{status.cwd}</Text>
        <Text color={token('text', d)}>tok:{status.tokens.total}</Text>
        <Text color={token('accent', d)}>{contextBar(status.contextFraction)}</Text>
        <EffortBadge effort={status.effort} depth={d} />
      </Box>
      <Box>
        <Text color={token('textDim', d)}>{status.statusText}</Text>
      </Box>
    </Box>
  );
}
