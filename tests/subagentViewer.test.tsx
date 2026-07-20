import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { SubagentEntry } from '../src/core/selectors';
import type { ToolState } from '../src/core/reducer';
import { agentToolEntries, SubagentViewer } from '../src/ui/SubagentViewer';

const entry: SubagentEntry = {
  id: 'agent-1', name: 'spawn_subagent', description: 'review durability', model: 'fable',
  provider: 'claude-cli', status: 'running', childCount: 1, runningLabel: 'working…',
};

const child: ToolState = {
  name: 'read_file', args: { path: 'README.md' }, status: 'result', result: 'ok',
  parentToolUseId: 'agent-1',
};

describe('SubagentViewer', () => {
  it('renders the selected agent and its recorder-backed descendants', () => {
    const tools = { 'agent-1::read': child };
    const { lastFrame } = render(<SubagentViewer entry={entry} tools={tools} rows={24} width={80} scroll={0} depth="ansi16" />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('review durability');
    expect(frame).toContain('running');
    expect(frame).toContain('read_file');
    expect(frame).toContain('m message');
  });

  it('walks nested ancestry and rejects unrelated tools', () => {
    const tools: Record<string, ToolState> = {
      direct: child,
      nested: { ...child, name: 'grep', parentToolUseId: 'direct' },
      other: { ...child, parentToolUseId: 'agent-2' },
    };
    expect(agentToolEntries(tools, 'agent-1').map(([id]) => id)).toEqual(['direct', 'nested']);
  });

  it('has an honest empty state for agents without recorded tool activity', () => {
    const { lastFrame } = render(<SubagentViewer entry={{ ...entry, status: 'done' }} tools={{}} rows={12} width={40} scroll={0} depth="ansi16" />);
    expect(lastFrame()).toContain('No tool activity recorded.');
  });
});
