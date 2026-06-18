import { Text } from 'ink';
import type { ComponentProps, ReactElement } from 'react';
import type { State } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface EffortBadgeProps {
  effort: State['effort'];
  depth?: ColorDepth;
  /** Text wrap mode; forwarded to the badge so a width-constrained, non-wrapping
   *  status row does not let the badge wrap vertically (resize duplication fix). */
  wrap?: ComponentProps<typeof Text>['wrap'];
}

/** Effort -> badge background token. Exhaustive over State['effort']. */
function effortToken(effort: State['effort']): FlatTokenName {
  switch (effort) {
    case 'medium':
      return 'effortBadge.medium';
    case 'high':
      return 'effortBadge.high';
    case 'xhigh':
      return 'effortBadge.xhigh';
  }
}

function effortLabel(effort: State['effort']): string {
  switch (effort) {
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
    case 'xhigh':
      return 'XHIGH';
  }
}

export function EffortBadge({ effort, depth, wrap }: EffortBadgeProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Text backgroundColor={token(effortToken(effort), d)} color={token('textInverse', d)} wrap={wrap}>
      {' '}
      {effortLabel(effort)}{' '}
    </Text>
  );
}
