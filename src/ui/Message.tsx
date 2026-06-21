import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Block, Msg } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { ToolCallCard } from './ToolCallCard';
import { MessageSeparator } from './MessageSeparator';

const DEPTH: ColorDepth = detectColorDepth();

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
  separated?: boolean;
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

/** Render a single tool block as a card (or a dim fallback if the snapshot lacks it). */
function renderToolBlock(msg: Msg, block: ToolBlock, d: ColorDepth, nested = false): ReactElement {
  const tool = msg.toolSnapshot?.[block.toolCallId];
  return tool !== undefined ? (
    <ToolCallCard key={block.id} tool={tool} depth={d} nested={nested} />
  ) : (
    <Text key={block.id} color={token('textDim', d)}>
      [tool {block.toolCallId}]
    </Text>
  );
}

function renderBlock(msg: Msg, block: Block, d: ColorDepth): ReactElement {
  switch (block.kind) {
    case 'text':
      return (
        <Text key={block.id} color={token(roleToken(msg.role), d)}>
          {block.text}
        </Text>
      );
    case 'tool':
      return renderToolBlock(msg, block, d);
  }
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
function renderBlocks(msg: Msg, d: ColorDepth): ReactElement[] {
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
    const parentToolUseId = msg.toolSnapshot?.[block.toolCallId]?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      const children = childBlocksByParent.get(parentToolUseId) ?? [];
      children.push(block);
      childBlocksByParent.set(parentToolUseId, children);
    }
  }

  const rendered: ReactElement[] = [];
  for (const block of msg.blocks) {
    if (block.kind === 'text') {
      rendered.push(renderBlock(msg, block, d));
      continue;
    }
    // A child whose parent exists in this message is rendered under that parent;
    // skip it here. (Orphans — parent not present — fall through to flat render.)
    const parentToolUseId = msg.toolSnapshot?.[block.toolCallId]?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      continue;
    }
    rendered.push(renderToolBlock(msg, block, d));
    for (const childBlock of childBlocksByParent.get(block.toolCallId) ?? []) {
      rendered.push(renderToolBlock(msg, childBlock, d, true));
    }
  }
  return rendered;
}

export function Message({ msg, depth, separated }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      {separated === true ? <MessageSeparator depth={d} /> : null}
      <Text color={token(roleToken(msg.role), d)} bold>
        {roleLabel(msg.role)}
      </Text>
      {msg.reasoning !== undefined && msg.reasoning.length > 0 ? (
        <Text color={token('textDim', d)} dimColor>
          thinking: {msg.reasoning}
        </Text>
      ) : null}
      {renderBlocks(msg, d)}
    </Box>
  );
}
