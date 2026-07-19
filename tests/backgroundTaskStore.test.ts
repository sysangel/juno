// tests/backgroundTaskStore.test.ts — Wave 14 (lane b7-background-durability): the
// crash-durability store for background agents. Proves the CLOBBER GUARD
// (first-terminal-wins, no late-running overwrite, idempotent delivered re-write),
// serialized NDJSON output, fail-soft reads that skip malformed/torn data, and the
// PURE classifyRecords split. All fs is injected (in-memory maps).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRecords,
  createBackgroundTaskStore,
  type BackgroundOutputLine,
  type BackgroundTaskRecord,
} from '../src/services/backgroundTaskStore';

const ROOT = '/tmp/juno-bg-test';

/** An in-memory fs seam mirroring the paths the store writes. */
function memFs() {
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const enoent = (p: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const deps = {
    dir: ROOT,
    writeFile: async (p: string, data: string): Promise<void> => {
      files.set(p, data);
    },
    appendFile: async (p: string, data: string): Promise<void> => {
      files.set(p, (files.get(p) ?? '') + data);
    },
    readFile: async (p: string): Promise<string> => {
      const v = files.get(p);
      if (v === undefined) throw enoent(p);
      return v;
    },
    readdir: async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const p of files.keys()) {
        if (path.dirname(p) === dir) out.push(path.basename(p));
      }
      if (out.length === 0 && !mkdirs.includes(dir)) throw enoent(dir);
      return out;
    },
    mkdir: async (dir: string): Promise<void> => {
      mkdirs.push(dir);
    },
    now: (): number => 1000,
  };
  return { files, mkdirs, deps };
}

const subDir = (sessionId: string): string => path.join(ROOT, `${sessionId}.subagents`);

function baseRecord(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return {
    schemaVersion: 1,
    taskId: 'spawn-1',
    sessionId: 'sess-1',
    model: 'claude-fable-5',
    provider: 'claude-cli',
    description: 'do a thing',
    status: 'running',
    startedAt: 100,
    updatedAt: 100,
    delivered: false,
    ...overrides,
  };
}

describe('backgroundTaskStore — writeRecord', () => {
  it('persists a running record to <sessionId>.subagents/<taskId>.state.json, mkdir once', async () => {
    const { files, mkdirs, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord());
    await store.appendOutput('sess-1', 'spawn-1', { kind: 'lifecycle', event: 'spawn', ts: 100 });

    const file = path.join(subDir('sess-1'), 'spawn-1.state.json');
    expect(files.has(file)).toBe(true);
    expect(JSON.parse(files.get(file)!)).toEqual(baseRecord());
    // Lazy mkdir happens exactly once for the session dir despite two writes.
    expect(mkdirs.filter((d) => d === subDir('sess-1'))).toHaveLength(1);
  });

  it('sanitizes a namespaced task id into a safe filename segment', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ taskId: 'spawn-1::c1' }));
    expect(files.has(path.join(subDir('sess-1'), 'spawn-1__c1.state.json'))).toBe(true);
  });
});

describe('backgroundTaskStore — clobber guard', () => {
  const file = path.join(subDir('sess-1'), 'spawn-1.state.json');

  it('refuses a late running write after a terminal record (no overwrite)', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ status: 'done', summary: 's' }));
    await store.writeRecord(baseRecord({ status: 'running' }));
    expect(JSON.parse(files.get(file)!).status).toBe('done');
  });

  it('first terminal wins — done cannot flip to error', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ status: 'done', summary: 's' }));
    await store.writeRecord(baseRecord({ status: 'error', error: 'boom' }));
    expect(JSON.parse(files.get(file)!).status).toBe('done');
  });

  it('allows running → done (a genuine settle)', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ status: 'running' }));
    await store.writeRecord(baseRecord({ status: 'done', summary: 's' }));
    expect(JSON.parse(files.get(file)!).status).toBe('done');
  });

  it('allows an idempotent same-terminal re-write that flips only delivered', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ status: 'done', summary: 's', delivered: false }));
    await store.writeRecord(baseRecord({ status: 'done', summary: 's', delivered: true }));
    const parsed = JSON.parse(files.get(file)!);
    expect(parsed.status).toBe('done');
    expect(parsed.delivered).toBe(true);
  });
});

describe('backgroundTaskStore — appendOutput', () => {
  it('writes NDJSON lines in order and serialized under concurrent calls', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    const lines: BackgroundOutputLine[] = [
      { kind: 'lifecycle', event: 'spawn', ts: 1 },
      { kind: 'text', delta: 'Hello ', ts: 2 },
      { kind: 'reasoning', delta: 'hmm', ts: 3 },
      { kind: 'text', delta: 'world', ts: 4 },
    ];
    // Fire all without awaiting individually — the per-instance chain must serialize them.
    await Promise.all(lines.map((l) => store.appendOutput('sess-1', 'spawn-1', l)));

    const file = path.join(subDir('sess-1'), 'spawn-1.output.ndjson');
    const parsed = files
      .get(file)!
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsed).toEqual(lines);
  });
});

