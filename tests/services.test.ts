import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Msg } from '../src/core/reducer';
import {
  DEFAULT_SETTINGS,
  createConfigService,
  createFakeConfigService,
  type Settings,
} from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import {
  CURRENT_FORMAT_VERSION,
  createMemorySessionStore,
  createMemoryTranscriptLog,
  createSessionStore,
  createTranscriptLog,
  type SessionMeta,
} from '../src/services/sessions';
import { createInMemoryMemoryStore, createMemoryStore } from '../src/services/memory';

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `juno-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config services', () => {
  it('returns fake settings and typed values', () => {
    const settings: Settings = {
      defaultProvider: 'test-provider',
      defaultModel: 'test-model',
      cwd: '/tmp/project',
      maxContext: 42,
    };

    const service = createFakeConfigService(settings);
    const model: string = service.getValue('defaultModel');

    expect(service.get()).toBe(settings);
    expect(model).toBe('test-model');
  });

  it('uses defaults when the config file is missing', async () => {
    const dir = await makeTempDir('config');
    const service = createConfigService({
      configPath: path.join(dir, 'missing.json'),
      env: {},
    });

    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('does not store or read provider secret values (apiKeyEnv is a name)', () => {
    const service = createFakeConfigService(DEFAULT_SETTINGS);
    const providers = service.get().providers;
    // The config holds the NAME of the env var, never the secret itself.
    expect(providers?.openai?.apiKeyEnv).toBe('OPENAI_API_KEY');
    const serialized = JSON.stringify(providers);
    expect(serialized.includes('sk-')).toBe(false);
  });

  it('applies env overrides over the config file and reloads from disk', async () => {
    const dir = await makeTempDir('config');
    const configPath = path.join(dir, 'config.json');

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      configPath,
      JSON.stringify({ defaultProvider: 'openai', defaultModel: DEFAULT_SETTINGS.defaultModel, cwd: '/from/file' }),
      'utf8',
    );

    const service = createConfigService({ configPath, env: { JUNO_MODEL: 'override-model' } });
    expect(service.get().defaultModel).toBe('override-model');
    expect(service.get().cwd).toBe('/from/file');

    await writeFile(
      configPath,
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'sonnet', cwd: '/from/file' }),
      'utf8',
    );
    // env override still wins for defaultModel; provider re-read from disk.
    const reloaded = service.reload();
    expect(reloaded.defaultModel).toBe('override-model');
    expect(reloaded.defaultProvider).toBe('anthropic');
  });

  it('keeps diagnostic tracing opt-in and allows a boolean env override', async () => {
    const dir = await makeTempDir('trace-config');
    const configPath = path.join(dir, 'config.json');
    expect(createConfigService({ configPath, env: {} }).get().trace).toBe(false);

    await writeFile(configPath, JSON.stringify({ trace: true }), 'utf8');
    expect(createConfigService({ configPath, env: {} }).get().trace).toBe(true);
    expect(createConfigService({ configPath, env: { JUNO_TRACE: '0' } }).get().trace).toBe(false);
    expect(createConfigService({ configPath, env: { JUNO_TRACE: 'invalid' } }).get().trace).toBe(true);
  });
});

describe('model catalog', () => {
  it('lists, resolves by id and alias, filters, and returns the default', () => {
    const catalog = createModelCatalog();
    const models = catalog.list();

    expect(models.length).toBeGreaterThan(0);

    const first = models[0];
    if (first === undefined) {
      throw new Error('expected a builtin model');
    }

    expect(catalog.resolve(first.id)).toEqual(first);

    const withAlias = models.find(
      (model) => model.aliases !== undefined && model.aliases.length > 0,
    );
    if (withAlias === undefined || withAlias.aliases?.[0] === undefined) {
      throw new Error('expected a builtin model alias');
    }

    expect(catalog.resolve(withAlias.aliases[0])).toEqual(withAlias);
    expect(catalog.resolve('definitely-not-a-model')).toBeUndefined();

    const byProvider = catalog.byProvider(first.provider);
    expect(byProvider.length).toBeGreaterThan(0);
    expect(byProvider.every((model) => model.provider === first.provider)).toBe(true);

    const defaultEntry = models.find((model) => model.default === true);
    expect(catalog.default()).toEqual(defaultEntry);
    expect(BUILTIN_MODELS.filter((m) => m.default === true)).toHaveLength(1);
  });

  it('accepts custom entries and falls back to the first when no default flag', () => {
    const catalog = createModelCatalog([
      { id: 'a', provider: 'p', label: 'A', contextWindow: 1000 },
      { id: 'b', provider: 'p', label: 'B', contextWindow: 2000, aliases: ['bee'] },
    ]);
    expect(catalog.list()).toHaveLength(2);
    expect(catalog.default()?.id).toBe('a');
    expect(catalog.resolve('bee')?.id).toBe('b');
  });

  it('deep-copies pricing on resolve so callers cannot mutate the shared entry', () => {
    const catalog = createModelCatalog();
    const first = catalog.resolve('z-ai/glm-5.2');
    if (first?.pricing === undefined) {
      throw new Error('expected z-ai/glm-5.2 to have pricing');
    }
    // Mutate the returned copy's pricing — must not leak back into the catalog.
    first.pricing.inputPerMTok = 999;

    const second = catalog.resolve('z-ai/glm-5.2');
    expect(second?.pricing?.inputPerMTok).toBe(0.56);
    expect(second?.pricing?.outputPerMTok).toBe(1.76);
  });

  it('every billable (non-subscription) entry carries pricing; subscription entries omit it', () => {
    const catalog = createModelCatalog();
    for (const entry of catalog.list()) {
      if (entry.provider === 'claude-cli' || entry.provider === 'codex-cli') {
        // Subscription backends (delegate CLIs): a $ chip would be a lie, so pricing
        // is absent for claude-cli AND every codex-cli (ChatGPT plan) entry.
        expect(entry.pricing).toBeUndefined();
      } else {
        expect(entry.pricing, `${entry.id} should have pricing`).toBeDefined();
        expect(entry.pricing?.inputPerMTok).toBeGreaterThan(0);
        expect(entry.pricing?.outputPerMTok).toBeGreaterThan(0);
      }
    }
  });
});

describe('session services (in-memory)', () => {
  it('round-trips sessions and transcripts', async () => {
    const store = createMemorySessionStore();
    const transcript = createMemoryTranscriptLog();

    expect(await store.load('missing')).toBeUndefined();
    expect(await transcript.read('missing')).toEqual([]);

    const meta: SessionMeta = {
      id: 'session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: DEFAULT_SETTINGS.defaultModel,
      cwd: '/tmp/project',
      title: 'Test session',
    };

    const firstMessage: Msg = {
      id: 'msg-1',
      turnId: 'turn-1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'block-1', text: 'hello' }],
      done: true,
      reasoning: 'kept',
      toolSnapshot: { sample: { status: 'result', name: 'read', args: { path: 'x' } } },
    };

    // A committed terminal-error line carries the `tone: 'error'` discriminator, which
    // must survive round-trip (the field is enumerated by parse/clone/serialize, not
    // preserve-unknown, so a missed hook would silently drop it). terminal-error-visibility.
    const secondMessage: Msg = {
      id: 'msg-2',
      role: 'system',
      blocks: [{ kind: 'text', id: 'block-2', text: 'provider 503' }],
      done: true,
      tone: 'error',
    };
    const compactionMarker: Msg = {
      id: 'compaction-notice-1',
      role: 'system',
      blocks: [{ kind: 'notice', id: 'compaction-notice-1:block:1', text: 'compacted 2 messages' }],
      done: true,
      compactionBoundary: { summaryText: 'durable summary', keepCount: 1 },
    };

    await store.create(meta);
    expect(await store.list()).toEqual([meta]);

    await store.save(meta.id, [firstMessage, secondMessage, compactionMarker]);
    const loaded = await store.load(meta.id);

    expect(loaded).toBeDefined();
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.messages).toHaveLength(3);
    expect(loaded?.messages[0]?.blocks[0]).toEqual(firstMessage.blocks[0]);
    expect(loaded?.messages[0]?.turnId).toBe('turn-1');
    expect(loaded?.messages[0]?.toolSnapshot).toEqual(firstMessage.toolSnapshot);
    expect(loaded?.messages[1]?.tone).toBe('error'); // discriminator preserved through the store
    expect(loaded?.messages[2]?.compactionBoundary).toEqual(compactionMarker.compactionBoundary);

    await transcript.append(meta.id, firstMessage);
    await transcript.append(meta.id, secondMessage);
    await transcript.append(meta.id, compactionMarker);

    const replayed = await transcript.read(meta.id);
    expect(replayed.map((message) => message.id)).toEqual([
      'msg-1',
      'msg-2',
      'compaction-notice-1',
    ]);
    expect(replayed[0]?.turnId).toBe('turn-1');
    expect(replayed[1]?.tone).toBe('error'); // and through the append-only transcript log
    expect(replayed[2]?.compactionBoundary).toEqual(compactionMarker.compactionBoundary);
  });
});

describe('session services (file-backed)', () => {
  it('round-trips meta + messages and transcript lines through a temp dir', async () => {
    const dir = await makeTempDir('sessions');
    const store = createSessionStore({ dir });
    const transcript = createTranscriptLog({ dir });

    // Missing id / empty dir must not throw.
    expect(await store.load('nope')).toBeUndefined();
    expect(await transcript.read('nope')).toEqual([]);
    expect(await store.list()).toEqual([]);

    const meta: SessionMeta = {
      id: 'abc',
      createdAt: '2026-05-01T12:00:00.000Z',
      title: 'persisted',
    };
    const message: Msg = {
      id: 'm-1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'm-1:block:1', text: 'on disk' }],
      done: true,
    };

    await store.create(meta);
    await store.save('abc', [message]);

    // The file-backed writer stamps the advisory format version onto the meta.
    const stampedMeta = { ...meta, formatVersion: CURRENT_FORMAT_VERSION };
    const loaded = await store.load('abc');
    expect(loaded?.meta).toEqual(stampedMeta);
    expect(loaded?.messages[0]?.blocks[0]).toEqual(message.blocks[0]);
    expect(await store.list()).toEqual([stampedMeta]);

    await transcript.append('abc', message);
    await transcript.append('abc', { ...message, id: 'm-2' });
    const lines = await transcript.read('abc');
    expect(lines.map((m) => m.id)).toEqual(['m-1', 'm-2']);

    await store.delete('abc');
    expect(await store.load('abc')).toBeUndefined();
  });
});

describe('session forward-compat (preserve-unknown + versioning)', () => {
  const sessionJsonPath = (dir: string, id: string): string =>
    path.join(dir, `${encodeURIComponent(id)}.json`);

  it('preserves an unknown block kind read->write unchanged (JSON store)', async () => {
    const dir = await makeTempDir('unknown-json');
    const store = createSessionStore({ dir });

    // Simulate a file written by a NEWER juno that emits an `image` block kind.
    const rawFile = {
      meta: { id: 'img', createdAt: '2026-06-01T00:00:00.000Z' },
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          done: true,
          blocks: [
            { kind: 'text', id: 'block-1', text: 'hello' },
            { kind: 'image', id: 'b1', url: 'x', w: 2 },
          ],
        },
      ],
    };
    await writeFile(sessionJsonPath(dir, 'img'), JSON.stringify(rawFile, null, 2), 'utf8');

    const loaded = await store.load('img');
    expect(loaded).toBeDefined();
    // The message is NOT dropped; the text block is intact; the image block is
    // surfaced as an opaque `unknown` passthrough carrying the ORIGINAL object.
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.blocks[0]).toEqual({ kind: 'text', id: 'block-1', text: 'hello' });
    expect(loaded?.messages[0]?.blocks[1]).toEqual({
      kind: 'unknown',
      id: 'b1',
      raw: { kind: 'image', id: 'b1', url: 'x', w: 2 },
    });

    // Write side: re-saving the loaded messages must reproduce the ORIGINAL block.
    await store.save('img', loaded!.messages);
    const reread = JSON.parse(await readFile(sessionJsonPath(dir, 'img'), 'utf8')) as {
      messages: Array<{ blocks: unknown[] }>;
    };
    expect(reread.messages[0]?.blocks[1]).toEqual({ kind: 'image', id: 'b1', url: 'x', w: 2 });
  });

  it('synthesizes a stable id for an unknown block that lacks one, without mutating raw', async () => {
    const dir = await makeTempDir('unknown-noid');
    const store = createSessionStore({ dir });

    const rawFile = {
      meta: { id: 'noid', createdAt: '2026-06-02T00:00:00.000Z' },
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          done: true,
          blocks: [{ kind: 'widget', foo: 1 }],
        },
      ],
    };
    await writeFile(sessionJsonPath(dir, 'noid'), JSON.stringify(rawFile), 'utf8');

    const first = await store.load('noid');
    const block = first?.messages[0]?.blocks[0];
    expect(block?.kind).toBe('unknown');
    expect(typeof block?.id).toBe('string');
    expect((block?.id ?? '').length).toBeGreaterThan(0);
    // The synthesized id is NOT written into raw (raw stays byte-identical).
    expect(block).toEqual({ kind: 'unknown', id: block?.id, raw: { kind: 'widget', foo: 1 } });

    // Stable across loads (same content -> same key).
    const second = await store.load('noid');
    expect(second?.messages[0]?.blocks[0]?.id).toBe(block?.id);
  });

  it('preserves an unknown block through the append-only transcript log', async () => {
    const dir = await makeTempDir('unknown-jsonl');
    const transcript = createTranscriptLog({ dir });

    const unknownMsg: Msg = {
      id: 'm-u',
      role: 'assistant',
      blocks: [{ kind: 'unknown', id: 'b1', raw: { kind: 'image', id: 'b1', url: 'z', h: 9 } }],
      done: true,
    };

    await transcript.append('tx', unknownMsg);

    const back = await transcript.read('tx');
    expect(back).toHaveLength(1);
    expect(back[0]?.blocks[0]).toEqual({
      kind: 'unknown',
      id: 'b1',
      raw: { kind: 'image', id: 'b1', url: 'z', h: 9 },
    });

    // The serialized line unwrapped the passthrough back to its raw form.
    const jsonl = await readFile(path.join(dir, 'tx.jsonl'), 'utf8');
    const parsed = JSON.parse(jsonl.trim()) as { blocks: unknown[] };
    expect(parsed.blocks[0]).toEqual({ kind: 'image', id: 'b1', url: 'z', h: 9 });
  });

  it('drops only genuinely malformed messages, not the whole JSON file', async () => {
    const dir = await makeTempDir('tolerant-json');
    const store = createSessionStore({ dir });

    const rawFile = {
      meta: { id: 'mix', createdAt: '2026-06-03T00:00:00.000Z' },
      messages: [
        { id: 'm1', role: 'user', done: true, blocks: [{ kind: 'text', id: 't1', text: 'a' }] },
        { id: 'm2', role: 'assistant', done: true, blocks: [{ kind: 'image', id: 'b1', url: 'x' }] },
        // blocks is not an array -> the ONLY thing dropped.
        { id: 'm3', role: 'user', done: true, blocks: 'nope' },
        // a block that is a non-record -> dropped.
        { id: 'm4', role: 'user', done: true, blocks: [42] },
        { id: 'm5', role: 'user', done: true, blocks: [{ kind: 'text', id: 't5', text: 'b' }] },
      ],
    };
    await writeFile(sessionJsonPath(dir, 'mix'), JSON.stringify(rawFile), 'utf8');

    const loaded = await store.load('mix');
    expect(loaded).toBeDefined();
    // Both good messages AND the unknown-bearing one survive; only m3/m4 dropped.
    expect(loaded?.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm5']);
    expect(loaded?.messages[1]?.blocks[0]).toEqual({
      kind: 'unknown',
      id: 'b1',
      raw: { kind: 'image', id: 'b1', url: 'x' },
    });
  });

  it('skips an unparseable JSONL line but keeps the valid lines around it', async () => {
    const dir = await makeTempDir('tolerant-jsonl');
    const transcript = createTranscriptLog({ dir });

    const l1 = JSON.stringify({
      id: 'm1',
      role: 'user',
      done: true,
      blocks: [{ kind: 'text', id: 't1', text: 'a' }],
    });
    const garbage = '{ this is not json';
    const l3 = JSON.stringify({
      id: 'm2',
      role: 'assistant',
      done: true,
      blocks: [{ kind: 'image', id: 'b1', url: 'q' }],
    });
    await writeFile(path.join(dir, 'gx.jsonl'), `${l1}\n${garbage}\n${l3}\n`, 'utf8');

    const back = await transcript.read('gx');
    expect(back.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(back[1]?.blocks[0]).toEqual({
      kind: 'unknown',
      id: 'b1',
      raw: { kind: 'image', id: 'b1', url: 'q' },
    });
  });

  it('stamps and surfaces formatVersion but never gates load on it', async () => {
    const dir = await makeTempDir('versioning');
    const store = createSessionStore({ dir });

    // create() writes the current version; load() surfaces it.
    await store.create({ id: 'v1', createdAt: '2026-06-04T00:00:00.000Z' });
    const rawCreated = JSON.parse(await readFile(sessionJsonPath(dir, 'v1'), 'utf8')) as {
      meta: { formatVersion?: number };
    };
    expect(rawCreated.meta.formatVersion).toBe(CURRENT_FORMAT_VERSION);

    await store.save('v1', []);
    const savedRaw = JSON.parse(await readFile(sessionJsonPath(dir, 'v1'), 'utf8')) as {
      meta: { formatVersion?: number };
    };
    expect(savedRaw.meta.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect((await store.load('v1'))?.meta.formatVersion).toBe(CURRENT_FORMAT_VERSION);

    // A legacy file with NO version still loads (advisory, not gated).
    await writeFile(
      sessionJsonPath(dir, 'legacy'),
      JSON.stringify({ meta: { id: 'legacy', createdAt: '2026-06-04T00:00:00.000Z' }, messages: [] }),
      'utf8',
    );
    const legacy = await store.load('legacy');
    expect(legacy).toBeDefined();
    expect(legacy?.meta.formatVersion).toBeUndefined();

    // A file from a HIGHER, unknown version still loads (not refused).
    await writeFile(
      sessionJsonPath(dir, 'future'),
      JSON.stringify({
        meta: { id: 'future', createdAt: '2026-06-04T00:00:00.000Z', formatVersion: CURRENT_FORMAT_VERSION + 99 },
        messages: [],
      }),
      'utf8',
    );
    const future = await store.load('future');
    expect(future).toBeDefined();
    expect(future?.meta.formatVersion).toBe(CURRENT_FORMAT_VERSION + 99);
  });

  it('round-trips reasoning start/end timestamps through save/load and the transcript', async () => {
    const dir = await makeTempDir('reasoning-ts');
    const store = createSessionStore({ dir });
    const transcript = createTranscriptLog({ dir });

    const msg: Msg = {
      id: 'r1',
      role: 'assistant',
      blocks: [{ kind: 'text', id: 't', text: 'hi' }],
      done: true,
      reasoning: 'think',
      reasoningStartedAt: 1000,
      reasoningEndedAt: 2000,
    };

    await store.create({ id: 'rs', createdAt: '2026-06-05T00:00:00.000Z' });
    await store.save('rs', [msg]);
    const loaded = await store.load('rs');
    expect(loaded?.messages[0]?.reasoningStartedAt).toBe(1000);
    expect(loaded?.messages[0]?.reasoningEndedAt).toBe(2000);

    await transcript.append('rs', msg);
    const back = await transcript.read('rs');
    expect(back[0]?.reasoningStartedAt).toBe(1000);
    expect(back[0]?.reasoningEndedAt).toBe(2000);
  });
});

describe('memory services (in-memory)', () => {
  it('round-trips memory entries', async () => {
    const store = createInMemoryMemoryStore({ maxBytes: 100 });

    await store.set('alpha', 'one', '2026-01-01T00:00:00.000Z');

    expect(await store.get('alpha')).toEqual({
      key: 'alpha',
      value: 'one',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await store.list()).toEqual([
      { key: 'alpha', value: 'one', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('evicts the oldest entry by updatedAt when over the byte limit', async () => {
    const store = createInMemoryMemoryStore({ maxBytes: 5 });

    await store.set('old', 'aa', '2026-01-01T00:00:00.000Z');
    await store.set('middle', 'bb', '2026-01-02T00:00:00.000Z');
    await store.set('new', 'ccc', '2026-01-03T00:00:00.000Z');

    expect(await store.get('old')).toBeUndefined();
    expect(await store.get('middle')).toEqual({
      key: 'middle',
      value: 'bb',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(await store.get('new')).toEqual({
      key: 'new',
      value: 'ccc',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(await store.size()).toBe(5);
  });
});

describe('memory services (file-backed)', () => {
  it('round-trips and enforces the byte bound through a temp dir', async () => {
    const dir = await makeTempDir('memory');
    const store = createMemoryStore({ dir, maxBytes: 4 });

    // Empty / missing file must not throw.
    expect(await store.get('nope')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.size()).toBe(0);

    await store.set('old', 'aa', '2026-01-01T00:00:00.000Z');
    // 'aa'(2) + 'ccc'(3) = 5 > maxBytes 4 -> evicts the oldest by updatedAt.
    await store.set('new', 'ccc', '2026-01-03T00:00:00.000Z');

    // A fresh file-backed instance over the same dir must read persisted state.
    const reopened = createMemoryStore({ dir, maxBytes: 4 });
    expect(await reopened.get('old')).toBeUndefined();
    expect((await reopened.get('new'))?.value).toBe('ccc');
    expect(await reopened.size()).toBe(3);

    await reopened.delete('new');
    expect(await reopened.get('new')).toBeUndefined();
    expect(await reopened.size()).toBe(0);
  });
});

const umsg = (id: string, text: string): Msg => ({
  id,
  role: 'user',
  blocks: [{ kind: 'text', id: `${id}:b`, text }],
  done: true,
});

describe('session services (concurrency + atomicity)', () => {
  it('interleaved concurrent saves are last-writer-wins with no torn file', async () => {
    const dir = await makeTempDir('sessions-race');
    const store = createSessionStore({ dir });
    await store.create({ id: 's1', createdAt: '2026-07-01T00:00:00.000Z' });

    // Build 20 saves synchronously WITHOUT awaiting between them. save() enqueues
    // on the id's chain in call order, so the queue runs them in index order — each
    // transcript a growing superset (length i+1, ids m0..mi). Without serialization
    // the racy read-then-write completions can land out of order and an OLDER, shorter
    // transcript clobbers the newest (empirically catches a reverted fix ~near-certainly,
    // where the 3-save version passed in the full-file run ~60% of the time).
    const saves = Array.from({ length: 20 }, (_, i) =>
      store.save(
        's1',
        Array.from({ length: i + 1 }, (_, j) => umsg(`m${j}`, `M${j}`)),
      ),
    );
    await Promise.all(saves);

    // The LAST enqueued transcript (20 messages) wins — older async completions
    // can't clobber it once the queue serializes the read-modify-writes.
    expect((await store.load('s1'))?.messages).toHaveLength(20);

    // The file parses cleanly as ONE complete transcript — never interleaved/torn.
    const parsed = JSON.parse(await readFile(path.join(dir, 's1.json'), 'utf8')) as {
      messages: { id: string }[];
    };
    expect(parsed.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${i}`),
    );
  });

  it('serializes per id — different sessions persist concurrently and independently', async () => {
    const dir = await makeTempDir('sessions-keys');
    const store = createSessionStore({ dir });
    await Promise.all([
      store.create({ id: 's1', createdAt: '2026-07-01T00:00:00.000Z' }),
      store.create({ id: 's2', createdAt: '2026-07-02T00:00:00.000Z' }),
    ]);

    await Promise.all([store.save('s1', [umsg('x', 'X')]), store.save('s2', [umsg('y', 'Y')])]);

    expect((await store.load('s1'))?.messages).toEqual([umsg('x', 'X')]);
    expect((await store.load('s2'))?.messages).toEqual([umsg('y', 'Y')]);
  });

  it('drain() awaits queued saves so a fresh store reads the last write', async () => {
    const dir = await makeTempDir('sessions-drain');
    const store = createSessionStore({ dir });
    await store.create({ id: 's1', createdAt: '2026-07-01T00:00:00.000Z' });

    // Enqueue several saves WITHOUT awaiting any of them.
    void store.save('s1', [umsg('a', 'A')]);
    void store.save('s1', [umsg('a', 'A'), umsg('b', 'B')]);
    const last = [umsg('a', 'A'), umsg('b', 'B'), umsg('c', 'C')];
    void store.save('s1', last);

    await store.drain?.();

    // A FRESH store over the same dir sees the last write already landed — proof
    // drain() resolved only after the pending writes completed.
    const fresh = createSessionStore({ dir });
    expect((await fresh.load('s1'))?.messages).toEqual(last);
  });
});

