// tests/subagentRecorder.test.ts — Wave 7 Lane A: the per-subagent transcript
// recorder. Verifies JSONL meta+event lines, once-per-parent meta, parent
// resolution for tool-status via state.tools, filename sanitization, and that
// non-subagent (parentless) tool events are ignored. All I/O is injected.
import { describe, expect, it } from 'vitest';
import type { Action, State } from '../src/core/reducer';
import { initialState, reducer } from '../src/core/reducer';
import { createSubagentRecorder } from '../src/services/subagentRecorder';

interface Write {
  file: string;
  data: string;
}

function harness(sessionId = 'sess-1') {
  const writes: Write[] = [];
  const mkdirs: string[] = [];
  const recorder = createSubagentRecorder({
    sessionId,
    dir: '/tmp/juno-test-sessions',
    appendFile: async (file, data) => {
      writes.push({ file, data });
    },
    mkdir: async (dir) => {
      mkdirs.push(dir);
    },
    now: () => '2026-07-11T00:00:00.000Z',
  });
  return { recorder, writes, mkdirs };
}

/** Flush the recorder's internal write chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Apply actions through the real reducer to get a faithful post-reduction state. */
function stateAfter(...actions: Action[]): State {
  let state = initialState();
  state = { ...state, live: { id: 'a1', role: 'assistant', blocks: [], done: false } };
  for (const action of actions) {
    state = reducer(state, action);
  }
  return state;
}

const parentCall: Action = {
  t: 'tool-call',
  toolCallId: 'spawn-1',
  name: 'spawn_subagent',
  args: { task: 'refactor the parser', model: 'gpt-5.6-sol' },
};
const childCall: Action = {
  t: 'tool-call',
  toolCallId: 'spawn-1::c1',
  name: 'read_file',
  args: { path: 'a.ts' },
  parentToolUseId: 'spawn-1',
};

describe('subagent recorder', () => {
  it('writes a meta header once, then event lines, keyed by parent tool-use id', async () => {
    const { recorder, writes, mkdirs } = harness();
    const s1 = stateAfter(parentCall, childCall);
    recorder.record(childCall, s1);

    const running: Action = { t: 'tool-status', toolCallId: 'spawn-1::c1', status: 'running' };
    const s2 = reducer(s1, running);
    recorder.record(running, s2);

    await flush();

    expect(mkdirs).toEqual(['/tmp/juno-test-sessions/sess-1.subagents']);
    expect(writes.length).toBe(2);
    expect(writes[0]!.file).toBe('/tmp/juno-test-sessions/sess-1.subagents/spawn-1.jsonl');

    // First write: a meta header line THEN the tool-call event line.
    const firstLines = writes[0]!.data.trim().split('\n').map((l) => JSON.parse(l));
    expect(firstLines[0]).toEqual({
      kind: 'meta',
      toolUseId: 'spawn-1',
      name: 'spawn_subagent',
      description: 'refactor the parser',
      model: 'gpt-5.6-sol',
      startRef: '2026-07-11T00:00:00.000Z',
    });
    expect(firstLines[1]).toEqual({
      kind: 'event',
      event: {
        type: 'tool-call',
        toolCallId: 'spawn-1::c1',
        name: 'read_file',
        args: { path: 'a.ts' },
        parentToolUseId: 'spawn-1',
      },
    });

    // Second write: NO meta again — just the tool-status event.
    const secondLines = writes[1]!.data.trim().split('\n').map((l) => JSON.parse(l));
    expect(secondLines).toHaveLength(1);
    expect(secondLines[0]).toEqual({
      kind: 'event',
      event: { type: 'tool-status', toolCallId: 'spawn-1::c1', status: 'running' },
    });
  });

  it('resolves the parent for a tool-status via state.tools (delta/status carry no parent)', async () => {
    const { recorder, writes } = harness();
    const s1 = stateAfter(parentCall, childCall);
    const result: Action = {
      t: 'tool-status',
      toolCallId: 'spawn-1::c1',
      status: 'result',
      result: 'contents',
    };
    const s2 = reducer(s1, result);
    // Record ONLY the status (parent must come from state, not the action).
    recorder.record(result, s2);
    await flush();

    expect(writes).toHaveLength(1);
    const lines = writes[0]!.data.trim().split('\n').map((l) => JSON.parse(l));
    // Meta is emitted lazily on first sighting of this parent.
    expect(lines[0].kind).toBe('meta');
    expect(lines[1].event).toEqual({
      type: 'tool-status',
      toolCallId: 'spawn-1::c1',
      status: 'result',
      result: 'contents',
    });
  });

  it('ignores parentless (top-level) tool events — not subagent activity', async () => {
    const { recorder, writes, mkdirs } = harness();
    const topLevel: Action = { t: 'tool-call', toolCallId: 't1', name: 'read_file', args: {} };
    const s = stateAfter(topLevel);
    recorder.record(topLevel, s);
    // A status for that top-level call is likewise ignored.
    const status: Action = { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'x' };
    recorder.record(status, reducer(s, status));
    await flush();

    expect(writes).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
  });

  it('sanitizes a namespaced parent id into a safe filename segment', async () => {
    const { recorder, writes } = harness();
    // A grandchild whose parent id was namespaced by the orchestrator ("a::b").
    const grandParentCall: Action = {
      t: 'tool-call',
      toolCallId: 'spawn-1::c1',
      name: 'spawn_subagent',
      args: { task: 't' },
      parentToolUseId: 'spawn-1',
    };
    const grandChild: Action = {
      t: 'tool-call',
      toolCallId: 'spawn-1::c1::g1',
      name: 'read_file',
      args: {},
      parentToolUseId: 'spawn-1::c1',
    };
    const s = stateAfter(parentCall, grandParentCall, grandChild);
    recorder.record(grandChild, s);
    await flush();

    expect(writes).toHaveLength(1);
    expect(writes[0]!.file).toBe(
      '/tmp/juno-test-sessions/sess-1.subagents/spawn-1__c1.jsonl',
    );
  });

  it('describes a claude-cli native Agent parent from its description/prompt args', async () => {
    const { recorder, writes } = harness();
    const agentCall: Action = {
      t: 'tool-call',
      toolCallId: 'agent-42',
      name: 'Agent',
      args: { description: 'audit deps', subagent_type: 'general-purpose', prompt: 'go' },
    };
    const nativeChild: Action = {
      t: 'tool-call',
      toolCallId: 'agent-42-c1',
      name: 'Bash',
      args: { command: 'ls' },
      parentToolUseId: 'agent-42',
    };
    const s = stateAfter(agentCall, nativeChild);
    recorder.record(nativeChild, s);
    await flush();

    const meta = JSON.parse(writes[0]!.data.trim().split('\n')[0]!);
    expect(meta).toMatchObject({
      kind: 'meta',
      toolUseId: 'agent-42',
      description: 'audit deps',
      model: 'general-purpose',
    });
  });
});