describe('backgroundTaskStore — readRecords', () => {
  it('returns valid records, skips a malformed file, [] on missing dir', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);

    // Missing dir → [].
    expect(await store.readRecords('nope')).toEqual([]);

    // Two valid records + one malformed + one non-state file (ignored by suffix).
    files.set(path.join(subDir('sess-1'), 'a.state.json'), JSON.stringify(baseRecord({ taskId: 'a' })));
    files.set(
      path.join(subDir('sess-1'), 'b.state.json'),
      JSON.stringify(baseRecord({ taskId: 'b', status: 'done' })),
    );
    files.set(path.join(subDir('sess-1'), 'bad.state.json'), '{not json');
    files.set(path.join(subDir('sess-1'), 'c.output.ndjson'), '{"kind":"text","delta":"x","ts":1}\n');

    const records = await store.readRecords('sess-1');
    expect(records.map((r) => r.taskId).sort()).toEqual(['a', 'b']);
  });
});

describe('backgroundTaskStore — readOutput', () => {
  it('concatenates text + reasoning, returns lifecycle, drops a torn final line', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    const file = path.join(subDir('sess-1'), 'spawn-1.output.ndjson');
    files.set(
      file,
      [
        JSON.stringify({ kind: 'lifecycle', event: 'spawn', ts: 0 }),
        JSON.stringify({ kind: 'text', delta: 'Hello ', ts: 1 }),
        JSON.stringify({ kind: 'reasoning', delta: 'think', ts: 2 }),
        JSON.stringify({ kind: 'text', delta: 'world', ts: 3 }),
        '{"kind":"text","delta":"tor', // torn (crash mid-append), no newline
      ].join('\n'),
    );
    const out = await store.readOutput('sess-1', 'spawn-1');
    expect(out.text).toBe('Hello world');
    expect(out.reasoning).toBe('think');
    expect(out.lifecycle).toEqual([{ kind: 'lifecycle', event: 'spawn', ts: 0 }]);
  });

  it('returns an empty result for a missing output file', async () => {
    const { deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    expect(await store.readOutput('sess-1', 'nope')).toEqual({
      text: '',
      reasoning: '',
      lifecycle: [],
    });
  });
});

describe('backgroundTaskStore — markDelivered', () => {
  it('read-modify-writes delivered:true on the terminal record (guard allows same status)', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.writeRecord(baseRecord({ status: 'done', summary: 's', delivered: false }));
    await store.markDelivered('sess-1', 'spawn-1');
    const parsed = JSON.parse(files.get(path.join(subDir('sess-1'), 'spawn-1.state.json'))!);
    expect(parsed.status).toBe('done');
    expect(parsed.delivered).toBe(true);
  });

  it('is a no-op when no durable record exists', async () => {
    const { files, deps } = memFs();
    const store = createBackgroundTaskStore(deps);
    await store.markDelivered('sess-1', 'ghost');
    expect(files.size).toBe(0);
  });
});

describe('classifyRecords (pure)', () => {
  it('interrupts a running record that is NOT live, rewriting status + endedAt', () => {
    const rec = baseRecord({ status: 'running', updatedAt: 500 });
    const { interrupted, undelivered } = classifyRecords([rec], new Set());
    expect(undelivered).toEqual([]);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.status).toBe('interrupted');
    expect(interrupted[0]!.endedAt).toBe(500);
  });

  it('excludes a running record that IS live (same-process resume guard)', () => {
    const rec = baseRecord({ status: 'running' });
    const { interrupted, undelivered } = classifyRecords([rec], new Set(['spawn-1']));
    expect(interrupted).toEqual([]);
    expect(undelivered).toEqual([]);
  });

  it('returns done/error records with delivered!==true as undelivered', () => {
    const done = baseRecord({ taskId: 'd', status: 'done', delivered: false });
    const err = baseRecord({ taskId: 'e', status: 'error', delivered: undefined });
    const { interrupted, undelivered } = classifyRecords([done, err], new Set());
    expect(interrupted).toEqual([]);
    expect(undelivered.map((r) => r.taskId).sort()).toEqual(['d', 'e']);
  });

  it('excludes delivered terminals and already-interrupted records from both lists', () => {
    const delivered = baseRecord({ taskId: 'd', status: 'done', delivered: true });
    const already = baseRecord({ taskId: 'i', status: 'interrupted' });
    const { interrupted, undelivered } = classifyRecords([delivered, already], new Set());
    expect(interrupted).toEqual([]);
    expect(undelivered).toEqual([]);
  });
});
