import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface StreamingMessageProps {
  live: Msg | null;
  depth?: ColorDepth;
}

export function StreamingMessage({ live, depth }: StreamingMessageProps): ReactElement | null {
  if (live === null) return null;
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Message msg={live} depth={d} />
      {!live.done ? (
        <Box>
          <Text color={token('accent', d)}>
            <Spinner type="dots" />
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
