I couldn’t write these into the repo or run the verification commands because this session’s filesystem is read-only. Below are the complete file contents.

### `src/tools/memoryTools.ts`
```ts
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

const rememberFactSpec: ToolSpec = {
  name: 'remember_fact',
  description:
    'Persist one durable fact for later recall. Use this only for stable facts, preferences, or decisions the user wants Juno to remember explicitly.',
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
  description: 'Recall every durable fact previously stored with remember_fact.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: [],
  },
};

function createRememberFactTool(deps: MemoryToolsDeps): Tool {
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
        await deps.store.set(key, value, (deps.now ?? defaultNow)());
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
            facts: facts.map((entry) => ({
              key: entry.key,
              value: entry.value,
              updatedAt: entry.updatedAt,
            })),
          },
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

export function createMemoryTools(deps: MemoryToolsDeps): Tool[] {
  return [createRememberFactTool(deps), createRecallFactsTool(deps.store)];
}
```

### `src/tools/registry.ts`
```ts
// src/tools/registry.ts
// W7 — the v1 tool registry. No bash/shell in v1.
import type { Tool, ToolSpec } from '../core/contracts';
import type { SkillsService } from '../services/skills';
import { createFileTools } from './fileTools';
import { createMemoryTools, type MemoryToolsDeps } from './memoryTools';
import { createSkillTool } from './skillTool';
import { createSubagentTool, type SubagentDeps } from './subagentTool';

/** Optional capabilities layered onto the base file tools (Wave 3). */
export interface DefaultToolsOptions {
  /** When provided, registers the on-demand `load_skill` tool over these skills. */
  readonly skills?: SkillsService;
  /**
   * When provided, registers the portable `spawn_subagent` tool. `childTools` is
   * supplied by the registry (the base tools assembled here, which never include
   * spawn_subagent — that is what enforces depth-1), so the caller passes
   * everything EXCEPT childTools.
   */
  readonly subagent?: Omit<SubagentDeps, 'childTools'>;
  /** When provided, registers explicit durable-memory tools for the parent agent. */
  readonly memory?: MemoryToolsDeps;
}

/** All v1 tools, as fresh independent instances. With no opts this is exactly
 * the five file tools (so BUILTIN_TOOL_SPECS and the test fixtures are stable). */
export function createDefaultTools(opts?: DefaultToolsOptions): Tool[] {
  const tools = createFileTools();
  if (opts?.skills !== undefined) {
    tools.push(createSkillTool(opts.skills));
  }
  if (opts?.subagent !== undefined) {
    // The sub-agent inherits the base tools assembled SO FAR (file tools +
    // load_skill). That set excludes spawn_subagent itself → depth-1 by design.
    const childTools = [...tools];
    tools.push(createSubagentTool({ ...opts.subagent, childTools }));
  }
  if (opts?.memory !== undefined) {
    tools.push(...createMemoryTools(opts.memory));
  }
  return tools;
}

/** The JSON-schema specs for every built-in tool (handed to the model by W9/W6). */
export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
```

### `src/cli.ts`
```ts
#!/usr/bin/env -S tsx
// src/cli.ts
// W6 — the `juno` entry point. Parses --help/--version (preserving the W1
// behavior), else builds the real deps (config, catalog, client, policy, tools)
// and renders <App deps=... />.
//
// Windows note: npm's global bin shim invokes `node`, which cannot run .ts
// directly. Use `npm start` / `tsx src/cli.ts`. See docs/DECISIONS.md.
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app';
import type { AppDeps } from './app';
import { createPermissionPolicy } from './permissions/policy';
import { createModelClient } from './providers';
import { createConfigService } from './services/config';
import { BUILTIN_MODELS, createModelCatalog, type ModelEntry } from './services/catalog';
import { createDefaultTools } from './tools/registry';
import { assembleSystemPrompt, createSkillsService } from './services/skills';
import { loadAgentDefinitions } from './services/agents';
import { createMemoryStore } from './services/memory';
import { createSessionStore } from './services/sessions';

const HELP = `juno — terminal agent UI

Usage:
  juno              launch the TUI
  juno --help       show this help
  juno --version    print version
