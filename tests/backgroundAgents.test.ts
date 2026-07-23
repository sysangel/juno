// tests/backgroundAgents.test.ts — Wave 13 (lane 1): the non-blocking
// background-agent runner. Proves spawn returns a handle SYNCHRONOUSLY (the parent
// is never pinned on the child), the child runs on a detached loop, its tool events
// surface through the INJECTED app dispatch (namespaced), {provider,model} stays
// pinned to the spawn-time entry, completion arrives as observable queue state, and
// abortAll stops a live task.
import { describe, expect, it } from 'vitest';
import type { ModelClient, Tool, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import type { Action } from '../src/core/reducer';
import type { ModelEntry } from '../src/services/catalog';
import { createPermissionPolicy } from '../src/permissions/policy';
import {
  BACKGROUND_SUMMARY_MAX_CHARS,
  BACKGROUND_TIMELINE_MAX_ENTRIES,
  BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS,
  createBackgroundAgentRunner,
  formatCompletion,
  type BackgroundCompletion,
} from '../src/services/backgroundAgents';
import type {
  BackgroundOutputLine,
  BackgroundTaskRecord,
  BackgroundTaskStore,
} from '../src/services/backgroundTaskStore';

const policy = createPermissionPolicy({ autoAllowSafe: true });

/**
 * An in-memory fake store faithful enough to exercise the runner's durability wiring:
 * it captures every writeRecord (with the SAME clobber guard the real store applies —
 * first-terminal-wins), serves readRecords/readOutput, and honours markDelivered. Used
 * only by the wave-14 b7 durability tests below.
 */
function fakeStore() {
  const records = new Map<string, BackgroundTaskRecord>();
  const output = new Map<string, BackgroundOutputLine[]>();
  const writeCalls: BackgroundTaskRecord[] = [];
  const TERMINAL = new Set(['done', 'error', 'interrupted']);
  const store: BackgroundTaskStore = {
    async writeRecord(rec) {
      writeCalls.push(rec);
      const prev = records.get(rec.taskId);
      if (prev !== undefined && TERMINAL.has(prev.status) && rec.status !== prev.status) return;
      records.set(rec.taskId, { ...rec });
    },
    async appendOutput(sessionId, taskId, line) {
      const key = `${sessionId}::${taskId}`;
      const arr = output.get(key) ?? [];
      arr.push(line);
      output.set(key, arr);
    },
    async readRecords(sessionId) {
      return [...records.values()].filter((r) => r.sessionId === sessionId).map((r) => ({ ...r }));
    },
    async readOutput(sessionId, taskId) {
      const arr = output.get(`${sessionId}::${taskId}`) ?? [];
      let text = '';
      let reasoning = '';
      const lifecycle: BackgroundOutputLine[] = [];
      for (const l of arr) {
        if (l.kind === 'text') text += l.delta;
        else if (l.kind === 'reasoning') reasoning += l.delta;
        else lifecycle.push(l);
      }
      return { text, reasoning, lifecycle };
    },
    async markDelivered(sessionId, taskId) {
      const rec = records.get(taskId);
      if (rec !== undefined && rec.sessionId === sessionId) {
        records.set(taskId, { ...rec, delivered: true });
      }
    },
  };
  return { store, records, output, writeCalls };
}

/** A one-shot client that also emits a reasoning delta (for write-through coverage). */
function reasoningClient(reasoning: string, summary: string): ModelClient {
  return {
    async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      yield { type: 'reasoning-delta', id: input.id, delta: reasoning };
      yield { type: 'text-delta', id: input.id, delta: summary };
      yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
    },
  };
}

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

