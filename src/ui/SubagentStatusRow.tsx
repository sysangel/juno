import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import {
  OK,
  TOOL_PENDING,
  RUNNING_HALF,
  presentedStateGlyph,
  presentedStatusToken,
  isWholeLinePresented,
} from './glyphs';
import { MAX_NEST_DEPTH, useRunningElapsedSeconds } from './ToolCallCard';
import { clipCells, displayWidth } from './clipText';
import type { PresentedStatus } from '../core/selectors';

const DEPTH: ColorDepth = detectColorDepth();

/** Rolled-up lifecycle of a subagent card, classified through the shared {@link PresentedStatus}.
 *  `aborted` is a cancel (user Esc/Ctrl+C or a parent-abort cascade) and `declined` a
 *  permission/policy deny — both split out of `error` so they read neutral, not as a failure;
 *  `queued`/`waiting` are a not-yet-started / permission-gated spawn (neither ticks the clock). */
export type SubagentRowStatus = PresentedStatus;

/**
 * Cell cap the transcript clips a status row's description AND its outcome/reason text to
 * (via Message.firstLineClipped) before this row renders them. The row is NOT width-clipped
 * (no truncate on its inline Text), so at a narrow terminal it word-wraps past one row — the
 * live-window height estimator (src/ui/liveWindow.ts) width-bounds it from THIS cap so it can
 * never under-count a wrapped status row and re-trigger Ink's scrollback-erasing repaint.
 * Owned here (the row it caps) and imported by Message.tsx so the clip and the estimate share
 * one source.
 */
export const STATUS_DESC_MAX_CHARS = 60;

export interface SubagentStatusRowProps {
  /** Lifecycle: drives the glyph, color, and which trailing detail shows. */
  readonly status: SubagentRowStatus;
  /** The subagent's human description (from its spawn args), or its tool name. */
  readonly description: string;
  /** Child model / `subagent_type`, when the spawn args carry one. */
  readonly model?: string;
  /** DONE only: a one-line outcome hint (the first line of the subagent's result). */
  readonly outcomeHint?: string;
  /** ERROR/ABORTED only: a one-line exit reason (the first line of the subagent's error, or
   *  the abort marker for a cancel). */
  readonly reason?: string;
  /**
   * Left-indent depth so the row reads as belonging to its spawn card. The row sits one
   * step DEEPER than the card it summarises (like a child row), clamped at
   * {@link MAX_NEST_DEPTH} so a pathological chain can't march it off the right edge.
   */
  readonly nestDepth: number;
  readonly depth?: ColorDepth;
  /**
   * Injectable clock for the running elapsed timer (mirrors ToolCallCard/LiveTurn) so
   * tests are deterministic. Defaults to Date.now; the clock lives at the render edge,
   * never in the reducer.
   */
  readonly now?: () => number;
  /**
   * Terminal columns (W5). When present, the WHOLE row is bound to `columns - 1` DISPLAY
   * CELLS at exactly one terminal row (head-priority fit, like GroupToolRow): the
   * description is the head, model/elapsed/waiting are short reserves, and the outcome
   * hint / exit reason is the compressible detail — clipped IN for a reason-bearing state
   * (error/aborted/declined must still show WHY), dropped for a done outcome hint. When
   * ABSENT the row keeps today's behavior byte-for-byte (description & reason already
   * arrive pre-clipped to {@link STATUS_DESC_MAX_CHARS} by Message.firstLineClipped); the
   * width math is gated behind `columns !== undefined && columns > 0`.
   */
  readonly columns?: number;
}

/** status → glyph. Running renders an animated spinner instead of a static glyph. `done`→✓ and
 *  `queued`→● (a static mark — a queued spawn no longer borrows the running spinner) stay local
 *  to this surface; waiting/error/aborted/declined delegate to the shared {@link presentedStateGlyph}. */
function glyphOf(status: SubagentRowStatus): string {
  switch (status) {
    case 'running':
      return RUNNING_HALF; // unused (spinner rendered); keeps the exhaustive mapping truthful
    case 'queued':
      return TOOL_PENDING; // ● static — no spinner, no ticking clock
    case 'done':
      return OK; // ✓
    case 'waiting':
    case 'error':
    case 'aborted':
    case 'declined':
      return presentedStateGlyph(status);
  }
}

/**
 * status → the theme token NAMES for the row's glyph and its trailing text. A thin wrapper over
 * the shared {@link presentedStatusToken} + {@link isWholeLinePresented} seam so the colour
 * DECISION is unit-testable without rendering (Ink emits no SGR under the test env's supports-color
 * 0) AND is identical across every surface. Behaviour-preserving for the original four states:
 *   - error   : whole line tinted toolError (red) — a failure carries its meaning across.
 *   - done    : green glyph, dim outcome text.
 *   - running : the live glyph hue, dim detail.
 *   - aborted : BOTH glyph and text muted textDim — a cancel is neutral (NOT red, NOT green).
 * And correct for the three new ones: waiting → amber whole-line; queued → pending glyph over dim
 * detail; declined → amber whole-line (like waiting) — {@link isWholeLinePresented} includes it, so
 * its {glyph,text} is {warning,warning}, NOT the neutral dim of an aborted cancel.
 */
export function subagentRowTokens(status: SubagentRowStatus): {
  glyph: FlatTokenName;
  text: FlatTokenName;
} {
  return {
    glyph: presentedStatusToken(status),
    text: isWholeLinePresented(status) ? presentedStatusToken(status) : 'textDim',
  };
}

