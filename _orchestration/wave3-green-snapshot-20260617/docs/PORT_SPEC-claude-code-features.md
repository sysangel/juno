# juno Port Spec — Claude Code Special Features via the Max Subscription

**Status:** SCOPE ONLY (not implementation). Target executor: an Orchestrator-of-Orchestrators running team-of-3 waves.
**Date:** 2026-06-17 · **Synthesizer:** Opus 4.8 (final, post-verification) · **Inputs:** Team A (feature inventory), Team B (endpoint matrix), Team C (juno seam map — *verified against source*), Team D (subscription-drive), plus a skeptical Opus verifier and the authoritative `claude-api` reference.

**Verification note.** All Team C `file:line` seams cited below were re-read against `C:\Users\Core\src\juno` source on 2026-06-17 and confirmed accurate (ModelClient/Tool/ToolCtx contracts, the provider switch, both `buildRequestBody` functions — neither reads `input.mode` — the catalog with no auth field, the build-once `cli.ts` client, the executor `ctx`-lacks-client gap, `turnRunner` re-entry, `eventBus` drain, `fileTools` risk levels). A skeptical verifier independently re-confirmed these. **Two v1 claims were materially wrong and are corrected here:** (1) the effort mechanism is **not** a disputed/possibly-hallucinated API surface — it is a *settled, model-keyed* API fact, and the model juno actually ships uses the *legacy* field; (2) the Agent SDK does **not** strictly "require an API key" — an OAuth/auth-token path is documented, so the real open question is narrower. Both are fixed below. Genuinely unverified items (subscription billing for `claude -p`, the `stream-json` schema) are confined to **Open Questions** and gated in Wave 0.

---

## 1. Context and corrected architecture

### 1.1 juno today (verified 2026-06-17)

