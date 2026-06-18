import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Block, Msg } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { ToolCallCard } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
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

function renderBlock(msg: Msg, block: Block, d: ColorDepth): ReactElement {
  switch (block.kind) {
    case 'text':
      return (
        <Text key={block.id} color={token(roleToken(msg.role), d)}>
          {block.text}
        </Text>
      );
    case 'tool': {
      const tool = msg.toolSnapshot?.[block.toolCallId];
      return tool !== undefined ? (
        <ToolCallCard key={block.id} tool={tool} depth={d} />
      ) : (
        <Text key={block.id} color={token('textDim', d)}>
          [tool {block.toolCallId}]
        </Text>
      );
    }
  }
}

export function Message({ msg, depth }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Text color={token(roleToken(msg.role), d)} bold>
        {roleLabel(msg.role)}
      </Text>
      {msg.reasoning !== undefined && msg.reasoning.length > 0 ? (
        <Text color={token('textDim', d)} dimColor>
          thinking: {msg.reasoning}
        </Text>
      ) : null}
      {msg.blocks.map((block) => renderBlock(msg, block, d))}
    </Box>
  );
}
