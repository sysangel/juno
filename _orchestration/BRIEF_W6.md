# TEAM BRIEF — W6: App shell + hooks + turnRunner (the coordinator) — Wave 3

You are writing the **coordinator** for a TypeScript + React + Ink terminal product called **`juno`** (a fresh TS/Node20/ESM port of a Python agent harness). Your unit is **W6**: the ONLY place that wires the model stream + tool execution + permission round-trip + abort together. **Waves 1 and 2 are done and green.** You CANNOT browse the filesystem — all context is inline. You GLUE existing pieces; you implement no tools, no providers, no policy, no reducer.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20 (global `fetch`, `AbortController`, `AbortSignal`, `Promise.withResolvers` may NOT exist — build your own deferred). **Language:** TypeScript, **strict mode on, no `any`**, exhaustive switches, ESM only.
- **tsconfig:** `module:ESNext`, `moduleResolution:"Bundler"`, `target/lib ES2022`, `jsx:"react-jsx"`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. React 18.3, Ink 5.1.
- **Imports:** Bundler resolution — import siblings/peers WITHOUT a file extension, e.g. `import { reducer } from '../core/reducer'` (existing `tests/*.ts` do exactly this). Do NOT add `.js` extensions in your new files.
- **Tests:** vitest (`npx vitest run`). **Deterministic — NO network, NO real filesystem writes, NO real keys.** Drive the FAKE client `createFakeModelClient` from `src/core/fakeClient.ts`. Component-level test of Ink is via `ink-testing-library` if needed, but the coordinator test should exercise the LOGIC (turnRunner + park/resolve registry), not render.

## THE DISCIPLINE RULE (verbatim — load-bearing)
> Do NOT modify any existing file under `src/core`, `src/ui`, `src/tools`, `src/permissions`, `src/providers`, `src/services`. Only CREATE the new W6 files + the new test file listed below. The two W1 placeholder files `src/cli.ts` and `src/app.tsx` are W6-OWNED and you DO replace their contents (they exist only as skeletons awaiting W6). If a wiring export you need is genuinely MISSING from an existing module, do NOT edit that module — FLAG it in a `## Open wiring needs` section in your NOTES; the synthesizer decides.

## The exact files you must write
1. `src/agent/eventBus.ts` — the permission **park/resolve registry** keyed by `toolCallId`, plus a tiny dispatch helper if useful. (See "Permission registry" below — this is the heart of W6.)
2. `src/agent/turnRunner.ts` — drives one model turn: consumes `client.streamTurn(...)`, maps each `AgentEvent`→Action via `eventToAction`, runs tools through the executor, owns the permission round-trip + abort. May loop to RE-ENTER tool results into the next turn when `stopReason==='tool_use'`.
3. `src/hooks/useTerminalSize.ts` — Ink `useStdout` resize → `{ columns, rows }`.
4. `src/hooks/useKeybinds.ts` — scoped key handling (Esc=abort, mode cycle, overlay open/close, slash/model-picker navigation). Pure-ish: takes callbacks + current overlay, returns nothing (registers `useInput`).
5. `src/hooks/useStreamingTurn.ts` — React glue: owns `useReducer(reducer, initialState())`, the `AbortController`, ~16 ms token-delta batching, and exposes `{ state, dispatch, submit, abort, resolvePermission }` to `app.tsx`. Internally calls `turnRunner`.
6. `src/app.tsx` — root component: wires `useStreamingTurn` + `useKeybinds` + `useTerminalSize`, owns ALL controlled UI state (`value`, `selectedIndex`, `selectedId`), routes overlays via `OverlayHost`, renders `Transcript`/`StreamingMessage`/`StatusLine`/`InputBox`.
7. `src/cli.ts` — `juno` entry: parse `--help`/`--version` (keep existing behavior), else build the real deps (config, catalog, client, policy, executor) and `render(<App deps=… />)`.
8. `tests/coordinator.test.ts` — the integration test (contract below).

Self-contained: import ONLY from `../core/*`, `../ui/*`, `../tools/*`, `../permissions/*`, `../providers/*`, `../services/*`, `react`, `ink`. Do NOT import any not-yet-written module.

---

## FROZEN W3 core (exists — import, never redefine)

