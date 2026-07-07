# juno

A terminal agent UI — a coding agent you drive from your terminal. `juno` streams
an LLM turn into a live transcript, lets the model call workspace-jailed file
tools, and gates every risky tool call behind an interactive permission prompt.

It is a single-runtime **TypeScript + React + [Ink](https://github.com/vadimdemedes/ink)**
application. There is **no Python**, no build step, and no cross-language surface:
`.ts`/`.tsx` run directly under [`tsx`](https://github.com/privatenumber/tsx) on
Node 20+.

## What you get

- **Streaming turns** — assistant text and extended-thinking ("reasoning") stream
  token-by-token into the transcript. Output is committed once per turn into an Ink
  `<Static>` region so finished messages are never redrawn.
- **Tool use** — five built-in file tools (`read_file`, `list_files`, `grep`,
  `write_file`, `edit_file`), all confined to a **workspace jail** rooted at the
  working directory. No shell/bash tool ships in v1.
- **Interactive permissions** — `read_file`/`list_files`/`grep` are `safe`;
  `write_file`/`edit_file` are `risky` and require an explicit per-call decision
  unless you remember an always-allow pattern.
- **Model picker** — switch models from a built-in catalog (OpenAI, Anthropic, and
  OpenRouter entries) without leaving the TUI.
- **Slash palette** — `/clear`, `/model`, `/mode`.
- **Sessions & memory** — committed transcripts and a small bounded key/value
  memory persist under `~/.config/juno/`.
- **Privacy** — when routing through OpenRouter, requests carry a no-train
  (`data_collection: 'deny'`) directive; see [docs/SECURITY.md](docs/SECURITY.md).

## Requirements

- Node.js **20 or newer** (the package is ESM-only, `"type": "module"`).
- A terminal with truecolor support is recommended. On Windows, use **Windows
  Terminal + PowerShell 7** with a UTF-8 code page for correct colors.

## Install

```sh
npm install
```

## Running juno

The `bin` entry (`juno`) points at `src/cli.ts`. Because npm's global bin shim
invokes `node`, and Node cannot execute a `.ts` file directly, launch juno through
the package scripts (which run it under `tsx`):

```sh
npm start              # launch the TUI  (tsx src/cli.ts)
npm run dev            # launch with file-watch reload  (tsx watch src/cli.ts)
```

To pass flags to the CLI, invoke `tsx` directly:

```sh
npx tsx src/cli.ts --help      # show usage
npx tsx src/cli.ts --version   # print version
```

`--help` / `-h` prints usage and exits; `--version` / `-v` prints the version and
exits. With no flags, juno builds its dependencies (config, model catalog, provider
client, permission policy, tools) and renders the TUI.

### Windows note

On Windows there is no separate launcher: the same `npm start` / `npx tsx
src/cli.ts` commands work in PowerShell 7. The CLI shim header (`#!/usr/bin/env -S
tsx`) only matters on POSIX shells; on Windows you always go through `tsx`. See
[docs/DECISIONS.md](docs/DECISIONS.md) for why there is no compiled `.js` bin.

## Quickstart

1. Set the API key for the provider you want. The key is read from an environment
   variable named by the provider's `apiKeyEnv`:
   - OpenAI → `OPENAI_API_KEY`
   - OpenRouter → `OPENROUTER_API_KEY`
   - Anthropic → `ANTHROPIC_API_KEY`
2. (Optional) pick a model: `JUNO_MODEL=claude-sonnet-4 npm start` — or switch in
   the model picker (`Ctrl+M`).
3. `npm start`, type a message at the prompt, and press Enter.

### Keys

| Key        | Action                                              |
| ---------- | --------------------------------------------------- |
| `Enter`    | Submit the current message                          |
| `Tab`      | Cycle execution mode (`normal` → `plan` → `ultracode`) |
| `/`        | Open the slash palette (only when the input is empty) |
| `Ctrl+M`   | Open the model picker                               |
| `↑` / `↓`  | Move the selection in an open palette/picker        |
| `Esc`      | Abort the in-flight turn, or close an open overlay  |

In the permission prompt: `y` allow once · `a` always allow (remember pattern) ·
`d` deny · `!` dangerous bypass.

## Configuration

Settings resolve in this order, last wins: **built-in defaults → config file →
environment variables**.

### Config file

`~/.config/juno/config.json` (JSON). A missing or malformed file silently falls
back to defaults. Recognized keys:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-4.1",
  "cwd": "/path/to/workspace",
  "maxContext": 1047576,
  "providers": {
    "openai":     { "apiKeyEnv": "OPENAI_API_KEY" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
    "anthropic":  { "apiKeyEnv": "ANTHROPIC_API_KEY" }
  }
}
```

`providers[*].apiKeyEnv` names the **environment variable** that holds the key; the
key value itself is never read or stored by the config layer — the provider adapter
reads it at request time.

### MCP servers

`mcpServers` registers external [Model Context Protocol](https://modelcontextprotocol.io)
stdio servers, keyed by a stable id (`[A-Za-z0-9_-]`, no `__`). Each server's tools
surface as parent-agent-only juno tools named `mcp__<id>__<tool>`. `command` is the
argv spawned **without a shell** (argv[0] is the binary) and is the only required
field; `env`, `cwd`, and `timeoutMs` (per connect / tool-call, default 30 000 ms) are
optional. A dead or slow server is skipped at startup with a warning — never fatal.

Risk is classified **per tool**: an entry in `toolRisk` (keyed by the server's own
tool name) wins, else the server-wide `risk`, else the `risky` default. Only tools
deliberately classified `safe` are auto-allowed; everything else prompts. This is how
the personal-brain server auto-allows its read tools while gating its durable write:

```json
{
  "mcpServers": {
    "brain": {
      "command": ["uv", "run", "--directory", "/path/to/brain", "brain-server"],
      "toolRisk": { "recall": "safe", "get_episode": "safe" }
    }
  }
}
```

Here `mcp__brain__recall` and `mcp__brain__get_episode` are `safe` (auto-allowed),
while `mcp__brain__remember` falls through to the `risky` default and stays
prompt-gated.

> **Pre-release checklist.** The unit suite exercises MCP discovery, risk
> classification, and dispatch against a hermetic fixture, but the live brain
> server is only reached by an opt-in end-to-end test that CI always skips (it
> needs `uv` + `~/src/brain`). Before cutting a release, run it for real once to
> confirm an actual `recall` tools/call still round-trips to the result shape the
> adapter renders:
>
> ```sh
> JUNO_BRAIN_E2E=1 npx vitest run tests/brainMcp.integration.test.ts
> node _forge/_tests/dryrun-darwin.mjs
> ```
>
> It is READ-ONLY — it never invokes `remember` against the real server. The
> `dryrun-darwin.mjs` gate is out-of-band (not covered by vitest) — run it too.

### Environment variables

| Variable           | Overrides            | Notes                                            |
| ------------------ | -------------------- | ------------------------------------------------ |
| `JUNO_PROVIDER`    | `defaultProvider`    |                                                  |
| `JUNO_MODEL`       | `defaultModel`       | An id or alias from the catalog                  |
| `JUNO_CWD`         | `cwd`                | Working directory / workspace-jail root          |
| `JUNO_MAX_CONTEXT` | `maxContext`         | Parsed as an integer; ignored unless `> 0`       |

There is also an advisory-only `JUNO_SKIP_POLICY_CHECK` consumed by the optional
`scripts/verify-openrouter-policy.ts` verifier (see SECURITY).

### Data locations

- Config: `~/.config/juno/config.json`
- Sessions: `~/.config/juno/sessions/` (`<id>.json` snapshots + `<id>.jsonl` append-only transcript logs)
- Memory: `~/.config/juno/memory/memory.json` (bounded, default 64 KiB)

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module tree, the event→reducer
  seam, the turn coordinator, the permission round-trip.
- [docs/SECURITY.md](docs/SECURITY.md) — privacy model, tool sandbox, permission gate.
- [docs/DECISIONS.md](docs/DECISIONS.md) — the append-only decision log.

## Development

```sh
npm test          # run the vitest suite once
npm run test:watch
npm run typecheck # tsc --noEmit (strict)
```
