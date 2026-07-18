// src/ui/ToolDetailOverlay.tsx
// Wave-7 lane C: the ctrl+o tool-detail overlay. Two views behind one overlay:
//
//  - LIST: every tool call of this session, most-recent-first, one condensed row
//    each (glyph + name + arg summary + result tail). up/down move the highlight;
//    enter opens the highlighted call; esc closes the overlay.
//  - DETAIL: the FULL args + FULL result of one call, hard-wrapped to width and
//    scrollable within the panel (up/down scroll); esc backs out to the list.
//
// The transcript cards are deliberately condensed to one line each (ToolCallCard),
// so this overlay is where the full detail — which the reducer now retains in
// `state.tools` (capped at MAX_STORED_RESULT_BYTES) — becomes readable again.
//
// Follows McpPanel's read-only bordered-box pattern; key routing lives in
// useKeybinds' `tool-detail` branch, and the composer is focus-gated off while it
// is open (app.tsx), exactly like the other overlays.
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { humanizeArgs, resultTail, toDisplay } from './ToolCallCard';
import { TOOL_DONE, TOOL_PENDING, RUNNING_HALF, FAIL } from './glyphs';
import { clipCells, wrapCells } from './clipText';
import { buildDiff, diffMarker, type DiffLine, type DiffLineKind } from './diff';

const DEPTH: ColorDepth = detectColorDepth();

/** One entry in the session's tool-call list: its call id + accumulated state. */
export interface ToolDetailEntry {
  readonly id: string;
  readonly tool: ToolState;
}

export interface ToolDetailOverlayProps {
  /** Which view is active. */
  readonly view: 'list' | 'detail';
  /** Session tool calls, most-recent-first (as the app builds them). */
  readonly entries: ReadonlyArray<ToolDetailEntry>;
  /** Highlighted row index (list view) / which entry is open (detail view). */
  readonly selectedIndex: number;
  /** Scroll offset in wrapped lines (detail view). Clamped by the app. */
  readonly scroll: number;
  /** Terminal rows — drives how many content lines the panel shows. */
  readonly rows: number;
  /** Terminal columns — drives detail-line hard-wrapping. */
  readonly width: number;
  readonly depth?: ColorDepth;
}

/**
 * How many content lines the panel body shows for a given terminal height. Bounded
 * so a tiny terminal still shows a few rows and a huge one does not fill the whole
 * screen (leaving the transcript visible above). Shared by the component and the
 * app's scroll clamp so the two never disagree about the viewport.
 */
export function toolDetailViewportRows(rows: number): number {
  return Math.max(4, Math.min(rows - 8, 40));
}

/** Status → glyph for the static list (no spinner here — the list never animates). */
function listGlyph(status: ToolState['status']): string {
  switch (status) {
    case 'error':
      return FAIL;
    case 'running':
      return RUNNING_HALF;
    case 'pending':
      return TOOL_PENDING;
    case 'result':
      return TOOL_DONE;
  }
}

/** Status → colour token. */
function statusToken(status: ToolState['status']): FlatTokenName {
  switch (status) {
    case 'error':
      return 'toolError';
    case 'running':
      return 'toolRunning';
    case 'pending':
      return 'toolPending';
    case 'result':
      return 'toolResult';
  }
}

/** A tone bucket for a detail-body line — drives its render color. Diff lines carry
 *  add/remove/meta; plain header/label/result lines stay 'text'. The tone (never a
 *  leading char) carries the color, so a result line that happens to start with '+'
 *  is NOT mistaken for a diff add. Mirrors PermissionPrompt's diff tokens. */
export type ToolDetailTone = 'text' | 'add' | 'remove' | 'meta';

/** One hard-wrapped detail-body row: its text plus the tone that colors it. */
export interface ToolDetailLine {
  readonly text: string;
  readonly tone: ToolDetailTone;
}

/** Diff-line kind → detail tone. add/remove keep their own bucket; context and meta
 *  both render dim (matching PermissionPrompt's diffToken, where both map to textDim). */
