import type { Block, ToolState } from '../core/reducer';
import { isSubagentDescendant, isSubagentToolName } from '../core/selectors';
import { sanitizeForDisplay } from './clipText';
import { presentTool } from './toolPresentation';

/** Semantic work units used by the transcript. Read + search intentionally share
 * one family: users experience both as exploration, regardless of backend tool. */
export type WorkFamily = 'explore' | 'run' | 'edit' | 'mcp' | 'other';

export interface WorkMember {
  readonly blockId: string;
  readonly toolCallId: string;
  readonly family: WorkFamily;
  readonly groupKey: string;
}

export interface WorkBlock {
  readonly anchorBlockId: string;
  readonly family: WorkFamily;
  readonly groupKey: string;
  readonly members: readonly WorkMember[];
}

export interface WorkBlockPlan {
  readonly blockByAnchor: ReadonlyMap<string, WorkBlock>;
  readonly consumed: ReadonlySet<string>;
  readonly blockByMember: ReadonlyMap<string, WorkBlock>;
}

export const WORK_BLOCK_MAX_VISIBLE_MEMBERS = 6;
export const WORK_BLOCK_MAX_COMMAND_LINES = 3;
export const WORK_BLOCK_MAX_RESULT_LINES = 3;
export const WORK_BLOCK_HEADER_ROWS = 1;

function mcpServer(name: string): string {
  const parts = name.split('__').filter(Boolean);
  return parts.length >= 2 ? parts.at(-2)!.toLowerCase() : 'service';
}

/** Collapse low-level presentation families into the verbs users reason about. */
export function workFamily(tool: ToolState): { family: WorkFamily; groupKey: string } {
  const semantic = presentTool(tool);
  switch (semantic.family) {
    case 'read':
    case 'search':
      return { family: 'explore', groupKey: 'explore' };
    case 'process':
    case 'test':
    case 'build':
      return { family: 'run', groupKey: 'run' };
    case 'write':
      return { family: 'edit', groupKey: 'edit' };
    case 'mcp': {
      const server = mcpServer(tool.name);
      return { family: 'mcp', groupKey: `mcp:${server}` };
    }
    case 'other':
    case 'agent':
      return { family: 'other', groupKey: `other:${tool.name.toLowerCase()}` };
  }
}

/**
 * Plan maximal adjacent runs of top-level plain tools with the same semantic
 * family. Text, notices, agents, descendants, and unknown tools are boundaries.
 * Unlike the old concurrency-only grouping, a single eligible call is also a
 * block: the visual grammar is consistent whether work took one call or six.
 */
export function planWorkBlocks(
  blocks: readonly Block[],
  lookup: (toolCallId: string) => ToolState | undefined,
): WorkBlockPlan {
  const blockByAnchor = new Map<string, WorkBlock>();
  const consumed = new Set<string>();
  const blockByMember = new Map<string, WorkBlock>();
  let run: WorkMember[] = [];

  const flush = (): void => {
    const anchor = run[0];
    if (anchor === undefined) return;
    const block: WorkBlock = {
      anchorBlockId: anchor.blockId,
      family: anchor.family,
      groupKey: anchor.groupKey,
      members: run.slice(),
    };
    blockByAnchor.set(anchor.blockId, block);
    for (const member of run) blockByMember.set(member.blockId, block);
    for (let i = 1; i < run.length; i += 1) consumed.add(run[i]!.blockId);
    run = [];
  };

  for (const block of blocks) {
    if (block.kind !== 'tool') {
      flush();
      continue;
    }
    const tool = lookup(block.toolCallId);
    const eligible = tool !== undefined
      && tool.parentToolUseId === undefined
      && !isSubagentToolName(tool.name)
      && !isSubagentDescendant(lookup, block.toolCallId);
    if (!eligible) {
      flush();
      continue;
    }
    const classified = workFamily(tool);
    const member: WorkMember = {
      blockId: block.id,
      toolCallId: block.toolCallId,
      ...classified,
    };
    if (run.length > 0 && run[0]!.groupKey !== member.groupKey) flush();
    run.push(member);
  }
  flush();
  return { blockByAnchor, consumed, blockByMember };
}

/** Verb-headed block label. Settled labels are deliberately past tense so a
 * neutral bullet still communicates completion without a green check on every row. */
