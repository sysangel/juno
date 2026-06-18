# Wave 0A — Subscription-Drive Empirical Findings (juno CC port)

**Status:** ✅ **GO** — the foundational unknown is resolved in favor of the subscription architecture.
**Date:** 2026-06-17 · **Method:** live tests of `claude.exe` v2.1.178 on this Windows 11 machine (Max subscription, logged-in session), `claude -p --output-format stream-json --verbose`. No juno code written.
**Companion to:** `PORT_SPEC-claude-code-features.md` (this de-risks its OQ 1 / Wave 0A; resolves the hard go/no-go gate).

---

## 1. Verdict (the hard gate)

The Max **consumer subscription drives `claude -p` headless, with no API key and no per-token billing.** Every headline feature (effort, subagents, skills, plan mode) routes through this one backend, and the gate clears. **Proceed to the build.**

Evidence:
- **No API key anywhere.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL` are all **unset** in the environment, yet `claude -p` runs (exit 0). Every `init` event reports **`"apiKeySource":"none"`**.
- **Auth source = subscription OAuth.** `~/.claude/.credentials.json` holds a `claudeAiOauth` object: `accessToken` (len 108), `refreshToken` (len 108), `expiresAt`, `scopes`, **`subscriptionType: "max"`**, **`rateLimitTier: "default_claude_max_5x"`**. This is the logged-in Claude Code session token — not an API key.
- **No per-token billing.** Each turn emits a `rate_limit_event`: `"rateLimitType":"five_hour"`, `"status":"allowed"`, **`"overageStatus":"rejected"`**, **`"overageDisabledReason":"org_level_disabled"`**, **`"isUsingOverage":false`**. Usage counts against the subscription's rolling 5-hour quota; metered overage is explicitly disabled. The `total_cost_usd` field in the `result` event is an **informational API-equivalent estimate**, not an actual charge (there is no API key to bill).

> ⚠️ **Plan-tier discrepancy to confirm:** the credential says `subscriptionType: max` / `rateLimitTier: default_claude_max_5x` (Max **5x**), while prior notes assumed Max **20x**. Doesn't change viability, but it changes the rate-limit headroom juno can assume. Worth confirming the actual plan.

---

## 2. Auth recipe (for the claudeCliClient)

- **Primary (this machine / dev):** do nothing — spawn `claude -p` and it reuses the logged-in `~/.claude/.credentials.json` OAuth session automatically. juno passes **no** auth env var.
- **Headless / CI / fresh environments:** `claude setup-token` mints a long-lived token ("requires Claude subscription"); `claude auth` manages the session. (Not needed when an interactive login already exists.)
- **🚫 NEVER pass `--bare` on the subscription backend.** Per `--help`: `--bare` makes "Anthropic auth strictly `ANTHROPIC_API_KEY` or apiKeyHelper… **OAuth and keychain are never read**." `--bare` would break subscription auth outright. (It also disables CLAUDE.md auto-discovery, hooks, plugins, auto-memory — so skills must then be provided explicitly.)

---

## 3. `stream-json` event schema (captured live on Windows)

Newline-delimited JSON (NDJSON), one event per line. Observed event `type`s and shapes:

### 3.1 `system` / `init` (first line)
```
{"type":"system","subtype":"init","cwd":"…","session_id":"<uuid>",
 "tools":[…],"mcp_servers":[{"name","status"}],"model":"claude-opus-4-8[1m]",
 "permissionMode":"default","slash_commands":[…],"apiKeySource":"none",
 "claude_code_version":"2.1.178","agents":[…],"skills":[…],"plugins":[…],
 "memory_paths":{…},"fast_mode_state":"off", …}
```
Carries the resolved model, permission mode, available tools/skills/agents, and the auth source. **`apiKeySource:"none"` is juno's runtime proof it's on the subscription.**

### 3.2 `rate_limit_event`
```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":<epoch>,
 "rateLimitType":"five_hour","overageStatus":"rejected",
 "overageDisabledReason":"org_level_disabled","isUsingOverage":false},
 "uuid":"…","session_id":"…"}
