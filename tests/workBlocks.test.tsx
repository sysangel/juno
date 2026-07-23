import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { Block, ToolState } from '../src/core/reducer';
import { ToolBlock } from '../src/ui/ToolBlock';
import {
  planWorkBlocks,
  workBlockLabel,
  workBlockLayout,
  workBlockRows,
} from '../src/ui/workBlocks';

function tool(name: string, extra: Partial<ToolState> = {}): ToolState {
  return { status: 'result', name, args: {}, result: 'ok', ...extra };
}

function blocks(...ids: string[]): Block[] {
  return ids.map((id) => ({ kind: 'tool', id: `b:${id}`, toolCallId: id }));
}

describe('semantic work-block planning', () => {
  it('groups sequential read/search calls across old concurrency boundaries, then starts a Ran block', () => {
    const tools: Record<string, ToolState> = {
      a: tool('read_file', { args: { path: 'a.ts' }, concurrencyGroupId: 'old-1' }),
      b: tool('grep', { args: { pattern: 'needle' }, concurrencyGroupId: 'old-2' }),
      c: tool('run_shell', { args: { command: 'npm test' } }),
    };
    const plan = planWorkBlocks(blocks('a', 'b', 'c'), (id) => tools[id]);
    const explore = plan.blockByAnchor.get('b:a');
    const run = plan.blockByAnchor.get('b:c');
    expect(explore?.family).toBe('explore');
    expect(explore?.members.map((member) => member.toolCallId)).toEqual(['a', 'b']);
    expect(plan.consumed.has('b:b')).toBe(true);
    expect(run?.family).toBe('run');
  });

  it('treats text and subagent spawns as hard boundaries', () => {
    const source: Block[] = [
      ...blocks('a'),
      { kind: 'text', id: 'txt', text: 'context' },
      ...blocks('agent', 'b'),
    ];
    const tools: Record<string, ToolState> = {
      a: tool('grep'),
      agent: tool('spawn_agent', { args: { task: 'review' } }),
      b: tool('read_file'),
    };
    const plan = planWorkBlocks(source, (id) => tools[id]);
    expect([...plan.blockByAnchor.values()].map((block) => block.members.map((m) => m.toolCallId))).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('maps brain recall calls to a concise past-tense block verb', () => {
    const entries = [tool('mcp__brain__recall'), tool('mcp__brain__get_episode')];
    expect(workBlockLabel('mcp', entries, true)).toBe('Recalled brain');
  });

  it('seals a prior family at a switch and leaves only the live tail open', () => {
    const tools: Record<string, ToolState> = {
      a: tool('read_file'),
      b: tool('grep'),
      c: tool('run_shell'),
    };
    const plan = planWorkBlocks(blocks('a', 'b', 'c'), (id) => tools[id]);

    expect(plan.blockByAnchor.get('b:a')).toMatchObject({
      sealed: true,
      members: [{ toolCallId: 'a' }, { toolCallId: 'b' }],
    });
    expect(plan.blockByAnchor.get('b:c')).toMatchObject({
      sealed: false,
      members: [{ toolCallId: 'c' }],
    });
  });

  it('uses an ineligible child as a permanent boundary between same-family calls', () => {
    const tools: Record<string, ToolState> = {
      a: tool('read_file'),
      child: tool('grep', { parentToolUseId: 'agent' }),
      b: tool('grep'),
    };
    const plan = planWorkBlocks(blocks('a', 'child', 'b'), (id) => tools[id]);

    expect(plan.blockByAnchor.get('b:a')).toMatchObject({
      sealed: true,
      members: [{ toolCallId: 'a' }],
    });
    expect(plan.blockByAnchor.get('b:b')).toMatchObject({
      sealed: false,
      members: [{ toolCallId: 'b' }],
    });
    expect(plan.blockByMember.has('b:child')).toBe(false);
  });

  it('keeps every existing member anchored when calls append to the prefix', () => {
    const tools: Record<string, ToolState> = {
      a: tool('read_file'),
      b: tool('grep'),
      c: tool('run_shell'),
      d: tool('read_file'),
    };
    const source = blocks('a', 'b', 'c', 'd');

    for (let length = 1; length < source.length; length += 1) {
      const before = planWorkBlocks(source.slice(0, length), (id) => tools[id]);
      const after = planWorkBlocks(source.slice(0, length + 1), (id) => tools[id]);
      for (const existing of source.slice(0, length)) {
        const prior = before.blockByMember.get(existing.id);
        const next = after.blockByMember.get(existing.id);
        expect(next?.anchorBlockId).toBe(prior?.anchorBlockId);
        expect(next?.groupKey).toBe(prior?.groupKey);
        expect(next?.members.slice(0, prior?.members.length).map((member) => member.blockId))
          .toEqual(prior?.members.map((member) => member.blockId));
      }
    }
  });

  it('seals the trailing block exactly when the turn ends', () => {
    const tools: Record<string, ToolState> = { a: tool('read_file') };
    expect(planWorkBlocks(blocks('a'), (id) => tools[id]).blockByAnchor.get('b:a')?.sealed)
      .toBe(false);
    expect(planWorkBlocks(blocks('a'), (id) => tools[id], true).blockByAnchor.get('b:a')?.sealed)
      .toBe(true);
  });
});

describe('ToolBlock renderer', () => {
  it('uses one verb header/provenance label and a tight tree of member facts', () => {
    const entries = [
      { toolCallId: 'a', tool: tool('read_file', { args: { path: 'src/app.tsx' }, result: 'one\ntwo' }) },
      { toolCallId: 'b', tool: tool('grep', { args: { pattern: 'spawn_agent' }, result: { matches: 4 } }) },
    ];
    const frame = render(
      <ToolBlock entries={entries} family="explore" providerKind="codex-cli" columns={100} depth="ansi16" />,
    ).lastFrame() ?? '';
    expect(frame).toContain('• Explored · via codex cli');
    expect(frame.match(/via codex cli/gu)).toHaveLength(1);
    expect(frame).toContain('└ Reading src/app.tsx · 2 lines');
    expect(frame).toContain('Searching for “spawn_agent” · 4 matches');
    expect(frame.split('\n').slice(1).some((line) => line.trim() === '')).toBe(false);
  });

  it('renders a bounded command/output preview with the full result delegated to ctrl+o', () => {
    const entry = {
      toolCallId: 'run',
      tool: tool('run_shell', {
        args: { command: ['npm test \\', '-- --filter workspace \\', '--reporter verbose', '--extra hidden'].join('\n') },
        result: 'PASS workspace\nPASS controls\n42 passed\ncoverage details\nmore output',
      }),
    };
    const frame = render(
      <Box width={70}><ToolBlock entries={[entry]} family="run" columns={70} depth="ansi16" /></Box>,
    ).lastFrame() ?? '';
    expect(frame).toContain('• Ran');
    expect(frame).toContain('└ npm test');
    expect(frame).toContain('│ -- --filter workspace');
    expect(frame).toContain('+1 command line (ctrl+o to view)');
    expect(frame).toContain('PASS workspace');
    expect(frame).toContain('+2 lines (ctrl+o to view)');
    expect(frame.split('\n').every((line) => line.length <= 70)).toBe(true);
  });

  it('caps oversized runs to six member rows plus an explicit earlier marker', () => {
    const entries = Array.from({ length: 40 }, (_, index) => tool('read_file', {
      args: { path: `src/${index}.ts` },
    }));
    const layout = workBlockLayout(entries);
    expect(layout.shown).toHaveLength(6);
    expect(layout.earlier).toBe(34);
    expect(workBlockRows(entries)).toBe(8); // header + earlier marker + six members
  });

  it('reserves the complete result-preview height while a Run block is open', () => {
    const entries = [tool('run_shell', {
      status: 'running',
      args: { command: 'npm test' },
      result: undefined,
    })];
    const layout = workBlockLayout(entries, false);

    expect(layout.previewRows).toHaveLength(4);
    expect(layout.previewRows.every((row) => row.placeholder)).toBe(true);
    expect(workBlockRows(entries, false)).toBe(6); // header + command + four reserved preview rows
  });

  it('slides an open seven-call tail without inserting or charging an earlier marker', () => {
    const six = Array.from({ length: 6 }, (_, index) => tool('read_file', {
      args: { path: `src/${index}.ts` },
    }));
    const seven = [...six, tool('read_file', { args: { path: 'src/6.ts' } })];
    const layout = workBlockLayout(seven, false);
    const frame = render(
      <ToolBlock
        entries={seven.map((entry, index) => ({ toolCallId: `read-${index}`, tool: entry }))}
        family="explore"
        sealed={false}
        columns={80}
        depth="ansi16"
      />,
    ).lastFrame() ?? '';

    expect(layout.shown).toHaveLength(6);
    expect(layout.shown[0]).toBe(seven[1]);
    expect(layout.earlier).toBe(0);
    expect(workBlockRows(six, false)).toBe(workBlockRows(seven, false));
    expect(frame).not.toContain('earlier call');
  });

  it('swaps the newest settled preview in place without changing open height', () => {
    const pending = tool('run_shell', {
      status: 'running',
      args: { command: 'npm test' },
      result: undefined,
    });
    const first = tool('run_shell', {
      args: { command: 'npm run typecheck' },
      result: 'TYPECHECK OK',
    });
    const before = [first, pending];
    const after = [
      first,
      { ...pending, status: 'result' as const, result: 'TESTS OK\n42 passed' },
    ];

    expect(workBlockLayout(before, false).previewRows.map((row) => row.text))
      .toContain('TYPECHECK OK');
    expect(workBlockLayout(after, false).previewRows.map((row) => row.text))
      .toContain('TESTS OK');
    expect(workBlockRows(after, false)).toBe(workBlockRows(before, false));
  });

  it('collapses reserved preview rows exactly once when the block seals', () => {
    const entries = [tool('run_shell', {
      status: 'running',
      args: { command: 'npm test' },
      result: undefined,
    })];

    expect(workBlockRows(entries, false)).toBe(6);
    expect(workBlockRows(entries, true)).toBe(2);
    expect(workBlockRows(entries, true)).toBe(workBlockRows(entries));
  });
});
