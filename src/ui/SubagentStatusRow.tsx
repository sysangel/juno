import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { MAX_NEST_DEPTH, useRunningElapsedSeconds } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

export interface SubagentStatusRowProps {
  /**
   * The live rollup label for this subagent — `running <tool>…` for its newest running
   * descendant, or `working…` — from `runningChildActivity`.
   */
  label: string;
  /**
   * Left-indent depth so the row reads as belonging to its Agent card. The row sits one
   * step DEEPER than the card it summarises (like a child row), clamped at
   * {@link MAX_NEST_DEPTH} so a pathological chain can't march it off the right edge.
   */
  nestDepth: number;
  depth?: ColorDepth;
  /**
   * Injectable clock for the elapsed timer (mirrors ToolCallCard/LiveTurn) so tests are
   * deterministic. Defaults to Date.now; the clock lives at the render edge, never in
   * the reducer.
   */
  now?: () => number;
}

/**
 * The per-subagent live status line (wave-6 lane C): ONE spinner + rollup label +
 * elapsed line rendered beneath a RUNNING `Agent`/`Task`/`spawn_subagent` card,
 * summarising what THAT subagent is doing right now (its newest running descendant, via
 * {@link runningChildActivity}). The global `LiveTurn` collapses ALL running tools to
 * the first one, so parallel subagents are indistinguishable there; giving each running
 * subagent card its own row makes the TUI show what EACH is doing.
 *
 * It deliberately carries NO `esc to abort` hint: aborting is a turn-level action owned
 * by `LiveTurn`, and the single-busy-line invariant (`resumedTurnSpinner`) counts busy
 * lines by that hint — a per-subagent row must never add to that count.
 */
export function SubagentStatusRow({
  label,
  nestDepth,
  depth,
  now,
}: SubagentStatusRowProps): ReactElement {
  const d = depth ?? DEPTH;
  // The row only renders while its subagent is running, so the elapsed clock is always
  // active; it reads how long the subagent has been working.
  const seconds = useRunningElapsedSeconds(true, now ?? Date.now);
  const indent = Math.max(0, Math.min(nestDepth, MAX_NEST_DEPTH)) * 2;
  return (
    <Box marginLeft={indent}>
      <Text color={token('toolRunning', d)}>
        <Spinner type="dots" />
      </Text>
      <Text color={token('textDim', d)}>{` ${label}`}</Text>
      {seconds !== null ? (
        <Text color={token('textDim', d)}>{` · ${Math.floor(seconds)}s`}</Text>
      ) : null}
    </Box>
  );
}
