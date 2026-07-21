import type { ToolState } from '../core/reducer';
import type { SubagentEntry } from '../core/selectors';
import type { BackgroundAgentSnapshot } from '../services/backgroundAgents';
import type { BackgroundOutputLine } from '../services/backgroundTaskStore';
import { humanizeArgs, humanizeResult } from './ToolCallCard';
import { providerKindOf, toolProvenanceLabel } from './providerKind';
import type {
  OrbitAgentVM,
  SelectedAgentVM,
  WorkspaceAgentStatus,
  WorkspaceStreamEventVM,
} from './workspace';

export interface WorkspaceViewModelInput {
  readonly snapshots: readonly BackgroundAgentSnapshot[];
  readonly subagents: readonly SubagentEntry[];
  readonly tools: Readonly<Record<string, ToolState>>;
  readonly selectedAgentId?: string;
  readonly now: number;
}

export interface WorkspaceViewModel {
  readonly agents: readonly OrbitAgentVM[];
  readonly selectedAgentId?: string;
  readonly selected?: SelectedAgentVM;
}

/** One ordering seam for both keyboard selection and rendered rail rows. */
export function workspaceAgentOrder(
  subagents: readonly SubagentEntry[],
  snapshots: readonly BackgroundAgentSnapshot[],
): string[] {
  const ids = subagents.map((entry) => entry.id);
  const known = new Set(ids);
  for (const snapshot of snapshots) {
    if (!known.has(snapshot.id)) ids.push(snapshot.id);
  }
  return ids;
}