describe('memory services (concurrency + atomicity)', () => {
  it('concurrent set() to DIFFERENT keys never loses an update (cross-key)', async () => {
    const dir = await makeTempDir('memory-crosskey');
    const store = createMemoryStore({ dir }); // default 64 KiB → no eviction here

    // Fire without awaiting between them: both do a whole-file read-modify-write of
    // the single shared memory.json. Without serialization one update is lost.
    await Promise.all([
      store.set('a', '1', '2026-01-01T00:00:00.000Z'),
      store.set('b', '2', '2026-01-02T00:00:00.000Z'),
    ]);

    const fresh = createMemoryStore({ dir });
    expect((await fresh.get('a'))?.value).toBe('1'); // BOTH survive
    expect((await fresh.get('b'))?.value).toBe('2');
  });

  it('serializes set/delete on one chain in FIFO order', async () => {
    const dir = await makeTempDir('memory-order');
    const store = createMemoryStore({ dir });

    // set THEN delete on the same key → ends deleted.
    await Promise.all([
      store.set('x', 'v', '2026-01-01T00:00:00.000Z'),
      store.delete('x'),
    ]);
    expect(await store.get('x')).toBeUndefined();

    // delete THEN set on the same key → ends set.
    await Promise.all([
      store.delete('y'),
      store.set('y', 'w', '2026-01-02T00:00:00.000Z'),
    ]);
    expect((await store.get('y'))?.value).toBe('w');
  });

  it('drain() awaits queued sets so a fresh store reads them all', async () => {
    const dir = await makeTempDir('memory-drain');
    const store = createMemoryStore({ dir });

    void store.set('a', '1', '2026-01-01T00:00:00.000Z');
    void store.set('b', '2', '2026-01-02T00:00:00.000Z');
    void store.set('c', '3', '2026-01-03T00:00:00.000Z');

    await store.drain?.();

    const fresh = createMemoryStore({ dir });
    expect((await fresh.list()).map((entry) => entry.key)).toEqual(['a', 'b', 'c']);
  });
});
