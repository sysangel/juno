# SEAMS — Wave 1 pinned inter-unit interfaces (`juno`)

> Authoritative seam doc for **Wave 1**. The W3 core contract (`src/core/{events,reducer,contracts,selectors}.ts`) is **FROZEN** and is the upstream source of truth; this file pins the *new* public APIs that **W5 (theme)** and **W10 (services)** EXPOSE so Wave 2 can build against them. **W11** exposes no library seam (it is a standalone script).
>
> Layout (pinned by W1): UI + theme under `src/ui/`, services under `src/services/`, providers under `src/providers/`, coordinator under `src/app/`, core contracts under `src/core/`. ESM, strict TS, Node 20.
>
> Rule (carried from W5/W10 DECOMP): pin the **names/signatures** here; **values/impl** may change freely behind them.

---

## W5 — Semantic-token theme (`src/ui/theme.ts`)

W5 replaces the old Python `theme.py` rainbow cosmetics with a small set of **named semantic tokens** plus colour-depth downsampling. W4 components import the tokens by NAME; the hex/ANSI VALUES behind a name may change without touching W4.

```ts
// src/ui/theme.ts  — EXPOSED by W5, CONSUMED by W4

/** A colour expressed as a 24-bit truecolor hex string, e.g. '#A6E22E'. */
export type Hex = `#${string}`;

/** Terminal colour capability; chosen once at startup from supports-color. */
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16';

/** The frozen set of semantic token names. ONE flag/state flips ONE token. */
export interface Theme {
  // base text
  text: Hex;            // primary foreground
  textDim: Hex;         // secondary / muted (timestamps, hints)
  textInverse: Hex;     // fg on a coloured background
  background: Hex;      // app background (may be unused by Ink, kept for parity)
  border: Hex;          // panel / card borders

  // semantic status
  accent: Hex;          // brand / focus / selected
  success: Hex;
  warning: Hex;
  error: Hex;
  info: Hex;

  // tool-call lifecycle — keyed to ToolStatus from W3
  toolPending: Hex;     // ToolStatus 'pending'
  toolRunning: Hex;     // ToolStatus 'running'
  toolResult: Hex;      // ToolStatus 'result'
  toolError: Hex;       // ToolStatus 'error'

  // role tints (Transcript / Message)
  roleUser: Hex;
  roleAssistant: Hex;
  roleSystem: Hex;

  // mode badge — keyed to State['mode'] from W3
  modeBadge: {
    normal: Hex;
    plan: Hex;
    ultracode: Hex;
  };
}

/** The single concrete theme instance. (Future: themed variants behind one flag.) */
export const theme: Theme;

/**
 * Downsample a truecolor hex to the terminal's capability. Pure, deterministic.
 * 'truecolor' returns the hex unchanged; 'ansi256' returns a 256-palette index
 * as a string usable by Ink's `color` prop; 'ansi16' returns a named-16 color
 * ('red','green','yellow','blue','cyan','magenta','white','gray', + 'bright*').
 */
export function downsample(hex: Hex, depth: ColorDepth): string;

/** Detect the terminal colour depth once (wraps supports-color). */
export function detectColorDepth(): ColorDepth;

/**
 * Convenience accessor a component uses to read a token already downsampled for
 * the current/ supplied depth. `depth` defaults to detectColorDepth().
 * Returns a string ready to pass to Ink's <Text color={...}>.
 */
export function token(name: FlatTokenName, depth?: ColorDepth): string;

/** Dotted token names addressable by `token()`, e.g. 'text' | 'modeBadge.plan'. */
export type FlatTokenName =
  | Exclude<keyof Theme, 'modeBadge'>
  | `modeBadge.${keyof Theme['modeBadge']}`;