function durationText(start: number, end: number): string {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function providerText(provider: string | undefined): string | undefined {
  if (provider === 'claude-cli') return 'claude cli';
  if (provider === 'codex-cli') return 'codex cli';
  return provider;
}

function toolStatus(status: ToolState['status'] | undefined): WorkspaceAgentStatus {
  if (status === 'running') return 'running';
  if (status === 'result') return 'done';
  if (status === 'error') return 'error';
  return 'queued';
}

function terminalLine(snapshot: BackgroundAgentSnapshot, now: number): string | undefined {
  if (snapshot.status === 'running' || snapshot.status === 'waiting') return undefined;
  const terminal = [...snapshot.timeline]
    .reverse()
    .find((line) => line.kind === 'lifecycle' && line.event !== 'spawn');
  const endedAt = terminal?.ts ?? now;
  const elapsed = durationText(snapshot.startedAt, endedAt);
  if (snapshot.status === 'done') return `done ${elapsed}`;
  if (snapshot.status === 'aborted') return `cancelled ${elapsed}`;
  return `failed ${elapsed}`;
}

function lineToEvent(
  snapshot: BackgroundAgentSnapshot,
  line: BackgroundOutputLine,
  index: number,
  tools: Readonly<Record<string, ToolState>>,
): WorkspaceStreamEventVM {
  const id = `${snapshot.id}:event:${index}`;
  switch (line.kind) {
    case 'text':
      return { kind: 'assistant', id, text: line.delta };
    case 'reasoning':
      return { kind: 'reasoning', id, text: line.delta };
    case 'steer':
      return { kind: 'steering', id, text: line.text };
    case 'checkpoint':
      return {
        kind: 'permission',
        id,
        toolName: line.toolName,
        ...(line.risk !== undefined ? { risk: line.risk } : {}),
        resolution:
          line.event === 'requested'
            ? 'pending'
            : line.decision === 'allow-once'
              ? 'granted'
              : 'denied',
      };
    case 'tool': {
      const tool = tools[line.toolCallId];
      const name = line.name ?? tool?.name ?? 'tool';
      const status = line.event === 'call' ? 'queued' : toolStatus(line.status);
      let detail = '';
      if (line.event === 'call') {
        detail = humanizeArgs(name, tool?.args);
      } else if (line.status === 'result') {
        detail = humanizeResult(name, tool?.result).text;
      } else if (line.status === 'error') {
        detail = tool?.error ?? '';
      }
      return {
        kind: 'tool',
        id,
        name,
        status,
        ...(detail.length > 0 ? { detail } : {}),
        ...(toolProvenanceLabel(providerKindOf(snapshot.provider), name) !== undefined
          ? { provenance: toolProvenanceLabel(providerKindOf(snapshot.provider), name) }
          : {}),
      };
    }
    case 'lifecycle':
      if (line.event === 'spawn') {
        return { kind: 'lifecycle', id, text: 'agent launched', tone: 'neutral' };
      }
      if (line.event === 'done') {
        return { kind: 'lifecycle', id, text: 'agent completed', tone: 'success' };
      }
      return {
        kind: 'lifecycle',
        id,
        text: line.error ?? (line.event === 'interrupted' ? 'agent interrupted' : 'agent failed'),
        tone: 'error',
      };
  }
}

function snapshotOrbit(snapshot: BackgroundAgentSnapshot, now: number): OrbitAgentVM {
  return {
    id: snapshot.id,
    label: snapshot.description,
    status: snapshot.status,
    model: snapshot.model,
    provider: providerText(snapshot.provider),
    ...(snapshot.status === 'running' || snapshot.status === 'waiting'
      ? { elapsed: durationText(snapshot.startedAt, now) }
      : { terminal: terminalLine(snapshot, now) }),
    ...(snapshot.status === 'waiting' || snapshot.checkpoint !== undefined
      ? { attention: true }
      : {}),
  };
}

function entryOrbit(entry: SubagentEntry): OrbitAgentVM {
  return {
    id: entry.id,
    label: entry.description,
    status: entry.status,
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(providerText(entry.provider) !== undefined ? { provider: providerText(entry.provider) } : {}),
    ...(entry.status === 'waiting' ? { attention: true } : {}),
    ...(entry.reason !== undefined ? { terminal: entry.reason } : {}),
  };
}

function fallbackEvents(entry: SubagentEntry, tools: Readonly<Record<string, ToolState>>): WorkspaceStreamEventVM[] {
  const events: WorkspaceStreamEventVM[] = [
    { kind: 'lifecycle', id: `${entry.id}:spawn`, text: 'agent recorded', tone: 'neutral' },
  ];
  for (const [toolCallId, tool] of Object.entries(tools)) {
    if (tool.parentToolUseId !== entry.id) continue;
    const detail =
      tool.status === 'result'
        ? humanizeResult(tool.name, tool.result).text
        : tool.status === 'error'
          ? tool.error ?? ''
          : humanizeArgs(tool.name, tool.args);
    events.push({
      kind: 'tool',
      id: `${entry.id}:tool:${toolCallId}`,
      name: tool.name,
      status: toolStatus(tool.status),
      ...(detail.length > 0 ? { detail } : {}),
      ...(toolProvenanceLabel(providerKindOf(entry.provider), tool.name) !== undefined
        ? { provenance: toolProvenanceLabel(providerKindOf(entry.provider), tool.name) }
        : {}),
    });
  }
  if (entry.status === 'done') {
    events.push({ kind: 'lifecycle', id: `${entry.id}:done`, text: 'agent completed', tone: 'success' });
  } else if (entry.status === 'error' || entry.status === 'aborted' || entry.status === 'declined') {
    events.push({
      kind: 'lifecycle',
      id: `${entry.id}:terminal`,
      text: entry.reason ?? entry.status,
      tone: entry.status === 'error' ? 'error' : 'neutral',
    });
  }
  return events;
}

export function buildWorkspaceViewModel(input: WorkspaceViewModelInput): WorkspaceViewModel {
  const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const entries = new Map(input.subagents.map((entry) => [entry.id, entry]));
  const ids = workspaceAgentOrder(input.subagents, input.snapshots);
  const agents = ids.map((id) => {
    const snapshot = snapshots.get(id);
    return snapshot === undefined ? entryOrbit(entries.get(id)!) : snapshotOrbit(snapshot, input.now);
  });
  const selectedAgentId =
    input.selectedAgentId !== undefined && ids.includes(input.selectedAgentId)
      ? input.selectedAgentId
      : ids.at(-1);
  if (selectedAgentId === undefined) return { agents };

  const snapshot = snapshots.get(selectedAgentId);
  const entry = entries.get(selectedAgentId);
  if (snapshot !== undefined) {
    const orbit = snapshotOrbit(snapshot, input.now);
    const selected: SelectedAgentVM = {
      id: snapshot.id,
      title: snapshot.profile ?? entry?.name ?? 'agent',
      task: snapshot.description,
      status: snapshot.status,
      model: snapshot.model,
      provider: providerText(snapshot.provider),
      ...(orbit.elapsed !== undefined ? { elapsed: orbit.elapsed } : {}),
      ...(orbit.terminal !== undefined ? { terminal: orbit.terminal } : {}),
      events: snapshot.timeline.map((line, index) =>
        lineToEvent(snapshot, line, index, input.tools),
      ),
    };
    return { agents, selectedAgentId, selected };
  }

  const fallback = entry!;
  const selected: SelectedAgentVM = {
    id: fallback.id,
    title: fallback.name,
    task: fallback.description,
    status: fallback.status,
    ...(fallback.model !== undefined ? { model: fallback.model } : {}),
    ...(providerText(fallback.provider) !== undefined ? { provider: providerText(fallback.provider) } : {}),
    ...(fallback.reason !== undefined ? { terminal: fallback.reason } : {}),
    events: fallbackEvents(fallback, input.tools),
  };
  return { agents, selectedAgentId, selected };
}
