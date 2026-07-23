# Architecture

`juno` is a single-runtime TypeScript + React + Ink application. State lives in one
pure reducer; every provider, tool, and permission interaction is normalized into a
single `AgentEvent` union that maps 1:1 onto reducer actions. The UI is a pure
function of reducer state.

## Module tree

All source lives under `src/`. Each directory owns one concern:

| Directory          | Owns                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `src/core/`        | The frozen seam. `events.ts` (the `AgentEvent` union + `eventToAction`), `reducer.ts` (the single pure reducer, `State`/`Action`/`Msg`), `contracts.ts` (the `ModelClient`/`Tool`/`ToolExecutor`/`PermissionPolicy` interfaces), `selectors.ts` (pure derived state for the status line), `fakeClient.ts` (a deterministic `ModelClient` for tests). |
| `src/providers/`   | LLM adapters. `openaiCompatClient.ts` (serves `openai` and `openrouter`), `anthropicClient.ts` (Anthropic Messages), `claudeCliClient.ts` and `codexCliClient.ts` (subscription CLI transports), `index.ts` (provider registry). |
| `src/agent/`       | The coordinator. `turnRunner.ts` (drives one submission to completion, looping on `tool_use`) and `eventBus.ts` (the permission park/resolve registry). |
| `src/permissions/` | The permission model. `policy.ts` (pure synchronous gate) and `patterns.ts` (the glob match-key grammar). |
| `src/tools/`       | Tool execution. `executor.ts` (drives one tool call + owns the permission round-trip), `fileTools.ts` (the five workspace-jailed file tools), `registry.ts` (the v1 tool set + their specs). |
| `src/hooks/`       | React glue. `useStreamingTurn.ts` (reducer + abort + registry + delta batching), `useKeybinds.ts` (scoped key handling), `useTerminalSize.ts`. |
| `src/services/`    | Process-edge services. Settings/catalog, atomic session and memory persistence, bounded durable background agents, MCP lifecycle, verification, trace recording/replay, and terminal cleanup. |
| `src/ui/`          | Ink components: `Transcript`, `StreamingMessage`, `StatusLine`, `InputBox`, `OverlayHost`, `SlashPalette`, `ModelPicker`, `PermissionPrompt`, semantic `ToolBlock`/`workBlocks`, `ToolCallCard`, `Message`, `ModeBadge`, `MarkdownView` (+ pure `markdown` tokenizer), `theme`. |
| `src/app.tsx`      | The root component. Wires the hooks together, owns controlled UI state, routes overlays. |
| `src/cli.ts`       | The `juno` entry point. Parses `--help`/`--version`, else builds deps and renders `<App>`. |

## The core data-flow seam

The load-bearing design is a single, frozen pipeline:

```
provider stream  ──►  AgentEvent  ──►  eventToAction  ──►  Action  ──►  reducer  ──►  State  ──►  Ink render
```

1. **Provider stream.** A `ModelClient.streamTurn(input, tools, signal)`
   (`src/core/contracts.ts`) is an async iterable that yields **only** normalized
   `AgentEvent` values — never provider-specific shapes. Each adapter translates its
   wire format (OpenAI SSE chunks, Anthropic `message_*`/`content_block_*` events)
   into that union.

2. **`AgentEvent`** (`src/core/events.ts`) is the discriminated union every adapter
   emits: `assistant-start`, `text-delta`, `reasoning-delta`, `tool-call`,
   `tool-call-delta`, `tool-status`, `permission-open`, `permission-resolved`,
   `assistant-done` (carrying a normalized `StopReason`), `usage`, `aborted`,
   `error`.

3. **`eventToAction`** (also in `events.ts`) maps each event variant 1:1 to a
   reducer `Action`. Purely local UI actions — `user-submit`, `set-mode`,
   `cycle-mode`, `set-overlay`, `clear` — have no corresponding event and are
   dispatched directly by the UI.

