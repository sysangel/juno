// tests/backgroundAgents.test.ts — Wave 13 (lane 1): the non-blocking
// background-agent runner. Proves spawn returns a handle SYNCHRONOUSLY (the parent
// is never pinned on the child), the child runs on a detached loop, its tool events
// surface through the INJECTED app dispatch (namespaced), {provider,model} stays
// pinned to the spawn-time entry, completion arrives as observable queue state, and
// abortAll stops a live task.
import { describe, expect, it } from 'vitest';
import type { ModelClient, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import type { Action } from '../src/core/reducer';
import type { ModelEntry } from '../src/services/catalog';
import { createPermissionPolicy } from '../src/permissions/policy';
import {
  createBackgroundAgentRunner,
  formatCompletion,
  type BackgroundCompletion,
} from '../src/services/backgroundAgents';

const policy = createPermissionPolicy({ autoAllowSafe: true });

const claudeEntry: ModelEntry = {
  id: 'claude-fable-5',
  provider: 'claude-cli',
  label: 'Claude',
  contextWindow: 200_000,
  default: true,
};
const codexEntry: ModelEntry = {
  id: 'gpt-5.6-sol',
  provider: 'codex-cli',
  label: 'Codex',
  contextWindow: 200_000,
};

/** A one-shot text client that streams a summary then ends. */
function textClient(summary: string): ModelClient {
  return {
    async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      yield { type: 'text-delta', id: input.id, delta: summary };
      yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
    },
  };
}

/** A client that BLOCKS at `gate` mid-stream (proves spawn does not await it). */
function gatedClient(gate: Promise<void>, summary: string): ModelClient {
  return {
    async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      await gate;
      yield { type: 'text-delta', id: input.id, delta: summary };
      yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
    },
  };
}

/** A client that emits a self-contained tool card (pretend-run) + prose. */
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('background-agent runner — non-blocking spawn', () => {
  it('returns the spawn card id SYNCHRONOUSLY while the child is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createBackgroundAgentRunner({
      createClient: () => gatedClient(gate, 'later'),
      policy,
      cwd: '.',
    });

    const handle = runner.spawn({
      spawnCardId: 'spawn-1',
      task: 'do a thing',
      entry: claudeEntry,
      childTools: [],
    });

    // Synchronous return: the child is blocked at the gate, so it has NOT completed.
    expect(handle).toEqual({ taskId: 'spawn-1' });
    expect(runner.taskStatuses()['spawn-1']).toBe('running');
    expect(runner.drainCompletions()).toHaveLength(0);

    // Give the detached loop turns; it stays blocked (still running, still no completion).
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.taskStatuses()['spawn-1']).toBe('running');
    expect(runner.drainCompletions()).toHaveLength(0);

    // Release the gate: the child completes and its result lands on the queue.
    release();
    await waitFor(() => runner.taskStatuses()['spawn-1'] === 'done');
    const completions = runner.drainCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ taskId: 'spawn-1', status: 'done', summary: 'later' });
  });

  it('bumps the version on spawn AND on completion; subscribers are notified', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('hi'),
      policy,
      cwd: '.',
    });
    let notifications = 0;
    runner.subscribe(() => {
      notifications += 1;
    });
    const before = runner.getVersion();
    runner.spawn({ spawnCardId: 's', task: 't', entry: claudeEntry, childTools: [] });
    expect(runner.getVersion()).toBe(before + 1); // spawn bumped it
    expect(notifications).toBe(1);
    await waitFor(() => runner.taskStatuses()['s'] === 'done');
    expect(runner.getVersion()).toBe(before + 2); // completion bumped it
    expect(notifications).toBe(2);
  });
});

