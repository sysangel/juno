import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { memo, type ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { presentedStatus, type PresentedStatus } from '../core/selectors';
import { clipCells, displayWidth, sanitizeForDisplay } from './clipText';
import { ABORTED, FAIL, TOOL_WAITING } from './glyphs';
import { humanizeArgs, humanizeResult } from './ToolCallCard';
import { toolProvenanceLabel, type ProviderKind } from './providerKind';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { presentTool } from './toolPresentation';
import {
  commandLines,
  workBlockLabel,
  workBlockLayout,
  type WorkFamily,
} from './workBlocks';

const DEPTH: ColorDepth = detectColorDepth();
const FALLBACK_WIDTH = 120;

export interface ToolBlockProps {
  readonly entries: readonly { readonly toolCallId: string; readonly tool: ToolState }[];
  readonly family: WorkFamily;
  readonly sealed?: boolean;
  readonly depth?: ColorDepth;
  readonly columns?: number;
  readonly providerKind?: ProviderKind;
  readonly pendingPermissionToolCallId?: string;
}

function aggregate(states: readonly PresentedStatus[]): PresentedStatus {
  if (states.includes('error')) return 'error';
  if (states.includes('running')) return 'running';
  if (states.includes('queued')) return 'queued';
  if (states.includes('waiting')) return 'waiting';
  if (states.includes('declined')) return 'declined';
  if (states.includes('aborted')) return 'aborted';
  return 'done';
}

function firstLine(value: string): string {
  return sanitizeForDisplay(value).split(/\r?\n/u).find((line) => line.trim().length > 0) ?? '';
}

function detail(tool: ToolState, status: PresentedStatus): string {
  if (status === 'waiting') return 'waiting on permission';
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'declined' || status === 'aborted') {
    return firstLine(tool.error ?? 'stopped');
  }
  const semantic = presentTool(tool);
  if (semantic.outcome.length > 0) return semantic.outcome;
  return semantic.family === 'other' || semantic.family === 'mcp'
    ? humanizeResult(tool.name, tool.result).text
    : '';
}

function memberHead(tool: ToolState, family: WorkFamily): string {
  if (family === 'mcp') {
    const action = tool.name.split('__').filter(Boolean).at(-1) ?? tool.name;
    const args = humanizeArgs(tool.name, tool.args);
    return `${action}${args.length > 0 ? `(${args})` : ''}`;
  }
  if (family === 'run') {
    const command = commandLines(tool);
    if (command.lines.length > 0) return command.lines[0]!;
  }
  const semantic = presentTool(tool);
  return semantic.family === 'other' || semantic.family === 'agent'
    ? `${tool.name}(${humanizeArgs(tool.name, tool.args)})`
    : semantic.activity;
}

function stateMarker(status: PresentedStatus): string {
  if (status === 'error') return `${FAIL} `;
  if (status === 'waiting' || status === 'declined') return `${TOOL_WAITING} `;
  if (status === 'aborted') return `${ABORTED} `;
  return '';
}

