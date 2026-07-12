// tests/subagentOrchestrator.test.ts — Wave 7 Lane A: the juno-side subagent
// orchestrator. Verifies that a spawned subagent's CHILD tool events are
// re-emitted into the PARENT stream with `parentToolUseId` set + namespaced ids,
// that child prose is NOT spliced, and that cross-provider children thread
// identically (a claude parent spawning a codex child and vice versa).
import { describe, expect, it } from 'vitest';
import type { ModelClient, ToolCtx, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createSubagentTool } from '../src/tools/subagentTool';
import { createToolExecutor } from '../src/tools/executor';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createPermissionRegistry } from '../src/agent/eventBus';
import { runTurn } from '../src/agent/turnRunner';
import { initialState, reducer, type Action, type State } from '../src/core/reducer';
import { createModelCatalog, type ModelEntry } from '../src/services/catalog';

const policy = createPermissionPolicy({ autoAllowSafe: true });

/** A child client that emits ONE self-contained tool card + a prose summary. */
function toolCardClient(toolName: string): ModelClient {
  return {
    async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      yield { type: 'tool-call', id: input.id, toolCallId: 'c1', name: toolName, args: { q: 1 } };
      yield { type: 'tool-status', toolCallId: 'c1', status: 'running' };
      yield { type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' };
      yield { type: 'text-delta', id: input.id, delta: 'child summary' };
      yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
    },
  };
}

function capturingCtx(toolCallId: string | undefined): {
  ctx: ToolCtx;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  const ctx: ToolCtx = {
    cwd: '.',
    signal: new AbortController().signal,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    emit: (event: AgentEvent) => events.push(event),
    awaitPermission: async () => 'deny',
    state: {} as ToolCtx['state'],
  };
  return { ctx, events };
}

const twoProviderCatalog = createModelCatalog([
  {
    id: 'claude-fable-5',
    provider: 'claude-cli',
    label: 'Claude',
    contextWindow: 200_000,
    default: true,
  },
  { id: 'gpt-5.6-sol', provider: 'codex-cli', label: 'Codex', contextWindow: 200_000 },
] as ModelEntry[]);

describe('subagent orchestrator — child tool events surfaced with parentToolUseId', () => {
  it('re-emits child tool-call / tool-status nested under the spawn id, namespaced', async () => {
    const tool = createSubagentTool({
      createClient: () => toolCardClient('read_file'),
      catalog: twoProviderCatalog,
      policy,
      childTools: [],
    });
    const { ctx, events } = capturingCtx('spawn-1');

    const result = await tool.run({ task: 'do it' }, ctx);

    // The nested tool-call is surfaced under the spawning call.
    const toolCalls = events.filter((e) => e.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    const call = toolCalls[0]!;
    expect(call).toMatchObject({
      type: 'tool-call',
      toolCallId: 'spawn-1::c1',
      name: 'read_file',
      parentToolUseId: 'spawn-1',
    });

    // Tool-status carries the SAME namespaced id (running + result).
    const statuses = events.filter((e) => e.type === 'tool-status');
    expect(statuses.map((s) => (s as Extract<AgentEvent, { type: 'tool-status' }>).toolCallId)).toEqual([
      'spawn-1::c1',
      'spawn-1::c1',
    ]);

    // Child prose / lifecycle is NOT spliced into the parent stream.
    expect(events.some((e) => e.type === 'text-delta')).toBe(false);
    expect(events.some((e) => e.type === 'assistant-start')).toBe(false);
    expect(events.some((e) => e.type === 'assistant-done')).toBe(false);

    // The summary still returns as before.
    expect(result.ok).toBe(true);
    expect((result.data as { summary: string }).summary).toBe('child summary');
  });

  it('degrades to summary-only (no surfacing) when the ctx carries no toolCallId', async () => {
    const tool = createSubagentTool({
      createClient: () => toolCardClient('read_file'),
      catalog: twoProviderCatalog,
      policy,
      childTools: [],
    });
    const { ctx, events } = capturingCtx(undefined);

    const result = await tool.run({ task: 'do it' }, ctx);

    expect(events).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

describe('subagent orchestrator — cross-provider children', () => {
  it('claude parent → codex child: model arg selects the codex entry; its tool card threads', async () => {
    const seen: Array<{ id: string; provider: string }> = [];
    const tool = createSubagentTool({
      createClient: (entry) => {
        seen.push({ id: entry.id, provider: entry.provider });
        return toolCardClient(entry.provider === 'codex-cli' ? 'shell' : 'read_file');
      },
      catalog: twoProviderCatalog,
      policy,
      childTools: [],
    });
    const { ctx, events } = capturingCtx('spawn-c');

    const result = await tool.run({ task: 'delegate', model: 'gpt-5.6-sol' }, ctx);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ id: 'gpt-5.6-sol', provider: 'codex-cli' }]);
    const call = events.find((e) => e.type === 'tool-call') as
      | Extract<AgentEvent, { type: 'tool-call' }>
      | undefined;
    expect(call?.name).toBe('shell');
    expect(call?.parentToolUseId).toBe('spawn-c');
    expect(call?.toolCallId).toBe('spawn-c::c1');
  });

  it('codex parent → claude child: model arg selects the claude entry; its tool card threads', async () => {
    const seen: Array<{ id: string; provider: string }> = [];
    const tool = createSubagentTool({
      createClient: (entry) => {
        seen.push({ id: entry.id, provider: entry.provider });
        return toolCardClient(entry.provider === 'codex-cli' ? 'shell' : 'read_file');
      },
      catalog: twoProviderCatalog,
      policy,
      childTools: [],
    });
    const { ctx, events } = capturingCtx('spawn-a');

    const result = await tool.run({ task: 'delegate', model: 'claude-fable-5' }, ctx);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ id: 'claude-fable-5', provider: 'claude-cli' }]);
    const call = events.find((e) => e.type === 'tool-call') as
      | Extract<AgentEvent, { type: 'tool-call' }>
      | undefined;
    expect(call?.name).toBe('read_file');
    expect(call?.parentToolUseId).toBe('spawn-a');
  });
});