`;

function versionFromEnv(env: NodeJS.ProcessEnv): string {
  return env.npm_package_version ?? '0.0.0';
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`juno ${versionFromEnv(env)}\n`);
    return;
  }

  const config = createConfigService({ env });
  const settings = config.get();
  const catalog = createModelCatalog(BUILTIN_MODELS);
  const model = catalog.resolve(settings.defaultModel) ?? catalog.default();

  if (model === undefined) {
    process.stderr.write('juno: no model is configured.\n');
    process.exitCode = 1;
    return;
  }

  // One shared policy (the executor AND every sub-agent use it, so remembered
  // allow-patterns persist) and one client factory (App + sub-agents share it).
  // Factory: build a client for whichever entry the picker selects. Provider
  // config is keyed on the SELECTED entry's provider (not the frozen default),
  // so selecting a cross-provider entry routes to its own endpoint.
  const policy = createPermissionPolicy({
    autoAllowSafe: true,
    mode: settings.permissionMode,
    allow: settings.permissions?.allow,
    deny: settings.permissions?.deny,
  });
  const createClient = (entry: ModelEntry) =>
    createModelClient(entry, {
      provider: settings.providers?.[entry.provider],
      env,
      fetchImpl: fetch,
    });

  // Discover skills (~/.claude/skills + <cwd>/.claude/skills) and sub-agent
  // definitions (.claude/agents) once at startup. Skill names+descriptions go
  // into the (raw-API) system prompt; `load_skill` reads bodies on demand;
  // `spawn_subagent` runs fresh nested turns. Tools + specs are derived from ONE
  // built array so the model's tool specs always match the registered tools.
  const skillsService = createSkillsService({ cwd: settings.cwd });
  const skills = skillsService.list();
  const systemPrompt = assembleSystemPrompt(skills);
  const agents = loadAgentDefinitions({ cwd: settings.cwd });
  const memoryStore = createMemoryStore();
  const tools = createDefaultTools({
    skills: skillsService,
    subagent: { createClient, catalog, policy, defaultModel: settings.defaultModel, agents },
    memory: { store: memoryStore },
  });
  const specs = tools.map((tool) => tool.spec);

  // Session persistence store (default dir ~/.config/juno/sessions). Powers
  // `/resume` (list + hydrate) and best-effort save of committed turns.
  const sessionStore = createSessionStore();

  const deps: AppDeps = {
    createClient,
    tools,
    policy,
    catalog,
    settings,
    specs,
    systemPrompt,
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    sessionStore,
  };

  render(createElement(App, { deps }));
}

// Run main() only when invoked directly (works under tsx `.ts` and a built `.js`).
const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath !== undefined && /(?:^|\/)(?:cli|juno)\.(?:ts|js)$/.test(invokedPath)) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`juno: ${message}\n`);
    process.exit(1);
  });
}
```

### `tests/memoryTools.test.ts`
```ts
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { ModelClient, Tool, ToolCtx } from '../src/core/contracts';
import type { State } from '../src/core/reducer';
import type { MemoryEntry, MemoryStore } from '../src/services/memory';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
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
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

function createCtx(): ToolCtx {
  return {
    cwd: '',
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async () => 'allow-once',
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

const subagentDeps = {
  createClient: (): ModelClient => ({
    async *streamTurn() {
      /* unused in registry wiring */
    },
  }),
  catalog: createModelCatalog(BUILTIN_MODELS),
  policy: createPermissionPolicy({ autoAllowSafe: true }),
  defaultModel: 'gpt-4.1',
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
      { value: 'value' },
      { key: '', value: 'value' },
      { key: 'key' },
      { key: 'key', value: '' },
    ];

    for (const args of invalidArgs) {
      await expect(remember.run(args, createCtx())).resolves.toEqual({
        ok: false,
        error: 'invalid args',
      });
    }

    await expect(store.list()).resolves.toEqual([]);
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

  it('registry includes memory tools only when memory deps are provided, with pinned risk levels', () => {
    const store = createInMemoryMemoryStore();
    const withMemory = createDefaultTools({ memory: { store } });
    const base = createDefaultTools();

    expect(withMemory.map((tool) => tool.name)).toContain('remember_fact');
    expect(withMemory.map((tool) => tool.name)).toContain('recall_facts');
    expect(base.map((tool) => tool.name).sort()).toEqual([
      'edit_file',
      'grep',
      'list_files',
      'read_file',
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
```