```

**Consumption (W4):** components import `{ theme, token, downsample, detectColorDepth }`. `ToolCallCard` maps `state.tools[id].status` → `toolPending|toolRunning|toolResult|toolError`. `ModeBadge` maps `state.mode` → `theme.modeBadge[mode]`. `StatusLine`/`Message`/`Transcript` use `text`/`textDim`/`accent`/role tints. W4 may import the raw `theme` object and downsample itself, OR call `token(name)` for a pre-downsampled string — both are supported.

**Decision (invented, flag for ratify):** the **accessor is a plain `token()` function + the exported `theme` object**, NOT a React hook/context. Rationale: theme is process-static (depth detected once at startup); a hook/provider adds Ink-context wiring for zero benefit. If W4 later wants reactive re-theming, wrap `theme` in a context then — the names don't change.

---

## W10 — Services (`src/services/`)

Four interface-backed services, **no hidden globals — everything injected**. Each module exports an **interface**, a **default factory** that returns a live impl, and (where useful) an **in-memory fake** for tests/`fakeClient` paths. W9 (providers) consumes `Settings` + `ModelCatalog`; W6 (coordinator) consumes `SessionStore`/`MemoryStore`/`TranscriptLog`; W4 consumes `ModelCatalog` (model-picker) + `Settings` (StatusLine).

### `src/services/config.ts` — settings + skills

```ts
export interface Settings {
  defaultProvider: string;            // catalog entry's `provider`
  defaultModel: string;               // catalog entry's `id`
  cwd: string;                        // working directory for turns
  maxContext?: number;                // feeds selectContextFraction (W3 selectors)
  /** Arbitrary provider creds/base-urls keyed by provider id (never logged). */
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
}

export interface ConfigService {
  /** Full resolved settings (defaults <- file <- env), cached after first load. */
  get(): Settings;
  /** One key, typed. */
  getValue<K extends keyof Settings>(key: K): Settings[K];
  /** Reload from disk (config file under the user config dir). */
  reload(): Settings;
}

/** Load config from `configPath` (default: OS user-config dir/juno/config.json). */
export function createConfigService(opts?: { configPath?: string; env?: NodeJS.ProcessEnv }): ConfigService;

/** Deterministic, file-free service over a literal Settings (tests/fakes). */
export function createFakeConfigService(settings: Settings): ConfigService;

export const DEFAULT_SETTINGS: Settings;
```

### `src/services/catalog.ts` — model catalog (DATA, not presentation)

```ts
export interface ModelEntry {
  id: string;                         // canonical model id, e.g. 'gpt-4o'
  provider: string;                   // 'openai' | 'openrouter' | 'anthropic' | 'claude-cli' | ...
  label: string;                      // human display name for the picker
  contextWindow: number;             // tokens; feeds selectContextFraction max
  aliases?: string[];                 // user-typeable shorthands
  default?: boolean;                  // catalog default pick
}

export interface ModelCatalog {
  list(): ReadonlyArray<ModelEntry>;
  /** Resolve an id OR alias to its entry; undefined if unknown. */
  resolve(idOrAlias: string): ModelEntry | undefined;
  /** Entries for one provider. */
  byProvider(provider: string): ReadonlyArray<ModelEntry>;
  /** The default entry (entry with default:true, else first). */
  default(): ModelEntry | undefined;
}

/** Build a catalog from data entries (the built-in list lives in this module). */
export function createModelCatalog(entries?: ReadonlyArray<ModelEntry>): ModelCatalog;

export const BUILTIN_MODELS: ReadonlyArray<ModelEntry>;
```

### `src/services/sessions.ts` — session + transcript persistence

```ts
import type { Msg } from '../core/reducer';

export interface SessionMeta {
  id: string;                         // session id (caller-supplied or generated)
  createdAt: string;                  // ISO-8601 string (caller supplies the clock)
  model?: string;
  cwd?: string;
  title?: string;
}

export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<ReadonlyArray<SessionMeta>>;
  load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined>;
  /** Persist the full committed transcript for a session (overwrite). */
  save(id: string, messages: ReadonlyArray<Msg>): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Append-only line log of committed messages (JSONL); separate from SessionStore. */
export interface TranscriptLog {
  append(sessionId: string, message: Msg): Promise<void>;
  read(sessionId: string): Promise<Msg[]>;
}

/** File-backed (JSONL under a sessions dir). */
export function createSessionStore(opts?: { dir?: string }): SessionStore;
export function createTranscriptLog(opts?: { dir?: string }): TranscriptLog;

/** In-memory, deterministic (tests/fakes). */
export function createMemorySessionStore(): SessionStore;
export function createMemoryTranscriptLog(): TranscriptLog;
```

### `src/services/memory.ts` — bounded memory files (Hermes concept)

```ts
export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;                  // ISO-8601, caller supplies the clock
}

export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | undefined>;
  set(key: string, value: string, updatedAt: string): Promise<void>;
  list(): Promise<ReadonlyArray<MemoryEntry>>;
  delete(key: string): Promise<void>;
  /** Total bytes currently stored; enforced against `maxBytes`. */
  size(): Promise<number>;
}

/**
 * File-backed, BOUNDED: writes that would exceed `maxBytes` (default 64 KiB)
 * evict the oldest entries by `updatedAt` until they fit (FIFO trim).
 */
export function createMemoryStore(opts?: { dir?: string; maxBytes?: number }): MemoryStore;

