# juno

**A terminal coding agent you drive from your shell.** juno streams a live LLM
turn into an [Ink](https://github.com/vadimdemedes/ink) transcript, lets the
model call workspace-jailed tools, and gates every risky call behind an
interactive permission prompt — built ground-up in TypeScript + React, no build
step.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)
![React + Ink](https://img.shields.io/badge/React%20%2B%20Ink-TUI-61dafb?style=flat-square)
![tests](https://img.shields.io/badge/tests-1006%20passing-brightgreen?style=flat-square)
![CI](https://img.shields.io/badge/CI-typecheck%20%2B%20test-blue?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-black?style=flat-square)

```text
  juno v0.1.0
  Claude Fable 5 (subscription) · ~/src/acme-api
  / commands · ? shortcuts

▌ add a rate-limit guard to the login handler

● I'll add a token-bucket check before the handler runs, then
  wire it into the router.

  ⚙ edit_file  src/routes/auth.ts

  ╭─ ⚠ permission required ───────────────────────────╮
  │ edit_file          risk: risky                     │
  │                                                    │
  │ + import { rateLimit } from './mw/limit'           │
  │ + router.post('/login', limit(5,'1m'),             │
  │ -   loginHandler);                                 │
  │ +   loginHandler);                                 │
  │                                                    │
  │ [y] allow  [a] always  [d] deny  [!] bypass        │
  ╰────────────────────────────────────────────────────╯

  Claude Fable 5 (subscription) · ~/src/acme-api · ctx 48.5k (5%) · medium
```

*(Illustration of the streaming transcript and a live permission prompt — the
box is rendered by Ink at runtime, colorized by risk tier.)*

---

## What it is

juno is a from-scratch reimplementation of a terminal AI coding agent — the loop
that takes a user message, streams a model's thinking and tool calls into a live
TUI, runs those tools against your files under an explicit permission gate, feeds
the results back, and repeats until the turn ends. It is a **single-runtime
TypeScript + React application** rendered with Ink: `.ts`/`.tsx` run directly
under [`tsx`](https://github.com/privatenumber/tsx) on Node 20+ — no Python, no
compile step, no cross-language surface.

## What this demonstrates

The engineering worth looking at:

- **A frozen event seam.** Every model backend translates its wire format into
  one normalized `AgentEvent` discriminated union
  ([`src/core/events.ts`](src/core/events.ts)); a pure `eventToAction` maps each
  event 1:1 onto a reducer action ([`src/core/reducer.ts`](src/core/reducer.ts)).
  The UI never sees a provider-specific shape — swapping backends changes nothing
  downstream.
- **A turn coordinator** ([`src/agent/turnRunner.ts`](src/agent/turnRunner.ts))
  that drives one submission to completion, loops on `tool_use`, runs each call
  through an executor that owns the permission round-trip, and re-enters the
  results — with an abort path that always settles parked permission prompts so
  nothing hangs.
- **A workspace-jail sandbox** ([`src/tools/fileTools.ts`](src/tools/fileTools.ts)):
  every file path is `realpath`-resolved against the working directory and any
  `..` escape, absolute-out-of-root path, or symlink pointing outside is rejected
  before the syscall.
- **Per-tool risk classification** (`safe` / `risky` / `dangerous`) with a
  headless, pure policy ([`src/permissions/policy.ts`](src/permissions/policy.ts)):
  reads auto-allow, writes prompt, the shell is always prompted, `deny` beats
  `allow`, and a `dangerous` call can never be satisfied by an ordinary
  remembered rule.
- **A multi-backend model layer** behind one `ModelClient` interface
  ([`src/providers/`](src/providers/)) — three genuinely different transports
  normalized to the same stream (see below).
- **MCP integration** ([`src/services/mcpManager.ts`](src/services/mcpManager.ts))
  — external Model Context Protocol servers discovered at startup, their tools
  surfaced through the same risk gate.
- **A privacy-by-default stance:** the OpenRouter transport tags every request
  with a no-train directive (`data_collection: 'deny'`), and the subscription
  backend runs render-only with shell, network, and sub-agent tools hard-denied.

## Feature highlights

- **Multi-provider model layer.** One `ModelClient` seam, three adapters:
  - **Anthropic Messages API** — streaming SSE against `/v1/messages`
    ([`anthropicClient.ts`](src/providers/anthropicClient.ts)).
  - **OpenAI-compatible / OpenRouter** — chat-completions streaming, OpenRouter
    carrying the no-train directive
    ([`openaiCompatClient.ts`](src/providers/openaiCompatClient.ts)).
  - **Subscription CLI seam** — spawns the `claude` CLI headless
    (`claude -p --output-format stream-json`) on the logged-in Max subscription
    (no API key), translating its NDJSON into the *same* `AgentEvent` stream, with
    server-side session reuse across turns
    ([`claudeCliClient.ts`](src/providers/claudeCliClient.ts)).
- **Streaming TUI.** Assistant text and extended-thinking stream token-by-token;
  finished turns commit into an Ink `<Static>` region so they are never redrawn.
  A model picker, slash-command palette, and a responsive status strip (model,
  cwd, context-window gauge, effort, cost) round it out.
- **Risk-tiered tool approval.** An interactive prompt shows the tool, its risk
  tint, and a colorized unified diff for file writes; `y`/`a`/`d` decide, `!` is
  an explicit dangerous bypass, and always-allow patterns are remembered.
- **Tool suite.** Five workspace-jailed file tools (`read_file`, `list_files`,
  `grep`, `write_file`, `edit_file`), an on-demand skill loader, a depth-limited
  `spawn_subagent`, a `dangerous`-tier `run_shell`, a preset-bound parent-only
  `run_verification`, a bounded session-memory
  tier, and any MCP server tools — assembled per session.
- **Sessions & resume.** Committed turns persist to `~/.config/juno/sessions/`
  (JSON snapshot + append-only JSONL log); a `/resume` palette lists past
  sessions newest-first and rehydrates the transcript.

## Architecture at a glance

```text
  provider adapters              normalized stream        UI
  ─────────────────              ─────────────────        ──
  anthropicClient  ┐
  openaiCompat     ├─►  AgentEvent  ─►  turnRunner  ─►  reducer  ─►  Ink <Static>
  claudeCliClient  ┘   (events.ts)      (loops on       (state)      transcript
  mcp tools ───────┘                     tool_use) ─► executor ─► permission gate
```

- [`src/providers/`](src/providers/) — the model backends + registry.
- [`src/core/`](src/core/) — the `AgentEvent` union, reducer, and selectors.
- [`src/agent/`](src/agent/) — the turn coordinator and event bus.
- [`src/tools/`](src/tools/) + [`src/permissions/`](src/permissions/) — tools,
  the executor, and the permission policy.
- [`src/ui/`](src/ui/) — the Ink components (transcript, status line, permission
  prompt, palettes).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
  [`docs/SECURITY.md`](docs/SECURITY.md) ·
  [`docs/DECISIONS.md`](docs/DECISIONS.md) — the deeper write-ups.

## Quickstart

Requires **Node.js 20+** (the package is ESM-only).

```sh
npm install
npm start          # launch the TUI (tsx src/cli.ts)
npm run dev        # launch with file-watch reload
```

`--help` / `--version` go through `tsx` directly:

```sh
npx tsx src/cli.ts --help
```

Set the API key for the transport you want (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), or use the default subscription
backend, which reuses your logged-in `claude` CLI session and needs no key. Pick
a model in the TUI or with `JUNO_MODEL=<id> npm start`.

### Configuration

Settings resolve **built-in defaults → `~/.config/juno/config.json` →
environment variables** (last wins). External MCP servers are registered under
`mcpServers`, keyed by id; each tool's risk is classified per tool so only tools
you deliberately mark `safe` are auto-allowed:

```json
{
  "defaultModel": "claude-fable-5",
  "mcpServers": {
    "docs": {
      "command": ["my-docs-mcp", "--stdio"],
      "toolRisk": { "search_docs": "safe", "get_doc": "safe" }
    }
  }
}
```

Here `mcp__docs__search_docs` and `mcp__docs__get_doc` auto-allow (reads), while
any write tool the server exposes falls through to the prompt-gated default.
Env overrides: `JUNO_PROVIDER`, `JUNO_MODEL`, `JUNO_CWD`, `JUNO_MAX_CONTEXT`.

#### Diagnostic traces and replay

Session tracing is deliberately **off by default**. Enable it with `"trace": true`
in `config.json` or `JUNO_TRACE=1`. Juno then writes versioned NDJSON under
`~/.config/juno/traces/`, at the single reducer dispatch funnel. Each line carries
a monotonic sequence, timestamp, session id, turn id, and the exact action shape
accepted by the reducer.

Raw user prompts are replaced with their character count. Tool arguments/results
are depth-, collection-, and string-bounded, and secret-looking keys are redacted;
resumed transcripts are not copied into traces. Model output remains diagnostic
content but is string-bounded, so treat the directory as private user data.
Serialization and append I/O run behind a bounded asynchronous queue; tracing is
fail-soft and never changes a turn outcome. Graceful shutdown and session changes
flush/close their recorder. Startup retains the 20 newest `.ndjson` files (including
the new session); hard process termination can leave only the final line incomplete,
which the line-oriented reader reports without hiding other records.

`replayTraceFile` / `replayTraceNdjson` in `src/services/sessionTrace.ts` provide the
first executable replay seam: records are validated and folded through the pure
reducer. Issues are classified as `trace` (NDJSON/envelope/ordering), `action`
(unknown action version), or `reducer` (application failure). Full provider/tool
selftest playback is intentionally follow-up work; this seam replays state evolution
without performing model calls, tools, permissions, or terminal rendering.

## Testing

```sh
npm test           # vitest, run once
npm run typecheck  # tsc --noEmit (strict)
```

The suite is **1006 passing (+3 opt-in skipped) across 51 files** — unit tests for
the reducer, permission policy, provider adapters, and workspace jail, component
tests over the Ink UI, and an end-to-end smoke test that drives the real TUI
through a pty. CI (GitHub Actions) runs typecheck + the full suite on Node 20 for
every push and pull request.

## How it was built

juno was produced by an **autonomous multi-agent build system** — a "forge" that
planned the port, decomposed it into sealed seams, and had agents implement,
test, and review each one against a frozen contract. The tight event/reducer
seams and the exhaustively-tested contracts throughout are a direct consequence
of that build discipline.

## Status

Active development. The architecture and test coverage are mature; the surface is
still moving (new providers and tools land regularly), and the version reflects
that (`0.1.0`).

## License

[MIT](LICENSE) © 2026 Aiden Angel
