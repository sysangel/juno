import { Static } from 'ink';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface TranscriptProps {
  committed: Msg[];
  depth?: ColorDepth;
  /**
   * Transcript generation counter (`state.transcriptEpoch`). Passed as the
   * `<Static>` key so a wholesale replacement of `committed` (resume / compact /
   * clear) remounts Static and resets its append-only internal index to 0 — without
   * it, Static renders only `committed.slice(index)` and silently drops the leading
   * messages of the replaced array.
   */
  epoch?: number;
}

export function Transcript({ committed, depth, epoch }: TranscriptProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Static key={epoch ?? 0} items={committed}>
      {(msg: Msg, index: number) => (
        <Message key={msg.id} msg={msg} depth={d} separated={index > 0} />
      )}
    </Static>
  );
}
