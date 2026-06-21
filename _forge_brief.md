# BRIEF — Explicit `remember_fact` / `recall_facts` tools (tool-driven memory) for Juno

You are one of two independent writers. Produce COMPLETE, COMPILING TypeScript for a small,
self-contained feature in the Juno codebase (a TS/Ink terminal agent). Output the full text
of every new/edited file in fenced code blocks with the file path as a header. Be precise and
follow the existing conventions EXACTLY. Strict TypeScript: no `any`, no non-null assertions,
no `Date.now`/`Math.random` inside tool code (inject the clock).

## Goal
Two agent-facing tools backed by the EXISTING, fully-tested `MemoryStore`
(`src/services/memory.ts`, file-backed, 64 KiB FIFO-bounded). NO system-prompt change, NO
volatile-tier injection. Just the explicit tool-call path.

- `remember_fact({ key, value })` — risk `'risky'`. Persists one fact via
  `store.set(key, value, now())`. Returns `{ ok:true, data:{ key, bytesWritten } }`.
- `recall_facts()` — risk `'safe'` (read-only, auto-allowed). Returns ALL entries:
  `{ ok:true, data:{ facts: MemoryEntry[] } }`, each `{ key, value, updatedAt }`.

## Existing contracts you MUST reuse (do NOT modify these files)

`src/core/contracts.ts`:
```ts
export interface ToolSpec { name: string; description: string; inputSchema: unknown; }
export interface ToolCtx {
  cwd: string; signal: AbortSignal; emit: (event: AgentEvent) => void;
  awaitPermission(toolCallId: string): Promise<PermissionDecision>;
  readonly state: Readonly<State>;
}
export interface ToolResult { ok: boolean; data?: unknown; error?: string; }
export interface Tool { name: string; risk: RiskLevel; spec: ToolSpec; run(args: unknown, ctx: ToolCtx): Promise<ToolResult>; }
```
`RiskLevel = 'safe' | 'risky' | 'dangerous'`.

`src/services/memory.ts` exports:
```ts
export interface MemoryEntry { key: string; value: string; updatedAt: string; }
export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | undefined>;
  set(key: string, value: string, updatedAt: string): Promise<void>;
  list(): Promise<ReadonlyArray<MemoryEntry>>;
  delete(key: string): Promise<void>;
  size(): Promise<number>;
}
export function createMemoryStore(opts?: { dir?: string; maxBytes?: number }): MemoryStore;
export function createInMemoryMemoryStore(opts?: { maxBytes?: number }): MemoryStore; // tests
```
The store's `list()` returns entries sorted by `updatedAt` then `key`.

## Conventions to mirror (from `src/tools/skillTool.ts` and `src/tools/fileTools.ts`)
- Module-level factory, e.g. `createSkillTool(skills)` returns a `Tool` literal.
- `isRecord` guard: `typeof value === 'object' && value !== null && !Array.isArray(value)`.
- Tools NEVER throw; fs/IO errors become `{ ok:false, error: message }` (wrap in try/catch).
- Invalid args → `{ ok:false, error:'invalid args' }`.
- `write_file` returns `bytesWritten: Buffer.byteLength(content,'utf8')` (import Buffer from 'node:buffer').

## FILE 1 (NEW) — `src/tools/memoryTools.ts`
```ts
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import type { MemoryStore } from '../services/memory';

export interface MemoryToolsDeps {
  readonly store: MemoryStore;
  /** ISO-8601 clock; defaults to () => new Date().toISOString(). Injected for tests. */
  readonly now?: () => string;
}

export function createMemoryTools(deps: MemoryToolsDeps): Tool[] { /* [remember_fact, recall_facts] */ }
```
Specs:
- `remember_fact`: `{ type:'object', additionalProperties:false, properties:{ key:{type:'string', description:...}, value:{type:'string', description:...} }, required:['key','value'] }`. Good description for the model.
- `recall_facts`: `{ type:'object', additionalProperties:false, properties:{}, required:[] }`.

Behaviour:
- `remember_fact.run(args, _ctx)`: `isRecord` guard; `key` and `value` must be NON-EMPTY strings, else `{ ok:false, error:'invalid args' }`. Then `await store.set(key, value, (deps.now ?? defaultNow)())` where `defaultNow = () => new Date().toISOString()`. Return `{ ok:true, data:{ key, bytesWritten: Buffer.byteLength(value,'utf8') } }`. Wrap the store call in try/catch → `{ ok:false, error: message }` (use an `errorMessage(e)` helper like fileTools).
- `recall_facts.run(_args, _ctx)`: ignore args. `const facts = await store.list();` return `{ ok:true, data:{ facts: facts.map(e => ({ key:e.key, value:e.value, updatedAt:e.updatedAt })) } }`. try/catch wrap.
- Do NOT touch `ctx.cwd`. No workspace jail. `risk` = `'risky'` for remember_fact, `'safe'` for recall_facts.