/** In-memory, deterministic (tests/fakes). */
export function createInMemoryMemoryStore(opts?: { maxBytes?: number }): MemoryStore;
```

**Cross-cutting rules (all four modules):**
- **No globals / no singletons** — callers construct a service via its factory and inject it.
- **No clock, no randomness inside the service** where avoidable: timestamps and ids are caller-supplied (`createdAt`, `updatedAt`, session id) so impls stay testable; the file-backed *generated*-id case may fall back to a supplied `idgen?: () => string`.
- **Never log secrets**: `Settings.providers[*].apiKeyEnv` names an ENV VAR; the value is read by W9 at call time, never stored or printed.
- Async API is `Promise`-based even for the in-memory fakes (uniform call sites).

**Decisions (invented, flag for ratify):**
1. **`memory` and `sessions` are separate modules** (DECOMP lumps "memory, sessions" but they have distinct shapes); `transcriptLog` lives with `sessions` since both persist `Msg`. SEAMS file count: `config.ts`, `catalog.ts`, `sessions.ts`, `memory.ts` — 4 modules under `src/services/` (DECOMP's `skills.ts` folded into `config.ts` as a settings concern; call out if you want it split).
2. **Timestamps/ids are caller-supplied strings**, not generated inside services, to keep them pure-testable (the reducer/core has the same purity discipline). W6 owns the clock.
3. **`maxContext` lives on `Settings`** and is passed to W3's `selectContextFraction(state, max)` by W4 — services don't import selectors.

---

## Wave 2 — pinned inter-unit interfaces

> Authoritative seam doc for **Wave 2** (W4 UI / W7 tools+executor / W8 permissions / W9 providers). Upstream truth = **FROZEN W3** (`src/core/{events,reducer,contracts,selectors}.ts`) + **done/green W5 theme** + **done/green W10 services**. Rule (carried): pin **names/signatures** here; **impl/values** free.
>
> **Layout (extends W1's):** UI under `src/ui/`, providers under `src/providers/`, services under `src/services/`, core under `src/core/`. **Wave-2 additions:** file tools + executor under **`src/tools/`** (W7); permission policy under **`src/permissions/`** (W8). W4's `PermissionPrompt` lives in `src/ui/` (it is a UI component).
>
> **Decoupling invariant:** every Wave-2 unit depends ONLY on frozen W3 + done W5/W10. No Wave-2 unit imports another Wave-2 unit. W6 (Wave 3) is the only place they are wired together; the seams below are exactly the surfaces W6 will glue.

### Decision 1 — Permission-prompt UI ownership: **split. W8 = policy logic only (zero Ink); the `PermissionPrompt` Ink component lives in W4** as a pure controlled component.

Rationale: keeps W7/W8 headless + unit-testable with no React, keeps every Wave-2 unit mutually decoupled, and matches the frozen `ToolCtx` comment (executor owns the round-trip; UI only renders + reports a decision). DECOMP's W8 says "testable *without* the UI" and lists only `permissions/{policy,patterns}.ts` (no `.tsx`) — so the prompt is NOT inside W8. DECOMP's W4 explicitly lists a `PermissionDialog` component → the prompt is W4. W6 (Wave 3) wires `onDecision` → on `always-allow-pattern` call `policy.remember(pattern, decision)`, then `dispatch({ t:'permission-resolved', toolCallId, decision })` (which resolves the parked `awaitPermission` promise).

```ts
// src/ui/PermissionPrompt.tsx — OWNED BY W4. Pure, controlled, focus-stealing.
import type { PermissionDecision, RiskLevel } from '../core/events';

export interface PermissionRequest {
  toolCallId: string;
  name: string;          // tool name, e.g. 'write_file'
  args: unknown;         // raw args to render (read-only)
  risk: RiskLevel;       // 'safe' | 'risky' | 'dangerous'
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  onDecision: (decision: PermissionDecision) => void;  // fires exactly once
}

export function PermissionPrompt(props: PermissionPromptProps): React.ReactElement;
```

W4 derives the open prompt from reducer State, not from props plumbing: the overlay host shows `PermissionPrompt` when `state.overlay === 'permission'` && `state.pendingPermissionToolCallId !== null`, reading the request fields from `state.tools[pendingId]` (`{ name, args }`) + the `risk` carried into the tools entry by `permission-open`. (W6 supplies `onDecision`.)

### Decision 2 — W7 `ToolExecutor` injection: a **factory** that closes over the runtime deps W6 supplies; the per-call `emit` stays on `execute`.

```ts
// src/tools/executor.ts — W7 EXPOSES; W6 (Wave 3) SUPPLIES the deps.
import type { AgentEvent } from '../core/events';
import type { State } from '../core/reducer';
import type { Tool, ToolExecutor, PermissionPolicy, ToolResult } from '../core/contracts';
import type { PermissionDecision } from '../core/events';

