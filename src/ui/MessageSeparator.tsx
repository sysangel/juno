import { Box } from 'ink';
import type { ReactElement } from 'react';
import type { ColorDepth } from './theme';

/**
 * Turn separator: a single blank line (unified-rendering wave 1). Pure
 * presentational; drawn BETWEEN transcript sections (never before the first),
 * on BOTH the live-streaming and committed paths so a turn's spacing does not
 * change when it commits. The old full-width dash rule is gone — turns are
 * separated by one blank line only. `depth` is accepted for call-site
 * compatibility but is unused (a blank line has no colour).
 */
export function MessageSeparator(_props: { depth?: ColorDepth }): ReactElement {
  return <Box height={1} />;
}