## FILE 2 (EDIT) — `src/tools/registry.ts`  (current full content)
```ts
// src/tools/registry.ts
import type { Tool, ToolSpec } from '../core/contracts';
import type { SkillsService } from '../services/skills';
import { createFileTools } from './fileTools';
import { createSkillTool } from './skillTool';
import { createSubagentTool, type SubagentDeps } from './subagentTool';

export interface DefaultToolsOptions {
  readonly skills?: SkillsService;
  readonly subagent?: Omit<SubagentDeps, 'childTools'>;
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
  return tools;
}

export const BUILTIN_TOOL_SPECS: ToolSpec[] = createDefaultTools().map((tool) => tool.spec);
```
Changes (ADDITIVE):
- import `createMemoryTools` and type `MemoryToolsDeps` from `./memoryTools`.
- Add `readonly memory?: MemoryToolsDeps;` to `DefaultToolsOptions`.
- AFTER the subagent push (LAST), add:
  ```ts
  if (opts?.memory !== undefined) {
    tools.push(...createMemoryTools(opts.memory));
  }
  ```
  Ordering is load-bearing: pushing AFTER the subagent block keeps memory tools OUT of the
  sub-agent's `childTools` snapshot (sub-agents do not get memory tools).
- `createDefaultTools()` with no opts must STILL be exactly the 5 file tools (BUILTIN set stable).

## FILE 3 (EDIT) — `src/cli.ts`  (wiring, additive)
- import `{ createMemoryStore }` from `./services/memory`.
- Before `createDefaultTools({...})`, add `const memoryStore = createMemoryStore();`.
- Add `memory: { store: memoryStore },` to the `createDefaultTools({ skills, subagent, ... })` call.
Current call site:
```ts
const tools = createDefaultTools({
  skills: skillsService,
  subagent: { createClient, catalog, policy, defaultModel: settings.defaultModel, agents },
});
```

## FILE 4 (NEW) — `tests/memoryTools.test.ts`  (vitest)
Use `createInMemoryMemoryStore()` + fixed clock `now: () => '2026-06-21T00:00:00.000Z'`.
A `ToolCtx` fake (cwd '', `signal: new AbortController().signal`, `emit: () => undefined`,
`awaitPermission: async () => 'allow-once'`, and a minimal `state` — but recall/remember
ignore state/cwd, so a cast-free minimal real State is ideal; if hard, the tools don't read
state so you can build the fake like tools.test.ts does). Cases:
1. `remember_fact` valid → `{ ok:true }`, `data.bytesWritten === Buffer.byteLength(value,'utf8')`, `data.key === key`; `store.list()` contains `{ key, value, updatedAt:'2026-06-21T00:00:00.000Z' }`.
2. `remember_fact` missing/empty key OR value → `{ ok:false, error:'invalid args' }`, store still empty.
3. `recall_facts` after two remembers → `data.facts` is the full array (store sort: updatedAt then key), each entry `{ key, value, updatedAt }`.
4. `recall_facts` on empty store → `{ ok:true, data:{ facts: [] } }`.
5. Registry: `createDefaultTools({ memory:{ store } })` includes `remember_fact` + `recall_facts`; `createDefaultTools()` (no opts) does NOT; risk levels `risky`/`safe`.
6. Sub-agent exclusion: with both `subagent` and `memory` opts present, the memory tools are pushed AFTER the subagent (assert order: index of remember_fact > index of spawn_subagent, mirroring the documented push-order). You may keep this simple/structural.

For State fake in the ctx, here is a valid `Readonly<State>` shape used by tools.test.ts:
```ts
{ committed: [], live: null, tools: {}, phase: 'idle', overlay: 'none', effort: 'medium',
  permissionMode: 'default', tokens: { in: 0, out: 0 }, pendingPermissionToolCallId: null,
  errorMessage: null }
```

## step->verify
After writing: `npx tsc --noEmit` must pass with 0 errors, and `npx vitest run tests/memoryTools.test.ts` must be green, and the full `npx vitest run` suite must remain green (no fixture regressions, BUILTIN set unchanged).

Output every file in full. Do not abbreviate.
