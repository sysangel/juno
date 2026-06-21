import { Static } from 'ink';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface TranscriptProps {
  committed: Msg[];
  depth?: ColorDepth;
}

export function Transcript({ committed, depth }: TranscriptProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Static items={committed}>
      {(msg: Msg, index: number) => (
        <Message key={msg.id} msg={msg} depth={d} separated={index > 0} />
      )}
    </Static>
  );
}