function abortableClient(): ModelClient {
  return {
    async *streamTurn(input: TurnInput, _tools, signal): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
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
  it('checkpoints a disallowed child tool, redacts secrets, and resumes once without replay', async () => {
    let turns = 0;
    let runs = 0;
    const client: ModelClient = {
      async *streamTurn(input) {
        turns += 1;
        yield { type: 'assistant-start', id: input.id };
        if (turns === 1) {
          yield { type: 'tool-call', id: input.id, toolCallId: 'danger-1', name: 'danger', args: { path: 'x', apiKey: 'shh' } };
          yield { type: 'assistant-done', id: input.id, stopReason: 'tool_use' };
        } else {
          yield { type: 'text-delta', id: input.id, delta: 'finished' };
          yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
        }
      },
    };
    const danger: Tool = {
      name: 'danger', risk: 'dangerous',
      spec: { name: 'danger', description: 'test', inputSchema: { type: 'object' } },
      async run() { runs += 1; return { ok: true, data: 'ok' }; },
    };
    const memory = fakeStore();
    const runner = createBackgroundAgentRunner({ createClient: () => client, policy, cwd: '.', store: memory.store });
    runner.setSessionId('session-cap');
    runner.spawn({ spawnCardId: 'spawn-cap', task: 'do it', entry: claudeEntry, childTools: [danger], profile: 'coder' });

    await waitFor(() => runner.taskStatuses()['spawn-cap'] === 'waiting');
    expect(runs).toBe(0);
    expect(runner.pendingPermission?.('spawn-cap')).toMatchObject({
      toolCallId: 'danger-1', toolName: 'danger', sanitizedArgs: { path: 'x', apiKey: '[redacted]' },
    });
    expect(memory.records.get('spawn-cap')?.status).toBe('needs-user');
    expect(runner.resolvePermission?.('spawn-cap', 'allow-once')).toBe(true);
    await waitFor(() => runner.taskStatuses()['spawn-cap'] === 'done');
    expect(runs).toBe(1);
    expect(turns).toBe(2);
  });

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

  it('notifies subscribers on spawn, streamed output, and completion', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('hi'),
      policy,
      cwd: '.',
    });
    let notifications = 0;
    runner.setTimelineVisible?.(true);
    runner.subscribe(() => {
      notifications += 1;
    });
    const before = runner.getVersion();
    runner.spawn({ spawnCardId: 's', task: 't', entry: claudeEntry, childTools: [] });
    expect(runner.getVersion()).toBe(before + 1); // spawn bumped it
    expect(notifications).toBe(1);
    await waitFor(() => runner.taskStatuses()['s'] === 'done');
    expect(runner.getVersion()).toBe(before + 3); // streamed text + completion bumped it
    expect(notifications).toBe(3);
  });

  it('does not publish token-only timeline churn while the workspace is hidden', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('hi'),
      policy,
      cwd: '.',
    });
    let notifications = 0;
    runner.subscribe(() => {
      notifications += 1;
    });
    runner.spawn({ spawnCardId: 'hidden', task: 't', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses().hidden === 'done');
    expect(notifications).toBe(2); // spawn + completion; text stayed presentation-local
    expect(runner.taskSnapshots?.()[0]?.timeline).toEqual([
      expect.objectContaining({ kind: 'lifecycle', event: 'spawn' }),
      expect.objectContaining({ kind: 'text', delta: 'hi' }),
      expect.objectContaining({ kind: 'lifecycle', event: 'done' }),
    ]);
  });
});

