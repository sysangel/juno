import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { viaCliLabel, type ProviderKind } from './providerKind';
import { isSubagentToolName, presentedStatus, type PresentedStatus } from '../core/selectors';
import {
  OK,
  TOOL_PENDING,
  RUNNING_HALF,
  presentedStateGlyph,
  presentedStatusToken,
  isWholeLinePresented,
} from './glyphs';
import { clipCells, displayWidth, sanitizeForDisplay } from './clipText';

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
 * Rendered terminal-row count of ONE ToolCallCard: the component is a single `<Box>`
 * row of inline `<Text>` (glyph + name + args + one-line tail). Exported so the live-
 * window height estimator (src/ui/liveWindow.ts) reserves the card's REAL height from
 * the renderer itself — it cannot silently drift from the true card height (the ghost
 * wave-7 multi-line-card budget this replaces was exactly such a drift).
 */
export const TOOL_CARD_ROWS = 1;

/**
 * Char cap on the single-line result/error tail rendered inline on a settled call
 * line (wave-7 lane C: condensed one-line cards — the full result now lives in the
 * ctrl+o tool-detail overlay, not in a multi-line preview slot). Exported so the live-
 * window height estimator (src/ui/liveWindow.ts) can width-bound the card's tail cell
 * budget from the SAME cap the render clips to — never drifting from the real card.
 */
export const RESULT_TAIL_MAX_CHARS = 48;
/** One-line arg summary cap on the call line. Exported for the estimator's card-width
 *  bound (see {@link RESULT_TAIL_MAX_CHARS}) — the args are clipped to this many cells. */
export const ARGS_MAX_CHARS = 60;

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
  /**
   * Terminal columns (W5). When present, the WHOLE rendered call line is bound to
   * `columns - 1` DISPLAY CELLS at exactly one terminal row, using GroupToolRow's
   * head-priority fit: glyph + name and the short semantic suffixes (waiting / elapsed
   * / via) are reserved, the args are the compressible middle (clipped first), and the
   * result/error tail is clipped/dropped last. When ABSENT (unit-test / committed-
   * fallback path) the card keeps its char-cap behavior byte-for-byte — the width math
   * is gated behind `columns !== undefined && columns > 0`.
   */
  columns?: number;
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

/**
 * The status glyph for each presented state. Running uses an animated spinner instead.
 * done renders the unified ✓ (OK); queued stays ● (TOOL_PENDING); waiting/error/aborted/
 * declined delegate to the shared {@link presentedStateGlyph} seam.
 */
function glyphOf(p: PresentedStatus): string {
  switch (p) {
    case 'queued':
      return TOOL_PENDING; // ●
    case 'running':
      return RUNNING_HALF; // unused (spinner rendered); keeps the exhaustive mapping truthful
    case 'done':
      return OK; // ✓
    case 'waiting':
    case 'error':
    case 'aborted':
    case 'declined':
      return presentedStateGlyph(p);
  }
}

/** Collapse whitespace to single spaces, trim, and cap to `max` DISPLAY CELLS with an
 * ellipsis. Shared via {@link clipCells} with Message.firstLineClipped and
 * SubagentPanel.clip so the card, the status row, and the panel all measure width in
 * terminal cells (a CJK/emoji glyph is 2 cells) rather than UTF-16 code units — a
 * length-based clip let those overflow the one-row budget and could split a surrogate. */
