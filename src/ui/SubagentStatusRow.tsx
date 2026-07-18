import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { OK, FAIL, ABORTED, RUNNING_STATIC } from './glyphs';
import { MAX_NEST_DEPTH, useRunningElapsedSeconds } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

/** Rolled-up lifecycle of a subagent card, mapped from its ToolState.status. `aborted` is a
 *  cancel (user Esc/Ctrl+C or a parent-abort cascade), split out of `error` so it reads
 *  neutral, not as a failure. */
export type SubagentRowStatus = 'running' | 'done' | 'error' | 'aborted';

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

/** status → glyph. Running renders an animated spinner instead of a static glyph. */
function glyphOf(status: SubagentRowStatus): string {
  switch (status) {
    case 'running':
      return RUNNING_STATIC; // unused (spinner rendered); kept for exhaustiveness
    case 'done':
      return OK;
    case 'error':
      return FAIL;
    case 'aborted':
      return ABORTED;
  }
}

/**
 * status → the theme token NAMES for the row's glyph and its trailing text. Split out as a
 * pure, exhaustively-typed mapping so the colour DECISION is unit-testable without rendering
 * (Ink emits no SGR under the test env's supports-color 0). Semantics:
 *   - error  : the whole line is tinted toolError (red) — a failure carries its meaning across.
 *   - done   : green glyph, dim outcome text.
 *   - running: the live glyph hue, dim detail.
 *   - aborted: BOTH glyph and text are the muted textDim — a cancel is neutral, deliberately
 *              NOT toolError red (would read as a failure) and NOT toolResult green (a clean
 *              finish).
 */
export function subagentRowTokens(status: SubagentRowStatus): {
  glyph: FlatTokenName;
  text: FlatTokenName;
} {
  switch (status) {
    case 'error':
      return { glyph: 'toolError', text: 'toolError' };
    case 'done':
      return { glyph: 'toolResult', text: 'textDim' };
    case 'running':
      return { glyph: 'toolRunning', text: 'textDim' };
    case 'aborted':
      return { glyph: 'textDim', text: 'textDim' };
  }
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
      {status === 'done' && outcomeHint !== undefined && outcomeHint.length > 0 ? (
        <Text color={dim}>{` · ${outcomeHint}`}</Text>
      ) : null}
      {(status === 'error' || status === 'aborted') && reason !== undefined && reason.length > 0 ? (
        <Text color={textColor}>{` · ${reason}`}</Text>
      ) : null}
    </Box>
  );
}
