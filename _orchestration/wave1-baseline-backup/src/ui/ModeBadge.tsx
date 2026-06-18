import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface ModeBadgeProps {
  mode: State['mode'];
  depth?: ColorDepth;
}

/** Mode -> badge background token. Exhaustive over State['mode']. */
function modeToken(mode: State['mode']): FlatTokenName {
  switch (mode) {
    case 'normal':
      return 'modeBadge.normal';
    case 'plan':
      return 'modeBadge.plan';
    case 'ultracode':
      return 'modeBadge.ultracode';
  }
}

function modeLabel(mode: State['mode']): string {
  switch (mode) {
    case 'normal':
      return 'NORMAL';
    case 'plan':
      return 'PLAN';
    case 'ultracode':
      return 'ULTRACODE';
  }
}

export function ModeBadge({ mode, depth }: ModeBadgeProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Text backgroundColor={token(modeToken(mode), d)} color={token('textInverse', d)}>
      {' '}
      {modeLabel(mode)}{' '}
    </Text>
  );
}