function oneLine(value: string, max: number): string {
  // Sanitize BEFORE clipping: this is the card-local choke point every untrusted tail flows
  // through — result tails, tool-error first-lines, and serialized arg text (incl. file
  // previews surfaced through tool results) — so scrubbing escapes/bidi here defuses ANSI
  // injection and Trojan-Source spoofing for all of them at one point. clipCells stays a
  // pure width clip; sanitizeForDisplay's ASCII fast path keeps the common case allocation-free.
  return clipCells(sanitizeForDisplay(value), max);
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

/** First non-blank STRING value in an args object, or undefined. Unlike {@link primaryArgValue}
 *  this skips numbers/booleans — a bare `1`/`true` is meaningless without its key, so those fall
 *  through to the JSON fallback, but a lone string (a path / pattern / query / url) reads well on
 *  its own. The general condenser for any tool NOT in humanizeArgs's explicit list. */
function firstStringField(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  for (const v of Object.values(args as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

/**
 * Humanize a tool call's args into the ONE most meaningful field for the call
 * line: shell→command, write_file/edit_file/read_file→path, list_files→dir,
 * grep→pattern, subagent spawns (`Agent`/`Task`/`spawn_subagent`)→description, MCP
 * tools (`mcp__…`)→primary arg; any OTHER tool (e.g. claude-cli's PascalCase `Read`/`Glob`/
 * `Edit`/`LS`)→its first string arg (a path/pattern/query), so those render `Read(app.tsx)` /
 * `Glob(src/**)` instead of a raw `{"file_path":…}` blob; final fallback = one-line JSON (only
 * when no string arg exists). Always capped to a single truncated line. Exported for unit tests.
 */
export function humanizeArgs(name: string, args: unknown): string {
  const lower = name.toLowerCase();
  let raw: string | undefined;
  if (lower === 'run_shell' || lower === 'shell' || lower === 'bash') {
    raw = argField(args, 'command');
  } else if (lower === 'start_process') {
    raw = argField(args, 'command');
  } else if (lower === 'poll_process' || lower === 'write_process_stdin' || lower === 'terminate_process') {
    raw = argField(args, 'process_id');
  } else if (lower === 'write_file' || lower === 'edit_file' || lower === 'read_file') {
    raw = argField(args, 'path');
  } else if (lower === 'apply_patch' && typeof args === 'object' && args !== null) {
    const operations = (args as Record<string, unknown>).operations;
    if (Array.isArray(operations)) {
      const paths = operations
        .map((operation) => argField(operation, 'path'))
        .filter((value): value is string => value !== undefined);
      raw = paths.length === 0 ? 'invalid patch' : paths.join(', ');
    }
  } else if (lower === 'list_files' || lower === 'tree') {
    raw = argField(args, 'dir') ?? argField(args, 'path') ?? '.';
  } else if (lower === 'grep' || lower === 'glob_files') {
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
  // A tool with no explicit humanizer: prefer its first string arg (path/pattern/query) over a
  // raw JSON dump — this is what keeps claude-cli's PascalCase Read/Glob/Edit/LS off the raw-JSON
  // path. JSON only survives for args with no string field (e.g. `{a:1,b:2}`).
  if (raw === undefined) raw = firstStringField(args) ?? jsonOneLine(args);
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

/** A plain (non-array, non-null) object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True iff a condensed tail is really a raw-JSON fallback — the structured value never
 *  unwrapped to text (string / content-block / `{summary}`), so `toDisplay` serialized it. */
function isRawJsonTail(text: string, value: unknown): boolean {
  return (Array.isArray(value) || isPlainRecord(value)) && /^[[{]/.test(text);
}

/**
 * Humanize a `{ ok, skippedRealIo, … }`-style write result into a plain phrase — never the
 * raw object, and never the harness-internal `skippedRealIo` key verbatim. A settled card is
 * already a success (`presentation === 'result'`), so a bare object degrades to `ok`.
 */
function humanizeOkRecord(value: Record<string, unknown>): string {
  const parts: string[] = [];
  if ('ok' in value) parts.push(value.ok === false ? 'failed' : 'ok');
  if (value.skippedRealIo === true) parts.push('real io skipped');
  return parts.length > 0 ? parts.join(' · ') : 'ok';
}

/**
 * The condensed inline tail for a settled tool CARD (wave-8 R2): like {@link resultTail} but
 * per-tool humanized so a structured result NEVER renders as a raw JSON blob on screen (the
 * full structure stays one Ctrl+O away, where {@link toDisplay} keeps the raw shape). Strings,
 * content-block arrays, and `{summary}` results already condense to clean text via resultTail;
 * this only intercepts the shapes that would otherwise serialize — `list_files` → a file count,
 * `write_file`/`edit_file` → the humanized outcome, and any other array/object → a neutral
 * count (or nothing, letting the green glyph carry "done"). Exported for unit tests.
 */
export function humanizeResult(name: string, value: unknown): { text: string; hidden: number } {
  const lower = name.toLowerCase();
  if (lower === 'list_files' && Array.isArray(value)) {
    const n = value.length;
    return { text: n === 1 ? '1 file' : `${n} files`, hidden: 0 };
  }
  if (isPlainRecord(value) && typeof value.status === 'string' && typeof value.processId === 'string') {
    const chunks = Array.isArray(value.chunks) ? value.chunks.length : 0;
    return { text: oneLine(`${value.status}${chunks > 0 ? ` · ${chunks} output chunk${chunks === 1 ? '' : 's'}` : ''}`, RESULT_TAIL_MAX_CHARS), hidden: 0 };
  }
  if ((lower === 'write_file' || lower === 'edit_file' || lower === 'apply_patch') && isPlainRecord(value)) {
    return { text: oneLine(humanizeOkRecord(value), RESULT_TAIL_MAX_CHARS), hidden: 0 };
  }
  const tail = resultTail(value);
  if (isRawJsonTail(tail.text, value)) {
    // A structured result no humanizer claimed: surface a neutral count for a list, or
    // nothing for an object (the glyph already reads "done"). Raw JSON never reaches the card.
    const text = Array.isArray(value) ? (value.length === 1 ? '1 item' : `${value.length} items`) : '';
    return { text, hidden: 0 };
  }
  return tail;
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
  columns,
}: ToolCallCardProps): ReactElement {
  const d = depth ?? DEPTH;
  const presentation = presentedStatus(tool, { waitingOnPermission: waitingOnPermission === true });
  const running = presentation === 'running';
  const elapsedSeconds = useRunningElapsedSeconds(running, now ?? Date.now);

  const stateColor = token(presentedStatusToken(presentation), d);
  // error (red) / waiting + declined (amber) carry their meaning across the WHOLE call line;
  // an `aborted` cancel is NON-whole-line (name stays default text, glyph + args + tail dim)
  // and every other state keeps the name in default text with args dim (glyph carries color).
  const wholeLineColored = isWholeLinePresented(presentation);
  const nameColor = wholeLineColored ? stateColor : token('text', d);
  const argsColor = wholeLineColored ? stateColor : token('textDim', d);

  let argsStr = humanizeArgs(tool.name, tool.args) || oneLine(tool.argsText ?? '', ARGS_MAX_CHARS);

  // The short SEMANTIC suffixes, precomputed so the width fit reserves EXACTLY the strings the
  // JSX renders. waiting/elapsed are mutually exclusive (waiting only when gated, elapsed only
  // while running); the via tag rides a failing card too (the original hard-wrap-orphaning-`cli`
  // bug).
  const waitingSuffix = presentation === 'waiting' ? ' · waiting on permission' : '';
  const elapsedSuffix = running && elapsedSeconds !== null ? ` · ${Math.floor(elapsedSeconds)}s` : '';
  const viaLabel = viaCliLabel(providerKind);
  const viaSuffix = viaLabel !== undefined ? ` · ${viaLabel}` : '';

  // Condensed one-line tail: settled result → dim first-line summary (+overflow
  // marker); error → red first error line. Both live INLINE on the call line so a
  // tool call never exceeds one row in the transcript.
  //
  // EXCEPTION — a subagent spawn card (`spawn_subagent`/`Agent`/`Task`) carries NO inline
  // tail: the per-agent SubagentStatusRow rendered directly beneath it (Message.tsx) already
  // shows the honest outcome (`✓ … · done` / `✗ … · <error>`). Repeating it here duplicated
  // the whole error verbatim across two lines AND — with the trailing `· via <x> cli` suffix —
  // pushed the failed card past the terminal width, hard-wrapping mid-suffix and orphaning a
  // bare `cli` at column 0. Dropping the tail keeps the spawn card to one clean line and lets
  // the status row own the outcome text exactly once.
  const isSubagentSpawn = isSubagentToolName(tool.name);
  // `tailInner` is the tail text WITHOUT its leading `  ` separator (added at render time); its
  // colour is dim for a done result, stateColor for an error/aborted/declined first line.
  let tailInner = '';
  let tailColor = token('textDim', d);
  if (!isSubagentSpawn && presentation === 'done') {
    const { text, hidden } = humanizeResult(tool.name, tool.result);
    if (text.length > 0) {
      const overflow = hidden > 0 ? ` +${hidden} line${hidden === 1 ? '' : 's'}` : '';
      tailInner = `${text}${overflow}`;
      tailColor = token('textDim', d);
    }
  } else if (
    !isSubagentSpawn &&
    (presentation === 'error' || presentation === 'aborted' || presentation === 'declined')
  ) {
    // All three ex-`error` presenteds carry the first `error` line as their tail, rendered
    // in stateColor — RED for a genuine failure, dim for an aborted (`interrupted`) card, amber
    // for a declined (`denied`) one — so a user Esc-abort or a [d] deny never reads as a red ✗.
    tailInner = oneLine((tool.error ?? 'tool failed').split('\n')[0] ?? '', RESULT_TAIL_MAX_CHARS);
    tailColor = stateColor;
  }

  const indent = Math.max(0, Math.min(nestDepth ?? 0, MAX_NEST_DEPTH)) * 2;

  // W5 — head-priority cell-accurate fit (mirrors GroupToolRow): bound the WHOLE line to
  // `columns - 1` cells (1-col slack ⇒ exactly one terminal row). `content` is the budget AFTER
  // the glyph(1) + leading space(1); the name gets first claim, the short suffixes are reserved,
  // the args are squeezed to fit the tail, and only when args have hit 0 does the tail itself get
  // clipped in (or emptied). Gated behind a present, positive `columns` so the width-less
  // unit-test / committed-fallback path keeps today's char-cap output byte-for-byte.
  if (columns !== undefined && columns > 0) {
    const content = Math.max(0, columns - 1 - indent - 2);
    const reserve = displayWidth(waitingSuffix) + displayWidth(elapsedSuffix) + displayWidth(viaSuffix);
    const tailWidth = tailInner.length > 0 ? 2 + displayWidth(tailInner) : 0; // '  ' + inner
    const argsBudget = Math.max(0, content - reserve - displayWidth(tool.name) - 2 /* parens */ - tailWidth);
    argsStr = clipCells(argsStr, argsBudget);
    if (tailInner.length > 0) {
      const tailRoom = content - reserve - displayWidth(tool.name) - 2 - displayWidth(argsStr);
      if (2 + displayWidth(tailInner) > tailRoom) {
        const innerBudget = tailRoom - 2; // reserve the `  ` separator
        tailInner = innerBudget > 0 ? clipCells(tailInner, innerBudget) : '';
      }
    }
  }

  return (
    <Box marginLeft={indent}>
      {running ? (
        <Text color={stateColor}>
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={stateColor}>{glyphOf(presentation)}</Text>
      )}
      <Text color={nameColor}>{` ${tool.name}`}</Text>
      <Text color={argsColor}>{`(${argsStr})`}</Text>
      {waitingSuffix.length > 0 ? (
        <Text color={stateColor}>{waitingSuffix}</Text>
      ) : null}
      {elapsedSuffix.length > 0 ? (
        <Text color={token('textDim', d)}>{elapsedSuffix}</Text>
      ) : null}
      {tailInner.length > 0 ? <Text color={tailColor}>{`  ${tailInner}`}</Text> : null}
      {viaLabel !== undefined ? (
        <Text color={token('textDim', d)}>
          {viaSuffix}
        </Text>
      ) : null}
    </Box>
  );
}
