import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { abbreviateHome } from './paths';

const DEPTH: ColorDepth = detectColorDepth();

export interface BannerProps {
  version: string;
  model: string;
  cwd: string;
  depth?: ColorDepth;
}

/**
 * Welcome banner on a fresh start (status-strip item D): ≤4 dim lines shown only
 * while the transcript is empty, so the screen is never blank-then-box:
 *
 *   juno v0.1.0
 *   <model> · <cwd>
 *   / commands · ? shortcuts
 *
 * All dim (color carries no meaning here); the cwd is home-abbreviated to match
 * the status line.
 */
export function Banner({ version, model, cwd, depth }: BannerProps): ReactElement {
  const d = depth ?? DEPTH;
  const dim = token('textDim', d);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={dim}>juno v{version}</Text>
      <Text color={dim}>
        {model} · {abbreviateHome(cwd)}
      </Text>
      <Text color={dim}>/ commands · ? shortcuts</Text>
    </Box>
  );
}