/**
 * The per-subagent status row rendered directly beneath a spawn card
 * (`Agent`/`Task`/`spawn_subagent`), replacing the old dim `⎿ ↓ agents` pointer. It
 * presents the subagent honestly by lifecycle:
 *
 *   ⠋ <description> · <model> · <elapsed>s   running (spinner + dim detail + clock)
 *   ✓ <description> · <model> · <outcome>     done    (green check + dim outcome hint)
 *   ✗ <description> · <reason>                error   (red cross, whole line tinted)
 *   ⊘ <description> · <reason>                aborted (neutral/dim circled-slash + dim reason;
 *                                                      a user cancel, NOT a failure — never red)
 *
 * Descendant tool chatter stays suppressed in the transcript (it is written to disk and
 * summarised in the below-composer agents panel), so this ONE row is the subagent's whole
 * presence in scrollback. Dim/secondary styling matches the condensed tool cards.
 *
 * It deliberately carries NO `esc to abort` hint: aborting is a turn-level action owned by
 * `LiveTurn`, and the single-busy-line invariant (`resumedTurnSpinner`) counts busy lines
 * by that hint — a per-subagent row must never add to that count.
 */
export function SubagentStatusRow({
  status,
  description,
  model,
  outcomeHint,
  reason,
  nestDepth,
  depth,
  now,
  columns,
}: SubagentStatusRowProps): ReactElement {
  const d = depth ?? DEPTH;
  const running = status === 'running';
  // The elapsed clock ticks only while the subagent runs; a settled row has none.
  const seconds = useRunningElapsedSeconds(running, now ?? Date.now);
  const indent = Math.max(0, Math.min(nestDepth, MAX_NEST_DEPTH)) * 2;

  const dim = token('textDim', d);
  // Glyph + trailing-text hues come from the pure, exhaustive token map (subagentRowTokens):
  // error tints the whole line red; done/running keep dim text under a coloured glyph; aborted
  // is fully neutral (dim glyph AND dim text) so a cancel never reads as a failure or a finish.
  const tokens = subagentRowTokens(status);
  const glyphColor = token(tokens.glyph, d);
  const textColor = token(tokens.text, d);

  // The short reserve suffixes (model / elapsed / waiting), precomputed so the width fit
  // reserves EXACTLY the strings the JSX renders. The single trailing DETAIL is the done
  // outcome hint (dim, droppable) OR an error/aborted/declined exit reason (textColor,
  // reason-bearing — clipped in, never blanked to read like a clean state).
  const modelSuffix = model !== undefined ? ` · ${model}` : '';
  const elapsedSuffix = running && seconds !== null ? ` · ${Math.floor(seconds)}s` : '';
  const waitingSuffix = status === 'waiting' ? ' · waiting on permission' : '';
  const reasonBearing = status === 'error' || status === 'aborted' || status === 'declined';
  let detailStr = '';
  let detailColor = dim;
  if (status === 'done' && outcomeHint !== undefined && outcomeHint.length > 0) {
    detailStr = outcomeHint;
    detailColor = dim;
  } else if (reasonBearing && reason !== undefined && reason.length > 0) {
    detailStr = reason;
    detailColor = textColor;
  }

  // W5 — head-priority cell-accurate fit (mirrors GroupToolRow). `content` is the budget AFTER
  // glyph(1) + leading space(1); the reserves are kept whole, leaving `avail` for the head
  // (description) + detail. When the detail does not fit whole, a reason-bearing state clips it
  // IN (never blanked); a done outcome hint is dropped. Gated behind a present, positive
  // `columns` so the width-less path stays byte-for-byte today's output.
  let headText = description;
  let detailRenderStr = detailStr.length > 0 ? ` · ${detailStr}` : '';
  if (columns !== undefined && columns > 0) {
    const content = Math.max(0, columns - 1 - indent - 2);
    const reserve = displayWidth(modelSuffix) + displayWidth(elapsedSuffix) + displayWidth(waitingSuffix);
    const avail = Math.max(0, content - reserve);
    const detailRender = detailStr.length > 0 ? ` · ${detailStr}` : '';
    const detailW = displayWidth(detailRender);
    const showDetailWhole = detailRender.length > 0 && displayWidth(description) + detailW <= avail;
    let dText = showDetailWhole ? detailRender : '';
    let headMax = showDetailWhole ? avail - detailW : avail;
    if (!showDetailWhole && reasonBearing && detailStr.length > 0) {
      // Reserve room for a clipped reason rather than dropping it (the error/aborted/declined
      // must still show WHY it exited).
      const room = avail - Math.min(displayWidth(description), Math.max(0, avail - 6));
      if (room > 3) {
        dText = ` · ${clipCells(detailStr, room - 3)}`;
        headMax = Math.max(0, avail - displayWidth(dText));
      }
    }
    headText = clipCells(description, headMax);
    detailRenderStr = dText;
  }

  return (
    <Box marginLeft={indent}>
      {running ? (
        <Text color={glyphColor}>
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={glyphColor}>{glyphOf(status)}</Text>
      )}
      <Text color={textColor}>{` ${headText}`}</Text>
      {modelSuffix.length > 0 ? <Text color={dim}>{modelSuffix}</Text> : null}
      {elapsedSuffix.length > 0 ? <Text color={dim}>{elapsedSuffix}</Text> : null}
      {waitingSuffix.length > 0 ? <Text color={textColor}>{waitingSuffix}</Text> : null}
      {detailRenderStr.length > 0 ? <Text color={detailColor}>{detailRenderStr}</Text> : null}
    </Box>
  );
}