4. **`reducer`** (`src/core/reducer.ts`) is the single source of truth. It is
   **pure**: no I/O, no `Date.now`, no `Math.random`, never mutates inputs, and
   returns the same state reference on a no-op (consumers may rely on `===`). It
   maintains:
   - `committed: Msg[]` — finished messages, rendered once into Ink `<Static>`.
   - `live: Msg | null` — the in-flight streaming assistant turn.
   - `tools: Record<string, ToolState>` — per-`toolCallId` accumulated tool state.
   - `phase` — `idle | preparing | streaming | awaiting-permission | running-tool |
     compacting | error`. This ONE field is the sole "a turn/compaction is in flight"
     authority (`selectBusy`); every phase change routes through the pure
     `transitionPhase(phase, action, ctx)` table so a new action can't compile without a
     decision. `preparing` covers the pre-`assistant-start` gap (submitted, no first byte
     yet — it replaced the out-of-reducer optimistic-turn flag); `compacting` is a
     fire-and-forget compaction LLM call (it replaced the `compactingRef`/`isCompacting`
     mirror). Acquired/released by the local `turn-start`/`turn-settle` and
     `compaction-start`/`compaction-settle` actions.
   - `overlay` — `none | slash | permission | model-picker`.
   - `mode` — `normal | plan | ultracode`.
   - `tokens: { in, out }` — cumulative usage.
   - `pendingPermission` (`{ toolCallId, risk } | null`) and `errorMessage`.
   - `completedTurns` (optional) — a monotonic count of genuinely-completed turns
     (terminal `end`/`max_tokens` only) that drives the completion bell on an increment,
     so an Esc-abort (which also lands at `idle`) never rings.

   Message blocks carry stable, monotonic ids (`<msgId>:block:<n>`) so React keys
   never shift across redraws. At `assistant-done`, the reducer freezes a
   `toolSnapshot` of the message's referenced tool calls so the committed
   `<Static>` render path never reads the live `tools` map.

5. **Ink render.** `App` renders `Transcript` (committed) + `StreamingMessage`
   (live) + `OverlayHost` + `StatusLine` + `InputBox`, derived entirely from state.
   `Message` renders a **completed** assistant text block through `MarkdownView`
   (headings, bold/italic/inline code, fenced blocks, lists, blockquotes, links,
   rules; tables degrade to aligned text). Gating is `role === 'assistant' && done`,
   so a streaming turn keeps raw text (no half-written-markup flicker) and, once a
   message commits to `<Static>`, it carries its formatting permanently. The
   `markdown` tokenizer is pure and tolerant — unmatched markers stay literal and an
   unterminated fence degrades rather than throws — so non-markdown text (pasted
   code with `*`/`#`/`_`) round-trips unmangled. User/system/tool text stays verbatim.

### Where state is held

`useStreamingTurn` (`src/hooks/useStreamingTurn.ts`) owns `useReducer(reducer)`. It
also keeps a `stateRef` updated **synchronously** alongside React's async dispatch,
so the executor's `getState()` and the permission-request selector always see the
newest state even before a re-render. Streaming `text-delta`/`reasoning-delta`
actions are batched on a ~16 ms timer and coalesced before dispatch to avoid
re-rendering on every token.

## The turn coordinator

`runTurn(input, deps)` in `src/agent/turnRunner.ts` drives one user submission to
completion:

1. Consume `client.streamTurn(...)`, dispatching each event via `eventToAction`.
2. Accumulate assistant text and `tool-call` records for the turn.
3. On `assistant-done` with `stopReason: 'tool_use'`, **defer** committing the
   assistant message: run the tool calls first so their `tool-status` results land
   before the `<Static>` snapshot is taken, then commit.
4. Run each tool call through `executor.execute(...)`. The executor emits
   `permission-open` and the `tool-status` lifecycle; the runner does not
   separately emit those for executor-driven calls.
5. Re-enter: append the assistant message (with its `toolCalls`) plus one `tool`
   message per resolved call into `messages`, and loop for the next turn.
6. Terminate on any non-`tool_use` stop (`end`/`max_tokens`/`error`/`abort`), an
   empty stream, or signal abort.

Defensive invariants in the runner: a `tool_use` stop with **no** matching
`tool-call` emits an `error` rather than calling the executor with a phantom call;
any tool call that completes without a terminal status is recorded as a failure for
re-entry; stranded permission overlays are cleared at a non-`tool_use` terminal.

