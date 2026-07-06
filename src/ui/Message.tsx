import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Block, Msg, ToolState } from '../core/reducer';
import { collapse, collapseIndicator } from './collapse';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { ToolCallCard } from './ToolCallCard';
import { MessageSeparator } from './MessageSeparator';

const DEPTH: ColorDepth = detectColorDepth();

/** Extended-thinking is collapsed-by-default (reducer contract) to a short preview. */
const THINKING_MAX_LINES = 4;
const THINKING_MAX_CHARS = 500;

/** Render `msg.reasoning` dim + collapsed to a first-N-lines preview, or null. */
function renderReasoning(reasoning: string | undefined, d: ColorDepth): ReactElement | null {
  if (reasoning === undefined || reasoning.length === 0) return null;
  const c = collapse(reasoning, { maxLines: THINKING_MAX_LINES, maxChars: THINKING_MAX_CHARS });
  const indicator = collapseIndicator(c);
  return (
    <Box flexDirection="column">
      <Text color={token('textDim', d)} dimColor>
        thinking: {c.text}
      </Text>
      {indicator.length > 0 ? (
        <Text color={token('textDim', d)} dimColor>
          {indicator}
        </Text>
      ) : null}
    </Box>
  );
}

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
  separated?: boolean;
  /**
   * LIVE tools map (reducer `state.tools`) for the in-flight streaming message,
   * whose tool blocks have no frozen `toolSnapshot` yet (that is set only at
   * commit). Lookup order is snapshot-first, so committed <Static> messages
   * NEVER read the live map (the frozen-snapshot contract is preserved).
   */
  tools?: Record<string, ToolState>;
}

/** Role -> tint token. Exhaustive over Role ('tool' tinted dim/neutral). */
function roleToken(role: Msg['role']): FlatTokenName {
  switch (role) {
    case 'user':
      return 'roleUser';
    case 'assistant':
      return 'roleAssistant';
    case 'system':
      return 'roleSystem';
    case 'tool':
      return 'textDim';
  }
}

function roleLabel(role: Msg['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
  }
}

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/** Snapshot-first tool lookup: frozen `toolSnapshot` (committed), else the LIVE
 * `tools` map (streaming message — no snapshot until commit). */
function lookupTool(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  toolCallId: string,
): ToolState | undefined {
  return msg.toolSnapshot?.[toolCallId] ?? tools?.[toolCallId];
}

/** Render a single tool block as a card (or a dim fallback if the state lacks it). */
function renderToolBlock(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  block: ToolBlock,
  d: ColorDepth,
  nested = false,
): ReactElement {
  const tool = lookupTool(msg, tools, block.toolCallId);
  return tool !== undefined ? (
    <ToolCallCard key={block.id} tool={tool} depth={d} nested={nested} />
  ) : (
    <Text key={block.id} color={token('textDim', d)}>
      [tool {block.toolCallId}]
    </Text>
  );
}

/**
 * Render `msg.blocks` with claude-cli subagent grouping: a top-level tool card
 * is followed by its child cards (those whose `ToolState.parentToolUseId` equals
 * the parent's `toolCallId`), INDENTED via `<ToolCallCard nested />`. Text blocks
 * render inline in order. A child whose parent tool block is unknown (orphan)
 * falls back to flat top-level rendering — never drop a card. Order- and
 * key-stable (React keys = `block.id`). A parent with zero children renders
 * exactly as before (no regression for non-subagent turns). PURE presentational.
 */
function renderBlocks(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  d: ColorDepth,
): ReactElement[] {
  // The set of toolCallIds that have a tool block in THIS message (so we can tell
  // a real parent from an orphan reference).
  const toolBlockIds = new Set<string>();
  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      toolBlockIds.add(block.toolCallId);
    }
  }

  // parent toolCallId -> its child tool blocks, in stream order.
  const childBlocksByParent = new Map<string, ToolBlock[]>();
  for (const block of msg.blocks) {
    if (block.kind !== 'tool') continue;
    const parentToolUseId = lookupTool(msg, tools, block.toolCallId)?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      const children = childBlocksByParent.get(parentToolUseId) ?? [];
      children.push(block);
      childBlocksByParent.set(parentToolUseId, children);
    }
  }

  const rendered: ReactElement[] = [];
  for (const block of msg.blocks) {
    if (block.kind === 'text') {
      rendered.push(
        <Text key={block.id} color={token(roleToken(msg.role), d)}>
          {block.text}
        </Text>,
      );
      continue;
    }
    // A child whose parent exists in this message is rendered under that parent;
    // skip it here. (Orphans — parent not present — fall through to flat render.)
    const parentToolUseId = lookupTool(msg, tools, block.toolCallId)?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      continue;
    }
    rendered.push(renderToolBlock(msg, tools, block, d));
    for (const childBlock of childBlocksByParent.get(block.toolCallId) ?? []) {
      rendered.push(renderToolBlock(msg, tools, childBlock, d, true));
    }
  }
  return rendered;
}

export function Message({ msg, depth, separated, tools }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      {separated === true ? <MessageSeparator depth={d} /> : null}
      <Text color={token(roleToken(msg.role), d)} bold>
        {roleLabel(msg.role)}
      </Text>
      {renderReasoning(msg.reasoning, d)}
      {renderBlocks(msg, tools, d)}
    </Box>
  );
}
