import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import {
  OK,
  TOOL_PENDING,
  RUNNING_STATIC,
  presentedStateGlyph,
  presentedStatusToken,
  isWholeLinePresented,
} from './glyphs';
import { MAX_NEST_DEPTH, useRunningElapsedSeconds } from './ToolCallCard';
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
}

/** status → glyph. Running renders an animated spinner instead of a static glyph. `done`→✓ and
 *  `queued`→● (a static mark — a queued spawn no longer borrows the running spinner) stay local
 *  to this surface; waiting/error/aborted/declined delegate to the shared {@link presentedStateGlyph}. */
function glyphOf(status: SubagentRowStatus): string {
  switch (status) {
    case 'running':
      return RUNNING_STATIC; // unused (spinner rendered); kept for exhaustiveness
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

  return (
    <Box marginLeft={indent}>
      {running ? (
        <Text color={glyphColor}>
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={glyphColor}>{glyphOf(status)}</Text>
      )}
      <Text color={textColor}>{` ${description}`}</Text>
      {model !== undefined ? <Text color={dim}>{` · ${model}`}</Text> : null}
      {running && seconds !== null ? (
        <Text color={dim}>{` · ${Math.floor(seconds)}s`}</Text>
      ) : null}
      {status === 'waiting' ? (
        <Text color={textColor}>{' · waiting on permission'}</Text>
      ) : null}
      {status === 'done' && outcomeHint !== undefined && outcomeHint.length > 0 ? (
        <Text color={dim}>{` · ${outcomeHint}`}</Text>
      ) : null}
      {(status === 'error' || status === 'aborted' || status === 'declined') &&
      reason !== undefined &&
      reason.length > 0 ? (
        <Text color={textColor}>{` · ${reason}`}</Text>
      ) : null}
    </Box>
  );
}