function diffKindToTone(kind: DiffLineKind): ToolDetailTone {
  switch (kind) {
    case 'add':
      return 'add';
    case 'remove':
      return 'remove';
    case 'context':
    case 'meta':
      return 'meta';
  }
}

/**
 * Render a buildDiff result as marker-prefixed detail lines: '@ …' meta, '- …' remove,
 * '+ …' add, '  …' context — the SAME single-char gutter PermissionPrompt renders, but
 * baked into the text so the tone (not a leading char) carries the color. `write_file`
 * is an all-adds "new content" view whose add lines carry TRUTHFUL new-file line numbers
 * 1..N in a left gutter; `edit_file` gets none — buildDiff does no I/O, so its numbers
 * would be snippet-relative and would misreport the file's real line positions.
 */
function renderDiffLines(name: string, diff: DiffLine[]): ToolDetailLine[] {
  const numbered = name === 'write_file';
  const addTotal = numbered ? diff.reduce((n, d) => (d.kind === 'add' ? n + 1 : n), 0) : 0;
  const gutter = String(addTotal).length;
  let lineNo = 0;
  return diff.map((d): ToolDetailLine => {
    const marker = diffMarker(d.kind);
    const tone = diffKindToTone(d.kind);
    if (numbered && d.kind === 'add') {
      lineNo += 1;
      return { text: `${String(lineNo).padStart(gutter)} ${marker} ${d.text}`, tone };
    }
    return { text: `${marker} ${d.text}`, tone };
  });
}

/**
 * Build the full, hard-wrapped detail body for one tool call: name/status header,
 * the args (a colorized old→new DIFF for edit_file/write_file, else the FULL
 * pretty-printed JSON), then the FULL result (or error). Exported so the app can
 * measure line count for the scroll clamp without re-implementing the layout.
 *
 * Each returned row carries a tone so DetailView colors diff lines with the same
 * tokens PermissionPrompt uses; header/label/result rows stay tone 'text'. Tone is
 * assigned per LOGICAL line and preserved across every hard-wrapped continuation row.
 */
export function buildToolDetailLines(tool: ToolState, width: number): ToolDetailLine[] {
  const max = Math.max(8, width - 4);
  const src: ToolDetailLine[] = [];
  const plain = (text: string): ToolDetailLine => ({ text, tone: 'text' });

  src.push(plain(`${tool.name}  ·  ${tool.status}`));
  src.push(plain(''));

  // For a file mutation, replace the 'args:' + raw-JSON segment with a readable diff
  // (edit_file: old→new with context; write_file: all-adds new content). buildDiff is
  // no-I/O and returns null on malformed args — then fall back to the pretty JSON.
  const diff =
    tool.name === 'edit_file' || tool.name === 'write_file'
      ? buildDiff(tool.name, tool.args)
      : null;
  if (diff !== null) {
    src.push(...renderDiffLines(tool.name, diff));
  } else {
    src.push(plain('args:'));
    src.push(plain(prettyArgs(tool.args)));
  }
  src.push(plain(''));

  if (tool.status === 'error') {
    src.push(plain('error:'));
    src.push(plain(tool.error !== undefined && tool.error.length > 0 ? tool.error : '(no error text)'));
  } else {
    src.push(plain('result:'));
    const body = toDisplay(tool.result);
    src.push(plain(body.length > 0 ? body : '(empty)'));
  }
  // Split embedded newlines first, then hard-wrap each to width in DISPLAY CELLS
  // (wrapCells never splits a wide glyph / surrogate pair — a UTF-16 slice would),
  // carrying the source line's tone onto every wrapped continuation row.
  return src.flatMap((line) =>
    line.text
      .split('\n')
      .flatMap((seg) => wrapCells(seg, max))
      .map((text): ToolDetailLine => ({ text, tone: line.tone })),
  );
}

/** Pretty-print args as indented JSON; fall back to a safe string on any throw. */
function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return '(none)';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return '[unserializable]';
  }
}

/** One-line condensed summary of a tool call for a list row. */
function rowSummary(tool: ToolState): string {
  const args = humanizeArgs(tool.name, tool.args);
  const head = `${tool.name}(${args})`;
  if (tool.status === 'error') {
    const first = (tool.error ?? 'failed').split('\n')[0] ?? '';
    return `${head}  ${first}`;
  }
  const { text } = resultTail(tool.result);
  return text.length > 0 ? `${head}  ${text}` : head;
}