export function workBlockLabel(
  family: WorkFamily,
  entries: readonly ToolState[],
  settled: boolean,
): string {
  if (family === 'explore') return settled ? 'Explored' : 'Exploring';
  if (family === 'edit') return settled ? 'Edited' : 'Editing';
  // Shell/process/test/build calls intentionally share one stable verb. The
  // command and evidence rows say what ran; changing the header between Ran,
  // Tested, and Checked would fragment one sequential command block.
  if (family === 'run') return settled ? 'Ran' : 'Running';
  if (family === 'mcp') {
    const server = entries[0] === undefined ? 'service' : mcpServer(entries[0].name);
    const names = entries.map((tool) => tool.name.toLowerCase());
    if (names.every((name) => name.includes('recall') || name.includes('read') || name.includes('get_episode'))) {
      return `${settled ? 'Recalled' : 'Recalling'} ${server}`;
    }
    if (names.every((name) => name.includes('remember') || name.includes('write'))) {
      return `${settled ? 'Remembered' : 'Remembering'} in ${server}`;
    }
    return `${settled ? 'Called' : 'Calling'} ${server}`;
  }
  const name = entries[0]?.name ?? 'tool';
  return `${settled ? 'Used' : 'Using'} ${name}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Full command text for shell-shaped tools, presentation-only and never executed. */
export function commandText(tool: ToolState): string | undefined {
  const args = record(tool.args);
  const value = args?.command ?? args?.cmd;
  return typeof value === 'string' && value.trim().length > 0
    ? sanitizeForDisplay(value.trim())
    : undefined;
}

export interface BoundedLines {
  readonly lines: readonly string[];
  readonly hidden: number;
}

function boundedNonBlankLines(text: string, maxLines: number): BoundedLines {
  const all = sanitizeForDisplay(text)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return { lines: all.slice(0, maxLines), hidden: Math.max(0, all.length - maxLines) };
}

/** At most three command rows; the full command remains in Ctrl+O detail. */
export function commandLines(tool: ToolState): BoundedLines {
  const command = commandText(tool);
  return command === undefined
    ? { lines: [], hidden: 0 }
    : boundedNonBlankLines(command, WORK_BLOCK_MAX_COMMAND_LINES);
}

/** Extract textual process output without serializing arbitrary structured results
 * into the transcript. Full structured data remains available in Ctrl+O. */
function textualResult(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const object = record(value);
  for (const key of ['output', 'stdout', 'text'] as const) {
    const found = object?.[key];
    if (typeof found === 'string') return found;
  }
  const chunks = object?.chunks;
  if (Array.isArray(chunks)) {
    const text = chunks.flatMap((chunk) => {
      const found = record(chunk)?.text;
      return typeof found === 'string' ? [found] : [];
    }).join('');
    if (text.length > 0) return text;
  }
  return undefined;
}

/** A small output preview for the newest settled command in a Run block. */
export function resultPreview(tool: ToolState): BoundedLines {
  if (tool.status !== 'result') return { lines: [], hidden: 0 };
  const text = textualResult(tool.result);
  return text === undefined
    ? { lines: [], hidden: 0 }
    : boundedNonBlankLines(text, WORK_BLOCK_MAX_RESULT_LINES);
}

export interface WorkBlockLayout {
  readonly shown: readonly ToolState[];
  readonly earlier: number;
  readonly commandRows: readonly number[];
  readonly preview: BoundedLines;
}

/** One shared, bounded layout used by both JSX and the live-height estimator. */
export function workBlockLayout(entries: readonly ToolState[]): WorkBlockLayout {
  const earlier = Math.max(0, entries.length - WORK_BLOCK_MAX_VISIBLE_MEMBERS);
  const shown = entries.slice(earlier);
  const commandRows = shown.map((tool) => {
    const command = commandLines(tool);
    return command.lines.length + (command.hidden > 0 ? 1 : 0);
  });
  const last = shown.at(-1);
  const preview = last !== undefined && workFamily(last).family === 'run'
    ? resultPreview(last)
    : { lines: [], hidden: 0 };
  return { shown, earlier, commandRows, preview };
}

export function workBlockRows(entries: readonly ToolState[]): number {
  const layout = workBlockLayout(entries);
  const memberRows = layout.shown.reduce((total, _tool, index) => {
    const commands = layout.commandRows[index] ?? 0;
    return total + Math.max(1, commands);
  }, 0);
  const previewRows = layout.preview.lines.length + (layout.preview.hidden > 0 ? 1 : 0);
  return WORK_BLOCK_HEADER_ROWS + (layout.earlier > 0 ? 1 : 0) + memberRows + previewRows;
}