function ToolBlockView(props: ToolBlockProps): ReactElement | null {
  if (props.entries.length === 0) return null;
  const d = props.depth ?? DEPTH;
  const width = props.columns !== undefined && props.columns > 0 ? props.columns : FALLBACK_WIDTH;
  const states = props.entries.map((entry) => presentedStatus(entry.tool, {
    waitingOnPermission: props.pendingPermissionToolCallId === entry.toolCallId,
  }));
  const state = aggregate(states);
  const settled = states.every((value) => ['done', 'error', 'aborted', 'declined'].includes(value));
  const label = workBlockLabel(props.family, props.entries.map((entry) => entry.tool), settled);
  const provenance = new Set(props.entries
    .map((entry) => toolProvenanceLabel(props.providerKind, entry.tool.name))
    .filter((value): value is string => value !== undefined));
  const via = provenance.size === 1 ? [...provenance][0] : provenance.size > 1 ? 'via mixed tools' : undefined;
  const viaSuffix = via === undefined ? '' : ` · ${via}`;
  const active = states.filter((value) => value === 'running' || value === 'queued').length;
  const waiting = states.filter((value) => value === 'waiting').length;
  const liveParts = settled ? [] : [
    active > 0 ? `${active} active` : '',
    waiting > 0 ? `${waiting} waiting` : '',
  ].filter(Boolean);
  const liveSuffix = liveParts.length > 0 ? ` · ${liveParts.join(' · ')}` : '';
  // Keep one cell of right-edge slack, matching every member/preview row. Ink
  // can hard-wrap a row that lands exactly on the terminal edge; that extra row
  // would invalidate liveWindow's shared height and re-open repaint jitter.
  const headerText = clipCells(
    `${label}${liveSuffix}`,
    Math.max(0, width - 3 - displayWidth(viaSuffix)),
  );
  const headerColor = state === 'error' ? token('toolError', d)
    : state === 'waiting' || state === 'declined' ? token('warning', d)
      : state === 'running' || state === 'queued' ? token('toolRunning', d)
        : token('text', d);

  const layout = workBlockLayout(
    props.entries.map((entry) => entry.tool),
    props.sealed ?? true,
  );
  const entryByTool = new Map(props.entries.map((entry) => [entry.tool, entry] as const));

  return (
    <Box flexDirection="column">
      <Box>
        {state === 'running' || state === 'queued' ? (
          <Text color={headerColor}><Spinner type="dots" /></Text>
        ) : (
          <Text color={headerColor}>
            {state === 'error' ? FAIL
              : state === 'waiting' || state === 'declined' ? TOOL_WAITING
                : state === 'aborted' ? ABORTED
                  : '•'}
          </Text>
        )}
        <Text color={headerColor}>{` ${headerText}`}</Text>
        {viaSuffix.length > 0 ? <Text color={token('textDim', d)}>{viaSuffix}</Text> : null}
      </Box>
      {layout.earlier > 0 ? (
        <Text color={token('textDim', d)}>
          {clipCells(`  │ ↑ ${layout.earlier} earlier call${layout.earlier === 1 ? '' : 's'} (ctrl+o to view)`, width - 1)}
        </Text>
      ) : null}
      {layout.shown.flatMap((tool, index) => {
        const entry = entryByTool.get(tool);
        if (entry === undefined) return [];
        const status = presentedStatus(tool, {
          waitingOnPermission: props.pendingPermissionToolCallId === entry.toolCallId,
        });
        const commands = props.family === 'run' ? commandLines(tool) : { lines: [], hidden: 0 };
        const head = memberHead(tool, props.family);
        const outcome = detail(tool, status);
        const marker = stateMarker(status);
        const branch = index === 0 ? '  └ ' : '    ';
        const suffix = outcome.length > 0 ? ` · ${outcome}` : '';
        const color = status === 'error' ? token('toolError', d)
          : status === 'waiting' || status === 'declined' ? token('warning', d)
            : token('textDim', d);
        const rows: ReactElement[] = [
          <Text key={`${entry.toolCallId}:head`} color={color}>
            {clipCells(`${branch}${marker}${head}${suffix}`, width - 1)}
          </Text>,
        ];
        for (let i = 1; i < commands.lines.length; i += 1) {
          rows.push(
            <Text key={`${entry.toolCallId}:command:${i}`} color={token('textDim', d)}>
              {clipCells(`    │ ${commands.lines[i]}`, width - 1)}
            </Text>,
          );
        }
        if (commands.hidden > 0) {
          rows.push(
            <Text key={`${entry.toolCallId}:command:hidden`} color={token('textDim', d)}>
              {clipCells(`    │ … +${commands.hidden} command line${commands.hidden === 1 ? '' : 's'} (ctrl+o to view)`, width - 1)}
            </Text>,
          );
        }
        return rows;
      })}
      {layout.previewRows.map((row, index) => (
        <Text key={`preview:${index}`} color={token('textDim', d)}>
          {row.placeholder
            ? clipCells('    │', width - 1)
            : clipCells(`    ${row.terminal ? '└' : '│'} ${row.text}`, width - 1)}
        </Text>
      ))}
    </Box>
  );
}

export const ToolBlock = memo(ToolBlockView);