function ListView(props: ToolDetailOverlayProps, d: ColorDepth): ReactElement {
  const dim = token('textDim', d);
  if (props.entries.length === 0) {
    return (
      <Text color={dim} dimColor>
        No tool calls yet.
      </Text>
    );
  }

  const viewport = toolDetailViewportRows(props.rows);
  const total = props.entries.length;
  // Window the list so the highlight stays visible, anchored within [0, total-viewport].
  const half = Math.floor(viewport / 2);
  const start = Math.max(0, Math.min(props.selectedIndex - half, Math.max(0, total - viewport)));
  const end = Math.min(total, start + viewport);
  const shown = props.entries.slice(start, end);

  return (
    <Box flexDirection="column">
      {start > 0 ? <Text color={dim} dimColor>{`  ↑ ${start} more`}</Text> : null}
      {shown.map((entry, i) => {
        const index = start + i;
        const selected = index === props.selectedIndex;
        const g = listGlyph(entry.tool.status);
        return (
          <Box key={entry.id}>
            <Text color={selected ? token('text', d) : dim}>{selected ? '▸ ' : '  '}</Text>
            <Text color={token(statusToken(entry.tool.status), d)}>{g}</Text>
            <Text color={selected ? token('text', d) : dim} bold={selected}>
              {` ${clipCells(rowSummary(entry.tool), Math.max(8, props.width - 8))}`}
            </Text>
          </Box>
        );
      })}
      {end < total ? <Text color={dim} dimColor>{`  ↓ ${total - end} more`}</Text> : null}
    </Box>
  );
}

/** Detail-body tone → theme token. Mirrors PermissionPrompt's diff coloring
 *  (add=green, remove=red, meta=dim) and leaves plain text in the primary fg. */
function detailToneToken(tone: ToolDetailTone): FlatTokenName {
  switch (tone) {
    case 'add':
      return 'success';
    case 'remove':
      return 'error';
    case 'meta':
      return 'textDim';
    case 'text':
      return 'text';
  }
}

function DetailView(props: ToolDetailOverlayProps, d: ColorDepth): ReactElement {
  const dim = token('textDim', d);
  const entry = props.entries[props.selectedIndex];
  if (entry === undefined) {
    return (
      <Text color={dim} dimColor>
        (no selection)
      </Text>
    );
  }
  const lines = buildToolDetailLines(entry.tool, props.width);
  const viewport = toolDetailViewportRows(props.rows);
  const maxScroll = Math.max(0, lines.length - viewport);
  const scroll = Math.max(0, Math.min(props.scroll, maxScroll));
  const shown = lines.slice(scroll, scroll + viewport);

  return (
    <Box flexDirection="column">
      {scroll > 0 ? <Text color={dim} dimColor>{`  ↑ ${scroll} more`}</Text> : null}
      {shown.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <Text key={i} color={token(detailToneToken(line.tone), d)}>
          {line.text.length > 0 ? line.text : ' '}
        </Text>
      ))}
      {scroll < maxScroll ? (
        <Text color={dim} dimColor>{`  ↓ ${maxScroll - scroll} more`}</Text>
      ) : null}
    </Box>
  );
}

export function ToolDetailOverlay(props: ToolDetailOverlayProps): ReactElement {
  const d = props.depth ?? DEPTH;
  const border = token('border', d);
  const dim = token('textDim', d);
  const inDetail = props.view === 'detail' && props.entries.length > 0;
  const title = inDetail
    ? `tool detail  (${props.selectedIndex + 1}/${props.entries.length})`
    : `tool calls  ·  ${props.entries.length}`;
  const hint = inDetail ? '↑↓ scroll · esc back' : '↑↓ move · enter open · esc close';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingLeft={1} paddingRight={1}>
      <Text color={dim}>{title}</Text>
      {inDetail ? DetailView(props, d) : ListView(props, d)}
      <Text color={dim} dimColor>
        {hint}
      </Text>
    </Box>
  );
}