describe('background-agent runner — workspace controls', () => {
  it('bounds long token streams without quadratic timeline or summary growth', async () => {
    const client: ModelClient = {
      async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        yield { type: 'assistant-start', id: input.id };
        for (let index = 0; index < 300; index += 1) {
          yield { type: 'text-delta', id: input.id, delta: 'x'.repeat(1_000) };
        }
        yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
      },
    };
    const runner = createBackgroundAgentRunner({ createClient: () => client, policy, cwd: '.' });
    runner.spawn({ spawnCardId: 'bounded', task: 'stream a lot', entry: claudeEntry, childTools: [] });

    await waitFor(() => runner.taskStatuses().bounded === 'done');
    const snapshot = runner.taskSnapshots?.()[0];
    expect(snapshot?.timeline.length).toBeLessThanOrEqual(BACKGROUND_TIMELINE_MAX_ENTRIES);
    const textLines = snapshot?.timeline.filter(
      (line): line is Extract<BackgroundOutputLine, { kind: 'text' }> => line.kind === 'text',
    ) ?? [];
    expect(Math.max(...textLines.map((line) => line.delta.length))).toBeLessThanOrEqual(
      BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS,
    );
    expect(snapshot?.summary?.length).toBeLessThan(
      BACKGROUND_SUMMARY_MAX_CHARS + 100,
    );
    expect(snapshot?.summary).toContain('agent output truncated by Juno');
  });

  it('projects a stable ordered timeline and truthful live capabilities', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => reasoningClient('consider ', 'finished'),
      policy,
      cwd: '.',
    });
    runner.spawn({
      spawnCardId: 'timeline-1',
      task: 'inspect the boundary',
      entry: claudeEntry,
      childTools: [],
      profile: 'reviewer',
    });

    const live = runner.taskSnapshots?.()[0];
    expect(live).toMatchObject({
      id: 'timeline-1',
      model: 'claude-fable-5',
      provider: 'claude-cli',
      status: 'running',
      description: 'inspect the boundary',
      profile: 'reviewer',
      capabilities: { steer: true, cancel: true, resolvePermission: false },
    });
    expect(live?.timeline).toEqual([
      expect.objectContaining({ kind: 'lifecycle', event: 'spawn' }),
    ]);

    await waitFor(() => runner.taskStatuses()['timeline-1'] === 'done');
    const settled = runner.taskSnapshots?.()[0];
    expect(settled?.status).toBe('done');
    expect(settled?.capabilities).toEqual({
      steer: false,
      cancel: false,
      resolvePermission: false,
    });
    expect(settled?.timeline.map((event) => event.kind)).toEqual([
      'lifecycle',
      'reasoning',
      'text',
      'lifecycle',
    ]);
    expect(settled?.timeline[1]).toMatchObject({ kind: 'reasoning', delta: 'consider ' });
    expect(settled?.timeline[2]).toMatchObject({ kind: 'text', delta: 'finished' });
  });

  it('accepts steering only while the selected agent is live', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = createBackgroundAgentRunner({ createClient: () => gatedClient(gate, 'done'), policy, cwd: '.' });
    runner.spawn({ spawnCardId: 'steer-1', task: 'work', entry: claudeEntry, childTools: [] });
    expect(runner.sendMessage?.('steer-1', '  check tests  ')).toBe(true);
    expect(runner.taskSnapshots?.()[0]?.timeline.at(-1)).toMatchObject({
      kind: 'steer',
      text: 'check tests',
    });
    expect(runner.sendMessage?.('missing', 'hello')).toBe(false);
    expect(runner.sendMessage?.('steer-1', '   ')).toBe(false);
    release();
    await waitFor(() => runner.taskStatuses()['steer-1'] === 'done');
    expect(runner.sendMessage?.('steer-1', 'too late')).toBe(false);
  });

  it('cancels one live agent without aborting its siblings', async () => {
    const runner = createBackgroundAgentRunner({ createClient: () => abortableClient(), policy, cwd: '.' });
    runner.spawn({ spawnCardId: 'cancel-1', task: 'one', entry: claudeEntry, childTools: [] });
    runner.spawn({ spawnCardId: 'keep-1', task: 'two', entry: claudeEntry, childTools: [] });
    expect(runner.cancel?.('cancel-1')).toBe(true);
    await waitFor(() => runner.taskStatuses()['cancel-1'] === 'aborted');
    expect(runner.taskStatuses()['keep-1']).toBe('running');
    expect(runner.cancel?.('cancel-1')).toBe(false);
    runner.abortAll();
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

    const toolTimeline = runner.taskSnapshots?.()[0]?.timeline.filter(
      (event) => event.kind === 'tool',
    );
    expect(toolTimeline).toEqual([
      expect.objectContaining({
        kind: 'tool', event: 'call', toolCallId: 'spawn-x::c1', name: 'read_file',
      }),
      expect.objectContaining({
        kind: 'tool', event: 'status', toolCallId: 'spawn-x::c1', status: 'running',
      }),
      expect.objectContaining({
        kind: 'tool', event: 'status', toolCallId: 'spawn-x::c1', status: 'result',
      }),
    ]);

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

describe('background-agent runner — bounded execution', () => {
  it('queues past the cap and promotes the oldest task when a slot frees', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clientsBuilt = 0;
    const runner = createBackgroundAgentRunner({
      createClient: () => {
        clientsBuilt += 1;
        return clientsBuilt === 1 ? gatedClient(gate, 'first') : textClient('second');
      },
      policy,
      cwd: '.',
      maxConcurrent: 1,
    });

    runner.spawn({ spawnCardId: 'first', task: 'one', entry: claudeEntry, childTools: [] });
    runner.spawn({ spawnCardId: 'second', task: 'two', entry: claudeEntry, childTools: [] });
    expect(runner.taskStatuses()).toEqual({ first: 'running', second: 'queued' });
    expect(clientsBuilt).toBe(1);

    release();
    await waitFor(() => runner.taskStatuses().first === 'done');
    await waitFor(() => runner.taskStatuses().second === 'done');
    expect(clientsBuilt).toBe(2);
  });

  it('cancels a queued task without ever constructing its provider', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clientsBuilt = 0;
    const runner = createBackgroundAgentRunner({
      createClient: () => {
        clientsBuilt += 1;
        return gatedClient(gate, 'first');
      },
      policy,
      cwd: '.',
      maxConcurrent: 1,
    });
    runner.spawn({ spawnCardId: 'live', task: 'one', entry: claudeEntry, childTools: [] });
    runner.spawn({ spawnCardId: 'parked', task: 'two', entry: claudeEntry, childTools: [] });

    expect(runner.cancel?.('parked')).toBe(true);
    expect(runner.taskStatuses().parked).toBe('aborted');
    expect(clientsBuilt).toBe(1);
    release();
    await waitFor(() => runner.taskStatuses().live === 'done');
  });

  it('drains queued work during abortAll and never starts it after teardown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clientsBuilt = 0;
    const runner = createBackgroundAgentRunner({
      createClient: () => {
        clientsBuilt += 1;
        return gatedClient(gate, 'first');
      },
      policy,
      cwd: '.',
      maxConcurrent: 1,
    });
    runner.spawn({ spawnCardId: 'live', task: 'one', entry: claudeEntry, childTools: [] });
    runner.spawn({ spawnCardId: 'parked', task: 'two', entry: claudeEntry, childTools: [] });

    runner.abortAll();
    expect(runner.taskStatuses().parked).toBe('aborted');
    release();
    await waitFor(() => runner.taskStatuses().live === 'error');
    await Promise.resolve();
    expect(clientsBuilt).toBe(1);
  });

  it('settles and frees the slot when the runner wall-clock timeout fires', async () => {
    let fire!: () => void;
    let cleared = false;
    const runner = createBackgroundAgentRunner({
      createClient: () => abortableClient(),
      policy,
      cwd: '.',
      maxConcurrent: 1,
      timeoutMs: 123,
      setTimer: (fn) => {
        fire = fn;
        return { clear: () => { cleared = true; } };
      },
    });
    runner.spawn({ spawnCardId: 'timed', task: 'one', entry: claudeEntry, childTools: [] });
    fire();

    await waitFor(() => runner.taskStatuses().timed === 'error');
    expect(runner.drainCompletions()[0]?.error).toBe('background agent timed out after 123ms');
    expect(cleared).toBe(true);
  });

  it('exposes spawn and newest-activity timestamps through the runner seam', async () => {
    let clock = 1_000;
    const runner = createBackgroundAgentRunner({
      createClient: () => toolCardClient('read_file'),
      policy,
      cwd: '.',
      now: () => clock,
    });
    runner.spawn({ spawnCardId: 'timing', task: 'one', entry: claudeEntry, childTools: [] });
    clock = 5_000;
    await waitFor(() => runner.taskStatuses().timing === 'done');
    expect(runner.taskTimings?.().timing).toEqual({
      startedAt: 1_000,
      lastActivityAt: 5_000,
    });
  });
});

