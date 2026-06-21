```ts
// src/tools/memoryTools.ts
import { Buffer } from 'node:buffer';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import type { MemoryStore } from '../services/memory';

// ---------------------------------------------------------------------------
// Helpers (mirroring fileTools conventions)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MemoryToolsDeps {
  readonly store: MemoryStore;
  /** ISO‑8601 clock; injected for tests. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

export function createMemoryTools(deps: MemoryToolsDeps): Tool[] {
  const clock = deps.now ?? defaultNow;

  // -- remember_fact ---------------------------------------------------------
  const rememberFactSpec: ToolSpec = {
    name: 'remember_fact',
    description:
      'Persist a key‑value fact into long‑term memory. ' +
      'Use this to store important information the user wants you to remember across sessions. ' +
      'Keys and values must be non‑empty strings.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: {
          type: 'string',
          description: 'The fact name / lookup key (non‑empty).',
        },
        value: {
          type: 'string',
          description: 'The fact content (non‑empty).',
        },
      },
      required: ['key', 'value'],
    },
  };

  const rememberFact: Tool = {
    name: 'remember_fact',
    risk: 'risky',
    spec: rememberFactSpec,
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const key = args.key;
      const value = args.value;
      if (typeof key !== 'string' || key.length === 0 || typeof value !== 'string' || value.length === 0) {
        return { ok: false, error: 'invalid args' };
      }
      try {
        await deps.store.set(key, value, clock());
        return {
          ok: true,
          data: {
            key,
            bytesWritten: Buffer.byteLength(value, 'utf8'),
          },
        };
      } catch (e: unknown) {
        return { ok: false, error: errorMessage(e) };
      }
    },
  };

  // -- recall_facts ----------------------------------------------------------
  const recallFactsSpec: ToolSpec = {
    name: 'recall_facts',
    description:
      'Return every fact currently stored in long‑term memory. ' +
      'The result is an array of `{ key, value, updatedAt }` objects, sorted by `updatedAt` then `key`.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  };

  const recallFacts: Tool = {
    name: 'recall_facts',
    risk: 'safe',
    spec: recallFactsSpec,
    async run(_args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      try {
        const entries = await deps.store.list();
        const facts = entries.map((e) => ({
          key: e.key,
          value: e.value,
          updatedAt: e.updatedAt,
        }));
        return { ok: true, data: { facts } };
      } catch (e: unknown) {
        return { ok: false, error: errorMessage(e) };
      }
    },
  };

  return [rememberFact, recallFacts];
}
```

```ts
// src/tools/registry.ts
import type { Tool, ToolSpec } from '../core/contracts';
import type { SkillsService } from '../services/skills';
import { createFileTools } from './fileTools';
import { createSkillTool } from './skillTool';
import { createSubagentTool, type SubagentDeps } from './subagentTool';
import { createMemoryTools, type MemoryToolsDeps } from './memoryTools';

export interface DefaultToolsOptions {
  readonly skills?: SkillsService;
  readonly subagent?: Omit<SubagentDeps, 'childTools'>;
  readonly memory?: MemoryToolsDeps;
}

export function createDefaultTools(opts?: DefaultToolsOptions): Tool[] {
  const tools = createFileTools();
  if (opts?.skills !== undefined) {
    tools.push(createSkillTool(opts.skills));
  }
  if (opts?.subagent !== undefined) {
    const childTools = [...tools];
    tools.push(createSubagentTool({ ...opts.subagent, childTools }));
  }
  // Memory tools are added AFTER the subagent so they are NOT part of the
  // sub‑agent's childTools snapshot.
  if (opts?.memory !== undefined) {
    tools.push(...createMemoryTools(opts.memory));
  }
  return tools;
}

export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
```

```ts
// src/cli.ts
// (Only the relevant section is shown; the rest of the file remains unchanged.)
import { createMemoryStore } from './services/memory';
// ... other imports ...

// ... inside the main setup function, before createDefaultTools:
const memoryStore = createMemoryStore();

const tools = createDefaultTools({
  skills: skillsService,
  subagent: { createClient, catalog, policy, defaultModel: settings.defaultModel, agents },
  memory: { store: memoryStore },
});
```

