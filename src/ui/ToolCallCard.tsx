import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { viaCliLabel, type ProviderKind } from './providerKind';

const DEPTH: ColorDepth = detectColorDepth();

/**
 * Deepest subagent-nesting level the child-card indentation grows to. A top-level
 * card is depth 0, its child depth 1, grandchild depth 2, … Cards deeper than this
 * clamp their indent here so a pathologically deep (or cyclic/malformed)
 * `parentToolUseId` chain can never march the indentation off the right edge. The
 * renderer's recursion in `Message.renderBlocks` is bounded by this same cap plus a
 * visited-set, so the two stay in lockstep. */
export const MAX_NEST_DEPTH = 4;

/** Result preview budget for a settled tool line (wave-1 item C: max 3 lines). */
const RESULT_MAX_LINES = 3;
/** Per-line char cap on the result preview so one huge line can't blow the width. */
const RESULT_LINE_MAX_CHARS = 200;
/** One-line arg summary cap on the call line. */
const ARGS_MAX_CHARS = 60;

/** Re-render cadence for the running line's elapsed readout. */
const ELAPSED_TICK_MS = 250;

export interface ToolCallCardProps {
  tool: ToolState;
  depth?: ColorDepth;
  /**
   * Subagent-nesting depth for a claude-cli subagent's tool card: 0 = top-level,
   * 1 = a direct child (indented one step beneath its parent `Agent` line),
   * 2 = a grandchild, … Drives the left indent (`depth × 2`, clamped at
   * {@link MAX_NEST_DEPTH}). Layout-only; distinct from `depth` (which is color).
   * Replaces the old `nested` boolean so children of children render at their true
   * depth instead of being flattened to a single indent step (or dropped).
   */
  nestDepth?: number;
  /**
   * Honest state mapping (wave-1 item C): true when a permission prompt is open
   * for THIS tool call (`state.pendingPermissionToolCallId` matches). A gated tool
   * is rendered as `waiting on permission`, never as running — the running spinner
   * would lie about what the process is doing.
   */
  waitingOnPermission?: boolean;
  /**
   * The rendering class of the active backend. For a render-only delegate CLI
   * (`claude-cli`/`codex-cli`) — which runs tools under ITS OWN config and juno
   * merely REPLAYS them — the call line is tagged `· via claude cli` / `· via codex
   * cli` (the surface-honestly decision). For `api` (or undefined) the tool ran
   * under juno's own executor and is unmarked.
   */
  providerKind?: ProviderKind;
  /**
   * Injectable clock for the running line's elapsed timer (mirrors the injectable
   * deps pattern) so tests are deterministic. Defaults to Date.now. The clock lives
   * HERE at the render edge — never in the reducer.
   */
  now?: () => number;
}

/**
 * Elapsed seconds since this line entered 'running', ticking a re-render every
 * ELAPSED_TICK_MS while active; null when not running. The start instant is a ref
 * local to the line (presentational timing, not reducer state — the reducer stays
 * clock-free).
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

/** The visual presentation a tool line resolves to. Distinct from ToolStatus:
 * a pending tool with an open permission prompt presents as 'waiting'. */
type Presentation = 'pending' | 'waiting' | 'running' | 'result' | 'error';

function presentationOf(status: ToolState['status'], waiting: boolean): Presentation {
  if (status === 'result') return 'result';
  if (status === 'error') return 'error';
  // Honest mapping: a gated tool (pending/running-in-name-only) is 'waiting', never running.
  if (waiting) return 'waiting';
  if (status === 'running') return 'running';
  return 'pending';
}

/** The status glyph for each presentation. Running uses an animated spinner instead. */
function glyphOf(p: Presentation): string {
  switch (p) {
    case 'pending':
      return '●';
    case 'waiting':
      return '◌';
    case 'running':
      return '●'; // unused (spinner rendered); kept for exhaustiveness
    case 'result':
      return '●';
    case 'error':
      return '✗';
  }
}

/** The color token carrying the state's meaning (green=ok, amber=attention, red=error). */
function colorTokenOf(p: Presentation): FlatTokenName {
  switch (p) {
    case 'pending':
      return 'toolPending';
    case 'waiting':
      return 'warning';
    case 'running':
      return 'toolRunning';
    case 'result':
      return 'toolResult';
    case 'error':
      return 'toolError';
  }
}