export interface ToolExecutorDeps {
  tools: ReadonlyArray<Tool>;                 // the v1 registry (see Decision 3)
  policy: PermissionPolicy;                   // W8 impl, injected
  cwd: string;                                // workspace-jail root for ToolCtx.cwd
  signal: AbortSignal;                        // turn-level cancel -> ToolCtx.signal
  getState: () => Readonly<State>;            // live read-only State -> ToolCtx.state (per-call)
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision>;  // W6 parks/resolves
}

/** Build the executor that drives one tool call's lifecycle + permission round-trip. */
export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor;
```

`execute(toolCallId, name, args, emit)` (frozen signature) does, in order:
1. resolve `tool = tools.find(t => t.name === name)`; if missing → `emit tool-status(toolCallId,'error',{error})` and return.
2. `const decision = policy.evaluate(name, args, tool.risk)`.
3. on `'auto-deny'` → terminal `tool-status('error', error:'denied by policy')`, do NOT run.
4. on `'prompt'` → `emit { type:'permission-open', toolCallId, name, args, risk: tool.risk }`, then `const d = await deps.awaitPermission(toolCallId)`; if `d === 'deny'` → terminal `tool-status('error', error:'denied')`, return; otherwise proceed. (`'auto-allow'` skips straight to run.)
5. run: `emit tool-status('running')`; build `ctx: ToolCtx = { cwd, signal, emit, awaitPermission: deps.awaitPermission, state: deps.getState() }`; `const r = await tool.run(args, ctx)`.
6. terminal: `r.ok` → `tool-status('result', result:r.data)` else `tool-status('error', error:r.error)`. If `signal.aborted` mid-run, stop and emit a terminal `tool-status('error', error:'aborted')` (executor does NOT emit the top-level `aborted` event — that's W9/W6).

**The executor — not the Tool — owns `evaluate` + the `permission-open`/`awaitPermission` round-trip**, per the frozen `ToolCtx` comment. Tools never call `evaluate`. `emit` is NOT stored on deps; it arrives per `execute` call.

### Decision 3 — W7 v1 tool set + risk levels

| `name`       | `risk`        | args (JSON-schema'd in `spec`)                    | result `data` shape |
|--------------|---------------|---------------------------------------------------|---------------------|
| `read_file`  | `safe`        | `{ path: string }`                                | `{ path, content: string }` |
| `list_files` | `safe`        | `{ dir?: string }`                                | `{ dir, entries: string[] }` |
| `grep`       | `safe`        | `{ pattern: string; dir?: string; glob?: string }`| `{ matches: Array<{ file; line; text }> }` |
| `write_file` | `risky`       | `{ path: string; content: string }`               | `{ path, bytesWritten: number }` |
| `edit_file`  | `risky`       | `{ path: string; oldString: string; newString: string; replaceAll?: boolean }` | `{ path, replacements: number }` |

`bash` / shell is **NOT in v1** (DECOMP W7: "add `shellTool.ts` only after file tools are stable"). When added it is `dangerous`. All paths are **workspace-jailed** under `ctx.cwd` (reject `..` escapes / absolute paths outside the jail → `ToolResult{ok:false,error}`). Strict Windows path handling. The registry (`src/tools/registry.ts`) exports `createDefaultTools(): Tool[]` and `BUILTIN_TOOL_SPECS: ToolSpec[]`.

### Decision 4 — W9 adapter registry + v1 providers + cred reading

```ts
// src/providers/index.ts (registry) — W9 EXPOSES; W6 obtains a client by model id.
import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

export interface ProviderDeps {
  /** Per-provider config from W10 Settings.providers[providerId]; baseUrl optional. */
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  /** Env source for the apiKeyEnv lookup; defaults to process.env. Injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** Optional injected fetch (tests pass a fake; real uses global fetch). */
  fetchImpl?: typeof fetch;
}

/** Resolve a ModelClient for a catalog entry by its `provider` field. Throws on unknown provider. */
export function createModelClient(entry: ModelEntry, deps?: ProviderDeps): ModelClient;

