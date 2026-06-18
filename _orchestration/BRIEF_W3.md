# TEAM BRIEF — W3: Lock the Contracts (`src/core/`)

You are writing **the central seam** of a TypeScript + React + Ink product called **`juno`**. Your unit is **W3**. Once frozen, every other unit (UI, tools, permissions, LLM adapters, the coordinator, the tests) builds against the types you define here. Getting the shapes right is the whole job. You CANNOT browse the filesystem — all needed context is inline.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**. ESM only.
- **UI:** React 18 + Ink 5 (you don't write UI here, but your types feed it).
- **Tests:** **vitest** (`import { describe, it, expect } from 'vitest'`). NOT pytest, NOT jest.
- The W1 skeleton already exists: `package.json`, strict `tsconfig.json`, `vitest.config.ts`, an Ink entry, and an empty `src/core/` directory. You fill `src/core/`.

## The exact files you must write (W3 owns these)
All under `src/core/` except the test:
1. `src/core/events.ts` — the normalized **`AgentEvent`** discriminated union + the shared enums.
2. `src/core/reducer.ts` — a **single PURE reducer** `reducer(state, action): State`, plus `State`, `Action`, `Msg` (and supporting block/tool types), and `initialState()`.
3. `src/core/contracts.ts` — the **`ModelClient`**, **`ToolExecutor`**, `Tool`, and **`PermissionPolicy`** interfaces (interfaces ONLY — no impls; W7/W8/W9 implement them).
4. `src/core/fakeClient.ts` — a **deterministic fake `ModelClient`** that emits a scripted `AgentEvent` sequence (text deltas + a non-gated tool + a permission-gated tool + usage + done). No keys, no randomness, no real I/O.
5. `tests/reducer.test.ts` — a vitest suite covering **every reducer transition**.

You may also add `src/core/selectors.ts` (pure derived-state helpers for the StatusLine: model, cwd, token/context bar, current mode/overlay) — recommended, and flag it as proposed in NOTES.

## FROZEN seam types — reproduce these shapes EXACTLY
These are the canonical contract shapes the whole project agreed on. Implement them as written; where a field is underspecified, pick a sensible type and **FLAG it as proposed** in NOTES.

```ts
// src/core/events.ts
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
export type RiskLevel = 'safe' | 'risky' | 'dangerous';
export type PermissionDecision =
  | 'allow-once' | 'deny' | 'always-allow-pattern' | 'dangerous-bypass';

export type AgentEvent =
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { type: 'assistant-done'; id: string; stopReason: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'error'; message: string };
```

```ts
// src/core/reducer.ts  (State shape is FROZEN)
export interface State {
  committed: Msg[];                  // -> Ink <Static>, printed once, never redrawn
  live: Msg | null;                  // the current streaming assistant turn
  tools: Record<string, { status: ToolStatus; name: string; args: unknown; result?: unknown; error?: string }>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker';
  mode: 'normal' | 'plan' | 'ultracode';
  tokens: { in: number; out: number };
}
// Action variants map 1:1 to AgentEvent variants, PLUS local UI actions.
export type Action =
  | { t: 'user-submit'; id: string; text: string }
  | { t: 'assistant-start'; id: string }
  | { t: 'text-delta'; id: string; delta: string }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { t: 'assistant-done'; id: string; stopReason: string }
  | { t: 'usage'; tokensIn: number; tokensOut: number }
  | { t: 'set-mode'; mode: State['mode'] }
  | { t: 'cycle-mode' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'error'; message: string }
  | { t: 'clear' };
export function reducer(state: State, action: Action): State; // PURE
export function initialState(): State;
```

```ts
// src/core/contracts.ts  (interfaces ONLY)
import type { AgentEvent, RiskLevel, PermissionDecision } from './events';
// TurnInput / ToolSpec / ToolCtx / ToolResult are W3-PROPOSED — keep minimal, flag in NOTES.
export interface ModelClient {
  streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent>;
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

## `Msg` shape (port from the proven starter reducer — keep this structure)
The validated starter modeled messages as append-only block lists with stable, monotonic block ids (never `Math.random`, never a render index). Carry this forward:
```ts
export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };   // renamed from starter's `toolId` to match the seam
export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  // Frozen snapshot of every tool call this message references, set ONLY at commit
  // time, so the <Static> committed render path never reads the live tools map.
  toolSnapshot?: Record<string, State['tools'][string]>;
}
```

## Required reducer behavior (the lifecycle — implement precisely)
- **`user-submit`**: push a committed user `Msg` (single text block). Optionally bump `tokens.in` via a deterministic estimate (`Math.ceil(len/4)`); flag the estimate as proposed.
- **`assistant-start`**: set `live` to a fresh empty assistant `Msg` (`done:false`); `phase='streaming'`.
- **`text-delta`**: append to the trailing text block of `live` **keeping the same block id**; if the last block isn't text (a tool block split it), push a NEW text block with a fresh monotonic id. Ignore if no live msg / id mismatch.
- **`tool-call`**: create `tools[toolCallId] = { status:'pending', name, args }`; push a `{kind:'tool', toolCallId}` block into `live`.
- **`tool-status`**: update `tools[toolCallId].status` (+ `result`/`error`). **Race guard:** once a call is `'error'`, a later non-error status must NOT clobber it. Set `phase='running-tool'` while `running`, back to `'streaming'` on `result`/`error` if a live turn is active.
- **`permission-open`**: set `overlay='permission'`, `phase='awaiting-permission'`, record the pending toolCallId (add a field to `State` for this — e.g. `pendingPermissionToolCallId: string | null` — and FLAG it as a proposed addition to the frozen shape).
- **`permission-resolved`**: clear the permission overlay (`overlay='none'`), restore `phase` to `'streaming'` if a live turn exists else `'idle'`. (The decision's effect on tool execution is W7/W8's job; the reducer only updates UI/phase.)
- **`assistant-done`**: commit `live` → `committed`, building `toolSnapshot` from the live tool blocks; clear `live`; `phase='idle'`.
- **`usage`**: add to `tokens.in`/`tokens.out`.
- **`set-mode` / `cycle-mode`**: cycle `normal→plan→ultracode`.
- **`set-overlay`**: set overlay; keep phase consistent.
- **`error`**: `phase='error'` and surface the message (e.g. commit a system `Msg` or store on state — choose one and flag it).
- **`clear`**: reset `committed`/`live`/`tools`/overlay/phase to an empty idle state.
- The reducer MUST be a pure function (no I/O, no Date.now, no random) and never mutate its inputs.

## `fakeClient.ts` requirements (the unlock for W4/W6/W13)
- Export a factory or class implementing `ModelClient`. `streamTurn` returns an `AsyncIterable<AgentEvent>` that yields a FIXED, byte-reproducible script (no `Math.random`):
  `assistant-start` → several `text-delta`s → a non-gated `tool-call` + `tool-status(running)` + `tool-status(result)` → another `text-delta` → a **gated** `tool-call` + `permission-open(risk:'risky')` (then it should yield `permission-resolved` is driven by the coordinator, NOT the client — so the fake just emits `tool-call`/`permission-open` and a follow-up `tool-status` after a tick) → `usage` → `assistant-done(stopReason:'end')`.
- Honor the `AbortSignal`: stop yielding promptly if `signal.aborted`.
- Use small `await` ticks (e.g. `setTimeout`-based `delay`) so consumers can interleave; keep delays fixed.
- No API keys, no network, no filesystem. This is the deterministic stand-in that lets the UI/coordinator/tests run with no providers.

## `tests/reducer.test.ts` requirements
- vitest. Cover EVERY `Action` variant at least once, plus the tricky paths:
  - `text-delta` appends to the same block id; a tool block splits text into a new block.
  - `tool-status` race guard (error not clobbered by a late result).
  - `assistant-done` builds a correct `toolSnapshot` and clears `live`.
  - `permission-open`/`permission-resolved` overlay+phase transitions.
  - `clear` resets everything.
- Assert the reducer never mutates the input `state` object (call with `Object.freeze(initialState())` or compare references).

## Seam you EXPOSE / what consumes it
- **W4 (UI)** reads `State`, `selectors`, `ToolStatus`, `PermissionDecision`; never calls providers.
- **W6 (coordinator/turnRunner)** consumes the `ModelClient` `AsyncIterable<AgentEvent>`, calls `ToolExecutor.execute`, drives the permission round-trip, and dispatches `Action`s 1:1 from events.
- **W7 (tools)** implements `ToolExecutor`/`Tool`, emits `tool-call`→`tool-status`.
- **W8 (permissions)** implements `PermissionPolicy`.
- **W9 (LLM adapters)** implement `ModelClient`, yielding ONLY normalized `AgentEvent`s.
Action variants map 1:1 to `AgentEvent` variants (plus local UI actions). Do NOT add provider-specific fields to `AgentEvent`.

---
Respond with a SINGLE markdown document. For every file you propose, put a line `=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block containing the full file contents. After all files, add a `=== NOTES ===` section (<200 words) explaining key design choices and the seams you expose or consume. Do NOT write to the filesystem — output only this document.
