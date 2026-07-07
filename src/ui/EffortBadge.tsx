import { Text } from 'ink';
import type { ComponentProps, ReactElement } from 'react';
import type { State } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface EffortBadgeProps {
  effort: State['effort'];
  depth?: ColorDepth;
  /** Text wrap mode; forwarded so a width-constrained, non-wrapping status row
   *  does not let the badge wrap vertically (resize duplication fix). */
  wrap?: ComponentProps<typeof Text>['wrap'];
}

/**
 * Effort → plain lowercase label + a semantic color token. Claude-Code-minimal:
 * effort is plain colored text (no inverse-background chip), color-carrying-meaning
 * only — medium=default, high=amber(attention), xhigh=hot(red). Exhaustive over
 * State['effort']. Exported so the StatusLine renders the SAME text/color inline
 * (and can measure its width for responsive chip-dropping) without a second source.
 */
export function effortDisplay(effort: State['effort']): { text: string; color: FlatTokenName } {
  switch (effort) {
    case 'medium':
      return { text: 'medium', color: 'text' };
    case 'high':
      return { text: 'high', color: 'warning' };
    case 'xhigh':
      return { text: 'xhigh', color: 'error' };
  }
}

export function EffortBadge({ effort, depth, wrap }: EffortBadgeProps): ReactElement {
  const d = depth ?? DEPTH;
  const { text, color } = effortDisplay(effort);
  return (
    <Text color={token(color, d)} wrap={wrap}>
      {text}
    </Text>
  );
}
