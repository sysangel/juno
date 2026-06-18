# DECISIONS

> Append-only log. Each unit records its decisions under a dated heading.

## Stack (pinned by W1)

- **Runtime:** Node 20+ (ESM only, `"type": "module"`).
- **Language:** TypeScript, `strict: true`, `noEmit` (typecheck only).
- **UI:** React 18 + Ink 5.
- **Tests:** vitest (`environment: node`, `globals: true`).
- **Dev runner:** `tsx` — no build step; `.ts`/`.tsx` run directly.
- **Host:** Windows Terminal + PowerShell 7, UTF-8 code page for truecolor.

## D1 — CUT: full TypeScript rewrite

The older Python agent loop is retired. `juno` is a clean TypeScript / React /
Ink rewrite. There is no Python runtime, no shared cross-language type surface,
and no `pytest` / `__pycache__` artifacts (retained in `.gitignore` only to
prevent stale Python files from leaking back in). The former LangGraph-style
agent loop is removed; the turn lifecycle is driven by `src/agent/turnRunner.ts`.

## D2 — Privacy enforced account-side

No local secret store. Privacy guarantees are enforced on the account /
provider side. Local artifacts (logs, run transcripts) are opt-in and
ephemeral by default. Downstream units must not persist user data without
explicit opt-in.

The privacy posture is **NO-TRAIN, and that is the whole policy.** It is enforced
**account-side** on OpenRouter, with a belt-and-suspenders body-level
`data_collection: 'deny'` applied **identity-keyed** (gated on the provider being
OpenRouter, never by base-URL string match). There is **no geographic /
"Western-only" allowlist** — that screen is retired; juno never emits an
`only: [...]` provider allowlist. `scripts/verify-openrouter-policy.ts` is an
**optional, advisory** verifier, not the enforcement path. See
[SECURITY.md](SECURITY.md).

*(There is no `HARNESS.md` in this repo to supersede; that prior plan is a no-op.
The account-side privacy claim it would have carried is recorded here and in
SECURITY.md.)*

## D3 — Product identity = `juno` (FINAL)

The product name is **`juno`** and stays `juno`. No rename. The configuration
namespace stays `juno` / `JUNO_*`: env vars `JUNO_MODEL`, `JUNO_PROVIDER`,
`JUNO_CWD`, `JUNO_MAX_CONTEXT` (plus the advisory `JUNO_SKIP_POLICY_CHECK`); the
config/state root is `~/.config/juno/` (`config.json`, `sessions/`, `memory/`); the
bin name is `juno`. The InputBox placeholder reads "Message Juno".

## D4 — As-built directory layout

The shipped layout under `src/` is:

- `src/core/` — `events.ts`, `reducer.ts`, `contracts.ts`, `selectors.ts`, `fakeClient.ts`
- `src/ui/` — Ink components + `theme.ts`
- `src/providers/` — `openaiCompatClient.ts`, `anthropicClient.ts`, `index.ts`
- `src/agent/` — `turnRunner.ts`, `eventBus.ts`
- `src/permissions/` — `policy.ts`, `patterns.ts`
- `src/tools/` — `executor.ts`, `fileTools.ts`, `registry.ts`
- `src/hooks/` — `useStreamingTurn.ts`, `useKeybinds.ts`, `useTerminalSize.ts`
- `src/services/` — `config.ts`, `catalog.ts`, `sessions.ts`, `memory.ts`
- `src/app.tsx`, `src/cli.ts`

The earlier `src/state` / `src/llm` / `src/components` decomposition names are
**stale** and were not used. See [ARCHITECTURE.md](ARCHITECTURE.md).

## D5 — Launch mechanism (Windows-safe)

The `bin` entry maps `juno` → `src/cli.ts`, but npm's global shim invokes `node`,
which cannot run a `.ts` file directly. juno is therefore launched through the
package scripts under `tsx`: `npm start` (`tsx src/cli.ts`) and `npm run dev`
(`tsx watch src/cli.ts`); flags go through `npx tsx src/cli.ts --help|--version`.
There is **no compiled `.js` bin** in v1. `cli.ts` keeps its W1 `--help`/`--version`
fast-path and only builds deps (config, catalog, client, policy, tools) and renders
`<App>` when launched without those flags.

## D6 — Build method: team-of-three synthesis

The codebase was produced unit-by-unit (W1, W3, …) via a multi-model "triad"
workflow: two independent writers from different model families drafted each
self-contained brief in isolation, an Opus synthesizer merged the best of both, and
a skeptical verifier plus the objective gate (`vitest` + `tsc --noEmit`) confirmed
each unit. Per-unit briefs and drafts live under `_orchestration/`.

## D7 — Deferred: `claude-cli` provider adapter

The provider registry (`src/providers/index.ts`) ships three adapters in v1:
`openai`, `openrouter`, `anthropic`. A `claude-cli` adapter is named in the type
surface as **deferred** — intentionally not built for v1.

## D8 — `grep` defaults to literal substring

The `grep` tool matches a **literal substring by default** (linear time, immune to
catastrophic-backtracking ReDoS). Regular-expression matching is opt-in via an
explicit `regex: true` argument, and an invalid regex falls back to literal
substring rather than throwing.

## D9 — Permission keybindings + always-allow grammar

The `PermissionPrompt` binds four keys: `y` (allow once), `a` (always allow →
remember pattern), `d` (deny), `!` (dangerous bypass). `Esc` aborts the turn (which
drains the parked permission to `deny`). `allow-once` is one-shot and never
persisted; `always-allow-pattern` / `dangerous-bypass` are remembered on the single
shared policy. Remembered rules match a `"<tool>:<salientPath>"` key; a bare tool
name normalizes to `tool:*`, `*` is the only glob metacharacter and crosses
newlines, and `deny` wins over allow.

## D10 — Token accounting is session-cumulative

Token usage accumulates additively across the session via the reducer's `usage`
action. The pre-W9 input estimate in `user-submit` was **removed** (it
double-counted input against the provider's real `usage` event), so input is counted
once from the provider. Output is likewise counted once: the Anthropic adapter emits
input at `message_start` and output at `message_delta` (never both at once) so the
cumulative `output_tokens` Anthropic re-reports is not double-counted. `clear`
resets the conversation but preserves cumulative tokens and the current mode.