```ts
// tests/memoryTools.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import type { ToolCtx, State } from '../src/core/contracts';
import { createMemoryTools } from '../src/tools/memoryTools';
import { createInMemoryMemoryStore, type MemoryStore } from '../src/services/memory';
import { createDefaultTools } from '../src/tools/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-06-21T00:00:00.000Z';

function fakeCtx(): ToolCtx {
  // Minimal Readonly<State> shape used by tools.test.ts
  const fakeState = {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle' as const,
    overlay: 'none' as const,
    effort: 'medium' as const,
    permissionMode: 'default' as const,
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
    errorMessage: null,
  } satisfies Readonly<State>;

  return {
    cwd: '',
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async () => 'allow-once',
    state: fakeState as unknown as Readonly<State>, // safe cast – tools don't read state
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memoryTools', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createInMemoryMemoryStore();
  });

  describe('remember_fact', () => {
    it('persists a fact and returns ok with bytesWritten', async () => {
      const [remember] = createMemoryTools({ store, now: () => FIXED_NOW });
      const result = await remember.run({ key: 'greeting', value: 'hello' }, fakeCtx());

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        key: 'greeting',
        bytesWritten: Buffer.byteLength('hello', 'utf8'),
      });

      const entries = await store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        key: 'greeting',
        value: 'hello',
        updatedAt: FIXED_NOW,
      });
    });

    it('rejects missing or empty key / value', async () => {
      const [remember] = createMemoryTools({ store, now: () => FIXED_NOW });
      const ctx = fakeCtx();

      const cases = [
        {},
        { key: '' },
        { value: '' },
        { key: '', value: '' },
        { key: 'a', value: '' },
        { key: '', value: 'b' },
        { key: 123, value: 'b' }, // not a string
        { key: 'a', value: 456 },
      ];

      for (const args of cases) {
        const result = await remember.run(args, ctx);
        expect(result.ok).toBe(false);
        expect(result.error).toBe('invalid args');
      }

      const entries = await store.list();
      expect(entries).toHaveLength(0);
    });

    it('wraps store errors', async () => {
      // Simulate a store that throws
      const brokenStore: MemoryStore = {
        ...store,
        set: () => Promise.reject(new Error('disk full')),
      };
      const [remember] = createMemoryTools({ store: brokenStore, now: () => FIXED_NOW });
      const result = await remember.run({ key: 'x', value: 'y' }, fakeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toBe('disk full');
    });
  });

  describe('recall_facts', () => {
    it('returns all facts sorted by updatedAt then key', async () => {
      const [remember, recall] = createMemoryTools({ store, now: () => FIXED_NOW });
      const ctx = fakeCtx();

      // Insert two facts
      await remember.run({ key: 'b', value: '2' }, ctx);
      await remember.run({ key: 'a', value: '1' }, ctx);

      const result = await recall.run({}, ctx);
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        facts: [
          { key: 'b', value: '2', updatedAt: FIXED_NOW },
          { key: 'a', value: '1', updatedAt: FIXED_NOW },
        ],
      });
    });

    it('returns empty array when store is empty', async () => {
      const [, recall] = createMemoryTools({ store, now: () => FIXED_NOW });
      const result = await recall.run({}, fakeCtx());
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ facts: [] });
    });

    it('wraps store errors', async () => {
      const brokenStore: MemoryStore = {
        ...store,
        list: () => Promise.reject(new Error('read error')),
      };
      const [, recall] = createMemoryTools({ store: brokenStore, now: () => FIXED_NOW });
      const result = await recall.run({}, fakeCtx());
      expect(result.ok).toBe(false);
      expect(result.error).toBe('read error');
    });
  });

  describe('registry integration', () => {
    it('includes memory tools when opts.memory is provided', () => {
      const tools = createDefaultTools({ memory: { store } });
      const names = tools.map((t) => t.name);
      expect(names).toContain('remember_fact');
      expect(names).toContain('recall_facts');

      const remember = tools.find((t) => t.name === 'remember_fact')!;
      const recall = tools.find((t) => t.name === 'recall_facts')!;
      expect(remember.risk).toBe('risky');
      expect(recall.risk).toBe('safe');
    });

    it('does NOT include memory tools when no opts.memory', () => {
      const tools = createDefaultTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('remember_fact');
      expect(names).not.toContain('recall_facts');
    });

    it('places memory tools AFTER subagent when both are present', () => {
      // Minimal subagent deps – we only need the tool to exist
      const subagentDeps = {
        createClient: () => ({} as any), // not used in this test
        catalog: {} as any,
        policy: {} as any,
        defaultModel: 'test-model',
        agents: {},
      };
      const tools = createDefaultTools({
        memory: { store },
        subagent: subagentDeps,
      });

      const subagentIdx = tools.findIndex((t) => t.name === 'spawn_subagent');
      const rememberIdx = tools.findIndex((t) => t.name === 'remember_fact');
      const recallIdx = tools.findIndex((t) => t.name === 'recall_facts');

      expect(subagentIdx).toBeGreaterThan(-1);
      expect(rememberIdx).toBeGreaterThan(subagentIdx);
      expect(recallIdx).toBeGreaterThan(subagentIdx);
    });
  });
});
```