### Abort and drain

The runner registers an abort listener on the shared `AbortSignal`. On abort or
teardown it calls `registry.drainDeny()` so any executor parked on
`awaitPermission` unsticks (resolving to `deny`) instead of hanging, and dispatches
the terminal `aborted` action **exactly once** (guarded by a flag; `drainDeny()` is
idempotent). `useStreamingTurn.abort()` only calls `controller.abort()` and drains
the registry — it never dispatches `aborted` itself, so the runner's listener stays
the single source of that action.

## The permission round-trip

Background children use the same executor boundary but a distinct resolution
surface. A prompt emits a sanitized durable `needs-user` checkpoint and parks the
child executor. Agent Workspace grant-once/deny resolves that exact promise; it
does not start a replacement turn. Persisted checkpoints from a dead process are
inspection-only because no safe provider continuation can be reconstructed.

This is the most subtle seam. The **executor owns** the permission decision — tools
never call `evaluate`/`awaitPermission`. The full cycle:

```
executor: policy.evaluate(name, args, risk)
            │
            ├─ 'auto-allow'  ──► run the tool
            ├─ 'auto-deny'   ──► emit tool-status('error'), do NOT run
            └─ 'prompt'
                 │
                 ├─ emit permission-open ──► reducer sets overlay='permission',
                 │                            phase='awaiting-permission',
                 │                            pendingPermissionToolCallId=id
                 │
                 ├─ App renders PermissionPrompt (via OverlayHost)
                 │     user presses y / a / d / !
                 │       onDecision(decision)
                 │
                 ├─ useStreamingTurn.resolvePermission(id, decision):
                 │     1. if persistent, policy.remember(toolName, decision)
                 │     2. registry.resolve(id, decision)   ◄── unsticks the await
                 │     3. dispatch permission-resolved      ◄── reducer drops overlay
                 │
                 └─ await awaitPermission(id) resolves with the decision
                       deny  ──► emit tool-status('error'), do NOT run
                       else  ──► run the tool
```

The park/resolve registry (`src/agent/eventBus.ts`, `createPermissionRegistry`) is
the mechanism: it parks a `Deferred<PermissionDecision>` keyed by `toolCallId`. It
guarantees **every parked promise eventually settles** — on a user decision, on
`drainDeny()` (abort/teardown), and even on an out-of-order `resolve()` that arrives
before `await()` (stashed in a `resolvedBefore` map so the later `await` returns
immediately). It never rejects; the only currency is a `PermissionDecision`.

The call's `RiskLevel` rides INTO reducer state: `permission-open` stores
`pendingPermission = { toolCallId, risk }`, and every terminal that closes the prompt
(`permission-resolved`, `aborted`, `error`, `compact`, `resume-session`, and a settling
`tool-status` for that id) clears it. `useStreamingTurn` rebuilds the full
`PermissionRequest` (name + args + risk) straight from that field — no side-table to
prune, which structurally fixes the old `permissionRisksRef`'s leak on the `error` path.

There is **one shared `PermissionPolicy` instance**: the same object injected into
the executor is the one `resolvePermission` calls `.remember(...)` on, so an
"always allow" decision in the UI immediately affects the executor's next
`evaluate`.

## Usage / token accounting

Token counts are **session-cumulative**. The reducer's `usage` action is additive:
`tokens.in += tokensIn; tokens.out += tokensOut`. To keep that additive model
correct:

- `user-submit` does **not** touch tokens — an earlier pre-provider input estimate
  was removed because it double-counted input against the provider's real `usage`
  event.
- The OpenAI-compatible adapter requests `stream_options.include_usage` and emits
  one `usage` event from the provider's `prompt_tokens`/`completion_tokens`.
- The Anthropic adapter emits input tokens at `message_start` (with `tokensOut: 0`)
  and output tokens at `message_delta` (with `tokensIn: 0`) — never both at once —
  because Anthropic re-reports cumulative `output_tokens`, so counting them at both
  points would double-count output.

`selectContextWindow` / `selectCost` (`src/core/selectors.ts`) derive the
status-line bar; context-window occupancy is the real measured input size of the most
recent request (else a char/4 transcript estimate), clamped to `[0, 1]` against the
configured `maxContext`, and `selectContextPressure` drives the compaction-aware tint.
`clear` resets the conversation and preserves the user prefs (effort, permission mode).

