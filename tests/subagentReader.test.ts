// tests/subagentReader.test.ts — Wave 7 Lane B: the READ side of the per-subagent
// recorder. Verifies the JSONL reconstructs into a live-shaped `tools` map that the
// panel selectors consume identically to the live path, that grandchild chains span
// files, that malformed lines are ignored, and that a recorder→reader roundtrip
// restores a resumed session's subagents (the finding's failure scenario).
import { describe, expect, it } from 'vitest';
import type { Action, State } from '../src/core/reducer';
import { initialState, reducer } from '../src/core/reducer';
import { createSubagentRecorder } from '../src/services/subagentRecorder';
import { reconstructSubagentTools, readSubagentTools } from '../src/services/subagentReader';
import { selectSubagents, selectSubagentTranscript } from '../src/core/selectors';

/** Serialize a recorder meta header line. */
function meta(fields: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'meta', startRef: '2026-07-11T00:00:00.000Z', ...fields });
}
/** Serialize a recorder event line. */
function ev(event: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'event', event });
}

describe('reconstructSubagentTools (pure)', () => {
  it('rebuilds a parent (from meta) + its children (from events) into a live-shaped map', () => {
    const file = [
      meta({ toolUseId: 'p1', name: 'spawn_subagent', description: 'summarize the repo', model: 'fable-mini' }),
      ev({ type: 'tool-call', toolCallId: 'c1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'p1' }),
      ev({ type: 'tool-status', toolCallId: 'c1', status: 'result', result: ['a.ts', 'b.ts'] }),
      ev({ type: 'tool-call', toolCallId: 'c2', name: 'run_shell', args: { command: 'echo hi' }, parentToolUseId: 'p1' }),
      ev({ type: 'tool-status', toolCallId: 'c2', status: 'result', result: 'hi' }),
    ].join('\n');

    const tools = reconstructSubagentTools([file]);
    // The child entries are faithful (name, status, result, parent link).
    expect(tools.c1).toMatchObject({ name: 'list_files', status: 'result', parentToolUseId: 'p1' });
    expect(tools.c2).toMatchObject({ name: 'run_shell', status: 'result', parentToolUseId: 'p1' });

    // selectSubagents rolls the disk map up exactly like the live path.
    const entries = selectSubagents({ tools });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'p1',
      name: 'spawn_subagent',
      description: 'summarize the repo',
      model: 'fable-mini',
      status: 'done', // a resumed/settled parent rolls up as done
      childCount: 2,
    });

    const rows = selectSubagentTranscript({ tools }, 'p1');
    expect(rows.map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  it('preserves the tool-status error race-guard (error is not clobbered by a later result)', () => {
    const file = [
      meta({ toolUseId: 'p1', name: 'Agent' }),
      ev({ type: 'tool-call', toolCallId: 'c1', name: 'Bash', args: {}, parentToolUseId: 'p1' }),
      ev({ type: 'tool-status', toolCallId: 'c1', status: 'error', error: 'boom' }),
      ev({ type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'late' }),
    ].join('\n');
    const tools = reconstructSubagentTools([file]);
    expect(tools.c1).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('spans a grandchild across files: the chain reaches the top parent', () => {
    // p1.jsonl records p1's direct child c1 (itself a subagent).
    const p1File = [
      meta({ toolUseId: 'p1', name: 'spawn_subagent', description: 'top' }),
      ev({ type: 'tool-call', toolCallId: 'c1', name: 'spawn_subagent', args: { task: 'nested' }, parentToolUseId: 'p1' }),
      ev({ type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' }),
    ].join('\n');
    // c1.jsonl records c1's own child g1 (p1's grandchild).
    const c1File = [
      meta({ toolUseId: 'c1', name: 'spawn_subagent', description: 'nested' }),
      ev({ type: 'tool-call', toolCallId: 'g1', name: 'read_file', args: { path: 'x.ts' }, parentToolUseId: 'c1' }),
      ev({ type: 'tool-status', toolCallId: 'g1', status: 'result', result: 'contents' }),
    ].join('\n');

    // File order must not matter — feed them reversed.
    const tools = reconstructSubagentTools([c1File, p1File]);
    // c1 keeps its authoritative child-derived entry (parent link to p1), NOT the meta.
    expect(tools.c1).toMatchObject({ name: 'spawn_subagent', parentToolUseId: 'p1' });
    // The grandchild's activity attributes up to the top ancestor p1.
    const rows = selectSubagentTranscript({ tools }, 'p1');
    expect(rows.map((r) => r.id).sort()).toEqual(['c1', 'g1']);
    // c1 lists as its own subagent row too (a nested subagent).
    const ids = selectSubagents({ tools }).map((e) => e.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('c1');
  });

  it('is fail-soft on malformed / blank / non-JSON lines', () => {
    const file = [
      '',
      'not json at all',
      '{"kind":"meta"}', // missing toolUseId → ignored
      meta({ toolUseId: 'p1', name: 'Task', description: 'ok' }),
      '{"kind":"event"}', // missing event → ignored
      ev({ type: 'tool-call', toolCallId: 'c1', name: 'Bash', args: {}, parentToolUseId: 'p1' }),
      ev({ type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'x' }),
      ev({ type: 'bogus-type', toolCallId: 'zz' }), // unknown event type → ignored
    ].join('\n');
    const tools = reconstructSubagentTools([file]);
    expect(Object.keys(tools).sort()).toEqual(['c1', 'p1']);
    expect(tools.zz).toBeUndefined();
    expect(selectSubagents({ tools })).toHaveLength(1);
  });
});

describe('readSubagentTools (fs-injected)', () => {
  it('lists the session dir, reads only .jsonl, and reconstructs', async () => {
    const files: Record<string, string> = {
      '/tmp/s/sess-1.subagents/p1.jsonl': [
        meta({ toolUseId: 'p1', name: 'spawn_subagent', description: 'work' }),
        ev({ type: 'tool-call', toolCallId: 'c1', name: 'Bash', args: {}, parentToolUseId: 'p1' }),
        ev({ type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' }),
      ].join('\n'),
      '/tmp/s/sess-1.subagents/notes.txt': 'ignore me',
    };
    const tools = await readSubagentTools({
      sessionId: 'sess-1',
      dir: '/tmp/s',
      readdir: async () => ['p1.jsonl', 'notes.txt'],
      readFile: async (file) => files[file] ?? Promise.reject(new Error('ENOENT')),
    });
    expect(selectSubagents({ tools })).toHaveLength(1);
    expect(tools.c1).toMatchObject({ name: 'Bash', parentToolUseId: 'p1' });
  });

  it('returns {} when the .subagents dir does not exist (fail-soft)', async () => {
    const tools = await readSubagentTools({
      sessionId: 'never',
      dir: '/tmp/s',
      readdir: async () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      readFile: async () => '',
    });
    expect(tools).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Roundtrip: recorder writes → reader restores a RESUMED session's subagents.
// This is the finding's failure scenario end to end.
// ---------------------------------------------------------------------------

function drive(actions: Action[]): State {
  return actions.reduce((s, a) => reducer(s, a), initialState());
}

describe('recorder → reader roundtrip restores subagents across a resume', () => {
  it('a resumed session (tools reset to {}) rehydrates the same panel entries from disk', async () => {
    // 1. A live turn with a subagent (parent p1 + two settled children).
    const script: Action[] = [
      { t: 'assistant-start', id: 'm1' },
      { t: 'tool-call', toolCallId: 'p1', name: 'spawn_subagent', args: { task: 'summarize the repo', model: 'fable-mini' } },
      { t: 'tool-status', toolCallId: 'p1', status: 'running' },
      { t: 'tool-call', toolCallId: 'c1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'p1' },
      { t: 'tool-status', toolCallId: 'c1', status: 'result', result: ['a.ts'] },
      { t: 'tool-call', toolCallId: 'c2', name: 'run_shell', args: { command: 'echo hi' }, parentToolUseId: 'p1' },
      { t: 'tool-status', toolCallId: 'c2', status: 'result', result: 'hi' },
      { t: 'tool-status', toolCallId: 'p1', status: 'result', result: 'done' },
    ];

    // 2. Feed each action + post-reduction state through the REAL recorder, capturing writes.
    const writes: Array<{ file: string; data: string }> = [];
    const recorder = createSubagentRecorder({
      sessionId: 'sess-1',
      dir: '/tmp/roundtrip',
      appendFile: async (file, data) => {
        writes.push({ file, data });
      },
      mkdir: async () => {},
      now: () => '2026-07-11T00:00:00.000Z',
    });
    let state: State = {
      ...initialState(),
      live: { id: 'm1', role: 'assistant', blocks: [], done: false },
    };
    for (const action of script) {
      state = reducer(state, action);
      recorder.record(action, state);
    }
    await new Promise((r) => setTimeout(r, 5)); // flush the recorder's write chain

    const liveEntries = selectSubagents(drive(script));
    expect(liveEntries).toHaveLength(1);

    // 3. Reconstruct per-file contents from the recorder's appends (grouped by file).
    const byFile = new Map<string, string>();
    for (const w of writes) byFile.set(w.file, (byFile.get(w.file) ?? '') + w.data);
    const tools = await readSubagentTools({
      sessionId: 'sess-1',
      dir: '/tmp/roundtrip',
      readdir: async () => [...byFile.keys()].map((f) => f.split('/').pop()!),
      readFile: async (file) => byFile.get(file) ?? Promise.reject(new Error('ENOENT')),
    });

    // 4. The resumed panel (from disk) matches the live panel on the durable fields.
    const diskEntries = selectSubagents({ tools });
    expect(diskEntries).toHaveLength(1);
    expect(diskEntries[0]).toMatchObject({
      id: 'p1',
      name: 'spawn_subagent',
      description: 'summarize the repo',
      model: 'fable-mini',
      childCount: 2,
    });
    // The transcript overlay body has both child steps, in order.
    expect(selectSubagentTranscript({ tools }, 'p1').map((r) => r.id)).toEqual(['c1', 'c2']);
  });
});