```
juno can surface this in the UI (quota window + reset time) — a subscription-only signal the raw-API backends don't have.

### 3.3 `assistant` (default: one event per *complete* content block)
Content blocks observed:
- **thinking:** `{"type":"thinking","thinking":"<text or empty>","signature":"<encrypted>"}` — extended-thinking block (text may be empty with only a signature, i.e. encrypted/redacted reasoning).
- **text:** `{"type":"text","text":"…"}`
- **tool_use:** `{"type":"tool_use","id":"toolu_…","name":"Bash","input":{…},"caller":{"type":"direct"}}`

Envelope: `{"type":"assistant","message":{"model","id","role":"assistant","content":[…block],"stop_reason","usage":{…}},"parent_tool_use_id","session_id","uuid","request_id"}`.
`parent_tool_use_id` is non-null for **subagent**-originated messages — the hook juno uses to attribute nested-agent output.

### 3.4 `user` (tool results, echoed back)
```
{"type":"user","message":{"role":"user","content":[
   {"tool_use_id":"toolu_…","type":"tool_result","content":"391","is_error":false}]},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…",
 "tool_use_result":{"stdout":"391","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}}
```

### 3.5 `stream_event` (only with `--include-partial-messages` → true token deltas)
Wraps the raw Anthropic SSE event:
```
{"type":"stream_event","event":{"type":"message_start","message":{…}},"session_id","parent_tool_use_id","uuid","ttft_ms"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}, …}
```
…followed by `content_block_delta` (`text_delta` / `thinking_delta` / `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop` — **the same SSE event vocabulary juno's `anthropicClient.ts` already parses.** This is the fine-grained streaming path.

### 3.6 `result` (terminal)
```
{"type":"result","subtype":"success","is_error":false,"duration_ms","duration_api_ms",
 "ttft_ms","num_turns","result":"<final assistant text>","stop_reason":"end_turn",
 "session_id","total_cost_usd","usage":{…,"iterations":[…]},
 "modelUsage":{"<model>":{"inputTokens","outputTokens","cacheReadInputTokens",
   "cacheCreationInputTokens","costUSD","contextWindow","maxOutputTokens"}},
 "permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off"}
```
`subtype` can also be error variants; `is_error`/`api_error_status` carry failure state. juno maps this to `assistant-done(stopReason)` + `usage`.

**Two translation modes for `claudeCliClient`:**
1. **Block mode (default):** parse complete `assistant` content blocks → emit one AgentEvent per block (`thinking→reasoning-delta`, `text→text-delta`, `tool_use→tool-call`).
2. **Delta mode (`--include-partial-messages`):** parse `stream_event` wrappers → emit fine-grained deltas, reusing the existing SSE-delta parsing logic. **Recommended** for live TUI streaming parity.

---

## 4. Flag surface (verified against `claude --help`, v2.1.178)

| Need (juno feature) | Flag | Notes |
|---|---|---|
| **Headless run** | `-p/--print` + `--output-format stream-json` + `--verbose` | `--verbose` required for stream-json |
| **Effort (Feature 2)** | `--effort <low\|medium\|high\|xhigh\|max>` | ✅ verified live; CLI handles model-keyed field internally — **juno just passes the level** |
| **Model select** | `--model <alias\|fullname>` | aliases `opus`/`sonnet`/`fable`; `sonnet`→`claude-sonnet-4-6` (the catalog-bump target) |
| **Plan mode (Feature 5)** | `--permission-mode plan` | also: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions` |
| **Subagents — native (Feature 3)** | `--agents '<json>'` | inline custom agents `{"name":{"description","prompt"}}`; also `.claude/agents/` |
| **Skills (Feature 4)** | auto-discovered from `~/.claude/skills/` & `.claude/skills/`; or inject via `--append-system-prompt` / `--system-prompt[-file]` | `init.skills[]` lists what loaded |
| **Tool gating** | `--allowedTools` / `--disallowedTools` / `--tools` | e.g. `--allowedTools "Bash(git *) Edit"`; `--tools ""` disables all |
| **MCP** | `--mcp-config <files\|json>` (+ `--strict-mcp-config`) | |
| **Structured output** | `--json-schema '<schema>'` | validates result against a JSON Schema |
| **True streaming** | `--include-partial-messages` | stream-json only |
| **Streaming input** | `--input-format stream-json` | realtime multi-turn input |
| **Budget cap** | `--max-budget-usd <amt>` | print mode only |
| **Sessions** | `--session-id`, `--resume`, `--continue`, `--fork-session`, `--no-session-persistence` | for multi-turn / fresh subagent contexts |
| **Headless token** | `claude setup-token` (subcommand) | for CI/fresh envs without an interactive login |
| **🚫 avoid** | `--bare` | disables OAuth → breaks subscription auth |

---

## 5. Implications for the build (updates to the spec's assumptions)

1. **Architecture decision firm: subprocess `claude -p` is the path.** Subscription auth + no metered billing both confirmed; an SDK is unnecessary (and would still be a new dependency). The `claudeCliClient` spawns `claude -p … --output-format stream-json --verbose --include-partial-messages` and translates NDJSON → juno `AgentEvent`s.
2. **Effort on the CLI backend is trivial** — pass `--effort`; no need to replicate the model-keyed `budget_tokens` vs `output_config.effort` logic (the CLI owns it). That model-keyed complexity only applies to the raw-API fallback backends.
3. **Catalog bump validated:** `--model sonnet` → `claude-sonnet-4-6` works; that's the non-deprecated replacement for the catalogued `claude-sonnet-4-20250514`. Default backend should become the CLI/Opus.
4. **Skills/subagents come "for free" through the CLI** (`init.skills[]`/`agents[]` already populated from `~/.claude/skills/`), *and* juno can still implement its own portable versions for the raw-API backends. No `--bare`, or that free discovery is lost.
5. **Windows process management is the real remaining risk** (spawn, signal-kill on abort, PATH resolution of `claude.exe`, NDJSON line buffering). Tests ran clean here, but the `claudeCliClient` must honor `signal` by killing the child and yielding `{type:'aborted'}`.
6. **Rate-limit UX bonus:** the `rate_limit_event` lets juno show the live 5-hour quota window — a subscription-native affordance.

---

## 6. Open items still for the user (narrowed)

- Confirm the actual plan tier (credential says Max **5x**, not 20x) — affects quota headroom assumptions.
- Spec OQ 2–11 (effort mapping, max_tokens, subagent recursion, skills injection strategy, plan-mode strength, deferred features) remain product decisions, now on a confirmed foundation.