/** Provider ids this registry can build in v1. */
export type ProviderId = 'openai' | 'openrouter' | 'anthropic';
```

- **v1 providers:** `openai` + `openrouter` (one OpenAI-compatible adapter in `src/providers/openaiCompatClient.ts`, base-url switched) and `anthropic` (`src/providers/anthropicClient.ts`). `claude-cli` is **deferred** (DECOMP: "then Claude Code CLI"; not v1). Registry keyed by `entry.provider`.
- **Creds read at call time, never stored/logged:** the adapter reads `deps.provider?.apiKeyEnv` (e.g. `'OPENROUTER_API_KEY'`) and does `(deps.env ?? process.env)[apiKeyEnv]` **inside `streamTurn`**, never in the factory, never persisted to a field, never emitted. A missing key → yield a single normalized `{ type:'error', message }` (no secret in the message) and stop.
- **NO-TRAIN routing (OpenRouter):** the OpenRouter request body sets `provider: { data_collection: 'deny', allow_fallbacks: true }`. **Do NOT add an `only:[...]`/"Western-only" allowlist** — that geographic screen is RETIRED; no-train is the whole policy.
- **Normalization contract:** `streamTurn` yields ONLY `AgentEvent`s and stops promptly on `signal.aborted` (mid-stream; emits `{type:'aborted'}` then returns). Event order per turn: `assistant-start(id)` → (`text-delta` | `reasoning-delta` | `tool-call-delta` | `tool-call`)* → optional `usage` → `assistant-done(id, stopReason)`. On error: `{type:'error',message}`. The adapter **invents no clock** — any timestamps come from the caller; `id` comes from `TurnInput.id`. Provider tool-call deltas are normalized to `tool-call-delta`(partial JSON)+`tool-call`(parsed). `stopReason` is normalized to `'end'|'tool_use'|'max_tokens'|'abort'|'error'`.

### Decision 5 — W4 component inventory (all pure/controlled; props from reducer `State` + selectors + theme tokens; no internal store, no data fetching)

| Component (`src/ui/*.tsx`) | Reads from State / selectors | Theme tokens |
|----------------------------|------------------------------|--------------|
| `Transcript`     | `state.committed` (renders via Ink `<Static>`) | role tints, `text`, `border` |
| `Message`        | one `Msg` (role, blocks, reasoning, toolSnapshot) | `roleUser/roleAssistant/roleSystem`, `text`, `textDim` |
| `StreamingMessage` | `state.live` (high-freq redraw path) | role tints, `text` |
| `ToolCallCard`   | `state.tools[toolCallId]` (or a `ToolState` prop) → `.status` | `toolPending/toolRunning/toolResult/toolError`, `border` |
| `ModeBadge`      | `state.mode` | `modeBadge.{normal,plan,ultracode}`, `textInverse` |
| `StatusLine`     | `selectStatusLine(state, {model,cwd,maxContext})` | `text`, `textDim`, `accent`, status tokens |
| `InputBox`       | controlled value + `onSubmit` (no State read) | `text`, `accent`, `border` |
| `SlashPalette`   | `state.overlay==='slash'` + command list prop | `accent`, `text`, `textDim` |
| `ModelPicker`    | `state.overlay==='model-picker'` + `ModelCatalog.list()` prop | `accent`, `text` |
| **`PermissionPrompt`** | `state.tools[pendingId]` + `risk`; shown when `overlay==='permission'` (see Decision 1) | `warning`, `error`, `accent`, `textInverse` |
| `OverlayHost`    | `state.overlay` → routes to SlashPalette/ModelPicker/PermissionPrompt | — |

Every component takes its data via props (the reducer State or a slice of it) + theme tokens; none subscribes to a store, calls a provider, or owns a clock. `PermissionPrompt` is the W4↔W8 decoupling point: W8's `PermissionPolicy` produces the decision *type*; W4 renders the choice and reports a `PermissionDecision` via `onDecision`; W6 connects them.

**Decisions (invented, flag for ratify):**
1. **Permission prompt = W4 component + W8 headless policy** (split per Decision 1). Alternative (prompt inside W8) was rejected: it would force React into the policy unit and couple W7→W8 UI.
2. **W9 registry keyed by `entry.provider`** (not a per-id switch) with one shared OpenAI-compatible adapter for `openai`+`openrouter`. `claude-cli` deferred out of v1.
3. **`OverlayHost` is a W4 component** (not W6) so overlay routing is pure-render and testable; W6 only supplies the `onDecision`/`onSubmit`/`onSelect` callbacks.
4. **Tool result `data` shapes** (Decision 3 table) are W7's structured contract; UI formatting stays in W4. These shapes are proposed — ratify or adjust field names.
