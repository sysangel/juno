# TEAM BRIEF — W9: Streaming `ModelClient` adapters (`src/providers/`)

You are writing the **real LLM provider adapters** for a TypeScript + React + Ink terminal product called **`juno`** (a fresh TS/Node20/ESM port of a Python agent harness). Your unit is **W9**: streaming adapters that turn provider wire formats into ONE normalized `AgentEvent` stream. **Wave 1 is done and green.** You CANNOT browse the filesystem — all context is inline. You write **zero React/Ink**.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20 (global `fetch` + `ReadableStream` available). **Language:** TypeScript, **strict mode on**, **no `any`**, exhaustive switches. **ESM only**.
- **tsconfig:** `moduleResolution:"Bundler"`, `target/lib ES2022`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- **Tests:** vitest. **Deterministic — NO real network.** Inject a fake `fetch` (and feed it a canned SSE/stream body) so tests never hit a provider and need no API key.

## The exact files you must write
1. `src/providers/openaiCompatClient.ts` — OpenAI-compatible adapter (serves `openai` AND `openrouter`, base-url switched).
2. `src/providers/anthropicClient.ts` — Anthropic Messages adapter.
3. `src/providers/index.ts` — the registry: `createModelClient(entry, deps)`.
4. `tests/modelClients.fake.test.ts` — vitest suite (see requirements).

Self-contained: import ONLY from `../core/contracts`, `../core/events`, and `../services/catalog` (for the `ModelEntry` type). Do NOT import React/Ink, W4, W7, W8, or any not-yet-written module.