describe('background-agent runner — surfacing via the injected dispatch', () => {
  it('forwards child tool events namespaced under the spawn card; child prose stays out', async () => {
    const dispatched: Action[] = [];
    const runner = createBackgroundAgentRunner({
      createClient: () => toolCardClient('read_file'),
      policy,
      cwd: '.',
    });
    runner.attach({ dispatch: (action) => dispatched.push(action) });

    runner.spawn({ spawnCardId: 'spawn-x', task: 'go', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['spawn-x'] === 'done');

    const toolCalls = dispatched.filter((a) => a.t === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      t: 'tool-call',
      toolCallId: 'spawn-x::c1',
      name: 'read_file',
      parentToolUseId: 'spawn-x',
    });
    const statuses = dispatched.filter((a) => a.t === 'tool-status');
    expect(
      statuses.map((s) => (s as Extract<Action, { t: 'tool-status' }>).toolCallId),
    ).toEqual(['spawn-x::c1', 'spawn-x::c1']);

    // Child text / lifecycle is NOT surfaced into the parent stream.
    expect(dispatched.some((a) => a.t === 'text-delta')).toBe(false);
    expect(dispatched.some((a) => a.t === 'assistant-start')).toBe(false);
    expect(dispatched.some((a) => a.t === 'assistant-done')).toBe(false);

    const completions = runner.drainCompletions();
    expect(completions[0]).toMatchObject({ status: 'done', summary: 'child summary' });
  });

  it('bubbles the child token usage to the injected dispatch stamped with the spawn card id (b6-boundary-honesty item 1)', async () => {
    // A child client that emits a big token-usage event mid-turn (no contextTokens),
    // then a prose summary. The runner must forward that usage to the parent dispatch
    // with parentToolUseId = spawnCardId so the reducer folds it into the cost meter
    // ONLY — never the parent's context-window occupancy (child context is isolated).
    const usageChild: ModelClient = {
      async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: input.id };
        yield { type: 'usage', tokensIn: 4000, tokensOut: 120 };
        yield { type: 'text-delta', id: input.id, delta: 'child summary' };
        yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
      },
    };
    const dispatched: Action[] = [];
    const runner = createBackgroundAgentRunner({
      createClient: () => usageChild,
      policy,
      cwd: '.',
    });
    runner.attach({ dispatch: (action) => dispatched.push(action) });

    runner.spawn({ spawnCardId: 'spawn-u', task: 'go', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['spawn-u'] === 'done');

    const usages = dispatched.filter((a) => a.t === 'usage') as Array<
      Extract<Action, { t: 'usage' }>
    >;
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      t: 'usage',
      tokensIn: 4000,
      tokensOut: 120,
      parentToolUseId: 'spawn-u',
    });
    // The spawn-card id is NOT namespaced (ns() is for child tool ids only) — it must
    // equal the parent spawn card id so the reducer keys the display-only bubbling.
    expect(usages[0]!.parentToolUseId).toBe('spawn-u');
  });

  it('degrades to summary-only when no dispatch has been attached', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => toolCardClient('read_file'),
      policy,
      cwd: '.',
    });
    // No attach() → surfacing is a no-op, but the completion still delivers.
    runner.spawn({ spawnCardId: 'spawn-y', task: 'go', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['spawn-y'] === 'done');
    expect(runner.drainCompletions()[0]).toMatchObject({ status: 'done', summary: 'child summary' });
  });
});

describe('background-agent runner — {provider, model} pinning', () => {
  it('builds the child client from the captured entry and never re-resolves', async () => {
    const seen: Array<{ id: string; provider: string }> = [];
    const runner = createBackgroundAgentRunner({
      createClient: (entry) => {
        seen.push({ id: entry.id, provider: entry.provider });
        return textClient('done');
      },
      policy,
      cwd: '.',
    });
    // The runner takes NO catalog — structurally it cannot re-resolve. Pin to codex.
    runner.spawn({ spawnCardId: 'p', task: 't', entry: codexEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['p'] === 'done');
    expect(seen).toEqual([{ id: 'gpt-5.6-sol', provider: 'codex-cli' }]);
    expect(runner.drainCompletions()[0]).toMatchObject({
      taskId: 'p',
      status: 'done',
      model: 'gpt-5.6-sol',
      provider: 'codex-cli',
    });
  });
});

describe('background-agent runner — failure + abort', () => {
  it('records a nested error as an error completion', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: (): ModelClient => ({
        async *streamTurn(): AsyncIterable<AgentEvent> {
          yield { type: 'error', message: 'boom' };
        },
      }),
      policy,
      cwd: '.',
    });
    runner.spawn({ spawnCardId: 'e', task: 't', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['e'] === 'error');
    const completion = runner.drainCompletions()[0];
    expect(completion?.status).toBe('error');
    expect(completion?.error).toContain('boom');
  });

  it('abortAll aborts a live task; it settles as an aborted error', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createBackgroundAgentRunner({
      createClient: () => gatedClient(gate, 'never'),
      policy,
      cwd: '.',
    });
    runner.spawn({ spawnCardId: 'a', task: 't', entry: claudeEntry, childTools: [] });
    expect(runner.taskStatuses()['a']).toBe('running');

    runner.abortAll();
    // The child is blocked at the gate; release it so runTurn observes the abort and returns.
    release();
    await waitFor(() => runner.taskStatuses()['a'] === 'error');
    expect(runner.drainCompletions()[0]?.error).toContain('aborted');
  });
});

describe('formatCompletion', () => {
  it('composes the model-facing steer + dim notice for a done result', () => {
    const completion: BackgroundCompletion = {
      taskId: 'spawn-1',
      status: 'done',
      model: 'claude-fable-5',
      provider: 'claude-cli',
      summary: 'the answer',
    };
    const { steerText, noticeText } = formatCompletion(completion);
    expect(steerText).toContain('spawn-1');
    expect(steerText).toContain('the answer');
    expect(noticeText).toBe('✓ agent spawn-1 done');
  });

  it('composes an error steer + notice (first error line only in the notice)', () => {
    const { steerText, noticeText } = formatCompletion({
      taskId: 'spawn-2',
      status: 'error',
      model: 'claude-fable-5',
      provider: 'claude-cli',
      error: 'sub-agent error: kaboom\nstack trace line',
    });
    expect(steerText).toContain('kaboom');
    expect(noticeText).toBe('✗ agent spawn-2 sub-agent error: kaboom');
  });

  it('falls back to a placeholder when a done result has no summary', () => {
    const { steerText } = formatCompletion({
      taskId: 'spawn-3',
      status: 'done',
      model: 'm',
      provider: 'p',
    });
    expect(steerText).toContain('(no output)');
  });
});
