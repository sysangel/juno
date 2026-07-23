import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import { eventToAction } from '../src/core/events';
import type { ModelClient, Tool } from '../src/core/contracts';
import { initialState, reducer, type State, type ToolState } from '../src/core/reducer';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createModelCatalog } from '../src/services/catalog';
import { createSessionStore } from '../src/services/sessions';
import { createToolExecutor } from '../src/tools/executor';
import { createProcessManager } from '../src/tools/processTools';
import { createDefaultTools } from '../src/tools/registry';

const roots: string[] = [];
const managers: Array<ReturnType<typeof createProcessManager>> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function toolByName(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing parity tool: ${name}`);
  return tool;
}

/**
 * Provider-parity acceptance scaffold.
 *
 * This deliberately avoids any Codex/MCP transport implementation. It pins the
 * public contract the bridge must feed: real Juno tools execute, normalized
 * AgentEvents cross eventToAction, the reducer freezes them into a toolSnapshot,
 * and a fresh disk SessionStore can recover exact evidence. A bridge that merely
 * emits convincing assistant prose cannot satisfy these assertions.
 */
describe('provider parity — durable capability evidence', () => {
  it('persists two completed agents, managed start/poll/terminate, and structured verification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'juno-parity-project-'));
    roots.push(root);
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'juno-parity-sessions-'));
    roots.push(sessionDir);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { test: 'node -e "console.log(\'parity test passed\')"' },
    }));

    const childTasks: string[] = [];
    const childClient: ModelClient = {
      async *streamTurn(input) {
        const task = input.messages.find((message) => message.role === 'user')?.content ?? '';
        childTasks.push(task);
        yield { type: 'assistant-start', id: input.id };
        yield { type: 'text-delta', id: input.id, delta: `review complete: ${task}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
      },
    };
    const catalog = createModelCatalog([{
      id: 'parity-reviewer', provider: 'test', label: 'Parity reviewer', contextWindow: 32_000, default: true,
    }]);
    const processManager = createProcessManager({ id: () => 'parity-process', killGraceMs: 10 });
    managers.push(processManager);
    const tools = createDefaultTools({
      subagent: {
        createClient: () => childClient,
        catalog,
        policy: createPermissionPolicy({ autoAllowSafe: true }),
        defaultModel: 'parity-reviewer',
      },
      processes: processManager,
      verification: {},
    });
    // Registry availability is itself part of parity: a transport may expose
    // only tools present in this parent-only capability set.
    for (const name of ['spawn_subagent', 'start_process', 'poll_process', 'terminate_process', 'run_verification']) {
      expect(toolByName(tools, name).name).toBe(name);
    }

    let state: State = reducer(initialState(), { t: 'assistant-start', id: 'parity-turn' });
    const events: AgentEvent[] = [];
    const record = (event: AgentEvent): void => {
      events.push(event);
      state = reducer(state, eventToAction(event));
    };
    const allow = async (toolCallId: string): Promise<PermissionDecision> => {
      record({ type: 'permission-resolved', toolCallId, decision: 'allow-once' });
      return 'allow-once';
    };
    const executor = createToolExecutor({
      tools,
      policy: createPermissionPolicy({ autoAllowSafe: true }),
      cwd: root,
      signal: new AbortController().signal,
      getState: () => state,
      awaitPermission: allow,
      timeoutMs: 5_000,
    });
    const execute = async (toolCallId: string, name: string, args: unknown): Promise<ToolState> => {
      record({ type: 'tool-call', id: 'parity-turn', toolCallId, name, args });
      await executor.execute(toolCallId, name, args, record);
      const settled = state.tools[toolCallId];
      if (settled === undefined) throw new Error(`missing settled evidence for ${toolCallId}`);
      expect(settled.status).toBe('result');
      return settled;
    };

    await execute('spawn-model', 'spawn_subagent', { task: 'review the data model', profile: 'reviewer' });
    await execute('spawn-tests', 'spawn_subagent', { task: 'review the test gaps', profile: 'reviewer' });

    const started = await execute('process-start', 'start_process', {
      command: 'node -e "setInterval(() => {}, 1000)"',
      idle_timeout_ms: 5_000,
      wall_timeout_ms: 10_000,
    });
    expect(asRecord(started.result)).toMatchObject({ processId: 'parity-process', status: 'running' });
    const polled = await execute('process-poll', 'poll_process', { process_id: 'parity-process' });
    expect(asRecord(polled.result)).toMatchObject({ processId: 'parity-process', status: 'running' });
    const terminated = await execute('process-terminate', 'terminate_process', { process_id: 'parity-process' });
    expect(asRecord(terminated.result)).toMatchObject({ processId: 'parity-process', status: 'terminated' });

    const verified = await execute('verification', 'run_verification', { checks: ['test'] });
    expect(asRecord(verified.result)).toMatchObject({ status: 'passed', passed: 1, failed: 0 });
    state = reducer(state, { t: 'assistant-done', id: 'parity-turn', stopReason: 'end' });

    // Prove the two reviewers actually ran; a pair of synthetic spawn cards alone
    // is insufficient acceptance evidence.
    expect(childTasks).toEqual(['review the data model', 'review the test gaps']);
    expect(events.filter((event) => event.type === 'tool-status' && event.status === 'result')).toHaveLength(6);

    const store = createSessionStore({ dir: sessionDir });
    await store.create({ id: 'parity-session', createdAt: '2026-07-20T00:00:00.000Z', cwd: root });
    await store.save('parity-session', state.committed);
    await store.drain?.();

    // Re-open from disk rather than trusting the writer's in-memory objects.
    const loaded = await createSessionStore({ dir: sessionDir }).load('parity-session');
    expect(loaded?.messages.at(-1)?.done).toBe(true);
    const evidence = (loaded?.messages ?? []).reduce<Record<string, ToolState>>(
      (all, message) => ({ ...all, ...message.toolSnapshot }),
      {},
    );
    const names = Object.values(evidence).map((tool) => tool.name);
    expect(names.filter((name) => name === 'spawn_subagent')).toHaveLength(2);
    expect(names.filter((name) => name === 'start_process')).toHaveLength(1);
    expect(names.filter((name) => name === 'poll_process')).toHaveLength(1);
    expect(names.filter((name) => name === 'terminate_process')).toHaveLength(1);
    expect(names.filter((name) => name === 'run_verification')).toHaveLength(1);

    expect(asRecord(evidence['spawn-model']?.result)).toMatchObject({ summary: 'review complete: review the data model' });
    expect(asRecord(evidence['spawn-tests']?.result)).toMatchObject({ summary: 'review complete: review the test gaps' });
    expect(asRecord(evidence['process-start']?.result)).toMatchObject({ status: 'running' });
    expect(asRecord(evidence['process-poll']?.result)).toMatchObject({ status: 'running' });
    expect(asRecord(evidence['process-terminate']?.result)).toMatchObject({ status: 'terminated' });
    expect(asRecord(evidence.verification?.result)).toMatchObject({ status: 'passed', passed: 1, failed: 0 });
  });
});