## Providers

`createModelClient(entry, deps)` (`src/providers/index.ts`) selects an adapter by
`entry.provider`: `openai` and `openrouter` both use `createOpenAICompatClient`
(base-URL switched, `isOpenRouter` flag set), `anthropic` uses
`createAnthropicClient`, and `claude-cli` / `codex-cli` spawn their authenticated
subscription CLIs headlessly. An unknown provider throws. HTTP adapters read their
API key from the env var named by `provider.apiKeyEnv` **inside `streamTurn` at call
time** — never stored, logged, or emitted. CLI transports preserve provider thread
ids across turns and normalize their NDJSON into the same `AgentEvent` seam.
Privacy and headless-tool enforcement details are in [SECURITY.md](SECURITY.md).

## Services at the process edge

- **`config.ts`** — `createConfigService` resolves `defaults → file → env`, caches
  after first load, degrades to defaults on a missing/corrupt file, and exposes
  `get()`/`getValue()`/`reload()`. A file-free `createFakeConfigService` exists for
  tests.
- **`catalog.ts`** — `createModelCatalog` indexes the built-in `ModelEntry` list by
  id and alias for O(1) `resolve`, with `list`/`byProvider`/`default`. Entries are
  defensively cloned so callers can't mutate internal state.
- **`sessions.ts`** — `SessionStore` persists `<id>.json` snapshots; `TranscriptLog`
  appends `<id>.jsonl` lines. Both validate parsed JSON against the `Msg`/
  `SessionMeta` shapes before accepting it. In-memory variants exist for tests.
- **`backgroundAgents.ts` / `backgroundTaskStore.ts`** — detached child execution
  with a settings-backed concurrency cap and wall-clock limit, FIFO promotion,
  cancellation, permission checkpoints, atomic task records, write-through NDJSON
  output, and restart reconciliation. The runner is the authority for live queue,
  status, and timing projections used by both orchestration surfaces.
- **`memory.ts`** — a bounded key/value store (default 64 KiB) that evicts
  oldest-by-`updatedAt` (FIFO) when a write would exceed the limit. This is the
  SESSION-SCRATCH tier of a two-tier memory: `remember_fact`/`recall_facts` are
  bounded, evictable working notes — NOT durable. Durable memory lives in the
  personal "brain": `src/services/brainRemember.ts` + the `brain_remember` tool
  (gated behind `brain.enabled`, risk:'risky') spawn the shell-free
  `brain-remember` CLI, whose write is dedup-guarded, git-committed, and pushed
  to a private remote. The read side (Phase 1) is `src/services/brainRecall.ts` +
  the `brain_recall` / `brain_get` tools (same `brain.enabled` gate, risk:'safe' —
  reads only): they spawn the shell-free `brain-recall` CLI with `--json`
  (`brain_recall` searches; `brain_get <id>` fetches full text) and return
  structured results. All three brain tools are parent-agent-only (registered
  after the subagent snapshot) and juno-internal (never mapped onto the claude-cli
  backend). Mirrors the read-only Phase-0 `brain.ts` SessionStart port; every path
  fails soft (a missing/broken brain never crashes the session).
  Phase 2 (ambient recall): behind `brain.ambientRecall` (default true, active
  only under `brain.enabled`), each raw user prompt is piped (stdin hook
  contract, via the shared `runBrainHook` spawn path in `brain.ts`) to the
  brain's FTS-only UserPromptSubmit hook `brain-hook` (~50ms; a 2.5s hard
  timeout bounds the worst case), and any matched-memory block is appended —
  Phase-0 `<brain-memory-context>` framing — to that turn's OUTGOING user
  message in `useStreamingTurn.submit`, so it reaches all three backends but is
  never committed, rendered, or fed back into the next recall query.
  Ambient recall is awaited before the turn dispatches, so it adds a bounded
  pre-turn delay (≤2.5s hard timeout, ~50-70ms typical) rather than running
  free; empty/timeout/error ⇒ inject nothing and proceed (fails open).