describe('subagent orchestrator — end-to-end through runTurn + executor + reducer', () => {
  it('a raw-API parent that calls spawn_subagent nests the child card in parent state.tools', async () => {
    // Parent client: request the spawn tool, then (on re-entry with the result) end.
    let parentTurn = 0;
    const parentClient: ModelClient = {
      async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        parentTurn += 1;
        if (parentTurn === 1) {
          yield { type: 'assistant-start', id: input.id };
          yield {
            type: 'tool-call',
            id: input.id,
            toolCallId: 'spawn-1',
            name: 'spawn_subagent',
            args: { task: 'go' },
          };
          yield { type: 'assistant-done', id: input.id, stopReason: 'tool_use' };
        } else {
          yield { type: 'assistant-start', id: input.id };
          yield { type: 'text-delta', id: input.id, delta: 'done' };
          yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
        }
      },
    };

    const subagentTool = createSubagentTool({
      createClient: () => toolCardClient('read_file'),
      catalog: twoProviderCatalog,
      policy,
      childTools: [],
    });

    // Reducer-backed dispatch so we can inspect the resulting nested state.
    let state: State = { ...initialState(), live: null };
    const dispatch = (action: Action): void => {
      state = reducer(state, action);
    };
    const registry = createPermissionRegistry();
    const executor = createToolExecutor({
      tools: [subagentTool],
      policy,
      cwd: '.',
      signal: new AbortController().signal,
      getState: () => state,
      // spawn_subagent is risky → the executor prompts; approve it.
      awaitPermission: async () => 'allow-once',
    });

    await runTurn(
      { id: 'parent-turn', messages: [{ role: 'user', content: 'delegate' }] },
      {
        client: parentClient,
        executor,
        specs: [subagentTool.spec],
        dispatch,
        signal: new AbortController().signal,
        registry,
      },
    );

    // The spawn card exists top-level; the child card is nested under it.
    expect(state.tools['spawn-1']?.name).toBe('spawn_subagent');
    const child = state.tools['spawn-1::c1'];
    expect(child).toBeDefined();
    expect(child?.name).toBe('read_file');
    expect(child?.parentToolUseId).toBe('spawn-1');
    // The child ran to completion (result surfaced), and the parent spawn resolved.
    expect(child?.status).toBe('result');
    expect(state.tools['spawn-1']?.status).toBe('result');
  });
});
