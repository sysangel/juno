// src/ui/workspace/StyledLineText.tsx
// The one styled-line → Ink bridge for the Observatory: each StyledLine from
// layout.ts renders as EXACTLY ONE terminal row (builders keep every line within
// its cell budget, so no wrap can occur). Keeping the mapping 1:1 is what makes
// the workspace's row arithmetic — and its bounded-height promise — literal.
import { Text } from 'ink';
import type { ReactElement } from 'react';
import { token, type ColorDepth } from '../theme';
import type { StyledLine } from './layout';

export interface StyledLineTextProps {
  readonly line: StyledLine;
  readonly depth: ColorDepth;
}

export function StyledLineText({ line, depth }: StyledLineTextProps): ReactElement {
  if (line.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {line.map((seg, i) => (
        <Text
          key={i}
          color={seg.token !== undefined ? token(seg.token, depth) : undefined}
          bold={seg.bold === true}
          italic={seg.italic === true}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}