/** Collapse whitespace to single spaces, trim, and cap to `max` with an ellipsis. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** JSON-serialize `value` onto one line, or '' for empty; total (never throws). */
function jsonOneLine(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

/** Read a named scalar field off an args object as a display string, or undefined. */
function argField(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** First scalar value in an args object (MCP-tool "primary arg"), or undefined. */
function primaryArgValue(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

/**
 * Humanize a tool call's args into the ONE most meaningful field for the call
 * line: shell→command, write_file/edit_file/read_file→path, list_files→dir,
 * grep→pattern, MCP tools (`mcp__…`)→primary arg; fallback = one-line JSON.
 * Always capped to a single truncated line. Exported for unit tests.
 */
export function humanizeArgs(name: string, args: unknown): string {
  const lower = name.toLowerCase();
  let raw: string | undefined;
  if (lower === 'run_shell' || lower === 'shell' || lower === 'bash') {
    raw = argField(args, 'command');
  } else if (lower === 'write_file' || lower === 'edit_file' || lower === 'read_file') {
    raw = argField(args, 'path');
  } else if (lower === 'list_files') {
    raw = argField(args, 'dir') ?? argField(args, 'path') ?? '.';
  } else if (lower === 'grep') {
    raw = argField(args, 'pattern');
  } else if (name.startsWith('mcp__')) {
    raw = primaryArgValue(args);
  }
  if (raw === undefined) raw = jsonOneLine(args);
  return oneLine(raw, ARGS_MAX_CHARS);
}

/** Narrow a settled tool.result to a display string, preserving line structure. */
function toDisplay(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+$/u, '');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

/** Split a preview into the first `RESULT_MAX_LINES` lines + a hidden-count. */
function previewLines(raw: string): { lines: string[]; hidden: number } {
  if (raw.length === 0) return { lines: [], hidden: 0 };
  const all = raw.split('\n');
  const shown = all.slice(0, RESULT_MAX_LINES).map((line) => oneLine(line, RESULT_LINE_MAX_CHARS));
  return { lines: shown, hidden: all.length - shown.length };
}

/**
 * The dim result slot beneath a settled call line:
 *   `  ⎿ <first line>` then indented continuation lines, then `… (+N lines)`.
 * `color` tints the preview (dim for results, error-red for the error's first line).
 */
function ResultSlot({
  lines,
  hidden,
  color,
  d,
}: {
  lines: string[];
  hidden: number;
  color: string;
  d: ColorDepth;
}): ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={i} color={color}>
          {(i === 0 ? '  ⎿ ' : '    ') + line}
        </Text>
      ))}
      {hidden > 0 ? (
        // Single-dim convention (item 6): the "+N lines" hint matches the result
        // preview's `textDim` (no stacked `dimColor` that read dimmer than it).
        <Text color={token('textDim', d)}>
          {`    … (+${hidden} line${hidden === 1 ? '' : 's'})`}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * A single tool call rendered as COMPACT LINES (wave-1 item C) — no bordered box:
 *
 *   ● toolName(args)                        done (green glyph)
 *     ⎿ <result preview, ≤3 lines>          dim
 *   ◌ toolName(args) · waiting on permission   amber (a permission prompt is open)
 *   ⠋ toolName(args) · 3s                    running (spinner + whole-seconds)
 *   ✗ toolName(args)                         error (red) + first error line below
 *
 * A delegate-CLI replay appends `· via claude cli` / `· via codex cli` to the call line.
 */
export function ToolCallCard({
  tool,
  depth,
  nestDepth,
  waitingOnPermission,
  providerKind,
  now,
}: ToolCallCardProps): ReactElement {
  const d = depth ?? DEPTH;
  const presentation = presentationOf(tool.status, waitingOnPermission === true);
  const running = presentation === 'running';
  const elapsedSeconds = useRunningElapsedSeconds(running, now ?? Date.now);

  const stateColor = token(colorTokenOf(presentation), d);
  // error / waiting carry their meaning across the WHOLE call line; other states
  // keep the name in default text and the args dim (glyph carries the color).
  const wholeLineColored = presentation === 'error' || presentation === 'waiting';
  const nameColor = wholeLineColored ? stateColor : token('text', d);
  const argsColor = wholeLineColored ? stateColor : token('textDim', d);

  const argsStr =
    humanizeArgs(tool.name, tool.args) || oneLine(tool.argsText ?? '', ARGS_MAX_CHARS);

  // Result slot: settled result → dim preview; error → first error line (red).
  let slot: ReactElement | null = null;
  if (presentation === 'result') {
    const { lines, hidden } = previewLines(toDisplay(tool.result));
    slot = <ResultSlot lines={lines} hidden={hidden} color={token('textDim', d)} d={d} />;
  } else if (presentation === 'error') {
    const firstLine = oneLine((tool.error ?? 'tool failed').split('\n')[0] ?? '', RESULT_LINE_MAX_CHARS);
    slot = <ResultSlot lines={[firstLine]} hidden={0} color={stateColor} d={d} />;
  }

  return (
    <Box flexDirection="column" marginLeft={Math.max(0, Math.min(nestDepth ?? 0, MAX_NEST_DEPTH)) * 2}>
      <Box>
        {running ? (
          <Text color={stateColor}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={stateColor}>{glyphOf(presentation)}</Text>
        )}
        <Text color={nameColor}>{` ${tool.name}`}</Text>
        <Text color={argsColor}>{`(${argsStr})`}</Text>
        {presentation === 'waiting' ? (
          <Text color={stateColor}>{' · waiting on permission'}</Text>
        ) : null}
        {running && elapsedSeconds !== null ? (
          <Text color={token('textDim', d)}>{` · ${Math.floor(elapsedSeconds)}s`}</Text>
        ) : null}
        {viaCliLabel(providerKind) !== undefined ? (
          <Text color={token('textDim', d)} dimColor>
            {` · ${viaCliLabel(providerKind)}`}
          </Text>
        ) : null}
      </Box>
      {slot}
    </Box>
  );
}
