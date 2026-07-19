// tests/subagentBackground.test.ts — Wave 13 (lane 1): spawn_subagent's
// NON-BLOCKING handoff. With a real tool-use id AND a runner, run() resolves the
// spawn (capturing the {provider,model}-pinned entry) and hands it to the runner,
// returning a 'spawned' handle SYNCHRONOUSLY — it never awaits the child. Without a
// toolCallId OR without a runner it degrades to the blocking summary path.
import { describe, expect, it } from 'vitest';
import type { ModelClient, ToolCtx, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createSubagentTool } from '../src/tools/subagentTool';
import { createFileTools } from '../src/tools/fileTools';
import { createPermissionPolicy } from '../src/permissions/policy';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import type {
  BackgroundAgentRunner,
  BackgroundSpawnOptions,
  BackgroundTaskStatus,
} from '../src/services/backgroundAgents';

const catalog = createModelCatalog(BUILTIN_MODELS);
const policy = createPermissionPolicy({ autoAllowSafe: true });

/** A runner stub that records every spawn but runs nothing. */
function stubRunner(): { runner: BackgroundAgentRunner; spawns: BackgroundSpawnOptions[] } {
  const spawns: BackgroundSpawnOptions[] = [];
  const statuses: Record<string, BackgroundTaskStatus> = {};
  const runner: BackgroundAgentRunner = {
    spawn(opts) {
      spawns.push(opts);
      statuses[opts.spawnCardId] = 'running';
      return { taskId: opts.spawnCardId };
    },
    attach() {},
    subscribe() {
      return () => {};
    },
    getVersion() {
      return 0;
    },
    drainCompletions() {
      return [];
    },
    taskStatuses() {
      return statuses;
    },
    abortAll() {},
    setSessionId() {},
    async reconcile() {
      return { interrupted: [], undeliveredCompletions: [] };
    },
    markDelivered() {},
    async readOutput() {
      return { text: '', reasoning: '', lifecycle: [] };
    },
  };
  return { runner, spawns };
}

/** A client whose streamTurn MUST NOT be called on the background path. */
function neverStreamClient(): { client: ModelClient; called: () => boolean } {
  let ran = false;
  const client: ModelClient = {
    // eslint-disable-next-line require-yield
    async *streamTurn(_input: TurnInput): AsyncIterable<AgentEvent> {
      ran = true;
    },
  };
  return { client, called: () => ran };
}

function ctxWith(toolCallId: string | undefined): ToolCtx {
  return {
    cwd: '.',
    signal: new AbortController().signal,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    emit: () => {},
    awaitPermission: async () => 'deny',
    state: {} as ToolCtx['state'],
  };
}

describe('spawn_subagent — non-blocking background handoff', () => {
  it('hands the resolved spawn to the runner and returns a spawned handle synchronously', async () => {
    const { runner, spawns } = stubRunner();
    const { client, called } = neverStreamClient();
    const childTools = createFileTools();
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools,
      defaultModel: 'claude-fable-5',
      runner,
    });

    const result = await tool.run({ task: 'do a thing' }, ctxWith('spawn-1'));

    // Handed to the runner; the child was NOT run inline (no blocking stream).
    expect(spawns).toHaveLength(1);
    expect(called()).toBe(false);
    const spawn = spawns[0]!;
    expect(spawn.spawnCardId).toBe('spawn-1');
    expect(spawn.task).toBe('do a thing');
    // {provider, model} pin: the entry captured at spawn time is the resolved default.
    expect(spawn.entry.id).toBe('claude-fable-5');
    expect(spawn.entry.provider).toBe(catalog.resolve('claude-fable-5')!.provider);
    // The child toolset is the depth-1 set (never spawn_subagent).
    expect(spawn.childTools.map((t) => t.name)).not.toContain('spawn_subagent');

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      taskId: 'spawn-1',
      status: 'spawned',
      model: 'claude-fable-5',
      provider: catalog.resolve('claude-fable-5')!.provider,
    });
    expect(result.promptText).toContain('spawn-1');
    expect(result.promptText).toContain('runs independently');
  });

  it('pins the model arg entry at spawn time (never re-resolved later)', async () => {
    const { runner, spawns } = stubRunner();
    const tool = createSubagentTool({
      createClient: () => neverStreamClient().client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'claude-fable-5',
      runner,
    });
    const other = catalog.list().find((e) => e.id !== 'claude-fable-5')!;
    await tool.run({ task: 't', model: other.id }, ctxWith('spawn-2'));
    expect(spawns[0]!.entry.id).toBe(other.id);
    expect(spawns[0]!.entry.provider).toBe(other.provider);
  });

  it('surfaces a spawn card id error-free even for an agent def (system prompt threaded)', async () => {
    const { runner, spawns } = stubRunner();
    const tool = createSubagentTool({
      createClient: () => neverStreamClient().client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'claude-fable-5',
      runner,
      agents: {
        researcher: {
          name: 'researcher',
          description: 'research',
          prompt: 'You are a researcher.',
          model: 'claude-sonnet-5',
          tools: ['read_file', 'grep'],
          source: 'project',
        },
      },
    });
    const result = await tool.run({ task: 'find X', agent: 'researcher' }, ctxWith('spawn-3'));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ agent: 'researcher', model: 'claude-sonnet-5' });
    expect(spawns[0]!.systemPrompt).toBe('You are a researcher.');
    expect(spawns[0]!.entry.id).toBe('claude-sonnet-5');
    expect(spawns[0]!.childTools.map((t) => t.name).sort()).toEqual(['grep', 'read_file']);
  });
});

describe('spawn_subagent — blocking fallback when the background path is unavailable', () => {
  function summaryClient(summary: string): ModelClient {
    return {
      async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: input.id };
        yield { type: 'text-delta', id: input.id, delta: summary };
        yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
      },
    };
  }

  it('runs inline (returns a summary) when a runner is present but the ctx has no toolCallId', async () => {
    const { runner, spawns } = stubRunner();
    const tool = createSubagentTool({
      createClient: () => summaryClient('inline result'),
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'claude-fable-5',
      runner,
    });
    const result = await tool.run({ task: 't' }, ctxWith(undefined));
    expect(spawns).toHaveLength(0); // never handed to the runner
    expect(result.ok).toBe(true);
    expect((result.data as { summary: string }).summary).toBe('inline result');
  });

  it('runs inline when a toolCallId is present but no runner is wired', async () => {
    const tool = createSubagentTool({
      createClient: () => summaryClient('inline too'),
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'claude-fable-5',
    });
    const result = await tool.run({ task: 't' }, ctxWith('spawn-4'));
    expect(result.ok).toBe(true);
    expect((result.data as { summary: string }).summary).toBe('inline too');
  });
});
