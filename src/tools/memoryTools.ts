// src/tools/memoryTools.ts
// Tool-driven memory — the explicit `remember_fact` / `recall_facts` tools.
// Module-level factory mirroring skillTool.ts / fileTools.ts: pure beyond the
// injected MemoryStore. The clock is INJECTED (no Date.now inside tools) so the
// store's `updatedAt` is deterministic under test. Tools NEVER throw — store/IO
// errors become { ok:false, error }. NO workspace jail: the store owns its own
// path + byte bound, so ctx.cwd is untouched.
import { Buffer } from 'node:buffer';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import type { MemoryStore } from '../services/memory';

export interface MemoryToolsDeps {
  readonly store: MemoryStore;
  /** ISO-8601 clock; defaults to () => new Date().toISOString(). Injected for tests. */
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The `MemoryStore.list()` interface declares no ordering guarantee, so the
// tool sorts its own output (updatedAt then key) to honour the contract stated
// in recallFactsSpec regardless of any store implementation's return order.
function compareFacts(
  left: { key: string; updatedAt: string },
  right: { key: string; updatedAt: string },
): number {
  const updated = left.updatedAt.localeCompare(right.updatedAt);
  return updated === 0 ? left.key.localeCompare(right.key) : updated;
}

const rememberFactSpec: ToolSpec = {
  name: 'remember_fact',
  description:
    'Persist one durable fact for later recall. Use this only for stable facts, preferences, or decisions the user wants Juno to remember explicitly. Keys and values must be non-empty strings.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      key: {
        type: 'string',
        description: 'Non-empty stable identifier for the fact, such as user.preference.editor.',
      },
      value: {
        type: 'string',
        description: 'Non-empty UTF-8 text value to remember for this key.',
      },
    },
    required: ['key', 'value'],
  },
};

const recallFactsSpec: ToolSpec = {
  name: 'recall_facts',
  description:
    'Recall every durable fact previously stored with remember_fact. Returns an array of { key, value, updatedAt } objects, sorted by updatedAt then key.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: [],
  },
};

function createRememberFactTool(deps: MemoryToolsDeps): Tool {
  const now = deps.now ?? defaultNow;
  return {
    name: 'remember_fact',
    risk: 'risky',
    spec: rememberFactSpec,
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }

      const key = stringProp(args, 'key');
      const value = stringProp(args, 'value');
      if (key === undefined || key.length === 0 || value === undefined || value.length === 0) {
        return { ok: false, error: 'invalid args' };
      }

      try {
        await deps.store.set(key, value, now());
        // store.set enforces the byte bound by evicting entries, which can drop
        // the fact we just wrote (e.g. a value larger than the bound). The tool
        // promises a *durable, recallable* fact, so confirm the key survived
        // rather than assuming a successful set means it remains recallable.
        const persisted = await deps.store.get(key);
        if (persisted === undefined || persisted.value !== value) {
          return {
            ok: false,
            error: 'fact not persisted: value exceeds the memory store byte limit',
          };
        }
        return {
          ok: true,
          data: { key, bytesWritten: Buffer.byteLength(value, 'utf8') },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function createRecallFactsTool(store: MemoryStore): Tool {
  return {
    name: 'recall_facts',
    risk: 'safe',
    spec: recallFactsSpec,
    async run(_args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      try {
        const facts = await store.list();
        return {
          ok: true,
          data: {
            facts: facts
              .map((entry) => ({
                key: entry.key,
                value: entry.value,
                updatedAt: entry.updatedAt,
              }))
              .sort(compareFacts),
          },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

/** Build the two durable-memory tools over a MemoryStore. Returns
 * [remember_fact, recall_facts] in that order. */
export function createMemoryTools(deps: MemoryToolsDeps): Tool[] {
  return [createRememberFactTool(deps), createRecallFactsTool(deps.store)];
}