- TypeScript / Node 20 / React+Ink terminal agent. 206/206 vitest green, tsc clean. Root: `C:\Users\Core\src\juno`.
- **Transport:** raw HTTP (`fetch`) to OpenAI / Anthropic / OpenRouter using API keys (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`). No subscription path exists.
- **No Anthropic SDK is present.** `package.json` deps are only `ink` / `react` / `supports-color` (verifier-confirmed); juno does raw `fetch`. **Neither `@anthropic-ai/claude-agent-sdk` nor `@anthropic-ai/sdk` is a dependency.** Any SDK-based or CLI-spawn path is therefore a *new dependency* to introduce into a zero-Anthropic-SDK ESM/tsx project — not a swap of one client impl for another. (See §4 Feature 1 risk and OQ 1.)
- **Frozen core pipeline** (do not modify for these features):
  ```
  ModelClient.streamTurn(TurnInput, ToolSpec[], signal) → AgentEvent
     → eventToAction → Action → reducer → State → Ink
  ```
- **Two extension seams carry everything:**
  - `ModelClient` (`src/core/contracts.ts:95-97`) — single method `streamTurn(input, tools, signal): AsyncIterable<AgentEvent>`. A new backend = a new implementer.
  - `Tool` (`src/core/contracts.ts:100-105`) — `{ name, risk, spec, run(args, ctx) }`, registered in `src/tools/registry.ts`. Subagents and skills attach here.
- **Provider registry:** `createModelClient(entry, deps)` is a `switch` on `entry.provider` (`src/providers/index.ts:23-34`). `ProviderId = 'openai' | 'openrouter' | 'anthropic'` (`index.ts:20`). A `claude-cli` entry is **only a comment** (`index.ts:19`) — it does not exist as code.
- **Catalog:** static 5 entries in `src/services/catalog.ts:21-58`. `ModelEntry` has **no auth field** (`catalog.ts:1-8`). The entries are:
  - `gpt-4.1` (openai, **default:true**, `catalog.ts:22-29`)
  - `gpt-4.1-mini` (openai, `:30-36`)
  - `claude-sonnet-4-20250514` (anthropic, `:37-43`)
  - `openai/gpt-4.1` (openrouter, `:44-50`)
  - `anthropic/claude-sonnet-4` (openrouter, `:51-57`)
- **Modes are inert.** `mode: 'normal'|'plan'|'ultracode'` is cycled in the reducer and **delivered** to `TurnInput.mode` (see seam note in §Seam-correction below), but **neither adapter's `buildRequestBody` reads `input.mode`** (verified: `anthropicClient.ts:217-252` and `openaiCompatClient.ts:210-250` never reference `input.mode`). It only colors `ModeBadge.tsx`. The `TurnInput.mode` doc-comment promises "lets adapters tweak system prompt/temperature" (`contracts.ts:38-39`) — that promise is unfulfilled at the adapter layer.
- **Tools:** 5 file tools only (read/list/grep/write/edit) in `src/tools/`. No subagent/Task/spawn tool; no skills loader (grep = 0 hits for both, verifier-confirmed).
- **Known bug (in scope):** the `ModelClient` is built **once** at startup (`src/cli.ts:57-61`) from the default entry. Each adapter captures its `baseUrl`/`apiKeyEnv` at construction (`anthropicClient.ts:31-32`, `openaiCompatClient.ts:37-40`) and `streamTurn` sends `model: input.model ?? entry.id` (`anthropicClient.ts:229`, `openaiCompatClient.ts:223`). The TUI picker only swaps the slug string, so picking a model from a *different provider* sends that slug to the *first* provider's endpoint. The failure is real; the exact HTTP code is endpoint-dependent (404/401/400 — not necessarily a 404). Any multi-backend feature must fix this first.

### 1.2 The corrected target

The user's corrected intent inverts the priority order: **the primary backend is Claude Code itself, driven through the Max subscription — not a paid API.** The deferred `claude-cli` provider becomes the *default*. Raw-API providers (Anthropic / OpenAI / OpenRouter) remain as secondary/fallback backends.

```
                       ┌─────────────────────────────────────────────┐
   juno TUI (Ink) ───► │ ModelClient (selected per catalog entry)     │
                       ├─────────────────────────────────────────────┤
  PRIMARY  (default) → │ claudeCliClient → spawn `claude -p`          │ ← Max subscription
                       │   --output-format stream-json  (subprocess)  │   (no API key, IF OQ1 holds)
                       │ anthropicClient → raw HTTPS (ANTHROPIC_API_KEY)│
  SECONDARY          → │ openaiCompatClient → raw HTTPS (OPENAI/OR key)│
                       └─────────────────────────────────────────────┘
```

**Subprocess CLI vs the Agent SDK (the central, genuinely-open question).** Two facts must be held apart:

1. *Auth is not the blocker the v1 spec claimed.* The Anthropic credential chain resolves in order: `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` (a Bearer/OAuth token), then an `ant auth login` profile — and the reference states **"Claude Code and the Claude Agent SDK honor the same profile resolution."** So an API key is **not strictly required**; an OAuth/auth-token path exists for both the CLI and the SDK. The v1 framing ("the SDK requires `ANTHROPIC_API_KEY` and does not accept subscription OAuth") is **overstated and removed.**
2. *What is still unverified* is the narrower question: **can the Max consumer subscription mint a credential (an `ANTHROPIC_AUTH_TOKEN` / `ant auth login` profile) that the CLI/SDK auth chain accepts headless, with no per-token billing?** The documented precedence proves a token path *exists*; it does **not** prove the Max plan can produce one usable for headless `claude -p`. The "June-2026 Agent SDK credit covers headless `claude -p`" detail (attributed to Team D) is **not corroborated** by the authoritative reference — treat it as an unsubstantiated rumor, not a medium-confidence finding.

**Decision posture (unchanged in spirit, sharpened):** spawn `claude -p` and translate its `stream-json` to juno `AgentEvent`s, *because* it is the lowest-assumption way to reuse a logged-in Claude Code session — **but the build is gated on Wave 0A empirically confirming the Max-subscription auth + no-per-token-billing claim.** If Wave 0A shows the *SDK* auth chain also accepts the subscription token, an SDK client is cleaner than subprocess parsing and should be reconsidered (it is still a new dependency either way). If Wave 0A returns NO-GO on subscription auth entirely, stop and re-plan §1.2 (fallback: pay-per-token Anthropic API as primary — see OQ 1).

**Net architectural change:** introduce a fourth `ModelClient` (subprocess, or SDK if Wave 0A favors it) that translates Claude Code output into juno's existing `AgentEvent` union — touching **no** reducer/event/eventToAction code (the frozen core already carries `reasoning-delta`, `tool-call`, and the tool re-entry loop every feature rides on).

---

## 2. Questions to investigate (sharpened)

1. **Subscription drive (primary backend).** Can the Max *consumer* subscription yield a credential the `claude -p` / Agent SDK auth chain accepts headless (`ANTHROPIC_AUTH_TOKEN` or `ant auth login` profile), with **no API key and no per-token billing**? The documented precedence proves such a path *exists in general*; it does not prove the Max plan can mint one. (Unverified — Wave 0A.)
2. **Effort = ultracode.** Resolved to a **model-keyed lookup**, not a dispute (see §3 note). The remaining question is *which model juno standardizes on*, which then determines the field deterministically.
3. **Subagent spawning.** Port the ability to spawn isolated, fresh-context workers. Via Claude Code's native subagents, or a juno-side `spawn_subagent` Tool that runs a nested turn, or both?
4. **Skills loading.** Port loading of `~/.claude/skills/*/SKILL.md`. As system-prompt enrichment (works on every endpoint, plain text) and/or as an invokable `run_skill` Tool, and/or by letting the CLI backend auto-discover them?
5. **Full inventory → portability decision.** Of the Claude Code console specials (effort, subagents, skills, plan mode, hooks, MCP, permission modes), which are portable into juno and at what cost?
6. **Per-endpoint feasibility (the crux).** For each feature, is it Anthropic-only, OpenAI-too, OpenRouter, or available when driving Claude Code via subscription? Map feature × endpoint → feasible? + exact mechanism.

---

## 3. Feature × endpoint capability matrix

Legend: ✅ native/direct · ⚠️ partial / model-restricted / indirect · ❌ not available natively (must implement in harness) · **Conf** = synthesizer's confidence after reconciling teams against the authoritative reference.

> **Effort mechanism — RESOLVED (was "the central dispute"; it is not one).** The authoritative `claude-api` reference settles this: **both** `thinking.budget_tokens` and `output_config.effort` are real, and the choice is a **deterministic function of model generation**, not a dispute or a hallucination.
>
> - **Current-generation Claude reasoning models** (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5): use **adaptive thinking** `thinking: { type: 'adaptive' }` + **`output_config: { effort: 'low'|'medium'|'high'|'xhigh'|'max' }`**. On these models `thinking: { type: 'enabled', budget_tokens: N }` is **deprecated/removed and returns a 400** (removed on Opus 4.7/4.8/Fable 5; deprecated on 4.6/Sonnet 4.6).
> - **Older models** (Sonnet 4.5 and earlier — which **includes the catalogued `claude-sonnet-4-20250514`**): the legacy **`thinking: { type: 'enabled', budget_tokens: N }`** is the correct field; **`output_config.effort` will *error*** on these (effort is documented as Opus 4.5+/Sonnet 4.6+ only, "will error on Sonnet 4.5 / Haiku 4.5", and Sonnet-4-2025-05 predates 4.6).
>
> **Catalog coupling — load-bearing.** juno's catalogued Anthropic models are `claude-sonnet-4-20250514` (direct) and `anthropic/claude-sonnet-4` (OpenRouter) — i.e. the *deprecated* Claude Sonnet 4 (retires **2026-06-15** per the migration guide; replacement `claude-sonnet-4-6`). For that exact model the **legacy `budget_tokens` field is correct**, and `output_config.effort` would 400. **Feature 2's Anthropic path, as written for the current catalog, must send `budget_tokens` — not `effort`.** To use `output_config.effort` you must **first add a 4.6+/Opus model to the catalog.** Do not carry this as an open question — carry it as the sequencing decision in OQ 5.

### 3.1 The features the user explicitly wants

| Feature | Claude Code via **subscription** (`claude -p`) | Raw **Anthropic** API | **OpenAI** API | **OpenRouter** | Conf |
|---|---|---|---|---|---|
| **CHANGE EFFORT (→ ultracode)** ⭐ | ✅ `--effort low\|medium\|high\|xhigh\|max` flag (Team D; CLI default is `xhigh`) | ✅ **model-keyed (not disputed):** catalogued `claude-sonnet-4-20250514` → `thinking:{type:'enabled',budget_tokens:N}` (`effort` 400s); a 4.6+/Opus model → `thinking:{type:'adaptive'}`+`output_config:{effort:…}` (`budget_tokens` 400s) | ⚠️ `reasoning_effort` **only on reasoning models** (o-series / gpt-5.x). **No-op on gpt-4.1 / gpt-4.1-mini** (current catalog, incl. the **default** gpt-4.1) | ⚠️ `reasoning` (normalized `{effort}`/`{max_tokens}`) — **passthrough, model-dependent** | **high** |
| **Subagent spawning** | ✅ native (`--agents <json>`, `.claude/agents/`, skill `context: fork`) | ❌ no native concept on the Messages API; ⚠️ the **Managed Agents API** (beta) *is* a full native subagent surface (coordinator rosters, `multiagent`, session threads) but is a **different API**, not Messages — see §3.2 takeaways | ❌ implement manually (N parallel calls) | ❌ implement manually (Claude-model passthrough only) | **high** |
| **Skills loading** | ✅ filesystem auto-discovery (`~/.claude/skills/`, `.claude/skills/`); `--bare` disables | ❌ not a Messages-API concept; ⚠️ Managed Agents API has a first-class **`skills[]`** field (`{type:'anthropic'|'custom', skill_id}`, max 20) + a Skills API — again a *different* surface | ❌ embed as prompt/tools | ❌ embed as prompt (Claude passthrough) | **high** |

### 3.2 The rest of the Claude Code inventory (for the §4 portability decision)

| Feature | Claude Code via subscription | Raw Anthropic | OpenAI | OpenRouter | Portable to juno? | Conf |
|---|---|---|---|---|---|---|
| **Plan mode** | ✅ `--permission-mode plan` (a *permission* mode, not auto-plan-execution — Team D) | ❌ | ❌ | ❌ | ✅ as juno-side prompt-steer + read-only policy (works every endpoint); ⚠️ native only via CLI | high |
| **Permission modes** (default/acceptEdits/plan/auto/dontAsk/bypass) | ✅ `--permission-mode <m>` | ❌ | ❌ | ❌ | ⚠️ juno already has its own `PermissionPolicy`; map a subset | med |
| **Hooks** (PreToolUse/PostToolUse/Session…) | ✅ full (settings.json) | ❌ | ❌ | ❌ | ⚠️ deferred — juno would implement Pre/PostToolUse around executor | med |
| **MCP servers** | ✅ `--mcp-config` (CLI auto-connects) | ⚠️ `mcp_servers` connector (beta, remote/HTTPS); Managed Agents has full MCP+vault auth | ❌ native | ⚠️ Claude-model passthrough / OR tunnel | ⚠️ deferred — Node MCP client lib exists; nontrivial | med |
| **Streaming / system prompt / tool calling / vision** | ✅ | ✅ | ✅ (tool calling ✅; vision ✅) | ✅ passthrough | ✅ juno already streams + system-prompt + 5 tools; vision is additive | high |

**Per-endpoint takeaways the parent asked for:**
- **Effort is fundamentally Claude/Anthropic-centric, and the field is model-determined.** Real when driving Claude Code (`--effort`), real on the raw Anthropic API (legacy `budget_tokens` for the catalogued Sonnet 4; `output_config.effort` only after a catalog bump to 4.6+/Opus), real on **OpenAI reasoning models only** (`reasoning_effort`), passthrough-and-model-dependent on **OpenRouter**, and a **no-op on the two non-reasoning OpenAI models currently in juno's catalog — including the out-of-box default `gpt-4.1`.** Consequence: **even after wiring effort end-to-end, `ultracode` does nothing on the default model.** Making `ultracode` observable on first run therefore *couples to* flipping the default to the CLI (Feature 1) or to a catalog bump (OQ 5).
- **Subagents and skills have no native *Messages-API* equivalent — but the Anthropic *Managed Agents API* is precisely the API-native answer.** Managed Agents is a separate beta surface (agents/sessions/environments, `agent_toolset_20260401`, `multiagent` coordinator rosters, `skills[]`). It is defensible to **defer** it (different API, beta, hosted-execution model), but it is **not** correct to say "no native raw-API path exists." Wave 4B must explicitly weigh Managed Agents for Features 3 & 4, not dismiss it.
- **The single highest-leverage subscription feature is that effort + subagents + skills all come "for free" when juno shells out to `claude -p`** — *provided the subscription-auth claim (OQ 1) holds.* Because **every** headline feature flows through this one backend, Wave 0A is a hard go/no-go for ~80% of the spec's claimed value, not just one feature (see §5 risk note).

---

## 4. Per-feature port design

Each feature: *what it is · endpoint mechanism · juno seam (file + shape of change, verified) · open questions · risk.*

### Seam-correction carried into every feature (verifier finding)

The v1 spec overstated the `systemPrompt`/`mode` plumbing gap. Verified state:

- **`mode` already reaches `TurnInput`.** `useStreamingTurn.ts:276` sets `mode: deps.mode ?? stateRef.current.mode`, and `StreamingTurnDeps:46` declares `mode?`. Because of the `stateRef.current.mode` fallback (the reducer's cycle-mode drives `state.mode`), `mode` reaches `TurnInput` **today even without `app.tsx` passing it.** The *only* gap for Features 2/5 is that **both adapters discard it** — there is no delivery plumbing to build, only adapter consumption.
- **`systemPrompt` plumbing is half-done.** The hook **already reads** `systemPrompt: deps.systemPrompt` (`useStreamingTurn.ts:277`) and `StreamingTurnDeps:47` **already declares** `systemPrompt?`. The **only** missing wiring is (a) the `app.tsx` call site (`app.tsx:58-65`) not passing the prop and (b) `AppDeps` (`app.tsx:23-30`) lacking a `systemPrompt` field, fed from `cli.ts:56-67`. The hook end is done.

### Feature 1 — Subscription / `claude-cli` provider (the new PRIMARY backend)

- **What it is:** a `ModelClient` that drives Claude Code over the Max subscription instead of raw HTTP. Elevates the deferred `claude-cli` to default.
- **Endpoint mechanism:** spawn `claude -p "<prompt>" --output-format stream-json --verbose [--model …] [--effort …] [--permission-mode …]`; parse the `stream-json` event stream. Auth is *intended* to be inherited from the logged-in CLI session / `ANTHROPIC_AUTH_TOKEN` / `ant auth login` profile — **no API key.** (Unverified for the Max consumer subscription — Wave 0A.)
- **juno seam (verified):**
  1. New `src/providers/claudeCliClient.ts` exporting `createClaudeCliClient(entry, deps): ModelClient`. Translate CLI `stream-json` → the same `AgentEvent`s `anthropicClient.ts` already emits: text→`text-delta` (`:142`), thinking→`reasoning-delta` (`:147`), tool intents→`tool-call-delta`/`tool-call` (`:154,:165`), plus `assistant-start`/`assistant-done(stopReason)`/`usage`/`aborted`/`error` (`:83,:200,:111,:186`). **Must honor `signal`**: on abort, kill the child and yield `{type:'aborted'}` (the runner's abort/drain contract `turnRunner.ts:111-117`, `eventBus.ts:80-87` depends on prompt stop).
  2. Register: add `'claude-cli'` to `ProviderId` (`index.ts:20`) and `case 'claude-cli': return createClaudeCliClient(entry, deps);` to the switch (`index.ts:24-33`).
  3. Catalog entry with `provider: 'claude-cli'`, `default: true` (`catalog.ts:21-58`). No `apiKeyEnv` (ModelEntry has no auth field — confirmed `catalog.ts:1-8`); `ProviderDeps.provider` is optional (`index.ts:13-14`) and can be omitted.
  4. **Fix the build-once endpoint bug** (prerequisite): replace the single pre-built client in `cli.ts:57-61` with a **factory** threaded through `AppDeps` (`app.tsx:23-30`) into `useStreamingTurn` (currently consumes pre-built `deps.client` at `useStreamingTurn.ts:40,282`), rebuilding/selecting the client from the picker-selected entry's provider when `selectedId` changes (`app.tsx:56,64`).
- **Open questions:** (a) Does the Max *consumer subscription* mint a headless credential the CLI/SDK auth chain accepts, with **no per-token billing**? (b) Interactive-session reuse vs. `ant auth login`/`setup-token` for a spawned subprocess? (c) Exact `stream-json` event schema (tool-call shape, thinking blocks, usage) — empirical capture required. (d) Windows subprocess specifics (`claude` resolution on PATH, shell quoting, signal-kill semantics). (e) Per-turn subprocess spawn latency vs. a long-lived process.
- **Risk:** **High, and concentrated.** The whole value proposition rests on the OQ-1 auth claim *and* this single backend (effort/subagents/skills "for free" all route through it). Subprocess stream parsing is fragile to CLI version drift. **Windows process management is a documented footgun** and, because every headline feature flows through this client, a failure here collapses ~80% of the spec — treat Wave 0A as a hard gate, not a detail. If the build pivots to the SDK, note the SDK is a **new dependency** with its own auth model and ESM/bundling implications, not a drop-in.

### Feature 2 — Effort control wired to `ultracode`

- **What it is:** make `mode === 'ultracode'` actually raise model reasoning effort, per the user's "ultracode = change the effort" intent.
- **Endpoint mechanism (per backend) — model-keyed, not disputed:**
  - **claude-cli (primary):** append `--effort xhigh` (or `max`) to the spawn args. Cleanest, fully supported (CLI default is `xhigh`).
  - **Anthropic raw — for the *catalogued* `claude-sonnet-4-20250514`:** add `thinking: { type: 'enabled', budget_tokens: N }`, **and raise `max_tokens`** (see truncation gap below). On this model `output_config.effort` would **400** — do not send it. (To use `output_config.effort` + adaptive thinking, first bump the catalog to a 4.6+/Opus model — OQ 5.) Output path is ready: the adapter already parses `thinking_delta → reasoning-delta` (`anthropicClient.ts:144-148`).
  - **OpenAI-compat:** `body.reasoning_effort` — **no-op on gpt-4.1/-mini**; only meaningful if a reasoning model is added.
  - **OpenRouter:** `body.reasoning` (normalized) — model-dependent.
- **juno seam (verified):** the one seam is *start reading `input.mode` inside `buildRequestBody`* — `mode` is already delivered (per the seam-correction above); only adapter consumption is missing. Edit `anthropicClient.ts:228-252` and `openaiCompatClient.ts:222-227`; add the `--effort` arg in `claudeCliClient.ts` (Feature 1). Map `normal→default`, `plan→high`, `ultracode→xhigh|max`.
- **`max_tokens` × effort truncation gap (concrete, will-bite).** The authoritative reference warns that high effort (`xhigh`/`max`) needs a large `max_tokens` **and** streaming, or output truncates. juno hardcodes `DEFAULT_MAX_TOKENS = 4096` (`anthropicClient.ts:13`). Wiring `ultracode`→high-effort on a 4096 ceiling **will truncate** on the Anthropic backend. Also, on the catalogued Sonnet 4, `budget_tokens` must be **strictly less than `max_tokens`** (min 1024) or the request 400s. So Feature 2 on the Anthropic backend **must** raise `max_tokens` (to a value tied to the chosen model and effort) as part of the change, not as an afterthought — OQ 4.
- **Open questions:** (a) What `budget_tokens` value does `ultracode` mean on the catalogued Sonnet 4? (b) What raised `max_tokens` ceiling avoids truncation (and keeps `budget_tokens < max_tokens`)? (c) Should `normal` send nothing (model default) or an explicit low level? (d) Sequencing: bump the catalog to a 4.6+/Opus model *before* effort work, so `output_config.effort` + adaptive thinking become usable and `ultracode` is observable on a non-deprecated model (OQ 5)?
- **Risk:** **Medium.** Low *structural* risk (one field per adapter), but: sending `output_config.effort` to the catalogued Sonnet 4 400s; not raising `max_tokens` truncates; `budget_tokens ≥ max_tokens` 400s. All three are deterministic and avoidable if the model→field mapping and `max_tokens` bump are done together.

### Feature 3 — Subagent spawning

- **What it is:** spawn isolated, fresh-context workers whose results return as a summary to the parent turn.
- **Endpoint mechanism:** (a) **Subscription/native:** `--agents <json>` or `.claude/agents/`. (b) **Endpoint-agnostic juno-side:** a `spawn_subagent` Tool that runs a *nested turn* against any `ModelClient` — works on every backend because it rides the existing tool + re-entry machinery. (c) **Anthropic-native via Managed Agents API:** a real but *different-API* path (coordinator rosters). Recommend (b) as the portable core, (a) as a CLI-backend bonus, and explicitly *evaluate* (c) in Wave 4B rather than assuming no API path exists.
- **juno seam (verified):**
  1. New `src/tools/subagentTool.ts` exporting a `Tool` (`spawn_subagent`, `risk:'risky'` so it hits the permission gate `executor.ts:62-95`), `inputSchema` like `{ task: string, model?: string }` (schema pattern `fileTools.ts:49-51`); register in `registry.ts:7-9`.
  2. `run(args, ctx)` builds a fresh `TurnInput`, a child `AbortController` chained to `ctx.signal` (`contracts.ts:72`), drives `runTurn(...)` (`turnRunner.ts:74`) or a `ModelClient.streamTurn` directly, and returns `{ ok, data: <final assistant text> }` as a `ToolResult` (`contracts.ts:84-88`); parent re-enters it as a `tool` message (`turnRunner.ts:283-289`).
  3. **Seam gap (verified):** `ToolCtx` (`contracts.ts:70-81`) carries `cwd/signal/emit/awaitPermission/state` but **no client and no executor/toolset**. **Prefer the lower-risk option:** inject a **module-level factory** into the tool so the *frozen* `ToolCtx`/`ToolExecutorDeps` contracts — which the 206 tests exercise directly at the `executor.ts:100-106` ctx-build site — are **not** touched. The alternative (extend `ToolExecutorDeps` `:12-19` and the `ctx` built at `:100-106` to pass a client + specs + tools) is *also* viable but is a contract change under test and is materially higher-risk for the green gate. These are **not** co-equal — the factory is the default; extend the contract only if the factory proves insufficient.
  4. Progress: forward child events via `ctx.emit` (`contracts.ts:73`) or keep opaque and return only the summary. **No reducer/event changes needed.**
- **Open questions:** (a) Recursion depth limit / cycle guard? (b) Does the subagent inherit the parent's tools, a restricted set, or its own? (c) Permission model for nested risky tools. (d) If using native CLI subagents, how do their events map back through `stream-json`?
- **Risk:** **Medium** with the factory option (no frozen-contract change). **Medium-high** if `ToolCtx`/`ToolExecutorDeps` is extended (contract under test). Unbounded recursion is a real footgun either way.

### Feature 4 — Skills loading

- **What it is:** load `~/.claude/skills/*/SKILL.md` (and project `.claude/skills/`) — parse YAML frontmatter + markdown, make them available as context and/or invokable.
- **Endpoint mechanism:** **endpoint-agnostic** — skills are plain text, so injecting them works on *every* backend (unlike effort). When the CLI backend is active, the subscription *also* auto-discovers skills natively (no juno work) unless `--bare`. (Managed Agents has a first-class `skills[]` field — relevant only if Wave 4B targets that API.)
- **juno seam (verified):** three candidate seams; recommend the first:
  1. **Service → system prompt (lowest friction):** new `src/services/skills.ts` (`createSkillsService()`, mirrors the `config.ts`/`catalog.ts` process-edge pattern) that lists/reads SKILL.md files → text appended to `TurnInput.systemPrompt`. Both adapters already concatenate `systemPrompt` into the system block (`anthropicClient.ts:235-241`, `openaiCompatClient.ts:217-219`). **Wiring required (corrected):** the hook end is **already done** (`useStreamingTurn.ts:277` reads `deps.systemPrompt`; `StreamingTurnDeps:47` declares it). Only the `app.tsx` call site (`app.tsx:58-65`) and `AppDeps` (`app.tsx:23-30`) need the `systemPrompt` field, fed from `cli.ts:56-67`.
  2. **Invokable `run_skill` Tool** (on-demand load of a named skill) registered in `registry.ts:7-9` — pairs naturally with Feature 3's tool plumbing.
  3. Combination: service backs both the system-prompt injection and the tool.
- **Prompt-caching note (new).** juno does **not** implement `cache_control` anywhere. Eager-injecting all SKILL.md text into `systemPrompt` means that text is **re-sent and re-processed (and re-billed) every turn** on the Anthropic backend — there is no cached prefix to amortize it. This is a per-turn cost, distinct from one-time "context bloat," and is a real argument for on-demand loading (OQ 6). (Adding `cache_control` is out of scope here but worth a one-line note in any v1 that goes eager.)
- **Open questions:** (a) Eager-inject-all (per-turn re-send cost + context) vs. on-demand (Claude Code injects descriptions only, full content on invoke — Team A). (b) Frontmatter fields juno honors (`allowed-tools`, `model`, `effort`, `context: fork`) — and which it ignores in v1. (c) Reuse of existing `~/.claude/skills/` (lean, triad, etc.) or juno-specific skills dir. (d) When CLI backend auto-discovers natively, does juno's injection double-load?
- **Risk:** **Low-medium.** Pure-text path is safe; main risks are per-turn re-send cost from naive eager injection and frontmatter-semantics scope creep.

### Feature 5 — Make `plan` / `ultracode` modes actually do something

- **What it is:** give the two non-normal modes real behavior. `ultracode` = effort (Feature 2). `plan` = produce-a-plan-don't-execute.
- **Endpoint mechanism:** `plan` has two complementary levers, both keyed off `input.mode === 'plan'`: (1) **prompt steer** — prepend a "produce a plan, do not execute" instruction; (2) **read-only enforcement** — deny `risky` tools while planning. When the CLI backend is active, `--permission-mode plan` is the native equivalent (a permission mode, *not* auto-execution — Team D).
- **juno seam (verified):**
  1. Prompt steer: in `buildRequestBody` (`anthropicClient.ts:235`, `openaiCompatClient.ts:217`) or upstream in `TurnInput.systemPrompt`.
  2. Read-only enforcement (stronger, optional): make `PermissionPolicy.evaluate(name,args,risk)` (`contracts.ts:133-135`, called at `executor.ts:62`) mode-aware, or pass `mode` into `ToolExecutorDeps` (`executor.ts:12-19`) and short-circuit `risky` tools (`write_file`/`edit_file`, risk set `fileTools.ts:297,328`) to `'auto-deny'` (`executor.ts:65-68`).
- **Open questions:** (a) Does `plan` block all risky tools, or allow git-read but not git-write? (b) Plan→approve→execute handoff UX (juno has no native approval-of-plan flow). (c) Should plan-mode map to CLI native `--permission-mode plan` when that backend is active, diverging behavior by backend?
- **Risk:** **Low** for prompt steer; **medium** for policy enforcement (touches the permission path that tests cover).

### Cross-cutting structural prerequisites (unblock most features)

1. **Factory-ize `ModelClient` construction** so provider switching re-targets the right endpoint (fixes the `cli.ts:57-61` build-once bug). Prereq for Features 1 & 3.
2. **Start consuming `TurnInput.mode`** in the adapters (already delivered, currently discarded). Prereq for Features 2 & 5.
> Neither touches `events.ts`, `reducer.ts`, or `eventToAction` — the frozen core already carries `reasoning-delta`, `tool-call`, and tool re-entry that all five features emit.

---

## 5. Next-session investigation/build plan (OoO-with-teams)

Run as dependency waves; each wave = one or more team-of-3 units (two independent writers from different model families → Opus synthesizer → skeptical verifier + objective gate `vitest`/`tsc`). Gate every code wave on **206/206 green + tsc clean** as the non-negotiable objective gate.

### Wave 0 — De-risk the foundational unknowns (INVESTIGATE, no juno code)
- **Team 0A — Subscription auth truth (HARD GO/NO-GO for ~80% of the spec).** Empirically determine: can the Max *consumer subscription* drive `claude -p --output-format stream-json` headless with **no** API key and **no** per-token billing (via session reuse / `ANTHROPIC_AUTH_TOKEN` / `ant auth login`)? Does it need `setup-token`? Capture a real `stream-json` transcript (text, thinking, tool-call, usage, done) on **Windows**. **Verifies:** OQ 1, on which the entire architecture rests. **Output:** a documented event schema + an auth recipe (and a billing observation confirming/denying per-token charges), or a NO-GO that pivots §1.2 to SDK or raw-API-as-primary.
- **Team 0B — Effort field confirmation (lightweight; the answer is already known from the reference).** Confirm against live Anthropic docs that for the *catalogued* `claude-sonnet-4-20250514` the legal field is `thinking.budget_tokens` (and `output_config.effort` 400s), and that a 4.6+/Opus model takes `output_config.effort` + adaptive thinking. Confirm `reasoning_effort` is a no-op on gpt-4.1. **This is verification of a settled fact, not dispute resolution.** **Output:** the exact request-body field(s) per backend *and per chosen model*, plus the `max_tokens`/`budget_tokens` constraints.
- **Dependency:** none. Both run in parallel. **Everything else waits on 0A.**

### Wave 1 — Structural prerequisites (BUILD)
- **Team 1A — Client factory + endpoint-bug fix.** Implement the `AppDeps`-threaded factory replacing the build-once client (`cli.ts:57-61` → `app.tsx:23-30` → `useStreamingTurn.ts:40,282`); provider switching re-targets endpoints. **Verifies:** picking a model from a different provider hits the correct endpoint (add a regression test for the known cross-provider bug).
- **Team 1B — `mode` consumption seam.** Make both adapters read `input.mode` in `buildRequestBody` (no behavior yet beyond a verified pass-through hook). Note `mode` already reaches `TurnInput` — this wave is *adapter consumption only*. **Verifies:** tests assert `input.mode` is read at body construction.
- **Dependency:** Wave 0 (1B needs 0B's per-model field decision). 1A and 1B are independent → parallel.

### Wave 2 — Primary backend + effort (BUILD)
- **Team 2A — `claudeCliClient.ts`.** Build the subprocess `ModelClient` translating `stream-json → AgentEvent`, honoring `signal`/kill, registered in the switch + catalog (default). **Verifies:** a real `claude -p` turn streams text/thinking/tool-calls into juno; abort kills the child. **Windows process management is the headline risk — budget for it.**
- **Team 2B — Effort → ultracode.** Wire `mode→effort` across all backends: `--effort` for CLI; **`budget_tokens` + raised `max_tokens` for the catalogued Anthropic Sonnet 4** (or `output_config.effort` + adaptive thinking iff the catalog was bumped per OQ 5); `reasoning_effort`/`reasoning` for the others as no-ops where applicable. **Verifies:** `ultracode` produces extended thinking on the CLI + Anthropic backends *without truncating* (max_tokens raised); gpt-4.1 unaffected; no 400 from wrong-field-for-model.
- **Dependency:** 2A needs 0A + 1A; 2B needs 0B + 1B + (for the CLI arg) 2A. Run 2A first or tightly coupled; 2B's non-CLI parts can start once 1B lands. **Note:** because effort is a no-op on the default gpt-4.1, observability of `ultracode` on first run depends on 2A landing (CLI default) or the OQ-5 catalog bump.

### Wave 3 — Subagents + skills (BUILD, parallel)
- **Team 3A — `spawn_subagent` Tool.** Build the nested-turn tool. **Prefer the module-level factory** (no frozen-contract change) over extending `ToolCtx`/`ToolExecutorDeps`; include a recursion-depth guard. **Verifies:** a subagent runs a fresh turn and returns a summary the parent re-enters; depth cap holds; 206 tests still green (the factory route should keep `executor.ts:100-106` untouched).
- **Team 3B — Skills loader.** Build `src/services/skills.ts` + the **remaining** `systemPrompt` wiring (`app.tsx:58-65` call site + `AppDeps` field; the hook end is already done), optional `run_skill` tool. Default to on-demand or document the per-turn re-send cost of eager injection (no `cache_control` in juno). **Verifies:** SKILL.md frontmatter parses; skill text reaches the system block on every backend.
- **Dependency:** both need Wave 1. 3A also benefits from 2A's client. 3A and 3B are independent → parallel. (If 3B uses the tool variant, sequence the shared tool-plumbing decision into 3A and have 3B consume it.)

### Wave 4 — Plan mode + portability decisions (BUILD/DECIDE)
- **Team 4A — plan-mode behavior.** Prompt-steer + optional read-only `PermissionPolicy` enforcement keyed off `mode` (`executor.ts:62-68`); map to `--permission-mode plan` on the CLI backend. **Verifies:** in plan mode, risky tools are blocked / steered; CLI backend uses native plan mode.
- **Team 4B — deferred-feature scoping** (hooks, MCP, permission-mode parity, **and an explicit Managed Agents evaluation for subagents/skills**). Produce a go/no-go + cost estimate for the §3.2 ⚠️ items; **weigh Managed Agents as the API-native answer to Features 3 & 4**, do not dismiss it. Do **not** build unless greenlit. **Verifies:** a decision doc, not code.
- **Dependency:** Wave 1; 4A benefits from 2A. Lowest priority.

**Critical path:** Wave 0A (subscription auth — hard gate) → Wave 1 (factory + mode) → Wave 2 (CLI client + effort) → Waves 3/4 parallel. **If Wave 0A returns NO-GO on subscription auth, stop and re-plan §1.2** before any further build — ~80% of the claimed value depends on it.

---

## 6. Open questions / decisions needed from the user

1. **Subscription auth + SDK-vs-CLI (architecture-defining).** The documented credential precedence proves an OAuth/auth-token path *exists* for both `claude -p` and the Agent SDK — but it does **not** prove the **Max consumer subscription** can mint one usable **headless with no per-token billing.** Wave 0A must confirm this empirically (watch real usage/billing). If confirmed for the CLI but not the SDK → subprocess + `stream-json` parsing (more fragile, Windows footguns; a **new dependency** either way). If confirmed for the SDK too → the SDK is cleaner (still a new dependency, new auth model, ESM/bundling work). If **not** confirmed at all → fallback to pay-per-token Anthropic API as primary. Which fallback is acceptable?
2. **`ultracode` concrete meaning.** Should `ultracode` map to `--effort xhigh` or `--effort max` on the CLI? And on the Anthropic raw backend, what `budget_tokens` (for the catalogued Sonnet 4) — *or* what `effort` level if the catalog is bumped to a 4.6+/Opus model?
3. **Mode → effort mapping for `normal`/`plan`.** Send model default for `normal` (recommended), or an explicit `low`/`medium`? Should `plan` raise effort (`high`) or stay neutral and only steer behavior?
4. **`max_tokens` ceiling for effort.** On the Anthropic backend, what `max_tokens` does `ultracode` require so high/xhigh effort does not truncate against the current `DEFAULT_MAX_TOKENS = 4096`? Needs an explicit value tied to the chosen model (and, for the catalogued Sonnet 4, must satisfy `budget_tokens < max_tokens`), likely with streaming confirmed.
5. **Catalog upgrade sequencing (gates effort observability and field choice).** Should the catalog be bumped — default to the CLI backend, and/or replace `claude-sonnet-4-20250514` with `claude-sonnet-4-6`/an Opus model — **before** effort work? Today the default `gpt-4.1` is a no-op for effort, and the catalogued Sonnet 4 is **deprecated (retires 2026-06-15)** and uses the **legacy** field. Bumping first makes `ultracode` observable on a non-deprecated model and unlocks `output_config.effort` + adaptive thinking.
6. **Subagents: native vs. juno-side vs. Managed Agents.** Prefer Claude Code's native subagents (CLI-only, richer), a portable juno `spawn_subagent` Tool (works on every backend), or the Anthropic Managed Agents API (API-native but a separate beta surface + hosted execution)? Recommendation: build the portable tool (factory option, no frozen-contract change); expose native subagents as a CLI-backend bonus; *evaluate* Managed Agents in Wave 4B rather than assuming no API path.
7. **Subagent recursion + tool inheritance.** Max depth? Does a subagent inherit parent tools, a restricted set, or its own? (Needed before Wave 3A.)
8. **Skills source + injection strategy.** Reuse the existing `~/.claude/skills/` (lean/triad/loopy/etc.) or a juno-specific dir? Eager-inject-all vs. on-demand — noting juno has **no `cache_control`**, so eager injection **re-sends and re-bills** all skill text **every turn** on the Anthropic backend? Which frontmatter fields does v1 honor vs. ignore?
9. **Plan-mode enforcement strength.** Prompt-steer only (soft) or hard `PermissionPolicy` deny of risky tools? And is divergent behavior by backend (native `--permission-mode plan` on CLI vs. juno policy elsewhere) acceptable?
10. **Scope of deferred features.** Are hooks / MCP / full permission-mode parity / Managed Agents in scope for this effort at all, or explicitly out (decision-only in Wave 4B)?
11. **Privacy posture for the CLI backend.** The no-train OpenRouter policy is enforced for the OR adapter (`openaiCompatClient.ts:242-247`). Does driving Claude Code via subscription have an equivalent data-policy requirement to assert, or is the subscription account-level policy sufficient?

---

**Carried-forward uncertainty (do not let later sessions silently resolve these by assumption):** (a) **subscription auth + no-per-token-billing for the Max consumer plan is unverified** — the documented token-precedence path proves *a* path exists, not that the Max plan mints one; the "Agent SDK credit covers headless `claude -p`" detail is uncorroborated; (b) the `stream-json` event schema is unknown until empirically captured (Wave 0A); (c) the Anthropic **Managed Agents API** is a separate beta surface, *is* the API-native answer to subagents/skills, and must be explicitly weighed (not dismissed) if a raw-API subagent/skill path is wanted; (d) adopting any Claude-Code-driving client (subprocess *or* SDK) introduces a **new dependency** into a currently zero-Anthropic-SDK codebase.

**Settled facts (do not re-litigate as open questions):** the effort field is a **deterministic, model-keyed lookup** — `budget_tokens` for the catalogued `claude-sonnet-4-20250514` (where `output_config.effort` 400s), `output_config.effort` + adaptive thinking for 4.6+/Opus (where `budget_tokens` 400s); the Agent SDK does **not** strictly require an API key (it honors `ANTHROPIC_AUTH_TOKEN` / `ant auth login`). Every build wave is gated on **206/206 vitest + tsc clean**.
