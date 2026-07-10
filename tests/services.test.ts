import { mkdtemp, rm } from 'node:fs/promises';
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
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-4.1', cwd: '/from/file' }),
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

  it('every billable (non-subscription) entry carries pricing; the subscription entry omits it', () => {
    const catalog = createModelCatalog();
    for (const entry of catalog.list()) {
      if (entry.provider === 'claude-cli') {
        // Subscription backend: a $ chip would be a lie, so pricing is absent.
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
      model: 'gpt-4.1',
      cwd: '/tmp/project',
      title: 'Test session',
    };

    const firstMessage: Msg = {
      id: 'msg-1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'block-1', text: 'hello' }],
      done: true,
      reasoning: 'kept',
      toolSnapshot: { sample: { status: 'result', name: 'read', args: { path: 'x' } } },
    };

    const secondMessage: Msg = {
      id: 'msg-2',
      role: 'assistant',
      blocks: [{ kind: 'text', id: 'block-2', text: 'hi' }],
      done: true,
    };

    await store.create(meta);
    expect(await store.list()).toEqual([meta]);

    await store.save(meta.id, [firstMessage]);
    const loaded = await store.load(meta.id);

    expect(loaded).toBeDefined();
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.blocks[0]).toEqual(firstMessage.blocks[0]);
    expect(loaded?.messages[0]?.toolSnapshot).toEqual(firstMessage.toolSnapshot);

    await transcript.append(meta.id, firstMessage);
    await transcript.append(meta.id, secondMessage);

    expect((await transcript.read(meta.id)).map((message) => message.id)).toEqual([
      'msg-1',
      'msg-2',
    ]);
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

    const loaded = await store.load('abc');
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.messages[0]?.blocks[0]).toEqual(message.blocks[0]);
    expect(await store.list()).toEqual([meta]);

    await transcript.append('abc', message);
    await transcript.append('abc', { ...message, id: 'm-2' });
    const lines = await transcript.read('abc');
    expect(lines.map((m) => m.id)).toEqual(['m-1', 'm-2']);

    await store.delete('abc');
    expect(await store.load('abc')).toBeUndefined();
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
