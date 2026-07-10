import { memo, type ReactElement } from 'react';
import type { Msg, ToolState } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';
import type { ProviderKind } from './providerKind';

const DEPTH: ColorDepth = detectColorDepth();

export interface StreamingMessageProps {
  live: Msg | null;
  depth?: ColorDepth;
  separated?: boolean;
  /** LIVE tools map so in-flight tool blocks render real cards (spinner +
   * elapsed) instead of dim placeholders — the live msg has no toolSnapshot. */
  tools?: Record<string, ToolState>;
  /** The tool call whose permission prompt is open, so its line renders
   * `waiting on permission` (honest state mapping, wave-1 item C). */
  pendingPermissionToolCallId?: string | null;
  /** The active backend's rendering class (render-only delegate tools tagged
   * `· via claude cli` / `· via codex cli`). */
  providerKind?: ProviderKind;
}

/**
 * Render the in-flight live message through the SAME <Message> path as committed
 * turns (unified rendering). No orphan spinner is drawn here: the live progress
 * spinner belongs to the designated live status area (wave-1 item D), not on its
 * own line below the message/tool cards. So the ONLY difference between a
 * streaming block and its committed form is the explicitly-live elements owned by
 * the status strip — this component adds no presentation of its own.
 */
function StreamingMessageView({
  live,
  depth,
  separated,
  tools,
  pendingPermissionToolCallId,
  providerKind,
}: StreamingMessageProps): ReactElement | null {
  if (live === null) return null;
  const d = depth ?? DEPTH;
  return (
    <Message
      msg={live}
      depth={d}
      separated={separated}
      tools={tools}
      pendingPermissionToolCallId={pendingPermissionToolCallId}
      providerKind={providerKind}
    />
  );
}

/**
 * Memoized (statusline-memo, Wave 2 item C). The default shallow compare is
 * DELIBERATE, not a custom comparator: the reducer is immutable, so every streaming
 * update hands a NEW `live` Msg (fresh `blocks`) and a NEW `tools` map — shallow
 * compare re-renders on exactly those mutations (live text is never frozen), yet
 * bails when a parent commit changes none of these props. A hand-written comparator
 * here is the classic way to accidentally freeze streaming/markdown text, so we
 * intentionally lean on prop identity instead.
 */
export const StreamingMessage = memo(StreamingMessageView);
