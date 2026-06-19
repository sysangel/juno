import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { DEFAULT_COMPACTION_THRESHOLD } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { EffortBadge } from './EffortBadge';

const DEPTH: ColorDepth = detectColorDepth();
const BAR_WIDTH = 10;

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
  width?: number;
}

/** Render a 0..1 fraction as a bracketed bar, e.g. `[####------]`. */
function contextBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

export function StatusLine({ status, depth, width }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  // When a fixed width is supplied (live terminal width threaded from the root),
  // pin the layout so the rendered line count is fully determined by structure,
  // never by wrap-driven drift: rows do not wrap and long chips truncate. This
  // is what stops the footer from accumulating extra lines (and visually
  // duplicating) when the terminal width shrinks on resize.
  const rowWrap = width === undefined ? undefined : 'nowrap';
  const rowOverflow = width === undefined ? undefined : 'hidden';
  const textWrap = width === undefined ? undefined : 'truncate-end';
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={token('border', d)}
      paddingLeft={1}
      paddingRight={1}
      width={width}
      overflow={rowOverflow}
    >
      <Box gap={1} flexWrap={rowWrap} overflow={rowOverflow}>
        <Text color={token('accent', d)} bold wrap={textWrap}>
          {status.model}
        </Text>
        <Text color={token('textDim', d)} wrap={textWrap}>
          {status.cwd}
        </Text>
        <Text color={token('text', d)} wrap={textWrap}>
          tok:{status.tokens.total}
        </Text>
        <Text
          color={
            (status.contextPressure ?? status.contextFraction) >= DEFAULT_COMPACTION_THRESHOLD
              ? token('warning', d)
              : token('accent', d)
          }
          wrap={textWrap}
        >
          {contextBar(status.contextPressure ?? status.contextFraction)}
        </Text>
        <EffortBadge effort={status.effort} depth={d} wrap={textWrap} />
        {status.skills !== undefined && status.skills.length > 0 ? (
          <Text color={token('info', d)} wrap={textWrap}>
            skills:{status.skills.length}
          </Text>
        ) : null}
        {status.permissionMode !== undefined && status.permissionMode !== 'default' ? (
          <Text color={token('warning', d)} wrap={textWrap}>
            mode:{status.permissionMode}
          </Text>
        ) : null}
        {(status.compactions ?? 0) > 0 ? (
          <Text color={token('info', d)} wrap={textWrap}>
            cmp:{status.compactions}
          </Text>
        ) : null}
      </Box>
      <Box flexWrap={rowWrap} overflow={rowOverflow}>
        <Text color={token('textDim', d)} wrap={textWrap}>
          {status.statusText}
        </Text>
      </Box>
    </Box>
  );
}
