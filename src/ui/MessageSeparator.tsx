import { Box } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

/** A dim, full-width horizontal rule + one blank line above it. Pure presentational;
 *  drawn BETWEEN transcript sections (never before the first). Spans parent width via
 *  Ink selective borders — no width prop needed. */
export function MessageSeparator({ depth }: { depth?: ColorDepth }): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor={token('border', d)}
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    />
  );
}
