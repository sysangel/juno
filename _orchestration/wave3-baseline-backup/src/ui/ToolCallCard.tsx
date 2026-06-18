import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface ToolCallCardProps {
  tool: ToolState;
  depth?: ColorDepth;
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

/** Narrow `unknown` (tool.result / tool.args) to a compact one-line string. */
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

export function ToolCallCard({ tool, depth }: ToolCallCardProps): ReactElement {
  const d = depth ?? DEPTH;
  const color = token(statusToken(tool.status), d);

  const summary =
    tool.status === 'error'
      ? tool.error ?? 'tool failed'
      : tool.status === 'result'
        ? compact(tool.result)
        : compact(tool.argsText ?? tool.args);

  return (
    <Box borderStyle="round" borderColor={color} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box gap={1}>
        <Text color={color}>{statusGlyph(tool.status)}</Text>
        <Text color={token('text', d)} bold>
          {tool.name}
        </Text>
        <Text color={token('textDim', d)}>[{tool.status}]</Text>
      </Box>
      {summary.length > 0 ? <Text color={token('textDim', d)}>{summary}</Text> : null}
    </Box>
  );
}
