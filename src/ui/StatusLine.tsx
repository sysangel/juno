import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { CONTEXT_DANGER_FRACTION, CONTEXT_WARN_FRACTION } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
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

/** Token count → compact label: 200000 → `200k`, 48500 → `48.5k`, 1047576 → `1M`. */
function humanizeTokens(n: number): string {
  const oneDecimal = (x: number): string => {
    const s = x.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return `${oneDecimal(n / 1_000_000)}M`;
  if (n >= 1_000) return `${oneDecimal(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * Tiered tint for the context-window gauge so thresholds are visible at a glance:
 * green while healthy, amber at/over WARN (consider clearing), red at/over DANGER.
 */
function contextTint(fraction: number): FlatTokenName {
  if (fraction >= CONTEXT_DANGER_FRACTION) return 'error';
  if (fraction >= CONTEXT_WARN_FRACTION) return 'warning';
  return 'success';
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
        {status.cost !== undefined ? (
          <Text color={token('info', d)} wrap={textWrap}>
            cost:${status.cost.usd.toFixed(4)}
          </Text>
        ) : null}
        {/* Context-window monitor: live occupancy of the current window, threshold-tinted
            so the user can watch it and clear/compact at a chosen level. `~` marks an
            estimate (no real measurement yet, e.g. right after clear/compact/resume). */}
        <Text color={token(contextTint(status.contextWindow.fraction), d)} wrap={textWrap}>
          ctx:{status.contextWindow.estimated ? '~' : ''}
          {humanizeTokens(status.contextWindow.used)}/{humanizeTokens(status.contextWindow.max)}{' '}
          {Math.round(status.contextWindow.fraction * 100)}%
        </Text>
        <Text color={token(contextTint(status.contextWindow.fraction), d)} wrap={textWrap}>
          {contextBar(status.contextWindow.fraction)}
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
        {status.toolBudget !== undefined &&
        status.toolBudget.max !== undefined &&
        status.toolBudget.used > 0 ? (
          <Text
            color={
              status.toolBudget.used >= status.toolBudget.max * 0.8
                ? token('warning', d)
                : token('info', d)
            }
            wrap={textWrap}
          >
            tools:{status.toolBudget.used}/{status.toolBudget.max}
          </Text>
        ) : null}
        {status.isCompacting ? (
          <Text color={token('warning', d)} wrap={textWrap}>
            cmp:compacting…
          </Text>
        ) : (status.compactions ?? 0) > 0 ? (
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
