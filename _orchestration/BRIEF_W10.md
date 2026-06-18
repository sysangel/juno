# TEAM BRIEF — W10: Services (config, catalog, sessions, memory) under `src/services/`

You are writing the **services layer** for a TypeScript + React + Ink terminal product called **`juno`**. Your unit is **W10**. You provide four interface-backed services — **config/settings**, **model catalog**, **sessions/transcripts**, and **bounded memory** — with **no hidden globals**: callers construct each via a factory and inject it. W9 (LLM provider adapters) consumes your `Settings` + `ModelCatalog`; W6 (coordinator) consumes your `SessionStore`/`TranscriptLog`/`MemoryStore`; W4 (UI) consumes `ModelCatalog` (model-picker) + `Settings` (status line). You CANNOT browse the filesystem — all needed context is inline.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**. **ESM only** (`"type": "module"`; ESM `import`/`export`, no `require`/`module.exports`). Use `node:`-prefixed builtins (`import { readFile } from 'node:fs/promises'`, `import path from 'node:path'`, `import os from 'node:os'`).
- **Tests:** vitest (`import { describe, it, expect } from 'vitest'`) — NOT pytest, NOT jest.
- **tsconfig:** `moduleResolution: "Bundler"`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `target/lib ES2022`, `types: ["node"]`. No `any`; prefer `unknown` + narrowing. Exhaustive switches. JSON parsing must be typed/narrowed, not cast blindly.
- **No extra deps:** use only Node builtins + the types from `src/core/`. Do NOT add SQLite or other packages — persist as **JSON / JSONL files** (DECOMP allowed JSONL or SQLite; pick **JSONL/JSON**, simplest that works).

## The exact files you must write (4 service modules + tests)
1. `src/services/config.ts` — `Settings`, `ConfigService`, `createConfigService`, `createFakeConfigService`, `DEFAULT_SETTINGS`.
2. `src/services/catalog.ts` — `ModelEntry`, `ModelCatalog`, `createModelCatalog`, `BUILTIN_MODELS`.
3. `src/services/sessions.ts` — `SessionMeta`, `SessionStore`, `TranscriptLog` + their file-backed and in-memory factories.
4. `src/services/memory.ts` — `MemoryEntry`, `MemoryStore` + file-backed (bounded) and in-memory factories.
5. `tests/services.test.ts` — vitest suite (see requirements).

Self-contained: import ONLY Node builtins and the `Msg` type from `../core/reducer`. Do NOT import React/Ink, providers, UI, or any not-yet-written module.

## FROZEN W3 type you depend on (already exists; import it, do not redefine)
From `src/core/reducer.ts`:
```ts
export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };
export interface Msg {
  id: string; role: Role; blocks: Block[]; done: boolean;
  reasoning?: string;
  toolSnapshot?: Record<string, /* ToolState */ unknown>;
}
```
Persist/return `Msg` objects faithfully (round-trip through JSON without losing fields). `SessionStore.load` and `TranscriptLog.read` return `Msg[]`. (For reference: `State['mode']` is `'normal'|'plan'|'ultracode'` and the W3 selector `selectContextFraction(state, max)` reads a `max` you supply via `Settings.maxContext` — but services do NOT import selectors.)

## The interfaces THIS unit must EXPOSE (pinned in SEAMS.md — implement EXACTLY)

### `src/services/config.ts`
```ts
export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
}
export interface ConfigService {
  get(): Settings;
  getValue<K extends keyof Settings>(key: K): Settings[K];
  reload(): Settings;
}
export function createConfigService(opts?: { configPath?: string; env?: NodeJS.ProcessEnv }): ConfigService;
export function createFakeConfigService(settings: Settings): ConfigService;
export const DEFAULT_SETTINGS: Settings;
```
- Resolution order: `DEFAULT_SETTINGS` ← config file (JSON at `configPath`, default `<os.homedir()>/.config/juno/config.json`) ← env overrides (e.g. `JUNO_MODEL`, `JUNO_PROVIDER` if present). Missing file = defaults (do NOT throw). Cache after first `get()`; `reload()` re-reads. **Never log secrets**: `providers[*].apiKeyEnv` names an ENV VAR; never read or print its value here.

### `src/services/catalog.ts`
```ts
export interface ModelEntry {
  id: string; provider: string; label: string; contextWindow: number;
  aliases?: string[]; default?: boolean;
}
export interface ModelCatalog {
  list(): ReadonlyArray<ModelEntry>;
  resolve(idOrAlias: string): ModelEntry | undefined;
  byProvider(provider: string): ReadonlyArray<ModelEntry>;
  default(): ModelEntry | undefined;
}
export function createModelCatalog(entries?: ReadonlyArray<ModelEntry>): ModelCatalog;
export const BUILTIN_MODELS: ReadonlyArray<ModelEntry>;
```
- `BUILTIN_MODELS` is **DATA, not presentation** — a handful of realistic entries spanning providers `openai`/`openrouter`/`anthropic` with plausible `contextWindow`s and a couple of `aliases`; mark exactly one `default: true`. `resolve` matches `id` first then any `aliases` entry. `default()` returns the `default:true` entry, else the first.

