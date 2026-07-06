import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { collapse, collapseIndicator } from './collapse';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

/** Collapse budget for a settled tool card's output preview (raw stays off-screen). */
const OUTPUT_MAX_LINES = 12;
const OUTPUT_MAX_CHARS = 800;

/** Re-render cadence for the running card's elapsed readout. */
const ELAPSED_TICK_MS = 250;

export interface ToolCallCardProps {
  tool: ToolState;
  depth?: ColorDepth;
  /**
   * When true, render as a nested child card — indented and with a dimmer
   * border — used to attribute a claude-cli subagent's tool call beneath its
   * parent `Agent` card. Layout-only; distinct from `depth` (which is color).
   */
  nested?: boolean;
  /**
   * Injectable clock for the running-card elapsed timer (mirrors the injectable
   * deps pattern in services/brain.ts) so tests are deterministic. Defaults to
   * Date.now. The clock lives HERE at the render edge — never in the reducer.
   */
  now?: () => number;
}

/**
 * Elapsed seconds since this card entered 'running', ticking a re-render every
 * ELAPSED_TICK_MS while active; null when not running. The start instant is a
 * ref local to the card (presentational timing, not reducer state — the reducer
 * stays clock-free).
 */
function useRunningElapsedSeconds(running: boolean, now: () => number): number | null {
  const startRef = useRef<number | null>(null);
  if (running && startRef.current === null) startRef.current = now();
  if (!running && startRef.current !== null) startRef.current = null;

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  return running && startRef.current !== null
    ? Math.max(0, now() - startRef.current) / 1000
    : null;
}

/** Map a tool lifecycle status to its theme token name. Exhaustive over ToolStatus. */
function statusToken(status: ToolState['status']): FlatTokenName {
  switch (status) {
    case 'pending':
      return 'toolPending';
    case 'running':
      return 'toolRunning';
    case 'result':
      return 'toolResult';
    case 'error':
      return 'toolError';
  }
}

/** Distinct glyph per status so different statuses render visibly differently. */
function statusGlyph(status: ToolState['status']): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'running':
      return '◐';
    case 'result':
      return '●';
    case 'error':
      return '✖';
  }
}

/** Narrow `unknown` (streaming tool.args) to a compact one-line string. */
function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value) ?? '[unserializable]';
    return s;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Narrow `unknown` (a settled tool.result) to a display string that PRESERVES
 * line structure, so `collapse` can cap it to a first-N-lines preview. Strings
 * pass through verbatim; everything else is JSON-serialized on one line (the
 * char cap then bounds a large single-line blob).
 */
function toDisplay(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+$/u, '');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

export function ToolCallCard({ tool, depth, nested, now }: ToolCallCardProps): ReactElement {
  const d = depth ?? DEPTH;
  const color = token(statusToken(tool.status), d);
  const borderColor = nested === true ? token('textDim', d) : color;
  const running = tool.status === 'running';
  const elapsedSeconds = useRunningElapsedSeconds(running, now ?? Date.now);

  // Settled cards (result/error) collapse to a bounded, line-preserving preview;
  // still-streaming cards keep the compact one-line arg summary.
  const settled = tool.status === 'result' || tool.status === 'error';
  const raw = settled
    ? tool.status === 'error'
      ? tool.error ?? 'tool failed'
      : toDisplay(tool.result)
    : compact(tool.argsText ?? tool.args);
  const collapsed = settled
    ? collapse(raw, { maxLines: OUTPUT_MAX_LINES, maxChars: OUTPUT_MAX_CHARS })
    : null;
  const summary = collapsed !== null ? collapsed.text : raw;
  const indicator = collapsed !== null ? collapseIndicator(collapsed) : '';

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      marginLeft={nested === true ? 2 : 0}
    >
      <Box gap={1}>
        {running ? (
          // Animated running indicator (ink-spinner) instead of the static ◐.
          <Text color={color}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={color}>{statusGlyph(tool.status)}</Text>
        )}
        <Text color={token('text', d)} bold>
          {tool.name}
        </Text>
        <Text color={token('textDim', d)}>[{tool.status}]</Text>
        {elapsedSeconds !== null ? (
          <Text color={token('textDim', d)}>({elapsedSeconds.toFixed(1)}s)</Text>
        ) : null}
      </Box>
      {summary.length > 0 ? <Text color={token('textDim', d)}>{summary}</Text> : null}
      {indicator.length > 0 ? (
        <Text color={token('textDim', d)} dimColor>
          {indicator}
        </Text>
      ) : null}
    </Box>
  );
}
