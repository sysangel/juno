import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { memo, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ActivityState } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { clipCells, displayWidth } from './clipText';

const DEPTH: ColorDepth = detectColorDepth();

/** Re-render cadence for the live-turn elapsed readout. */
const ELAPSED_TICK_MS = 250;

export interface LiveTurnProps {
  /** The current activity, or null when idle (renders nothing). */
  activity: ActivityState | null;
  depth?: ColorDepth;
  /**
   * Injectable clock for the elapsed timer (mirrors ToolCallCard) so tests are
   * deterministic. Defaults to Date.now. The clock lives at the render edge —
   * never in the reducer.
   */
  now?: () => number;
  /**
   * Terminal columns. When set, the status line is kept to ONE row at that width
   * via priority-based segment dropping (abort hint, then elapsed) + a single-line
   * clip — so a narrow / split pane never reflows the spinner + label + elapsed +
   * abort into interleaved wrapped columns. Omit (isolated tests) ⇒ render every
   * segment untruncated.
   */
  width?: number;
}

/**
 * Whole-seconds elapsed since the turn became active, ticking a re-render every
 * ELAPSED_TICK_MS while active; null when idle. The start instant is a ref
 * (presentational timing, not reducer state) reset whenever activity toggles off.
 */
function useTurnElapsedSeconds(active: boolean, now: () => number): number | null {
  const startRef = useRef<number | null>(null);
  if (active && startRef.current === null) startRef.current = now();
  if (!active && startRef.current !== null) startRef.current = null;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return active && startRef.current !== null
    ? Math.floor(Math.max(0, now() - startRef.current) / 1000)
    : null;
}

/**
 * The live turn area (status-strip item D): a single line rendered ONLY while a
 * turn is in flight, sitting between the transcript and the composer. It is the
 * ONE designated home for the spinner (no orphan glyph elsewhere) and the honest
 * status:
 *
 *   <spinner> thinking… · 4s · esc to abort
 *   ◌ waiting on permission · esc to abort        (amber; a permission prompt is open)
 *
 * The elapsed readout is omitted for the permission-wait state (the clock there
 * measures the user's decision, not the model's work).
 */
function LiveTurnView({ activity, depth, now, width }: LiveTurnProps): ReactElement | null {
  const active = activity !== null;
  const seconds = useTurnElapsedSeconds(active, now ?? Date.now);
  if (activity === null) return null;
  const d = depth ?? DEPTH;
  const labelColor = activity.attention ? token('warning', d) : token('text', d);
  const showElapsed = !activity.attention && seconds !== null;

  // The trailing dim segments, each an INDIVISIBLE unit so the `s` on the elapsed time and
  // the whole `esc to abort` hint are never split across the row (the narrow-width bug:
  // ` · 0s · esc to abort` reflowed into interleaved columns, blanking the spinner and
  // shearing `0s`→`0`). They are DROPPED whole from the right as width shrinks — abort
  // first (least important), then elapsed — while the spinner + label always survive.
  const elapsedSeg = showElapsed ? ` · ${seconds}s` : '';
  const abortSeg = activity.abortable ? ' · esc to abort' : '';
  let label = activity.label;
  let tail = `${elapsedSeg}${abortSeg}`;
  if (width !== undefined) {
    // Visible line = glyph(1) + ' '(1) + label + tail; keep it to width-1 cells so it never
    // touches the final column (a full-width row can wrap on some terminals). Budget is the
    // room left for `label + tail` after the 2-cell `⠼ ` prefix.
    const budget = Math.max(0, width - 1 - 2);
    if (displayWidth(label) + displayWidth(tail) > budget) tail = elapsedSeg; // drop abort hint
    if (displayWidth(label) + displayWidth(tail) > budget) tail = ''; // drop elapsed too
    if (displayWidth(label) > budget) label = clipCells(label, budget); // clip an over-long label
  }

  // Each segment is its OWN flex <Text> (spinner / label / tail) rather than one wrapping
  // <Text>: a single wrapping node shrinks to its min-content width in the tall-live-turn
  // full-repaint layout and reflows into columns. `truncate-end` + `overflow: hidden`
  // keep the row to exactly one line; the priority drop above makes those clips no-ops on
  // a normally-sized turn (nothing is truncated mid-segment).
  const segWrap = width === undefined ? undefined : 'truncate-end';
  const rowOverflow = width === undefined ? undefined : 'hidden';
  return (
    <Box width={width} overflow={rowOverflow}>
      <Text color={activity.attention ? token('warning', d) : token('accent', d)}>
        {activity.attention ? '◌' : <Spinner type="dots" />}
      </Text>
      <Text color={labelColor} wrap={segWrap}>{` ${label}`}</Text>
      {tail.length > 0 ? (
        <Text color={token('textDim', d)} wrap={segWrap}>
          {tail}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Memoized (statusline-memo, Wave 2 item C). `selectActivity` returns a FRESH object
 * every parent render, so a plain shallow compare would never bail — the comparator
 * instead diffs activity BY VALUE (label/abortable/attention) so a token flush that
 * leaves the activity unchanged skips the render fn. Any real activity change
 * (null↔active, thinking→responding, phase swap) fails the compare and re-renders,
 * which re-runs the `active`-keyed effect — so the elapsed-tick reset refs keep their
 * exact re-subscribe timing. The elapsed/Spinner ticks are leaf-local state updates
 * that memo never gates (they re-render this component from within, not from a prop).
 */
export const LiveTurn = memo(LiveTurnView, (prev, next) => {
  const a = prev.activity;
  const b = next.activity;
  const activityEqual =
    a === b ||
    (a !== null &&
      b !== null &&
      a.label === b.label &&
      a.abortable === b.abortable &&
      a.attention === b.attention);
  return (
    activityEqual && prev.depth === next.depth && prev.now === next.now && prev.width === next.width
  );
});