### `src/services/sessions.ts`
```ts
import type { Msg } from '../core/reducer';
export interface SessionMeta {
  id: string; createdAt: string; model?: string; cwd?: string; title?: string;
}
export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<ReadonlyArray<SessionMeta>>;
  load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined>;
  save(id: string, messages: ReadonlyArray<Msg>): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface TranscriptLog {
  append(sessionId: string, message: Msg): Promise<void>;
  read(sessionId: string): Promise<Msg[]>;
}
export function createSessionStore(opts?: { dir?: string }): SessionStore;
export function createTranscriptLog(opts?: { dir?: string }): TranscriptLog;
export function createMemorySessionStore(): SessionStore;
export function createMemoryTranscriptLog(): TranscriptLog;
```
- File-backed `dir` default `<os.homedir()>/.config/juno/sessions`. `SessionStore` stores meta + messages as JSON per session (e.g. `<dir>/<id>.json`); `TranscriptLog` appends one `Msg` per line as JSONL (e.g. `<dir>/<id>.jsonl`). `load`/`read` of a missing id return `undefined`/`[]` (never throw). Create the dir lazily (`mkdir recursive`). **No clock inside** — `createdAt` is caller-supplied.

### `src/services/memory.ts`
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
export function createInMemoryMemoryStore(opts?: { maxBytes?: number }): MemoryStore;
```
- **BOUNDED** (Hermes concept): `maxBytes` default `64 * 1024`. `set` writes the entry, then if total stored bytes exceed `maxBytes`, **evict oldest by `updatedAt` (FIFO)** until it fits. `size()` returns total bytes of stored values. File-backed `dir` default `<os.homedir()>/.config/juno/memory`; persist as a single JSON map or one JSON file — your choice, keep it simple. `updatedAt` is caller-supplied (no clock).

## Cross-cutting rules (ALL modules)
- **No globals / no singletons.** Construct via the factory; the caller injects. Do not read/cache module-level mutable state shared across instances.
- **No internal clock or randomness** where avoidable: timestamps (`createdAt`/`updatedAt`) and the session `id` are **caller-supplied**, keeping impls deterministically testable. (If a file-backed impl ever needs a generated id, accept an optional `idgen?: () => string` — not required by the seam.)
- **Async everywhere**, `Promise`-based, including the in-memory fakes, so call sites are uniform.
- Narrow parsed JSON defensively; a corrupt/missing file degrades to defaults/empty, never a throw that crashes startup.

## `tests/services.test.ts` requirements (vitest)
- **config:** `createFakeConfigService(s).get()` returns `s`; `getValue('defaultModel')` works typed; `createConfigService` with a missing `configPath` returns `DEFAULT_SETTINGS`-equivalent values without throwing.
- **catalog:** `createModelCatalog().list()` is non-empty; `resolve` finds by id AND by alias; `byProvider` filters; `default()` returns the `default:true` entry.
- **sessions (in-memory):** `create`→`list` shows the meta; `save`→`load` round-trips a small `Msg[]` (assert a `Msg` field survives, e.g. `blocks[0]`); `TranscriptLog.append` x2 → `read` returns 2 in order; missing id → `undefined`/`[]`.
- **memory (in-memory):** `set`→`get` round-trips; `list` reflects entries; exceeding `maxBytes` evicts the **oldest by `updatedAt`** (set a tiny `maxBytes`, insert in known timestamp order, assert the oldest is gone and the newest remain); `size()` shrinks after eviction.
- Use `tmpdir`-based dirs (or just the in-memory factories) for any file-backed test so nothing pollutes the real home dir.

## Seam you EXPOSE / what consumes it
- **W9 (providers)** reads `Settings` (default provider/model, `providers[*].baseUrl`/`apiKeyEnv`) and `ModelCatalog` (resolve a model id, read its `contextWindow`) — **injected**, never imported as a global.
- **W6 (coordinator)** owns the clock + session id, calls `SessionStore`/`TranscriptLog`/`MemoryStore`.
- **W4 (UI)** reads `ModelCatalog` for the model-picker and `Settings.maxContext` for the context bar (passed to W3's `selectContextFraction`).
- **Decisions to honor:** `memory` and `sessions` are SEPARATE modules; `TranscriptLog` lives with `sessions`; DECOMP's `skills.ts` is folded into `config.ts` (no separate skills service in this unit).

---
Respond with a SINGLE markdown document. For every file, a line `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.
