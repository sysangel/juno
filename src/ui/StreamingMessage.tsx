import type { ReactElement } from 'react';
import type { Msg, ToolState } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface StreamingMessageProps {
  live: Msg | null;
  depth?: ColorDepth;
  separated?: boolean;
  /** LIVE tools map so in-flight tool blocks render real cards (spinner +
   * elapsed) instead of dim placeholders — the live msg has no toolSnapshot. */
  tools?: Record<string, ToolState>;
}

/**
 * Render the in-flight live message through the SAME <Message> path as committed
 * turns (unified rendering). No orphan spinner is drawn here: the live progress
 * spinner belongs to the designated live status area (wave-1 item D), not on its
 * own line below the message/tool cards. So the ONLY difference between a
 * streaming block and its committed form is the explicitly-live elements owned by
 * the status strip — this component adds no presentation of its own.
 */
export function StreamingMessage({ live, depth, separated, tools }: StreamingMessageProps): ReactElement | null {
  if (live === null) return null;
  const d = depth ?? DEPTH;
  return <Message msg={live} depth={d} separated={separated} tools={tools} />;
}