```ts
// src/core/events.ts
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
export type RiskLevel = 'safe' | 'risky' | 'dangerous';
export type PermissionDecision = 'allow-once' | 'deny' | 'always-allow-pattern' | 'dangerous-bypass';
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'abort' | 'error';
export type AgentEvent =
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { type: 'assistant-done'; id: string; stopReason: StopReason }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'aborted'; reason?: string }
  | { type: 'error'; message: string };
export function eventToAction(e: AgentEvent): Action; // 1:1 map to the matching Action variant
```

```ts
// src/core/reducer.ts  (PURE; no-op returns SAME ref)
export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type Block = { kind: 'text'; id: string; text: string } | { kind: 'tool'; id: string; toolCallId: string };
export interface ToolState { status: ToolStatus; name: string; args: unknown; result?: unknown; error?: string; argsText?: string; }
export interface Msg { id: string; role: Role; blocks: Block[]; done: boolean; reasoning?: string; toolSnapshot?: Record<string, ToolState>; }
export interface State {
  committed: Msg[]; live: Msg | null; tools: Record<string, ToolState>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker';
  mode: 'normal' | 'plan' | 'ultracode';
  tokens: { in: number; out: number };
  pendingPermissionToolCallId: string | null;
  errorMessage: string | null;
}
export type Action =
  | { t: 'user-submit'; id: string; text: string }
  | { t: 'assistant-start'; id: string } | { t: 'text-delta'; id: string; delta: string }
  | { t: 'reasoning-delta'; id: string; delta: string }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { t: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { t: 'assistant-done'; id: string; stopReason: StopReason }
  | { t: 'usage'; tokensIn: number; tokensOut: number } | { t: 'aborted'; reason?: string }
  | { t: 'set-mode'; mode: State['mode'] } | { t: 'cycle-mode' }
  | { t: 'set-overlay'; overlay: State['overlay'] } | { t: 'error'; message: string } | { t: 'clear' };
export function initialState(): State;
export function reducer(state: State, action: Action): State;
```
Reducer behaviors W6 relies on: `permission-open` sets `overlay:'permission'`, `phase:'awaiting-permission'`, `pendingPermissionToolCallId`. **`permission-resolved` flips `overlay:'none'`** + restores phase + clears `pendingPermissionToolCallId` (it does NOT store the decision — execution effects are W6's job). `assistant-done` commits `live`→`committed`, clears `live`. `usage` is ADDITIVE (`in += tokensIn`). `tool-status('result'|'error')` returns phase to `streaming` (if live) else `idle`; once a tool is `'error'`, a later non-error status is ignored.

```ts
// src/core/contracts.ts
export type TurnMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: Array<{ toolCallId: string; name: string; args: unknown }> }
  | { role: 'tool'; toolCallId: string; content: string };
export interface TurnInput { id: string; messages: TurnMessage[]; model?: string; cwd?: string; mode?: State['mode']; systemPrompt?: string; }
export interface ToolSpec { name: string; description: string; inputSchema: unknown; }
export interface ToolCtx { cwd: string; signal: AbortSignal; emit: (e: AgentEvent) => void; awaitPermission(toolCallId: string): Promise<PermissionDecision>; readonly state: Readonly<State>; }
export interface ToolResult { ok: boolean; data?: unknown; error?: string; }
export interface ModelClient { streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent>; }
export interface Tool { name: string; risk: RiskLevel; spec: ToolSpec; run(args: unknown, ctx: ToolCtx): Promise<ToolResult>; }
export interface ToolExecutor { execute(toolCallId: string, name: string, args: unknown, emit: (e: AgentEvent) => void): Promise<void>; }
export interface PermissionPolicy { evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt'; remember(pattern: string, decision: PermissionDecision): void; }
```

```ts
// src/core/selectors.ts (consume for StatusLine)
export interface StatusLineState { model: string; cwd: string; tokens: { in: number; out: number; total: number }; contextFraction: number; mode: State['mode']; overlay: State['overlay']; phase: State['phase']; statusText: string; pendingPermissionToolCallId: string | null; }
export function selectStatusLine(state: State, ctx?: { model?: string; cwd?: string; maxContext?: number }): StatusLineState;
```

```ts
// src/core/fakeClient.ts — the deterministic driver for your test
export function createFakeModelClient(opts?: { tickMs?: number }): ModelClient;
```
**Fake script (FIXED, in order):** `assistant-start(fake-assistant-1)` → reasoning-deltas → text-deltas "Hello from Juno." → safe tool `list_files` (`tc-safe-1`): tool-call-deltas, `tool-call`, `tool-status running`, `tool-status result` → text-delta → **risky tool `write_file` (`tc-risky-1`)**: `tool-call` then `permission-open(risky)` then `tool-status running` then `tool-status result` → `usage(120,48)` → `assistant-done(stopReason:'end')`.
**CRITICAL about the fake:** it emits `permission-open` AND its own `tool-status running/result` for the risky tool, but it does NOT emit `permission-resolved` and it does NOT call the executor — the fake "pretends" the tool ran. **For the integration test do NOT just replay the fake's tool-status events.** Drive the round-trip through YOUR turnRunner + executor + park/resolve registry so the assertions are real. Build a tiny scripted `ModelClient` in the test that yields `assistant-start → tool-call(risky) → assistant-done(stopReason:'tool_use')` so turnRunner actually invokes `executor.execute`, which calls `awaitPermission` (full control of stopReason and a second risky call).

---

## Wave-2 surfaces W6 must wire (EXIST — import these EXACT signatures)

```ts
// src/tools/executor.ts
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
**Executor behavior W6 MUST honor (frozen):** `execute(toolCallId,name,args,emit)` does, in order: abort-check → resolve tool (missing → terminal `tool-status error`) → `policy.evaluate(name,args,risk)` → on `'auto-deny'` terminal error (no run) → on `'prompt'` it `emit`s `permission-open` then `await deps.awaitPermission(toolCallId)`; **after that await returns it re-checks `signal.aborted`**; if the resolved decision `=== 'deny'` → terminal error, no run; else → `emit tool-status running`, builds `ctx` with `state: deps.getState()` (snapshotted ONCE here), runs the tool, emits terminal `tool-status result|error`. **The executor emits `permission-open` itself** — so do NOT also emit `permission-open` from turnRunner for executor-driven calls (would double-open).

```ts
// src/tools/registry.ts
export function createDefaultTools(): Tool[];
export const BUILTIN_TOOL_SPECS: ToolSpec[];   // pass to client.streamTurn(input, BUILTIN_TOOL_SPECS, signal)
```

```ts
// src/permissions/policy.ts
export interface PermissionPolicyOptions { autoAllowSafe?: boolean; initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>; }
export function createPermissionPolicy(opts?: PermissionPolicyOptions): PermissionPolicy;
```
`remember(pattern, decision)`: persists ONLY `'deny'` | `'always-allow-pattern'` | `'dangerous-bypass'`; `'allow-once'` is a silent no-op by design. Pattern grammar (from W8): a bare tool-name (no `:`) is normalized to `tool:*`; full key is `${name}:${salientPath}` where salientPath is `args.path` else `args.dir` else `''`; `*` is the only glob. **So to "always allow this pattern" for a tool call, pass `remember(name, 'always-allow-pattern')`** (bare name → matches every call to that tool), OR a precise `${name}:${path}`.

```ts
// src/providers/index.ts
export interface ProviderDeps { provider?: { baseUrl?: string; apiKeyEnv?: string }; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; }
export type ProviderId = 'openai' | 'openrouter' | 'anthropic';
export function createModelClient(entry: ModelEntry, deps?: ProviderDeps): ModelClient;
```

```ts
// src/services/config.ts
export interface Settings { defaultProvider: string; defaultModel: string; cwd: string; maxContext?: number; providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>; }
export interface ConfigService { get(): Settings; getValue<K extends keyof Settings>(k: K): Settings[K]; reload(): Settings; }
export const DEFAULT_SETTINGS: Settings;
export function createConfigService(opts?: { configPath?: string; env?: NodeJS.ProcessEnv }): ConfigService;   // FLAG if absent
export function createFakeConfigService(settings: Settings): ConfigService;                                    // FLAG if absent
// src/services/catalog.ts
export interface ModelEntry { id: string; provider: string; label: string; contextWindow: number; aliases?: string[]; default?: boolean; }
export interface ModelCatalog { list(): ReadonlyArray<ModelEntry>; resolve(idOrAlias: string): ModelEntry | undefined; byProvider(p: string): ReadonlyArray<ModelEntry>; default(): ModelEntry | undefined; }
export function createModelCatalog(entries?: ReadonlyArray<ModelEntry>): ModelCatalog;
export const BUILTIN_MODELS: ReadonlyArray<ModelEntry>;
```
> NOTE: `createConfigService`/`createFakeConfigService` are specified in the SEAMS doc; if the actual `config.ts` exports only `DEFAULT_SETTINGS`/`ConfigService`, build `cli.ts` against what EXISTS (e.g. `DEFAULT_SETTINGS`) and FLAG the gap — do not edit config.ts.

### UI components W6 mounts (EXACT props — all PURE/controlled, hold NO state)
```ts
// src/ui/*
export interface TranscriptProps { committed: Msg[]; depth?: ColorDepth; }
export interface StreamingMessageProps { live: Msg | null; depth?: ColorDepth; }
export interface StatusLineProps { status: StatusLineState; depth?: ColorDepth; }
export interface ModeBadgeProps { mode: State['mode']; depth?: ColorDepth; }
export interface ToolCallCardProps { tool: ToolState; depth?: ColorDepth; }
export interface InputBoxProps { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; placeholder?: string; depth?: ColorDepth; }
export interface SlashPaletteProps { commands: Array<{ name: string; description: string }>; selectedIndex?: number; depth?: ColorDepth; }
export interface ModelPickerProps { models: ReadonlyArray<ModelEntry>; selectedId?: string; depth?: ColorDepth; }
export interface PermissionRequest { toolCallId: string; name: string; args: unknown; risk: RiskLevel; }
export interface PermissionPromptProps { request: PermissionRequest; onDecision: (d: PermissionDecision) => void; }   // onDecision fires EXACTLY once (ref-guarded); does NOT self-unmount
export interface OverlayHostProps { overlay: State['overlay']; slash?: SlashPaletteProps; modelPicker?: ModelPickerProps; permission?: PermissionPromptProps; }
export function OverlayHost(props: OverlayHostProps): ReactElement | null;
// + named exports: Transcript, StreamingMessage, StatusLine, ModeBadge, ToolCallCard, InputBox, SlashPalette, ModelPicker, PermissionPrompt
```
`PermissionPrompt` internally has its OWN `useInput` (y/a/d/!) that calls `onDecision` once. W6 supplies `onDecision`. **W6 builds the `PermissionRequest` from `state.tools[pendingId]` + the risk** (read `state.tools[pendingId].name`/`.args`; risk is carried by `permission-open` into the tools entry only if W6 stores it — the reducer's `permission-open` defensively seeds `{status,name,args}` WITHOUT risk, so W6 must remember the `risk` from the live `permission-open` event/registry when constructing the prompt).

---

## THE W6 WIRING CONTRACT (NON-NEGOTIABLE — distilled from 4 adversarial verifiers)

### A. `awaitPermission` MUST ALWAYS settle — or the turn hangs forever
The executor does `const d = await deps.awaitPermission(toolCallId)` and only re-checks `signal.aborted` AFTER it returns. **Aborting the signal does NOT by itself unstick a parked permission promise.** Therefore:
- Build a **registry** keyed by `toolCallId` that PARKS a promise on `awaitPermission(id)` and RESOLVES it exactly once.
- `resolvePermission(id, decision)` resolves the parked promise with that decision (called when the user decides via `PermissionPrompt.onDecision` → dispatch `permission-resolved`).
- **On cancellation / abort / turn-teardown, W6 MUST forcibly resolve EVERY still-parked promise with `'deny'`** (drain the registry). Wire `signal.addEventListener('abort', drainWithDeny)` AND drain in turnRunner's finally/teardown. A parked id that never resolves = a hung turn. After draining, the executor's post-await abort-check (or the `'deny'`) makes it NOT run the tool and emit a terminal error.
- Resolving the same id twice must be a no-op (guard with a `delete`/`has` check).

### B. ONE shared `PermissionPolicy` instance
`createPermissionPolicy()` is per-instance state. W6 must create ONE policy and inject the SAME reference into `ToolExecutorDeps.policy` AND call `.remember(...)` on that SAME instance. Do NOT create a second policy for the prompt path. Only call `remember` for `'always-allow-pattern'` (and `'dangerous-bypass'` if you surface it); `'allow-once'` is a silent no-op by design (calling it is harmless but pointless) and `'deny'` here is a one-shot prompt deny, not a remembered rule — do NOT remember `'deny'` from a prompt.

### C. PermissionPrompt does not self-dismiss; W6 owns dismissal + ALL controlled UI state
`PermissionPrompt.onDecision` fires exactly once (ref-guarded internally) but it does NOT auto-unmount. **W6 must flip `overlay` off `'permission'` by dispatching `permission-resolved`** (the reducer sets `overlay:'none'` + clears `pendingPermissionToolCallId`). The wiring of `onDecision(decision)` is:
1. if `decision === 'always-allow-pattern'` (or `'dangerous-bypass'`): `policy.remember(<bare tool name or name:path>, decision)` on the SHARED instance FIRST.
2. `resolvePermission(toolCallId, decision)` — resolves the parked executor promise.
3. `dispatch({ t: 'permission-resolved', toolCallId, decision })` — dismisses the overlay + restores phase.
W6 also owns `value` / `selectedIndex` / `selectedId` and ALL key handling for `InputBox` / `SlashPalette` / `ModelPicker` (those components hold NO state of their own). InputBox is controlled (`value`+`onChange`+`onSubmit`); SlashPalette/ModelPicker render a `selectedIndex`/`selectedId` you own and you drive arrow/enter/esc via `useInput` (in `useKeybinds`), then dispatch `set-overlay`/`set-mode`/submit accordingly.

### D. Streaming / usage / stopReason discipline
- **`usage` is additive / last-wins per field.** Anthropic emits TWO usage events (input tokens at message_start, output at message_delta); OpenAI emits one. Just dispatch every `usage` event to the reducer (which adds them) — do NOT special-case or sum yourself.
- **Branch on `assistant-done.stopReason`** — never assume success. `'tool_use'` → after the turn's tool calls resolve, RE-ENTER: append the assistant message (with its `toolCalls`) + one `tool` TurnMessage per resolved tool (`content` = JSON of the tool result/error, correlated by `toolCallId`) and run the NEXT turn. `'end'` → done. `'max_tokens'` → commit + stop (optionally surface a hint). `'error'`/`'abort'` → stop; for `'error'` you already dispatched an `error` event.
- **`aborted` is itself terminal** — handle it alongside `assistant-done`: stop the turn loop, drain parked permissions with `'deny'`, dispatch the `aborted` action (reducer drops `live`, clears the prompt, returns to idle). Do not continue re-entry after an abort.
- A `tool_use` stopReason may NOT have a preceding `tool-call` if the model's args were malformed JSON (provider couldn't parse) → in that case emit an `{ type:'error', message }` rather than calling the executor with no call. Guard: only run tools for `tool-call` events you actually saw this turn.
- `getState()` you pass into `ToolExecutorDeps` must return the CURRENT reducer state at call time (close over a ref/latest-state holder), but note the executor snapshots it ONCE per `execute`; tools do not see mid-run state — that's expected, don't fight it.

---

## turnRunner shape (recommended; drafters may refine but MUST honor A–D)
A function, NOT a React component:
```ts
export interface TurnRunnerDeps {
  client: ModelClient;
  executor: ToolExecutor;          // built from createToolExecutor with the SHARED policy + same signal + same awaitPermission registry
  specs: ToolSpec[];               // BUILTIN_TOOL_SPECS
  dispatch: (a: Action) => void;   // reducer dispatch
  signal: AbortSignal;
  registry: PermissionRegistry;    // park/resolve, from eventBus.ts
}
/** Run ONE user submission to completion (looping on tool_use). Resolves when the
 *  conversation turn(s) finish or abort. NEVER throws on abort. */
export async function runTurn(input: TurnInput, deps: TurnRunnerDeps): Promise<void>;
```
Per streamed `AgentEvent` from `client.streamTurn(input, specs, signal)`:
- `dispatch(eventToAction(e))` for the 1:1 reducer effect (text/reasoning/tool-call-delta/usage/etc.).
- On `tool-call`: record `{toolCallId,name,args}` for this turn (for re-entry) and **invoke `executor.execute(toolCallId, name, args, emit)`** where `emit` = `(ev) => dispatch(eventToAction(ev))`. The executor itself emits `permission-open` (→ overlay) and the `tool-status` lifecycle; W6 does NOT separately emit those for executor-driven calls. (You MAY collect tool results by also capturing the terminal `tool-status` the executor emits, keyed by toolCallId, for re-entry content.)
- On `assistant-done`: branch on `stopReason` (D).
- On `aborted` / signal abort: drain registry with `'deny'`, dispatch `aborted`, stop.
The park/resolve registry (`eventBus.ts`) is shared between `awaitPermission` (executor side) and `resolvePermission` (UI side). Provide a `Deferred<T>` helper (don't rely on `Promise.withResolvers`).

`eventBus.ts` minimum API:
```ts
export interface PermissionRegistry {
  await(toolCallId: string): Promise<PermissionDecision>;   // parks (one per id; second await for same id returns the same pending promise)
  resolve(toolCallId: string, decision: PermissionDecision): void;  // resolves once; no-op if absent/already resolved
  drainDeny(): void;   // resolve ALL parked with 'deny' (abort/teardown)
  pending(): number;   // count, for tests
}
export function createPermissionRegistry(): PermissionRegistry;
```

---

## `tests/coordinator.test.ts` — integration contract (vitest; drive deterministically, NO network/FS)
Build the real pieces: `policy = createPermissionPolicy()`, `registry = createPermissionRegistry()`, an `AbortController`, `getState` reading the latest reducer state, `executor = createToolExecutor({ tools: createDefaultTools(), policy, cwd: <a temp/jail dir or '.'>, signal, getState, awaitPermission: registry.await })`, and a **small in-test scripted `ModelClient`** (preferred over the fake's pretend-run path) that yields the events you need so the EXECUTOR actually runs. Use a SAFE-by-construction tool path or stub `tool.run` so no real FS write happens — OR assert at the `tool-status running`/decision level so the test never depends on real IO. Then assert the four paths:

**(a) ALLOW round-trip:** scripted client yields `assistant-start → tool-call(write_file, tc1, args) → assistant-done(stopReason:'tool_use')`. Run turnRunner. Assert: executor called `awaitPermission('tc1')` (registry.pending()===1) → reducer entered `phase:'awaiting-permission'` & `overlay:'permission'` & `pendingPermissionToolCallId==='tc1'`. Simulate the UI: `resolve('tc1','allow-once')` + `dispatch(permission-resolved tc1 'allow-once')`. Assert: `awaitPermission` resolved, the tool RAN (a `tool-status running` then a terminal `tool-status result|error` was dispatched for tc1; if you stub run, assert your stub was called), overlay flipped back to `'none'`, and the turn completed (no hang; the awaited `runTurn` promise resolved).

**(b) DENY path:** same setup; resolve with `'deny'` (+ dispatch permission-resolved). Assert: the tool did NOT run (your stubbed `run` was NOT called / a terminal `tool-status error` with no `running→result`), overlay back to `'none'`, `runTurn` resolved cleanly.

**(c) ABORT-WHILE-PARKED:** scripted client yields `tool-call(risky)` → executor parks `awaitPermission`. While `registry.pending()===1`, call `controller.abort()` and `registry.drainDeny()` (this is what W6 wires to the abort listener / teardown). Assert: the parked promise resolved to `'deny'`, NO tool ran, `runTurn` RESOLVES (does NOT hang) within the test, and the reducer is back to idle (dispatch `aborted`). This is the regression test for contract A.

**(d) ALWAYS-ALLOW dedupe on the SHARED instance:** scripted client yields TWO risky `write_file` calls to the SAME pattern in one turn (or two sequential turns), `tc1` then `tc2`. On `tc1`'s prompt, simulate `onDecision('always-allow-pattern')`: W6 calls `policy.remember(<name or name:path>, 'always-allow-pattern')` on the SHARED policy, then resolve+dispatch. Assert: `tc1` prompted (pending hit 1) and ran; **`tc2` did NOT open a prompt** (registry never parked for tc2 / `permission-open` count for tc2 === 0 / `phase` never re-entered `awaiting-permission` for tc2) and ran directly — because `policy.evaluate` now returns `'auto-allow'` for the remembered pattern. Proves B + C wiring share one policy.

Also assert (smoke): driving the **real `createFakeModelClient()`** end-to-end through `useStreamingTurn`/turnRunner (you may test turnRunner directly with the fake) produces a committed assistant message containing "Hello from Juno." and additive tokens `in===120, out===48` after `assistant-done`. (The fake's risky tool pretends-runs and emits its own tool-status — that path won't call your executor; that's fine, the executor paths are covered by the scripted client in a–d.)

---

## Done =
- `npx tsc --noEmit` is clean (strict, no `any`).
- `npx vitest run` is green, INCLUDING the new `tests/coordinator.test.ts`, and no existing test regressed.

## Output format
Respond with a SINGLE markdown document. For every file: `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<200 words) containing a `## Open wiring needs` subsection listing any export you needed that does not exist in the current modules (or "none").