## FROZEN W3 contracts you implement (already exist — import, do not redefine)
```ts
// contracts.ts
export type TurnMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: Array<{ toolCallId: string; name: string; args: unknown }> }
  | { role: 'tool'; toolCallId: string; content: string };
export interface TurnInput {
  id: string;                 // stamp assistant-start/done with THIS id
  messages: TurnMessage[];
  model?: string;
  cwd?: string;
  mode?: 'normal' | 'plan' | 'ultracode';
  systemPrompt?: string;
}
export interface ToolSpec { name: string; description: string; inputSchema: unknown; }
export interface ModelClient {
  streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent>;
}

// events.ts — you yield ONLY these (the normalized union). Do NOT invent fields.
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'abort' | 'error';
export type AgentEvent =
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'assistant-done'; id: string; stopReason: StopReason }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'aborted'; reason?: string }
  | { type: 'error'; message: string };
```
(You emit `assistant-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`tool-call`/`usage`/`assistant-done`/`aborted`/`error`. You do NOT emit `tool-status`/`permission-*` — those belong to W7/W8.)

## Consumed Wave-1 API (done/green) — `src/services/catalog.ts`
```ts
export interface ModelEntry {
  id: string;          // e.g. 'gpt-4.1' or 'anthropic/claude-sonnet-4'
  provider: string;    // 'openai' | 'openrouter' | 'anthropic' | ...
  label: string;
  contextWindow: number;
  aliases?: string[];
  default?: boolean;
}
```
Provider config (base URL + env-var NAME for the key) comes from W10 `Settings.providers[id] = { baseUrl?: string; apiKeyEnv?: string }`, passed to you via `deps.provider` — NOT hardcoded.

## Pinned Wave-2 seam — the registry (implement EXACTLY)
```ts
// src/providers/index.ts
import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
export interface ProviderDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };  // from Settings.providers[entry.provider]
  env?: NodeJS.ProcessEnv;                              // defaults to process.env; injected in tests
  fetchImpl?: typeof fetch;                             // defaults to global fetch; injected in tests
}
export type ProviderId = 'openai' | 'openrouter' | 'anthropic';
/** Resolve a ModelClient by entry.provider. Throws on an unknown provider id. */
export function createModelClient(entry: ModelEntry, deps?: ProviderDeps): ModelClient;
```
- Registry switches on `entry.provider`: `'openai'`/`'openrouter'` → `openaiCompatClient` (OpenRouter just sets `baseUrl='https://openrouter.ai/api/v1'` from `deps.provider.baseUrl`); `'anthropic'` → `anthropicClient`. Unknown → `throw new Error('unknown provider: '+entry.provider)`.
- The model id sent on the wire is `input.model ?? entry.id`.

## Hard requirements (these are the point of W9)
- **Creds read at CALL time, never stored/logged:** read the key INSIDE `streamTurn` as `(deps.env ?? process.env)[deps.provider?.apiKeyEnv ?? '']`. Never assign it to a class field, never put it in an emitted event/message, never log it. If the env var is missing/empty → yield a single `{ type:'error', message:'missing API key for <provider>' }` (name the env-var NAME, never a value) and return.
- **NO-TRAIN routing (OpenRouter only):** when `baseUrl` is the OpenRouter one, set request-body `provider: { data_collection: 'deny', allow_fallbacks: true }`. **Do NOT add an `only:[...]` / "Western-only" allowlist — that geographic screen is RETIRED; no-train is the whole policy.**
- **Stops promptly on abort:** check `signal.aborted` before/while reading the stream; pass `signal` to `fetchImpl`. On abort, yield `{ type:'aborted' }` once and return (do not throw an uncaught `AbortError` — catch it and treat as abort).
- **Yields ONLY normalized events**, never provider-specific shapes. **Invents no clock** — no `Date.now`; `id` comes from `input.id`.
- **No `any`** — type the parsed SSE/JSON via narrowing helpers + `unknown`. Strict ESM.

## Normalization contract (event order per turn)
`assistant-start(input.id)` → then, as the stream arrives: `text-delta` (assistant content chunks), `reasoning-delta` (extended-thinking chunks, if the provider sends them), `tool-call-delta` (partial tool-arg JSON as it streams) and finally `tool-call(id:input.id, toolCallId, name, args)` once a tool call's args are complete → optional `usage(tokensIn,tokensOut)` when the provider reports it → `assistant-done(input.id, stopReason)`. Map provider stop/finish reasons to `StopReason`: tool-call present → `'tool_use'`; clean stop → `'end'`; length cap → `'max_tokens'`; otherwise `'error'`/`'abort'`. On a non-abort failure yield `{ type:'error', message }` (and you may still emit `assistant-done(...,'error')`).
- **OpenAI-compatible wire:** POST `${baseUrl}/chat/completions` with `stream:true`, `Authorization: Bearer <key>`; parse SSE `data:` lines, accumulate `choices[0].delta.content`→text-delta and `delta.tool_calls[].function.arguments`→tool-call-delta (emit `tool-call` when a call's args parse / on finish). `[DONE]` ends the stream.
- **Anthropic wire:** POST `${baseUrl ?? 'https://api.anthropic.com'}/v1/messages` with `stream:true`, headers `x-api-key:<key>`, `anthropic-version:'2023-06-01'`; parse the event stream (`content_block_delta` text → text-delta; thinking deltas → reasoning-delta; `input_json_delta` → tool-call-delta; `message_delta.usage`/`stop_reason`).

## `tests/modelClients.fake.test.ts` requirements (vitest)
- Build a **fake `fetch`** that returns a `Response` whose `body` is a `ReadableStream` you fill with canned SSE bytes (a few text chunks, optionally one tool call, a usage line, a done marker). Pass it via `deps.fetchImpl` and a fake `deps.env` containing the key.
- Drain `streamTurn(...)` into an array; assert: starts with `assistant-start` (id === input.id), contains the expected `text-delta`s in order, ends with `assistant-done` with the right `stopReason`, and a `usage` event if the canned body had one.
- A tool-call canned body yields `tool-call-delta`(s) then a `tool-call` with parsed `args` and `stopReason:'tool_use'`.
- **Missing key:** empty `deps.env` → exactly one `error` event, message names the env var (NOT a value), no `assistant-start`.
- **Abort:** pre-aborted `AbortSignal` → yields `aborted` (or nothing) and returns promptly; never throws.
- **No-train:** assert the OpenRouter request body (capture it in the fake fetch) contains `provider.data_collection === 'deny'` and has NO `only` field.
- Assert no event carries the API key string anywhere.

---
Respond with a SINGLE markdown document. For every file, `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.

## Gate (must pass)
```
cd /c/Users/Core/src/juno && npx tsc --noEmit && npx vitest run tests/modelClients.fake.test.ts
```
