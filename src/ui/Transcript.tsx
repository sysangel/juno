import { Static } from 'ink';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';
import type { ProviderKind } from './providerKind';

const DEPTH: ColorDepth = detectColorDepth();

export interface TranscriptProps {
  committed: Msg[];
  depth?: ColorDepth;
  /**
   * Transcript generation counter (`state.transcriptEpoch`). Passed as the
   * `<Static>` key so a wholesale replacement of `committed` (resume / clear)
   * remounts Static and resets its append-only internal index to 0 — without
   * it, Static renders only `committed.slice(index)` and silently drops the leading
   * messages of the replaced array.
   */
  epoch?: number;
  /** The active backend's rendering class, so committed tool lines from a
   * render-only delegate CLI are tagged `· via claude cli` / `· via codex cli`
   * (surface-honestly, wave-1 item C). */
  providerKind?: ProviderKind;
  /**
   * Terminal columns (W5), forwarded to each committed <Message> so a settled tool
   * line — a solo card, a subagent status row, and a concurrent group's condensed line —
   * clips in DISPLAY CELLS at the SAME width the live turn used. Without it the committed
   * path fell back to a fixed cap (concurrent groups to FALLBACK_WIDTH=120), so a group
   * clipped LIVE at the real width re-clipped at 120 once committed — a visible reflow at
   * the commit boundary when the terminal is narrower than 120 (append-only violation).
   * `<Static>` is append-only (it prints each item once, never re-emitting already-printed
   * items), so a live-updating `columns` is safe: on resize only NEW committed items pick
   * up the new width; previously-committed lines stay frozen. Omit ⇒ the fixed-cap path
   * (width-less unit tests stay unaffected — FALLBACK_WIDTH survives only for them).
   */
  columns?: number;
}

export function Transcript({ committed, depth, epoch, providerKind, columns }: TranscriptProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Static key={epoch ?? 0} items={committed}>
      {(msg: Msg, index: number) => (
        <Message
          key={msg.id}
          msg={msg}
          depth={d}
          separated={index > 0}
          providerKind={providerKind}
          {...(columns !== undefined ? { columns } : {})}
        />
      )}
    </Static>
  );
}