describe('background-agent runner — durability (wave 14 b7)', () => {
  it('spawn writes an initial running record (pinned model/provider/sessionId, delivered:false) + spawn lifecycle', async () => {
    const { store, records, output } = fakeStore();
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('hi'),
      policy,
      cwd: '.',
      store,
    });
    runner.setSessionId('sess-A');
    runner.spawn({ spawnCardId: 'spawn-1', task: 'do a thing', entry: codexEntry, childTools: [] });

    // The initial running record is written SYNCHRONOUSLY at spawn (before the child settles).
    const initial = records.get('spawn-1');
    expect(initial).toMatchObject({
      schemaVersion: 1,
      taskId: 'spawn-1',
      sessionId: 'sess-A',
      model: 'gpt-5.6-sol',
      provider: 'codex-cli',
      description: 'do a thing',
      status: 'running',
      delivered: false,
    });
    expect(output.get('sess-A::spawn-1')).toEqual([
      { kind: 'lifecycle', event: 'spawn', ts: initial!.startedAt },
    ]);
  });

  it('writes child text + reasoning deltas through to the output log during the run', async () => {
    const { store } = fakeStore();
    const runner = createBackgroundAgentRunner({
      createClient: () => reasoningClient('pondering', 'the answer'),
      policy,
      cwd: '.',
      store,
    });
    runner.setSessionId('sess-A');
    runner.spawn({ spawnCardId: 'w', task: 't', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['w'] === 'done');

    const out = await runner.readOutput('sess-A', 'w');
    expect(out.text).toBe('the answer');
    expect(out.reasoning).toBe('pondering');
  });

  it('completion (done) persists a terminal record delivered:false + done lifecycle; the completion carries sessionId', async () => {
    const { store, records, output } = fakeStore();
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('result'),
      policy,
      cwd: '.',
      store,
    });
    runner.setSessionId('sess-A');
    runner.spawn({ spawnCardId: 'd', task: 't', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['d'] === 'done');

    expect(records.get('d')).toMatchObject({ status: 'done', delivered: false, summary: 'result' });
    expect(output.get('sess-A::d')?.some((l) => l.kind === 'lifecycle' && l.event === 'done')).toBe(
      true,
    );
    expect(runner.drainCompletions()[0]).toMatchObject({ taskId: 'd', sessionId: 'sess-A' });
  });

  it('abortAll persists the terminal record delivered:TRUE (so it does not resurface on resume)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, records } = fakeStore();
    const runner = createBackgroundAgentRunner({
      createClient: () => gatedClient(gate, 'never'),
      policy,
      cwd: '.',
      store,
    });
    runner.setSessionId('sess-A');
    runner.spawn({ spawnCardId: 'a', task: 't', entry: claudeEntry, childTools: [] });
    runner.abortAll();
    release();
    await waitFor(() => runner.taskStatuses()['a'] === 'error');
    expect(records.get('a')).toMatchObject({ status: 'error', delivered: true });
  });

  it('reconcile interrupts a dead running record, re-queues an undelivered done, skips a live id, and is idempotent', async () => {
    const { store, records } = fakeStore();
    // Seed a PRIOR process's records: one still-running (dead) task and one done-but-undelivered.
    await store.writeRecord({
      schemaVersion: 1,
      taskId: 'dead-1',
      sessionId: 'S',
      model: 'claude-fable-5',
      provider: 'claude-cli',
      description: 'stuck',
      status: 'running',
      startedAt: 1,
      updatedAt: 5,
      delivered: false,
    });
    await store.writeRecord({
      schemaVersion: 1,
      taskId: 'done-1',
      sessionId: 'S',
      model: 'claude-fable-5',
      provider: 'claude-cli',
      description: 'finished offscreen',
      status: 'done',
      startedAt: 1,
      updatedAt: 9,
      endedAt: 9,
      delivered: false,
      summary: 'the offscreen result',
    });

    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('x'),
      policy,
      cwd: '.',
      store,
    });

    const res = await runner.reconcile('S');
    expect(res.interrupted.map((r) => r.taskId)).toEqual(['dead-1']);
    expect(res.interrupted[0]!.status).toBe('interrupted');
    expect(res.undeliveredCompletions).toHaveLength(1);
    expect(res.undeliveredCompletions[0]).toMatchObject({
      taskId: 'done-1',
      status: 'done',
      sessionId: 'S',
      summary: 'the offscreen result',
    });
    // The interrupted flip was PERSISTED (running → interrupted).
    expect(records.get('dead-1')?.status).toBe('interrupted');

    // Simulate App surfacing the completion → mark it delivered.
    runner.markDelivered('S', 'done-1');
    await waitFor(() => records.get('done-1')?.delivered === true);

    // A second reconcile of the same session yields NOTHING (no duplicate notices/steers).
    const again = await runner.reconcile('S');
    expect(again.interrupted).toEqual([]);
    expect(again.undeliveredCompletions).toEqual([]);
  });

  it('reconcile does NOT interrupt a still-live detached task (same-process resume guard)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store } = fakeStore();
    const runner = createBackgroundAgentRunner({
      createClient: () => gatedClient(gate, 'later'),
      policy,
      cwd: '.',
      store,
    });
    runner.setSessionId('S');
    // A live task: its detached loop is still running, so its id is in `tasks`.
    runner.spawn({ spawnCardId: 'live-1', task: 't', entry: claudeEntry, childTools: [] });
    expect(runner.taskStatuses()['live-1']).toBe('running');

    const res = await runner.reconcile('S');
    // The live task's disk 'running' record is NOT flipped to interrupted.
    expect(res.interrupted).toEqual([]);

    // Clean up: let it finish so the detached loop settles.
    release();
    await waitFor(() => runner.taskStatuses()['live-1'] === 'done');
  });

  it('markDelivered flips delivered:true so a subsequent reconcile drops it from undelivered', async () => {
    const { store } = fakeStore();
    await store.writeRecord({
      schemaVersion: 1,
      taskId: 'u',
      sessionId: 'S',
      model: 'm',
      provider: 'p',
      description: 'd',
      status: 'error',
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
      delivered: false,
      error: 'boom',
    });
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('x'),
      policy,
      cwd: '.',
      store,
    });
    expect((await runner.reconcile('S')).undeliveredCompletions).toHaveLength(1);
    runner.markDelivered('S', 'u');
    await new Promise((r) => setTimeout(r, 5));
    expect((await runner.reconcile('S')).undeliveredCompletions).toEqual([]);
  });

  it('REGRESSION: a storeless runner no-ops every durability path (reconcile empty, spawn/complete never throw)', async () => {
    const runner = createBackgroundAgentRunner({
      createClient: () => textClient('hi'),
      policy,
      cwd: '.',
    });
    // No setSessionId, no store. Spawn + complete must behave exactly as before.
    runner.setSessionId('anything'); // no-op without a store
    runner.spawn({ spawnCardId: 'n', task: 't', entry: claudeEntry, childTools: [] });
    await waitFor(() => runner.taskStatuses()['n'] === 'done');
    expect(runner.drainCompletions()[0]).toMatchObject({ taskId: 'n', status: 'done' });
    // reconcile / readOutput / markDelivered are all safe no-ops.
    expect(await runner.reconcile('anything')).toEqual({
      interrupted: [],
      needsUser: [],
      undeliveredCompletions: [],
    });
    expect(await runner.readOutput('anything', 'n')).toEqual({
      text: '',
      reasoning: '',
      lifecycle: [],
    });
    expect(() => runner.markDelivered('anything', 'n')).not.toThrow();
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

  it('classifies explicit cancellation neutrally', () => {
    const { steerText, noticeText } = formatCompletion({
      taskId: 'spawn-4', status: 'aborted', model: 'm', provider: 'p',
    });
    expect(steerText).toContain('was cancelled');
    expect(noticeText).toBe('⊘ agent spawn-4 cancelled');
  });
});
