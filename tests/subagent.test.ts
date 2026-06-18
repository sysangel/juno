// tests/subagent.test.ts — Wave 3 Unit 2: spawn_subagent (nested turn → summary)
// + agent-definition loading.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelClient, Tool, ToolCtx, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createSubagentTool } from '../src/tools/subagentTool';
import { createFileTools } from '../src/tools/fileTools';
import { createPermissionPolicy } from '../src/permissions/policy';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { loadAgentDefinitions } from '../src/services/agents';

const tempDirs: string[] = [];
async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `juno-${name}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ctxWith(signal?: AbortSignal): ToolCtx {
  return {
    cwd: '.',
    signal: signal ?? new AbortController().signal,
    emit: () => {},
    awaitPermission: async () => 'deny',
    state: {} as ToolCtx['state'],
  };
}

/** A scripted fake ModelClient that records the input + specs of each turn. */
function scriptedClient(scripts: Array<(input: TurnInput) => AgentEvent[]>): {
  client: ModelClient;
  calls: Array<{ input: TurnInput; specs: ToolSpec[] }>;
} {
  const calls: Array<{ input: TurnInput; specs: ToolSpec[] }> = [];
  let turn = 0;
  const client: ModelClient = {
    async *streamTurn(input, specs) {
      calls.push({ input, specs });
      const script = scripts[Math.min(turn, scripts.length - 1)];
      turn += 1;
      for (const event of script ? script(input) : []) {
        yield event;
      }
    },
  };
  return { client, calls };
}

const catalog = createModelCatalog(BUILTIN_MODELS);
const policy = createPermissionPolicy({ autoAllowSafe: true });

describe('spawn_subagent', () => {
  it('runs a fresh nested turn and returns the final assistant text as a summary', async () => {
    const { client } = scriptedClient([
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'text-delta', id: input.id, delta: 'Hello ' },
        { type: 'text-delta', id: input.id, delta: 'summary' },
        { type: 'assistant-done', id: input.id, stopReason: 'end' },
      ],
    ]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
    });

    const result = await tool.run({ task: 'do a thing' }, ctxWith());
    expect(result.ok).toBe(true);
    expect((result.data as { summary: string }).summary).toBe('Hello summary');
    expect((result.data as { model: string }).model).toBe('gpt-4.1');
  });

  it('is risky (spawning hits the permission gate in the parent turn)', () => {
    const { client } = scriptedClient([() => []]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
    });
    expect(tool.risk).toBe('risky');
  });

  it('enforces depth-1: the child toolset never includes spawn_subagent', async () => {
    const { client, calls } = scriptedClient([
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'assistant-done', id: input.id, stopReason: 'end' },
      ],
    ]);
    // Deliberately pollute childTools with a spawn_subagent-named tool.
    const fakeSpawn: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run() {
        return { ok: true };
      },
    };
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: [...createFileTools(), fakeSpawn],
      defaultModel: 'gpt-4.1',
    });

    await tool.run({ task: 'x' }, ctxWith());
    const specNames = calls[0]?.specs.map((s) => s.name) ?? [];
    expect(specNames).not.toContain('spawn_subagent');
    expect(specNames).toContain('read_file');
  });

  it('re-enters tool results and returns the post-tool answer', async () => {
    let echoRan = false;
    const echo: Tool = {
      name: 'echo',
      risk: 'safe',
      spec: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      async run() {
        echoRan = true;
        return { ok: true, data: { echoed: true } };
      },
    };
    const { client } = scriptedClient([
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'tool-call', id: input.id, toolCallId: 'tc1', name: 'echo', args: {} },
        { type: 'assistant-done', id: input.id, stopReason: 'tool_use' },
      ],
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'text-delta', id: input.id, delta: 'done after tool' },
        { type: 'assistant-done', id: input.id, stopReason: 'end' },
      ],
    ]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: [echo],
      defaultModel: 'gpt-4.1',
    });

    const result = await tool.run({ task: 'use the tool' }, ctxWith());
    expect(echoRan).toBe(true);
    expect(result.ok).toBe(true);
    expect((result.data as { summary: string }).summary).toBe('done after tool');
  });

  it('applies a named agent definition (system prompt + tool allow-list + model)', async () => {
    const { client, calls } = scriptedClient([
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'text-delta', id: input.id, delta: 'researched' },
        { type: 'assistant-done', id: input.id, stopReason: 'end' },
      ],
    ]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
      agents: {
        researcher: {
          name: 'researcher',
          description: 'research',
          prompt: 'You are a researcher.',
          model: 'claude-sonnet-4-6',
          tools: ['read_file', 'grep'],
          source: 'project',
        },
      },
    });

    const result = await tool.run({ task: 'find X', agent: 'researcher' }, ctxWith());
    expect(result.ok).toBe(true);
    expect(calls[0]?.input.systemPrompt).toBe('You are a researcher.');
    expect(calls[0]?.input.model).toBe('claude-sonnet-4-6');
    expect(calls[0]?.specs.map((s) => s.name).sort()).toEqual(['grep', 'read_file']);
  });

  it('errors on unknown agent or unknown model, and on missing task', async () => {
    const { client } = scriptedClient([() => []]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
      agents: {},
    });

    expect((await tool.run({}, ctxWith())).ok).toBe(false);
    const badAgent = await tool.run({ task: 't', agent: 'ghost' }, ctxWith());
    expect(badAgent.ok).toBe(false);
    expect(badAgent.error).toContain('unknown agent');
    const badModel = await tool.run({ task: 't', model: 'no-such-model' }, ctxWith());
    expect(badModel.ok).toBe(false);
    expect(badModel.error).toContain('unknown model');
  });

  it('propagates a nested error as a failed result', async () => {
    const { client } = scriptedClient([() => [{ type: 'error', message: 'boom' }]]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
    });
    const result = await tool.run({ task: 't' }, ctxWith());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('returns aborted when the parent signal is already aborted', async () => {
    const { client } = scriptedClient([
      (input) => [
        { type: 'assistant-start', id: input.id },
        { type: 'text-delta', id: input.id, delta: 'should not matter' },
        { type: 'assistant-done', id: input.id, stopReason: 'end' },
      ],
    ]);
    const tool = createSubagentTool({
      createClient: () => client,
      catalog,
      policy,
      childTools: createFileTools(),
      defaultModel: 'gpt-4.1',
    });
    const controller = new AbortController();
    controller.abort();
    const result = await tool.run({ task: 't' }, ctxWith(controller.signal));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });
});

describe('loadAgentDefinitions', () => {
  async function writeAgent(root: string, fileName: string, content: string): Promise<void> {
    const dir = path.join(root, '.claude', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), content, 'utf8');
  }

  it('parses name/description/model/tools + body prompt, inline and block tools', async () => {
    const home = await makeTempDir('agents-home');
    const project = await makeTempDir('agents-proj');
    await writeAgent(
      home,
      'researcher.md',
      `---
name: researcher
description: Researches things.
model: gpt-4.1
tools: read_file, grep
---
You are a research sub-agent. Be thorough.`,
    );
    await writeAgent(
      project,
      'builder.md',
      `---
name: builder
description: Builds things.
tools:
  - read_file
  - write_file
---
You build.`,
    );

    const defs = loadAgentDefinitions({ homeDir: home, cwd: project });
    expect(defs.researcher?.model).toBe('gpt-4.1');
    expect(defs.researcher?.tools).toEqual(['read_file', 'grep']);
    expect(defs.researcher?.prompt).toBe('You are a research sub-agent. Be thorough.');
    expect(defs.researcher?.source).toBe('user');
    expect(defs.builder?.tools).toEqual(['read_file', 'write_file']);
    expect(defs.builder?.model).toBeUndefined();
  });

  it('returns {} when the agents dirs are missing (never throws)', () => {
    const defs = loadAgentDefinitions({ homeDir: path.join(os.tmpdir(), 'nope-home-xyz'), cwd: path.join(os.tmpdir(), 'nope-proj-xyz') });
    expect(defs).toEqual({});
  });
});
