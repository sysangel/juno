import { memo, type ReactElement } from 'react';
import type { Msg, ToolState } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';
import { windowLiveMsg } from './liveWindow';
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
  /**
   * Upper bound (in lines) on the live turn's rendered height, so the dynamic
   * redraw region stays SHORTER than the viewport and Ink keeps terminal-following
   * instead of full-screen repainting (LANE D autoscroll fix — see liveWindow.ts).
   * When streaming text exceeds this, only the trailing `maxLines` lines render
   * (a dim elision marker leads); the full turn still commits to <Static> at
   * `assistant-done`. Omit/Infinity ⇒ no clamping (existing behavior for tests).
   */
  maxLines?: number;
  /**
   * Terminal width, so the height budget counts WRAPPED rows (Ink wraps every line
   * at this width) rather than source lines — without it a wide paragraph is one
   * budget line but many rendered rows and the live turn overflows the viewport,
   * re-triggering the scrollback-erasing full repaint (LANE D). Omit ⇒ 1 row per
   * source line (non-TTY / test behavior).
   */
  columns?: number;
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
  maxLines,
  columns,
}: StreamingMessageProps): ReactElement | null {
  if (live === null) return null;
  const d = depth ?? DEPTH;
  // Bound the live turn's height (in WRAPPED rows at `columns` wide) to keep Ink
  // terminal-following (autoscroll). No-op when the turn already fits or maxLines is
  // unset — returns the same `live` ref.
  const shown = windowLiveMsg(
    live,
    maxLines ?? Number.POSITIVE_INFINITY,
    columns ?? Number.POSITIVE_INFINITY,
    tools,
  );
  return (
    <Message
      msg={shown}
      depth={d}
      separated={separated}
      tools={tools}
      pendingPermissionToolCallId={pendingPermissionToolCallId}
      providerKind={providerKind}
      {...(columns !== undefined ? { columns } : {})}
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
