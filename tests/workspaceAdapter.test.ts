import { describe, expect, it } from 'vitest';
import type { SubagentEntry } from '../src/core/selectors';
import type { ToolState } from '../src/core/reducer';
import type { BackgroundAgentSnapshot } from '../src/services/backgroundAgents';
import { buildWorkspaceViewModel, workspaceAgentOrder } from '../src/ui/workspaceAdapter';

const snapshot: BackgroundAgentSnapshot = {
  id: 'agent-1',
  model: 'claude-fable-5',
  provider: 'claude-cli',
  status: 'done',
  description: 'Review error handling',
  profile: 'reviewer',
  startedAt: 1_000,
  timeline: [
    { kind: 'lifecycle', event: 'spawn', ts: 1_000 },
    { kind: 'reasoning', delta: 'inspect boundaries', ts: 1_100 },
    { kind: 'tool', event: 'call', toolCallId: 'agent-1::read', name: 'read_file', ts: 1_200 },
    { kind: 'tool', event: 'status', toolCallId: 'agent-1::read', status: 'result', ts: 1_300 },
    { kind: 'steer', text: 'also inspect tests', ts: 1_400 },
    { kind: 'text', delta: 'Two findings.', ts: 1_500 },
    { kind: 'lifecycle', event: 'done', ts: 4_000, summary: 'Two findings.' },
  ],
  capabilities: { steer: false, cancel: false, resolvePermission: false },
};

const spawnEntry: SubagentEntry = {
  id: 'agent-1',
  name: 'spawn_subagent',
  description: 'Review error handling',
  model: 'claude-fable-5',
  provider: 'claude-cli',
  status: 'done',
  childCount: 1,
  runningLabel: 'working…',
};

describe('workspace adapter', () => {
  it('owns the deduplicated rail and keyboard ordering', () => {
    expect(workspaceAgentOrder([spawnEntry], [snapshot, { ...snapshot, id: 'agent-2' }])).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('preserves the runner timeline order and textual provenance', () => {
    const tools: Record<string, ToolState> = {
      'agent-1::read': {
        name: 'read_file',
        status: 'result',
        args: { path: 'src/app.tsx' },
        result: 'export function App',
        parentToolUseId: 'agent-1',
      },
    };
    const vm = buildWorkspaceViewModel({
      snapshots: [snapshot],
      subagents: [spawnEntry],
      tools,
      selectedAgentId: 'agent-1',
      now: 10_000,
    });

    expect(vm.agents).toEqual([
      expect.objectContaining({
        id: 'agent-1', status: 'done', model: 'claude-fable-5', provider: 'claude cli', terminal: 'done 3s',
      }),
    ]);
    expect(vm.selected).toMatchObject({ title: 'reviewer', task: 'Review error handling' });
    expect(vm.selected?.events.map((event) => event.kind)).toEqual([
      'lifecycle', 'reasoning', 'tool', 'tool', 'steering', 'assistant', 'lifecycle',
    ]);
    expect(vm.selected?.events[3]).toMatchObject({
      kind: 'tool', status: 'done', detail: 'export function App', provenance: 'via claude cli',
    });
  });

  it('marks permission waits as attention and falls back to recorder-backed tools', () => {
    const waiting: BackgroundAgentSnapshot = {
      ...snapshot,
      id: 'waiting',
      status: 'waiting',
      checkpoint: {
        toolCallId: 'danger', toolName: 'run_shell', risk: 'dangerous', sanitizedArgs: {}, requestedAt: 2_000,
      },
      timeline: [
        { kind: 'lifecycle', event: 'spawn', ts: 1_000 },
        { kind: 'checkpoint', event: 'requested', toolCallId: 'danger', toolName: 'run_shell', risk: 'dangerous', ts: 2_000 },
      ],
      capabilities: { steer: false, cancel: true, resolvePermission: true },
    };
    const native: SubagentEntry = {
      ...spawnEntry,
      id: 'native',
      name: 'Agent',
      description: 'Native reviewer',
      model: 'reviewer',
    };
    const tools: Record<string, ToolState> = {
      native: { name: 'Agent', status: 'result', args: { description: 'Native reviewer' }, result: 'done' },
      child: { name: 'Grep', status: 'result', args: { pattern: 'catch' }, result: '3 matches', parentToolUseId: 'native' },
    };
    const vm = buildWorkspaceViewModel({ snapshots: [waiting], subagents: [native], tools, now: 3_000 });
    expect(vm.agents.find((agent) => agent.id === 'waiting')).toMatchObject({ attention: true, elapsed: '2s' });
    expect(vm.selectedAgentId).toBe('waiting');

    const fallback = buildWorkspaceViewModel({ snapshots: [], subagents: [native], tools, selectedAgentId: 'native', now: 3_000 });
    expect(fallback.selected?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', name: 'Grep', status: 'done', detail: '3 matches' }),
    ]));
  });
});
