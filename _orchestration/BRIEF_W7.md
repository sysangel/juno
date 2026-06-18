# TEAM BRIEF — W7: File tools + ToolExecutor (`src/tools/`)

You are writing the **file tools + the tool executor** for a TypeScript + React + Ink terminal product called **`juno`** (a fresh TS/Node20/ESM port of a Python agent harness). Your unit is **W7**: a set of structured, event-emitting file tools (read/list/grep/write/edit), a registry, and the `ToolExecutor` that drives one tool call's lifecycle **including the permission round-trip**. **Wave 1 is done and green.** You CANNOT browse the filesystem — all context is inline. You write **zero React/Ink**.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**, **no `any`**, exhaustive switches. **ESM only** (ESM `import`/`export`; use `node:` prefix for builtins, e.g. `import { readFile } from 'node:fs/promises'`).
- **tsconfig:** `moduleResolution:"Bundler"`, `target/lib ES2022`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- **Tests:** vitest. Deterministic; do real fs only inside an OS temp dir you `mkdtemp` and clean up in `afterEach` (the done W10 services use this pattern). No network. No clock unless you control it.
- **Windows path handling is strict** — use `node:path` (`path.resolve`, `path.relative`), never string-concat paths.

## The exact files you must write
1. `src/tools/fileTools.ts` — the 5 `Tool` impls.
2. `src/tools/registry.ts` — `createDefaultTools()` + `BUILTIN_TOOL_SPECS`.
3. `src/tools/executor.ts` — `createToolExecutor(deps)` → `ToolExecutor`.
4. `tests/tools.test.ts` — vitest suite (see requirements).

Self-contained: import ONLY from `../core/contracts`, `../core/events`, `../core/reducer` (for `State` type), and `node:*`. Do NOT import React/Ink, W8, W4, W9, or any not-yet-written module.

## FROZEN W3 contracts you implement (already exist in `src/core/contracts.ts` + `events.ts` — import, do not redefine)
```ts
// events.ts
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
export type RiskLevel = 'safe' | 'risky' | 'dangerous';
export type PermissionDecision = 'allow-once' | 'deny' | 'always-allow-pattern' | 'dangerous-bypass';
export type AgentEvent =
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  /* …other variants exist; you only emit tool-status + permission-open… */ ;

// contracts.ts
export interface ToolSpec { name: string; description: string; inputSchema: unknown; }
export interface ToolResult { ok: boolean; data?: unknown; error?: string; }
export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  awaitPermission(toolCallId: string): Promise<PermissionDecision>;
  readonly state: Readonly<State>;
}
export interface Tool {
  name: string;
  risk: RiskLevel;
  spec: ToolSpec;
  run(args: unknown, ctx: ToolCtx): Promise<ToolResult>;
}
export interface ToolExecutor {
  execute(toolCallId: string, name: string, args: unknown, emit: (e: AgentEvent) => void): Promise<void>;
}
export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
}
```
**PERMISSION OWNERSHIP (frozen):** the *executor* — NOT the tool — calls `policy.evaluate`. On `'prompt'` the executor emits `permission-open` then `await ctx.awaitPermission(toolCallId)`. Tools NEVER call `evaluate` or `awaitPermission`.

## Pinned Wave-2 seam — `createToolExecutor` factory (implement EXACTLY)
```ts
// src/tools/executor.ts
import type { State } from '../core/reducer';
export interface ToolExecutorDeps {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  cwd: string;
  signal: AbortSignal;
  getState: () => Readonly<State>;
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision>;
}
export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor;
```
`execute(toolCallId, name, args, emit)` does, IN ORDER:
1. `tool = tools.find(t => t.name === name)`; if none → `emit tool-status(toolCallId,'error', error:'unknown tool: '+name)`; return.
2. `const decision = deps.policy.evaluate(name, args, tool.risk)`.
3. `'auto-deny'` → `emit tool-status('error', error:'denied by policy')`; return (do NOT run).
4. `'prompt'` → `emit { type:'permission-open', toolCallId, name, args, risk: tool.risk }`; `const d = await deps.awaitPermission(toolCallId)`; if `d === 'deny'` → `emit tool-status('error', error:'denied')`; return; else proceed.
5. `'auto-allow'` (or proceeded) → `emit tool-status('running')`; build `ctx: ToolCtx = { cwd: deps.cwd, signal: deps.signal, emit, awaitPermission: deps.awaitPermission, state: deps.getState() }`; `const r = await tool.run(args, ctx)`.
6. `r.ok` → `emit tool-status('result', result: r.data)`; else `emit tool-status('error', error: r.error ?? 'tool failed')`.
7. If `deps.signal.aborted` at any await point, stop and emit a terminal `tool-status('error', error:'aborted')`. The executor does NOT emit the top-level `aborted` event.

