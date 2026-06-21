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
  separated?: boolean;
}

export function StreamingMessage({ live, depth, separated }: StreamingMessageProps): ReactElement | null {
  if (live === null) return null;
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Message msg={live} depth={d} separated={separated} />
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
