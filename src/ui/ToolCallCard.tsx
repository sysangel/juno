import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { viaCliLabel, type ProviderKind } from './providerKind';
import { isSubagentToolName } from '../core/selectors';
import { clipCells } from './clipText';

const DEPTH: ColorDepth = detectColorDepth();

/**
 * Deepest subagent-nesting level the child-card indentation grows to. A top-level
 * card is depth 0, its child depth 1, grandchild depth 2, … Cards deeper than this
 * clamp their indent here so a pathologically deep (or cyclic/malformed)
 * `parentToolUseId` chain can never march the indentation off the right edge. The
 * renderer's recursion in `Message.renderBlocks` is bounded by this same cap plus a
 * visited-set, so the two stay in lockstep. */
export const MAX_NEST_DEPTH = 4;

/**
 * Char cap on the single-line result/error tail rendered inline on a settled call
 * line (wave-7 lane C: condensed one-line cards — the full result now lives in the
 * ctrl+o tool-detail overlay, not in a multi-line preview slot).
 */
const RESULT_TAIL_MAX_CHARS = 48;
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
export function useRunningElapsedSeconds(running: boolean, now: () => number): number | null {
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

/** Collapse whitespace to single spaces, trim, and cap to `max` DISPLAY CELLS with an
 * ellipsis. Shared via {@link clipCells} with Message.firstLineClipped and
 * SubagentPanel.clip so the card, the status row, and the panel all measure width in
 * terminal cells (a CJK/emoji glyph is 2 cells) rather than UTF-16 code units — a
 * length-based clip let those overflow the one-row budget and could split a surrogate. */
function oneLine(value: string, max: number): string {
  return clipCells(value, max);
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
 * grep→pattern, subagent spawns (`Agent`/`Task`/`spawn_subagent`)→description, MCP
 * tools (`mcp__…`)→primary arg; fallback = one-line JSON. Always capped to a single
 * truncated line. Exported for unit tests.
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
  } else if (isSubagentToolName(name)) {
    // A subagent spawn's args are `{ description, prompt, subagent_type }` (claude-cli
    // Agent/Task) or `{ task, model, agent }` (juno spawn_subagent). Show ONLY the
    // human description — the full prompt/model lands in the ctrl+o overlay, never a
    // raw JSON blob on the call line.
    raw = argField(args, 'description') ?? argField(args, 'task') ?? argField(args, 'prompt');
  } else if (name.startsWith('mcp__')) {
    raw = primaryArgValue(args);
  }
  if (raw === undefined) raw = jsonOneLine(args);
  return oneLine(raw, ARGS_MAX_CHARS);
}

/**
 * Unwrap a provider "content block" array (`[{ type: 'text', text }, …]`) to its
 * joined plain text, or undefined when the value is not such an array. Subagent (and
 * some MCP/tool) results arrive in this shape; surfacing the text beats dumping a raw
 * JSON blob. Every element must be an object carrying a string `text` field, else the
 * value is left for the JSON fallback (a mixed/binary block array stays structured).
 */
function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const texts: string[] = [];
  for (const block of value) {
    if (typeof block !== 'object' || block === null) return undefined;
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== 'string') return undefined;
    texts.push(text);
  }
  return texts.join('\n');
}

/** Narrow a settled tool.result to a display string, preserving line structure.
 * Exported so the tool-detail overlay can render the FULL result (this card only
 * shows a one-line tail — the overlay shows everything). */
export function toDisplay(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+$/u, '');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Content-block arrays (`[{type:'text',text}]`, e.g. a subagent's Launched… result)
  // unwrap to their plain text BEFORE the JSON fallback, so the inline tail (and the
  // ctrl+o overlay) read as text, never a `[{"type":"text",…}]` blob.
  const blocks = contentBlocksToText(value);
  if (blocks !== undefined) return blocks.replace(/\s+$/u, '');
  // A plain (non-array) object carrying a string `summary` — juno's spawn_subagent tool
  // data `{ summary, model, agent? }` (subagentTool.ts), which the codex-bridge and the
  // raw-API executor forward VERBATIM as the spawn card's result — unwraps to that
  // summary text BEFORE the JSON fallback. Without this the spawn card's inline tail, the
  // done status-row outcome hint, and the ctrl+o overlay would all show a raw
  // `{"summary":…}` blob where a claude-cli parent (whose result arrives as a content-
  // block array, unwrapped just above) shows clean text — a codex-parity break. Unwrapping
  // HERE at the render edge leaves the model-facing tool-result shape untouched.
  if (typeof value === 'object' && !Array.isArray(value)) {
    const summary = (value as Record<string, unknown>).summary;
    if (typeof summary === 'string') return summary.replace(/\s+$/u, '');
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Condense a settled result to a ONE-LINE inline tail (wave-7 lane C): the first
 * non-blank line of the result, capped, plus a `+N lines` marker when the result
 * spilled past that first line (the overflow is not lost — ctrl+o opens the full
 * result in the tool-detail overlay). Empty result → empty text (the glyph alone
 * carries "done"). Exported for unit tests.
 */
export function resultTail(value: unknown): { text: string; hidden: number } {
  const raw = toDisplay(value);
  if (raw.length === 0) return { text: '', hidden: 0 };
  const all = raw.split('\n');
  const firstIdx = all.findIndex((line) => line.trim().length > 0);
  const idx = firstIdx === -1 ? 0 : firstIdx;
  const text = oneLine(all[idx] ?? '', RESULT_TAIL_MAX_CHARS);
  // Lines beyond the first shown line are "hidden" behind the overlay.
  return { text, hidden: Math.max(0, all.length - 1) };
}

/**
 * A single tool call rendered as ONE CONDENSED LINE (wave-7 lane C) — no bordered
 * box, no multi-line preview slot. The full args + result live in the ctrl+o
 * tool-detail overlay; the transcript stays tight:
 *
 *   ● toolName(args) <result tail>          done (green glyph) + dim one-line tail
 *   ◌ toolName(args) · waiting on permission   amber (a permission prompt is open)
 *   ⠋ toolName(args) · 3s                    running (spinner + whole-seconds)
 *   ✗ toolName(args) <first error line>      error (red), whole line tinted
 *
 * The result tail is the first non-blank result line (capped), with a `+N lines`
 * marker when there is more (open the overlay to read it). A delegate-CLI replay
 * appends `· via claude cli` / `· via codex cli` to the call line.
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

  // Condensed one-line tail: settled result → dim first-line summary (+overflow
  // marker); error → red first error line. Both live INLINE on the call line so a
  // tool call never exceeds one row in the transcript.
  let tail: ReactElement | null = null;
  if (presentation === 'result') {
    const { text, hidden } = resultTail(tool.result);
    if (text.length > 0) {
      const overflow = hidden > 0 ? ` +${hidden} line${hidden === 1 ? '' : 's'}` : '';
      tail = <Text color={token('textDim', d)}>{`  ${text}${overflow}`}</Text>;
    }
  } else if (presentation === 'error') {
    const firstLine = oneLine((tool.error ?? 'tool failed').split('\n')[0] ?? '', RESULT_TAIL_MAX_CHARS);
    tail = <Text color={stateColor}>{`  ${firstLine}`}</Text>;
  }

  return (
    <Box marginLeft={Math.max(0, Math.min(nestDepth ?? 0, MAX_NEST_DEPTH)) * 2}>
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
      {tail}
      {viaCliLabel(providerKind) !== undefined ? (
        <Text color={token('textDim', d)} dimColor>
          {` · ${viaCliLabel(providerKind)}`}
        </Text>
      ) : null}
    </Box>
  );
}
