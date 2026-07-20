import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { ModelClient, ToolExecutor, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { initialState, reducer, type Action, type Msg, type State } from '../src/core/reducer';
import {
  delegationCounts,
  delegationLedgerFromTools,
  hasUnsupportedDelegationClaim,
} from '../src/core/delegationEvidence';
import { runTurn } from '../src/agent/turnRunner';
import { createPermissionRegistry } from '../src/agent/eventBus';
import { createSessionStore } from '../src/services/sessions';
import { Message } from '../src/ui/Message';

function step(state: State, action: Action): State {
  return reducer(state, action);
}

function startTurn(text = 'Use two agents'): State {
  let state = initialState();
  state = step(state, { t: 'user-submit', id: 'u1', text });
  state = step(state, { t: 'assistant-start', id: 'a1' });
  return state;
}

function finishAgentRound(
  state: State,
  id: string,
  args: Record<string, unknown>,
  nextAssistantId: string,
): State {
  let next = step(state, { t: 'tool-call', toolCallId: id, name: 'spawn_subagent', args });
  next = step(next, { t: 'tool-status', toolCallId: id, status: 'running' });
  next = step(next, {
    t: 'tool-status',
    toolCallId: id,
    status: 'result',
    result: { summary: 'review complete' },
  });
  next = step(next, { t: 'assistant-done', id: state.live!.id, stopReason: 'tool_use' });
  return step(next, { t: 'assistant-start', id: nextAssistantId });
}

function twoAgentCompletion(): State {
  let state = startTurn();
  state = finishAgentRound(
    state,
    'spawn-model',
    { agent: 'reviewer', task: 'Review the data model' },
    'a2',
  );
  state = finishAgentRound(
    state,
    'spawn-tests',
    { subagent_type: 'test-reviewer', description: 'Review edge-case tests' },
    'a3',
  );
  state = step(state, {
    t: 'text-delta',
    id: 'a3',
    delta: 'Both subagents completed their reviews.',
  });
  return step(state, { t: 'assistant-done', id: 'a3', stopReason: 'end' });
}

describe('delegation evidence — reducer truth contract', () => {
  it('marks a zero-spawn prose claim unverified without fabricating an entry', () => {
    let state = startTurn();
    state = step(state, {
      t: 'text-delta',
      id: 'a1',
      delta: 'Both subagents completed their reviews and found no issues.',
    });
    state = step(state, { t: 'assistant-done', id: 'a1', stopReason: 'end' });

    expect(state.committed.at(-1)?.delegationReceipt).toEqual({
      source: 'recorded-tool-events',
      entries: [],
      warning: 'unsupported-delegation-claim',
    });
    expect(delegationLedgerFromTools(state.tools)).toEqual([]);
  });

  it('freezes a real two-agent completion receipt with roles and statuses', () => {
    const state = twoAgentCompletion();
    const receipt = state.committed.at(-1)?.delegationReceipt;

    expect(receipt?.warning).toBeUndefined();
    expect(receipt?.entries).toEqual([
      expect.objectContaining({
        toolCallId: 'spawn-model',
        role: 'reviewer',
        description: 'Review the data model',
        status: 'completed',
      }),
      expect.objectContaining({
        toolCallId: 'spawn-tests',
        role: 'test-reviewer',
        description: 'Review edge-case tests',
        status: 'completed',
      }),
    ]);
    expect(delegationCounts(receipt!.entries)).toEqual({
      started: 2,
      completed: 2,
      active: 0,
      failed: 0,
    });
  });

  it('does not carry a prior turn delegation into a later turn receipt', () => {
    let state = twoAgentCompletion();
    state = step(state, { t: 'user-submit', id: 'u2', text: 'Now answer directly' });
    state = step(state, { t: 'assistant-start', id: 'a4' });
    state = step(state, { t: 'text-delta', id: 'a4', delta: 'Done directly.' });
    state = step(state, { t: 'assistant-done', id: 'a4', stopReason: 'end' });
    expect(state.committed.at(-1)?.delegationReceipt).toBeUndefined();
    // The session ledger remains factual and session-wide.
    expect(delegationLedgerFromTools(state.tools)).toHaveLength(2);
  });

  it('treats a background spawn handle as active until the runner records its real terminal', () => {
    let state = startTurn();
    state = step(state, {
      t: 'tool-call',
      toolCallId: 'background-1',
      name: 'spawn_subagent',
      args: { agent: 'reviewer', task: 'Review asynchronously' },
    });
    state = step(state, {
      t: 'tool-status',
      toolCallId: 'background-1',
      status: 'result',
      result: { taskId: 'background-1', status: 'spawned', provider: 'api' },
    });
    state = step(state, { t: 'assistant-done', id: 'a1', stopReason: 'tool_use' });
    state = step(state, { t: 'assistant-start', id: 'a2' });
    state = step(state, {
      t: 'text-delta',
      id: 'a2',
      delta: 'The independent reviewer completed its work.',
    });
    state = step(state, { t: 'assistant-done', id: 'a2', stopReason: 'end' });
    expect(state.committed.at(-1)?.delegationReceipt).toMatchObject({
      warning: 'unsupported-delegation-claim',
      entries: [expect.objectContaining({ toolCallId: 'background-1', status: 'running' })],
    });

    state = step(state, {
      t: 'delegation-status',
      toolCallId: 'background-1',
      status: 'completed',
      summary: 'looks good',
    });
    expect(delegationLedgerFromTools(state.tools)[0]?.status).toBe('completed');
    // The historical snapshot is updated too, making the real terminal resumable.
    expect(state.committed.find((message) => message.toolSnapshot?.['background-1'])
      ?.toolSnapshot?.['background-1']?.result).toMatchObject({
      status: 'completed',
      summary: 'looks good',
    });

    state = step(state, { t: 'user-submit', id: 'u2', text: 'Summarize the review' });
    state = step(state, { t: 'assistant-start', id: 'a3' });
    state = step(state, {
      t: 'text-delta',
      id: 'a3',
      delta: 'The independent reviewer completed and found no issues.',
    });
    state = step(state, { t: 'assistant-done', id: 'a3', stopReason: 'end' });
    expect(state.committed.at(-1)?.delegationReceipt).toMatchObject({
      source: 'recorded-tool-events',
      entries: [expect.objectContaining({ toolCallId: 'background-1', status: 'completed' })],
    });
    expect(state.committed.at(-1)?.delegationReceipt?.warning).toBeUndefined();
  });

  it('keeps conservative detection warning-only and ignores an honest negative disclosure', () => {
    expect(hasUnsupportedDelegationClaim('The independent reviewer completed its audit.')).toBe(true);
    expect(hasUnsupportedDelegationClaim('No subagents were used; I reviewed it directly.')).toBe(false);
    expect(hasUnsupportedDelegationClaim('This could benefit from an independent review.')).toBe(false);
  });
});

describe('delegation evidence — persistence and resume', () => {
  it('round-trips the structured receipt and resume rebuilds the underlying tool ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'juno-delegation-evidence-'));
    try {
      const completed = twoAgentCompletion();
      const store = createSessionStore({ dir });
      await store.create({ id: 'delegated', createdAt: '2026-07-20T00:00:00.000Z' });
      await store.save('delegated', completed.committed);
      const loaded = await store.load('delegated');

      expect(loaded?.messages.at(-1)?.delegationReceipt?.entries).toHaveLength(2);
      const resumed = step(initialState(), {
        t: 'resume-session',
        messages: loaded?.messages ?? [],
      });
      expect(resumed.committed.at(-1)?.delegationReceipt?.source).toBe('recorded-tool-events');
      expect(delegationLedgerFromTools(resumed.tools).map((entry) => entry.toolCallId)).toEqual([
        'spawn-model',
        'spawn-tests',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('delegation evidence — transcript receipt', () => {
  it('renders an unmistakable two-agent completion receipt', () => {
    const msg = twoAgentCompletion().committed.at(-1)!;
    const frame = render(<Message msg={msg} depth="ansi16" columns={100} />).lastFrame() ?? '';
    expect(frame).toContain('✓ 2 agents · 2 completed · reviewer · test-reviewer');
    expect(frame).not.toContain('unverified');
  });

  it('renders unsupported prose as unverified, not completed', () => {
    const msg: Msg = {
      id: 'a',
      role: 'assistant',
      done: true,
      blocks: [{ kind: 'text', id: 'a:block:1', text: 'Both subagents completed.' }],
      delegationReceipt: {
        source: 'recorded-tool-events',
        entries: [],
        warning: 'unsupported-delegation-claim',
      },
    };
    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('delegation unverified');
    expect(frame).toContain('no recorded agent calls');
  });
});

describe('delegation evidence — model-facing re-entry', () => {
  it('injects authoritative completed counts after a real spawn tool result', async () => {
    const inputs: TurnInput[] = [];
    let call = 0;
    const client: ModelClient = {
      streamTurn: async function* (input: TurnInput): AsyncIterable<AgentEvent> {
        inputs.push(input);
        if (call++ === 0) {
          yield { type: 'assistant-start', id: 'a1' };
          yield {
            type: 'tool-call',
            id: 'a1',
            toolCallId: 'spawn-1',
            name: 'spawn_subagent',
            args: { agent: 'reviewer', task: 'Review the model' },
          };
          yield { type: 'assistant-done', id: 'a1', stopReason: 'tool_use' };
          return;
        }
        yield { type: 'assistant-start', id: 'a2' };
        yield { type: 'text-delta', id: 'a2', delta: 'The recorded reviewer completed.' };
        yield { type: 'assistant-done', id: 'a2', stopReason: 'end' };
      },
    };

    let state = step(initialState(), { t: 'user-submit', id: 'u1', text: 'Delegate review' });
    const dispatch = (action: Action): void => {
      state = step(state, action);
    };
    const executor: ToolExecutor = {
      execute: async (toolCallId, _name, _args, emit) => {
        emit({ type: 'tool-status', toolCallId, status: 'running' });
        emit({
          type: 'tool-status',
          toolCallId,
          status: 'result',
          result: { summary: 'reviewed' },
        });
      },
    };
    const specs: ToolSpec[] = [
      { name: 'spawn_subagent', description: 'spawn', inputSchema: { type: 'object' } },
    ];
    await runTurn(
      { id: 'a1', messages: [{ role: 'user', content: 'Delegate review' }] },
      {
        client,
        executor,
        specs,
        dispatch,
        signal: new AbortController().signal,
        registry: createPermissionRegistry(),
      },
    );

    const fact = inputs[1]?.messages.find(
      (message) => message.role === 'system' && message.content.startsWith('<juno-delegation-evidence'),
    );
    expect(fact?.content).toContain('started: 1');
    expect(fact?.content).toContain('completed: 1');
    expect(fact?.content).toContain('spawn-1: reviewer — completed');
    expect(state.committed.at(-1)?.delegationReceipt?.entries).toHaveLength(1);
  });
});
