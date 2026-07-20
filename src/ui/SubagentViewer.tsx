import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import type { SubagentEntry } from '../core/selectors';
import { ToolCallCard } from './ToolCallCard';
import { clipCells } from './clipText';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { providerKindOf, viaCliLabel } from './providerKind';

const DEPTH = detectColorDepth();

export interface SubagentViewerProps {
  entry: SubagentEntry | undefined;
  tools: Record<string, ToolState>;
  rows: number;
  width: number;
  scroll: number;
  depth?: ColorDepth;
  checkpoint?: { toolName: string; risk: string; sanitizedArgs: unknown };
}

/** Cycle-safe ancestry test over the live-wins recorder map. */
export function isAgentDescendant(tools: Record<string, ToolState>, id: string, agentId: string): boolean {
  const seen = new Set<string>();
  let parent = tools[id]?.parentToolUseId;
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === agentId) return true;
    seen.add(parent);
    parent = tools[parent]?.parentToolUseId;
  }
  return false;
}

export function agentToolEntries(tools: Record<string, ToolState>, agentId: string): Array<[string, ToolState]> {
  return Object.entries(tools).filter(([id]) => isAgentDescendant(tools, id, agentId));
}

export function subagentViewerViewportRows(rows: number): number {
  return Math.max(3, Math.min(30, rows - 9));
}

export function SubagentViewer(props: SubagentViewerProps): ReactElement {
  const d = props.depth ?? DEPTH;
  const dim = token('textDim', d);
  const entry = props.entry;
  const children = entry === undefined ? [] : agentToolEntries(props.tools, entry.id);
  const viewport = subagentViewerViewportRows(props.rows);
  const maxScroll = Math.max(0, children.length - viewport);
  const scroll = Math.min(Math.max(props.scroll, 0), maxScroll);
  const shown = children.slice(scroll, scroll + viewport);
  const source = entry === undefined
    ? ''
    : [entry.model, viaCliLabel(providerKindOf(entry.provider))].filter(Boolean).join(' · ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', d)} paddingLeft={1} paddingRight={1}>
      <Text color={token('accent', d)}>{clipCells(entry?.description ?? 'agent unavailable', Math.max(8, props.width - 4))}</Text>
      {entry !== undefined ? <Text color={dim}>{clipCells(`${entry.status}${source ? ` · ${source}` : ''}`, Math.max(8, props.width - 4))}</Text> : null}
      {props.checkpoint !== undefined ? (
        <Box flexDirection="column">
          <Text color={token('warning', d)}>{clipCells(`Needs approval: ${props.checkpoint.toolName} (${props.checkpoint.risk})`, Math.max(8, props.width - 4))}</Text>
          <Text color={dim}>{clipCells(JSON.stringify(props.checkpoint.sanitizedArgs), Math.max(8, props.width - 4))}</Text>
          <Text color={dim}>g grant once · d deny</Text>
        </Box>
      ) : null}
      {scroll > 0 ? <Text color={dim}>{`↑ ${scroll} earlier`}</Text> : null}
      {shown.length === 0 ? <Text color={dim}>No tool activity recorded.</Text> : shown.map(([id, tool]) => (
        <ToolCallCard key={id} tool={tool} columns={Math.max(8, props.width - 4)} />
      ))}
      {scroll < maxScroll ? <Text color={dim}>{`↓ ${maxScroll - scroll} more`}</Text> : null}
      <Text color={dim}>{clipCells('↑↓ scroll · m message · x cancel · esc back', Math.max(8, props.width - 4))}</Text>
    </Box>
  );
}
