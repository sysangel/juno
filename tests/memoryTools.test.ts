// tests/memoryTools.test.ts
// Tool-driven memory suite. Deterministic: an in-memory MemoryStore + an injected
// fixed clock; no real fs, no network, no Date.now/Math.random. Mirrors the
// tools.test.ts ToolCtx-fake pattern.
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { ModelClient, Tool, ToolCtx } from '../src/core/contracts';
import type { PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import type { MemoryEntry, MemoryStore } from '../src/services/memory';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { DEFAULT_SETTINGS } from '../src/services/config';
import { createInMemoryMemoryStore } from '../src/services/memory';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createMemoryTools } from '../src/tools/memoryTools';
import { createDefaultTools } from '../src/tools/registry';

const FIXED_TIME = '2026-06-21T00:00:00.000Z';

interface RememberFactData {
  key: string;
  bytesWritten: number;
}

interface RecallFactsData {
  facts: MemoryEntry[];
}

/** A minimal, real Readonly<State> for ToolCtx — no `any`, no unsafe cast. */
function fakeState(): Readonly<State> {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermission: null,
    errorMessage: null,
  };
}

function createCtx(): ToolCtx {
  return {
    cwd: '',
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    state: fakeState(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.value === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function rememberData(value: unknown): RememberFactData {
  if (!isRecord(value)) {
    throw new Error('remember_fact data was not an object');
  }
  const key = value.key;
  const bytesWritten = value.bytesWritten;
  if (typeof key !== 'string' || typeof bytesWritten !== 'number') {
    throw new Error('remember_fact data had the wrong shape');
  }
  return { key, bytesWritten };
}

function recallData(value: unknown): RecallFactsData {
  if (!isRecord(value)) {
    throw new Error('recall_facts data was not an object');
  }
  const rawFacts = value.facts;
  if (!Array.isArray(rawFacts)) {
    throw new Error('recall_facts data had no facts array');
  }
  const facts: MemoryEntry[] = [];
  for (const fact of rawFacts) {
    if (!isMemoryEntry(fact)) {
      throw new Error('recall_facts returned a malformed fact');
    }
    facts.push({ key: fact.key, value: fact.value, updatedAt: fact.updatedAt });
  }
  return { facts };
}

function requireTool(tools: ReadonlyArray<Tool>, name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

function createMemoryToolset(store: MemoryStore): { remember: Tool; recall: Tool } {
  const tools = createMemoryTools({ store, now: () => FIXED_TIME });
  return {
    remember: requireTool(tools, 'remember_fact'),
    recall: requireTool(tools, 'recall_facts'),
  };
}

function toolIndex(tools: ReadonlyArray<Tool>, name: string): number {
  return tools.findIndex((tool) => tool.name === name);
}

// Real (no-`any`) subagent deps so the registry can build spawn_subagent.
const subagentDeps = {
  createClient: (): ModelClient => ({
    async *streamTurn() {
      /* unused in registry wiring */
    },
  }),
  catalog: createModelCatalog(BUILTIN_MODELS),
  policy: createPermissionPolicy({ autoAllowSafe: true }),
  defaultModel: DEFAULT_SETTINGS.defaultModel,
};

describe('memory tools', () => {
  it('remember_fact persists a valid fact and reports bytesWritten', async () => {
    const store = createInMemoryMemoryStore();
    const { remember } = createMemoryToolset(store);
    const key = 'user.preference.editor';
    const value = 'Use vim keybindings';

    const result = await remember.run({ key, value }, createCtx());

    expect(result.ok).toBe(true);
    expect(rememberData(result.data)).toEqual({
      key,
      bytesWritten: Buffer.byteLength(value, 'utf8'),
    });
    await expect(store.list()).resolves.toEqual([{ key, value, updatedAt: FIXED_TIME }]);
  });

  it('remember_fact rejects missing or empty key/value and leaves the store empty', async () => {
    const store = createInMemoryMemoryStore();
    const { remember } = createMemoryToolset(store);
    const invalidArgs: unknown[] = [
      undefined,
      {},
      { value: 'value' },
      { key: '', value: 'value' },
      { key: 'key' },
      { key: 'key', value: '' },
      { key: 123, value: 'value' },
      { key: 'key', value: 456 },
    ];

    for (const args of invalidArgs) {
      await expect(remember.run(args, createCtx())).resolves.toEqual({
        ok: false,
        error: 'invalid args',
      });
    }

    await expect(store.list()).resolves.toEqual([]);
  });

  it('remember_fact wraps a store error as { ok:false }', async () => {
    const base = createInMemoryMemoryStore();
    const brokenStore: MemoryStore = {
      ...base,
      set: () => Promise.reject(new Error('disk full')),
    };
    const { remember } = createMemoryToolset(brokenStore);

    await expect(remember.run({ key: 'x', value: 'y' }, createCtx())).resolves.toEqual({
      ok: false,
      error: 'disk full',
    });
  });

  it('recall_facts returns all remembered facts sorted by updatedAt then key', async () => {
    const store = createInMemoryMemoryStore();
    const { remember, recall } = createMemoryToolset(store);

    expect((await remember.run({ key: 'b', value: 'second' }, createCtx())).ok).toBe(true);
    expect((await remember.run({ key: 'a', value: 'first' }, createCtx())).ok).toBe(true);

    const result = await recall.run({}, createCtx());

    expect(result.ok).toBe(true);
    expect(recallData(result.data)).toEqual({
      facts: [
        { key: 'a', value: 'first', updatedAt: FIXED_TIME },
        { key: 'b', value: 'second', updatedAt: FIXED_TIME },
      ],
    });
  });

  it('recall_facts returns an empty facts array for an empty store', async () => {
    const store = createInMemoryMemoryStore();
    const { recall } = createMemoryToolset(store);

    await expect(recall.run(undefined, createCtx())).resolves.toEqual({
      ok: true,
      data: { facts: [] },
    });
  });

  it('recall_facts wraps a store error as { ok:false }', async () => {
    const base = createInMemoryMemoryStore();
    const brokenStore: MemoryStore = {
      ...base,
      list: () => Promise.reject(new Error('read error')),
    };
    const { recall } = createMemoryToolset(brokenStore);

    await expect(recall.run({}, createCtx())).resolves.toEqual({
      ok: false,
      error: 'read error',
    });
  });

  it('registry includes memory tools only when memory deps are provided, with pinned risk levels', () => {
    const store = createInMemoryMemoryStore();
    const withMemory = createDefaultTools({ memory: { store } });
    const base = createDefaultTools();

    expect(withMemory.map((tool) => tool.name)).toContain('remember_fact');
    expect(withMemory.map((tool) => tool.name)).toContain('recall_facts');
    // No-opts BUILTIN set stays exactly the native file tools.
    expect(base.map((tool) => tool.name).sort()).toEqual([
      'apply_patch',
      'edit_file',
      'glob_files',
      'grep',
      'list_files',
      'read_file',
      'tree',
      'write_file',
    ]);
    expect(requireTool(withMemory, 'remember_fact').risk).toBe('risky');
    expect(requireTool(withMemory, 'recall_facts').risk).toBe('safe');
  });

  it('registry appends memory tools after spawn_subagent so sub-agents do not inherit them', () => {
    const store = createInMemoryMemoryStore();
    const tools = createDefaultTools({
      subagent: subagentDeps,
      memory: { store },
    });

    const spawnIndex = toolIndex(tools, 'spawn_subagent');
    const rememberIndex = toolIndex(tools, 'remember_fact');
    const recallIndex = toolIndex(tools, 'recall_facts');

    expect(spawnIndex).toBeGreaterThanOrEqual(0);
    expect(rememberIndex).toBeGreaterThan(spawnIndex);
    expect(recallIndex).toBeGreaterThan(spawnIndex);
  });
});
