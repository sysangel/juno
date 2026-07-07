import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ActivityState } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth } from './theme';

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
export function LiveTurn({ activity, depth, now }: LiveTurnProps): ReactElement | null {
  const active = activity !== null;
  const seconds = useTurnElapsedSeconds(active, now ?? Date.now);
  if (activity === null) return null;
  const d = depth ?? DEPTH;
  const labelColor = activity.attention ? token('warning', d) : token('text', d);
  const showElapsed = !activity.attention && seconds !== null;
  return (
    <Box>
      <Text color={activity.attention ? token('warning', d) : token('accent', d)}>
        {activity.attention ? '◌' : <Spinner type="dots" />}
      </Text>
      <Text color={labelColor}>{` ${activity.label}`}</Text>
      {showElapsed ? <Text color={token('textDim', d)}>{` · ${seconds}s`}</Text> : null}
      {activity.abortable ? (
        <Text color={token('textDim', d)}>{' · esc to abort'}</Text>
      ) : null}
    </Box>
  );
}
