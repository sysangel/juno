// src/ui/workspace/WorkspaceFooter.tsx
// One dim command row advertising EXACTLY the keys the integrator supplies —
// the workspace invents no bindings of its own. Keys read `key action`, joined by
// the house ` · ` separator and clipped whole-line to the width.
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from '../theme';
import { clipCells, displayWidth } from '../clipText';
import type { WorkspaceKeyHint } from './types';

const DEPTH: ColorDepth = detectColorDepth();

export interface WorkspaceFooterProps {
  readonly keys: readonly WorkspaceKeyHint[];
  readonly width: number;
  readonly notice?: string;
  readonly depth?: ColorDepth;
}

/**
 * Pure footer text. Hints are fitted as whole action groups so a narrow terminal
 * never ends on a misleading half-binding such as `g/d allow/…`.
 */
export function footerText(keys: readonly WorkspaceKeyHint[], width: number): string {
  const budget = Math.max(1, width);
  const labels = keys.map((k) => `${k.key} ${k.action}`);
  let text = '';
  let consumed = 0;
  for (const label of labels) {
    const candidate = text.length === 0 ? label : `${text} · ${label}`;
    if (displayWidth(candidate) > budget) break;
    text = candidate;
    consumed += 1;
  }
  if (consumed === 0 && labels.length > 0) return clipCells(labels[0]!, budget);
  if (consumed < labels.length && displayWidth(`${text} …`) <= budget) text += ' …';
  return text;
}

export function WorkspaceFooter({ keys, width, notice, depth }: WorkspaceFooterProps): ReactElement {
  const d = depth ?? DEPTH;
  const text = notice !== undefined && notice.length > 0
    ? clipCells(notice, Math.max(1, width))
    : footerText(keys, width);
  return (
    <Box height={1} width={width} overflow="hidden">
      <Text color={token(notice !== undefined ? 'warning' : 'textDim', d)}>
        {text.length > 0 ? text : ' '}
      </Text>
    </Box>
  );
}
