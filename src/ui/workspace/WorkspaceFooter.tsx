// src/ui/workspace/WorkspaceFooter.tsx
// One dim command row advertising EXACTLY the keys the integrator supplies —
// the workspace invents no bindings of its own. Keys read `key action`, joined by
// the house ` · ` separator and clipped whole-line to the width.
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from '../theme';
import { clipCells } from '../clipText';
import type { WorkspaceKeyHint } from './types';

const DEPTH: ColorDepth = detectColorDepth();

export interface WorkspaceFooterProps {
  readonly keys: readonly WorkspaceKeyHint[];
  readonly width: number;
  readonly depth?: ColorDepth;
}

/** Pure footer text: `tab focus · ↑↓ agent · enter open`, clipped to `width`. */
export function footerText(keys: readonly WorkspaceKeyHint[], width: number): string {
  return clipCells(keys.map((k) => `${k.key} ${k.action}`).join(' · '), Math.max(1, width));
}

export function WorkspaceFooter({ keys, width, depth }: WorkspaceFooterProps): ReactElement {
  const d = depth ?? DEPTH;
  const text = footerText(keys, width);
  return (
    <Box height={1} width={width} overflow="hidden">
      <Text color={token('textDim', d)}>{text.length > 0 ? text : ' '}</Text>
    </Box>
  );
}