(The executor does NOT emit `tool-call` — the model stream does; the executor only emits `permission-open` + the `tool-status` lifecycle.)

## Pinned Wave-2 seam — v1 tools + risk + result shapes (implement EXACTLY)
All file ops are **workspace-jailed** under `ctx.cwd`: resolve the target with `path.resolve(ctx.cwd, p)`, then reject if `path.relative(ctx.cwd, resolved)` starts with `..` or is absolute → return `{ ok:false, error:'path escapes workspace' }`. Never throw to the caller — catch fs errors and return `{ ok:false, error }`.

| `name`       | `risk`  | args                                              | `data` on success |
|--------------|---------|---------------------------------------------------|-------------------|
| `read_file`  | safe    | `{ path: string }`                                | `{ path, content: string }` |
| `list_files` | safe    | `{ dir?: string }` (default `'.'`)                | `{ dir, entries: string[] }` (names, sorted) |
| `grep`       | safe    | `{ pattern: string; dir?: string; glob?: string }`| `{ matches: Array<{ file: string; line: number; text: string }> }` |
| `write_file` | risky   | `{ path: string; content: string }`               | `{ path, bytesWritten: number }` |
| `edit_file`  | risky   | `{ path: string; oldString: string; newString: string; replaceAll?: boolean }` | `{ path, replacements: number }` |

- Each `Tool.spec` = `{ name, description, inputSchema }` where `inputSchema` is a plain JSON-Schema object literal describing the args (typed `unknown` in the contract; you provide a real object). 
- `grep`: walk files under `dir` (skip `node_modules`/dotdirs), match `pattern` as a substring or simple regex (your call — keep deterministic; sort matches by file then line). `glob` filter optional (simple `*` glob on filename).
- `edit_file`: read, replace `oldString`→`newString` (once unless `replaceAll`), error if `oldString` not found (`replacements:0` → `{ok:false}`), else write and report count.
- Validate args at the top of each `run` (narrow `unknown`; no `any`); on bad args return `{ ok:false, error:'invalid args' }`.
- `registry.ts`: `createDefaultTools(): Tool[]` returns all 5; `BUILTIN_TOOL_SPECS: ToolSpec[]` = their `.spec`s. **No `bash`/shell in v1.**

## `tests/tools.test.ts` requirements (vitest)
- Use `mkdtemp` for a temp workspace; clean in `afterEach`. Pass it as `cwd`.
- `read_file`/`write_file` round-trip; `write_file` reports `bytesWritten`.
- `list_files` returns sorted entries; `grep` finds a known line with correct `line` number.
- `edit_file` replaces and reports count; missing `oldString` → `ok:false`.
- **Jail:** `read_file({path:'../outside'})` (or an absolute path outside cwd) → `ok:false`, error mentions escape.
- **Executor + a fake `PermissionPolicy`:**
  - safe tool with policy `evaluate→'auto-allow'`: emits `tool-status running` then `result`; no `permission-open`.
  - risky tool with `evaluate→'prompt'` + `awaitPermission` resolving `'allow-once'`: emits `permission-open` then `running`→`result`.
  - `evaluate→'auto-deny'`: emits a terminal `tool-status error`, tool's `run` NOT called.
  - `awaitPermission` resolving `'deny'`: terminal `error`, run NOT called.
  - unknown tool name: terminal `error`.
- Collect emitted events into an array via the `emit` callback and assert order/contents.

## Hard requirements
- Purity of tools beyond fs I/O: no global state, no clock, no randomness. Executor adds no clock.
- No `any`; narrow all `unknown`. Strict ESM. `node:` builtins.

---
Respond with a SINGLE markdown document. For every file, `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.

## Gate (must pass)
```
cd /c/Users/Core/src/juno && npx tsc --noEmit && npx vitest run tests/tools.test.ts
```
