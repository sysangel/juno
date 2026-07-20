# Security

`juno` rests on three guarantees: a **no-train privacy posture**, a **workspace
jail** on every file tool, and an **interactive permission gate** in front of risky
tool calls. This document states each as it is actually built.

## Privacy model — no-train only

**The whole policy is NO-TRAIN.** There is no geographic / "Western-only"
allowlist; that screen was retired. juno never adds an `only: [...]` provider
allowlist.

No-train is enforced **account-side on OpenRouter** (project decision D2). The
account's OpenRouter data policy is the source of truth. On top of that, the
adapter adds a **belt-and-suspenders** directive in the request body.

### How it is applied

In `src/providers/openaiCompatClient.ts`, when the request targets OpenRouter the
adapter attaches:

```js
body.provider = {
  data_collection: 'deny',
  allow_fallbacks: true,
};
```

This block is **identity-keyed**: it is gated on the `isOpenRouter` flag, which is
derived from the catalog entry's provider id (`entry.provider === 'openrouter'`),
**not** by string-matching the base URL. A custom or trailing-slash OpenRouter base
URL still routes correctly, and a non-OpenRouter base URL is never accidentally
tagged. Note there is **no `only: [...]` allowlist** — `data_collection: 'deny'` is
the entire body-level directive.

### API keys

API keys are never stored, logged, or emitted by juno. The config layer
(`src/services/config.ts`) only records the **name** of an environment variable
(`providers[*].apiKeyEnv`); the value is read by the provider adapter **inside
`streamTurn`, at request time**, sent in the `Authorization` / `x-api-key` header,
and otherwise never persisted.

Opt-in diagnostic traces (`trace: true` / `JUNO_TRACE=1`) are local artifacts, not
telemetry. Prompts are removed, secret-looking tool keys are redacted, and payloads
are bounded before asynchronous NDJSON persistence. Redaction is defense in depth,
not a guarantee that arbitrary model output contains no sensitive material; traces
therefore remain disabled by default and should be protected like session files.

### Advisory verifier (not enforcement)

`scripts/verify-openrouter-policy.ts` is an **optional, secondary,
non-enforcing** convenience check, run standalone:

```sh
npx tsx scripts/verify-openrouter-policy.ts
```

It never sits in the request hot path and never gates a request. It checks whether
`OPENROUTER_API_KEY` is set and (best-effort) that the key resolves against the
OpenRouter `/key` endpoint, then prints an advisory message to stderr and exits 0/1.
It is skippable via `--skip` or `JUNO_SKIP_POLICY_CHECK=1`. Every message it prints
is framed as "secondary / not enforcement" so it can never be mistaken for the
account-side enforcement. The key is sent in-memory only and is never printed.

## Tool sandbox — the workspace jail

Every file tool (`src/tools/fileTools.ts`) confines all filesystem access to a
**jail root** equal to the resolved working directory (`ctx.cwd`, from
`settings.cwd` / `JUNO_CWD`). Before any read or write, the requested path is passed
through `resolveInWorkspace(cwd, targetPath)`:

```
root     = path.resolve(cwd)
resolved = path.resolve(root, targetPath)
rel      = path.relative(root, resolved)
reject if  rel === '..'  ||  rel startsWith '..' + sep  ||  path.isAbsolute(rel)
```

Guarantees this gives:

- **No `..` escape.** A relative path that climbs above the root yields a `rel`
  beginning with `..` and is rejected (`"path escapes workspace"`).
- **No absolute-path escape.** An absolute target outside the root resolves to a
  `rel` that is itself absolute and is rejected.
- **Cross-drive escape (Windows).** When the target is on a different drive than the
  root (e.g. `C:\` vs `D:\`), `path.relative` returns an absolute path, so the same
  `isAbsolute(rel)` guard catches it.
- The root itself is allowed (`rel === ''`, e.g. `list_files(".")`).

### Sensitive-path deny (secret-bearing files)

Passing the jail is **necessary but not sufficient**. After the containment check
confirms the canonical `rel` is in-jail, `resolveInWorkspace` runs one more gate:
`isSensitivePath(rel, patterns)`. If it matches, the call is rejected with a
**distinct** error string — `"path is denied (sensitive file)"`, *not*
`"path escapes workspace"` — so callers, tests, and logs can tell a jail-escape
from a sensitive-deny. This blocks the native file tools
(`read_file`/`list_files`/`glob_files`/`tree`/`grep`/`write_file`/`edit_file`/
`apply_patch`) from touching a shipped
default set of secret-bearing paths **even when they sit inside the jail**.

`apply_patch` additionally preflights every canonical target and exact-content
precondition before its first mutation. Each replacement uses a same-directory
temporary file plus atomic rename; if a later operation fails, already-applied
operations are restored in reverse order. Duplicate canonical targets are rejected,
including differently spelled paths that resolve to the same file.

**Why the tool layer, not a policy-layer deny.** `src/permissions/patterns.ts`
`matchKey` keys on the **raw** `args.path`/`args.dir`, so a policy rule like
`read_file:**/.env` is evadable three ways: `./x/../.env`, an absolute form, or a
symlink renamed to a harmless name. The tool-layer check matches on the
**post-`realpath` canonical `rel`**, which all three dereference to, closing every
variant at once. (The read tools are `risk:'safe'` / auto-allowed, so the tool
layer is also the *only* place that can plug the grep content-leak below.)

**Default pattern set** (`DEFAULT_SENSITIVE_PATTERNS`), matched per path segment,
case-insensitively, anchored (so it does **not** over-match — `env.example`,
`environment.ts`, and `readme.pem.txt` stay readable):

- exact basenames `.env`, `.npmrc`, `id_rsa`, `credentials`
- the `.env.*` family (`.env.local`, `.env.production`, …) but **not** `env.example`
- `*.pem` anchored to the end of the basename (any PEM key/cert)
- a `.ssh/` **directory-segment** rule — any path containing a `.ssh` segment

**Both sneaky readers are closed, not just the direct-target case:**

- **`grep`** walks the directory tree and reads every file directly, so a jail
  check on the *dir* argument alone would still leak file **contents**. The walk
  loop skips any file whose canonical `rel` is sensitive, so `.env`/`id_rsa`/`*.pem`
  contents never surface in a match. (Dot-*directories* like `.ssh/` were already
  skipped by the walker; the danger was dot-*files* and plain files.)
- **`list_files`** filters sensitive basenames out of the returned `entries`, so
  `list_files(".")` does not even expose `.env` as a **name** (chosen contract:
  exclude, not merely block reads).

**Symlink-rename evasion is caught.** A link `harmless.txt` → an in-workspace
`.env` resolves to its sensitive canonical `rel` and is denied; a raw-arg policy
deny would miss it. (A link pointing to an `.env` *outside* the jail is already
caught by the containment check above.)

**Overridable via settings** (`src/services/config.ts`,
`Settings.permissions`), plumbed CLI → `createDefaultTools` → `createFileTools`:

- `permissions.denySensitiveDefaults: false` turns the shipped default set **off**
  (so `.env` becomes readable again). Default is `true` (deny on).
- `permissions.sensitivePaths: [...]` **appends** extra patterns (same grammar:
  a basename glob, or a `dir/` segment rule).

**Coverage limit (honest scope).** This deny covers juno's **own** file tools
ONLY. It does **not** cover `run_shell`: the shell has no path jail and neither the
policy nor the tool layer can see command content, so `run_shell` can still
`cat .env`. That path is gated only by `run_shell` being `risk:'dangerous'`
(always human-prompted) — see the shell subsection below. Full non-interactive
coverage of secret files needs the OS-level sandbox deny.

Additional containment properties:

- **Shell (`run_shell`) is the most-gated tool.** The registry
  (`src/tools/registry.ts`) exposes a `run_shell` tool (`src/tools/shellTool.ts`)
  that runs a command line via `sh -c` (no interactive/login profile,
  `shell:false`, stdin closed). It is `risk:'dangerous'`, so the permission policy
  **always prompts** for it in **both** `default` and `acceptEdits` modes — it is
  never auto-approved by risk alone. The prompt for a **dangerous** tool
  deliberately does **not** offer `[a]` (always allow): the remembered pattern
  would be the bare tool name, which matches *every* future call, so one `a` on a
  benign command would blanket-grant all commands forever. Only an explicit
  `dangerous-bypass` (`!`) can pre-grant it — and the policy **structurally
  refuses** to satisfy dangerous risk from an ordinary `always-allow-pattern`
  rule even when a matching one exists (defense in depth against a UI
  regression).

  **The workspace jail does NOT constrain the shell.** The child's `cwd` merely
  *starts* at the workspace root; a command can `cd` anywhere or touch absolute
  paths outside it freely. cwd is a starting directory, not confinement — the
  per-command permission prompt (which shows the exact command string) is the
  control.

  **Sanitized environment.** The child env is built from an allowlist — `PATH`,
  `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LANGUAGE`, `TMPDIR`, `TERM`,
  `COLORTERM`, plus any `LC_*` locale variables (`SHELL_ENV_ALLOWLIST` in
  `src/tools/shellTool.ts`). Everything else — `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `OPENROUTER_API_KEY`, tokens, juno's own `JUNO_*` config —
  is withheld, so a shell command can never read juno's secrets from its
  environment.

  Output is capped (default 100 KiB per stream, truncation-marked) and the child
  is killed (SIGTERM→SIGKILL) after a hard timeout (default 120s). A non-zero
  exit is a tool error, not a crash. It is a **parent-agent-only** capability
  (excluded from the sub-agent tool snapshot, like the memory tools). `run_shell`
  is a **juno-internal** tool: it has no `JUNO_TO_CLI_TOOL` mapping, so on the
  **`claude-cli` backend** it is never projected onto `--allowedTools`, and that
  backend's own `Bash` stays unconditionally on `--disallowedTools`. The five file
  tools remain the only *other* tools that touch the filesystem. On the
  **`claude-cli` backend** (the default), the spawned `claude -p` runs its *own*
  tools within the invocation, so juno's executor cannot intercept them
  individually. That backend is instead constrained up front
  (`src/providers/claudeCliClient.ts`, `buildCliToolGrants`). What this **does**
  guarantee, per turn:
  - The child is spawned with `cwd` pinned to the jail root.
  - `--allowedTools` pre-approves **only** the CLI tools whose juno mirror the
    permission policy would *auto-allow in the live mode*: the read-only tools
    (`read_file→Read`, `list_files→Glob`, `grep→Grep`) always, and the write
    tools (`write_file→Write`, `edit_file→Edit`) **only in `acceptEdits` mode**.
    Every file-tool allow entry is **path-scoped** to the jail root as
    `Tool(//<jailroot>/**)` (gitignore-style absolute pattern), so a pre-approval
    never covers a path outside the jail. It **also** pre-approves the sub-agent
    orchestration tools `Task`/`Agent` **unconditionally** (both juno modes are
    non-prompting) — a headless `claude -p` auto-denies anything not
    pre-approved, so the subagent tools must be allowlisted for the child to
    spawn subagents that render live in juno's TUI. `Task`/`Agent` are *not*
    path-scoped (they are orchestration, not filesystem tools).
  - `--disallowedTools` **unconditionally** denies the shell/network escape-hatch
    tools (`Bash`, `BashOutput`, `KillShell`, `WebFetch`, `WebSearch`),
    and in juno **`default` mode** *also* denies `Write`/`Edit` — juno would
    prompt a human for those, and a headless `claude -p` cannot prompt, so they
    are hard-denied rather than silently auto-approved (the original bypass).
  - **MCP is pinned to juno's own grants.** Every spawn carries `--mcp-config`
    **plus `--strict-mcp-config`**, so the child's *only* MCP servers are the
    ones juno auto-allowed this turn. Per exposed `mcp__<server>__<tool>`, the
    translation mirrors juno's live permission policy (risk from the config's
    `toolRisk`/`risk`, `'risky'` default): an `auto-allow` verdict lands on
    `--allowedTools` and wires its server into the config; anything juno would
    prompt for (or deny) lands on `--disallowedTools` — a headless child cannot
    prompt, so would-prompt means deny. On turns where *nothing* is auto-allowed
    (or the passthrough is off) the config is an **empty** `{"mcpServers":{}}`:
    without strict, the child would *also* load the user's ambient
    `~/.claude.json`/settings MCP servers — tools juno never saw and so granted
    neither an allow nor a deny, which a pre-existing user-level `mcp__*` allow
    rule would then auto-approve **ungated** (an out-of-jail write/network hole).
    `--strict-mcp-config` scopes *only* the MCP sources; the subscription
    OAuth/user settings the backend depends on load exactly as before. The
    config itself rides a **private 0600 temp file** (fresh random name per
    spawn, unlinked at attempt end) — inline JSON on argv would expose every
    server's `env` (tokens, keys) to any local process via `ps`. The
    translation evaluates each tool once with **empty args** (there are no
    per-call args at spawn time), so a deny rule **scoped to specific args**
    (e.g. `mcp__fs__read:/etc/*`) could never fire in that evaluation — any
    such rule therefore **fails the tool closed** (hard-denied for the whole
    spawn): the child enforces no per-call argument scoping, and handing the
    tool an unscoped allow would grant it broader authority than juno's live
    gate gives on real args. Arg-scoped *allow* rules need no counterpart —
    invisible to the empty-args evaluation, they can only make the translation
    deny *more* than the live gate, never less.
  - **Sub-agents are bounded by the same gate.** A subagent spawned by the child
    inherits the parent invocation's full permission context: the deny set
    (deny-wins), the path-scoped file allows, and default-mode `Write`/`Edit`
    denial. Empirically confirmed on the live CLI (three-vector probe: a
    subagent's Read of an out-of-jail path is DENIED, its Write inside the jail
    is BLOCKED with no file created, and its Read inside the jail SUCCEEDS). So
    un-denying `Task`/`Agent` lets subagents render but does **not** hand them a
    shell, network access, or a path outside the jail. (This assumes the CLI
    propagates the parent's `--disallowedTools`/scoped `--allowedTools` to the
    nested agent, which the probe verifies for the CLI version in use.)
  - A deny rule wins over any allow rule, so the denied set — and the
    default-mode `Write`/`Edit` denial — cannot be re-enabled by a user's
    `~/.claude` config. Any tool or path not pre-approved is denied headlessly
    in `-p` mode (no prompter exists to fall back to).

  What this **does not** guarantee: this is defense-by-configuration of the
  child process, **not** a kernel/OS-level jail. It relies on Claude Code
  honoring its own permission-rule engine; a bug there would not be contained by
  juno. juno does **not** pass `--setting-sources`, so the user's own
  `~/.claude` settings still load (their MCP *servers*, however, do **not** —
  `--strict-mcp-config` pins the child's MCP universe to juno's own config
  regardless of user settings). Because deny wins over allow this cannot widen
  the denied set, but the read tools (`Read`/`Glob`/`Grep`) are *not* on the deny
  list, so a user's pre-existing global *allow* rule for one of them (e.g. an
  unscoped `Read`) could still widen reads beyond the jail. The `cwd` pin and
  path-scoped grants bound what **juno itself** pre-authorizes; they do not
  revoke a broader grant the user configured globally. Passing
  `--setting-sources project,local` would close this, but is omitted to avoid
  disturbing the subscription OAuth/user configuration the backend depends on.
- **`codex-cli` backend: the passthrough drops the user's entire `~/.codex/config.toml`.**
  Codex `exec` has no `--strict-mcp-config`, so every codex passthrough turn is spawned
  with **`--ignore-user-config`** — which drops the user's ambient `config.toml` *wholesale*
  (its MCP servers **and** everything else), not just the MCP sources. juno re-supplies MCP
  server config for the servers its gate auto-allows via `-c mcp_servers.*` overrides on argv
  (`src/providers/codexCliClient.ts`), so no ungated ambient server can reintroduce a hole.
- **`codex-cli` backend: a wired server must be safe against LATER-ADDED tools, not just
  this turn's.** codex opens its *own* live connection to each `-c mcp_servers.*` server
  (translation, not proxy), so it can call whatever tools the server exposes at connect
  time — **not** juno's per-turn tool snapshot. The gate therefore wires a server only when
  **all** of: (1) every tool exposed this turn auto-allows; (2) the server's *default* risk
  posture auto-allows — a probe for a hypothetical un-configured tool, standing in for any
  tool added after this turn; (3) every statically-configured `toolRisk` tool auto-allows —
  an entry that *raises* a specific tool to risky (even one not exposed this turn, e.g.
  `toolRisk.nuke:'risky'`) sinks the server, since codex could call it; and (4) no `deny`
  rule targets the `mcp__<server>__` namespace — a named deny (`mcp__<server>__purge`) for a
  not-exposed tool is invisible to (1) yet codex could still invoke it. Consequently a server
  whose tools auto-allow only via per-tool `toolRisk`/`allow` overrides atop a risky default
  is **denied**; only a wholesale-safe server (server-wide `risk:'safe'`, e.g. the read-only
  brain server) or one covered by a **wildcard** `mcp__<server>__*` allow — both of which
  also cover future tools — qualifies.
- **Tools never throw to the caller.** Filesystem errors are returned as
  `{ ok: false, error }`, so a bad path or missing file cannot crash a turn.
- **`grep` is ReDoS-safe by default.** Matching is literal-substring (linear time)
  unless `regex: true` is explicitly passed; an invalid user regex falls back to
  literal substring rather than throwing. The recursive walk skips `node_modules`
  and dot-directories and honors the abort signal.

## Permission gate

Risky tool calls cannot run without an explicit decision. Tools declare a
`RiskLevel`: `read_file`/`list_files`/`grep` are `safe`; `write_file`/`edit_file`
are `risky`. The pure policy in `src/permissions/policy.ts` decides via
`evaluate(name, args, risk)`:

- **Remembered rules win first**, evaluated in deny-over-allow order: a matching
  `deny` rule → `auto-deny`; otherwise a matching `dangerous-bypass` →
  `auto-allow`; otherwise a matching `always-allow-pattern` → `auto-allow` **only
  for non-`dangerous` risk**. A `dangerous` call is never satisfied by an
  ordinary always-allow rule — only an explicit `dangerous-bypass` pre-grants it.
- **Otherwise the risk fallback applies:** `safe` → `auto-allow` (when
  `autoAllowSafe`, the default); `risky` → `prompt`; `dangerous` → `prompt`. A
  `dangerous` call is **never** silently auto-allowed by risk alone — only an
  explicit remembered bypass pre-grants it.

When `evaluate` returns `prompt`, the executor opens the interactive
`PermissionPrompt`, which offers four decisions (keys `y` / `a` / `d` / `!`).
For a **`dangerous`** tool the `a` binding is disabled and hidden — only
`y` / `d` / `!` are offered (see the `run_shell` bullet above for why):

| Key | Decision                 | Effect                                              |
| --- | ------------------------ | --------------------------------------------------- |
| `y` | `allow-once`             | Run this call only; never remembered.               |
| `a` | `always-allow-pattern`   | Run, and remember an allow rule for this tool.      |
| `d` | `deny`                   | Do not run; emit a terminal `tool-status('error')`. |
| `!` | `dangerous-bypass`       | Run, and remember a bypass rule for this tool.      |

A `deny` decision means the tool is not run. The full async mechanics of the prompt
(the park/resolve registry, the single shared policy instance, the drain-on-abort
guarantee) are documented in [ARCHITECTURE.md](ARCHITECTURE.md#the-permission-round-trip).

### Always-allow pattern grammar

Remembered rules are matched against a stable key `"<toolName>:<salient>"`, where
`salient` is the call's `path` (or `dir`) argument when present, else the empty
string (`src/permissions/patterns.ts`). Pattern rules:

- A **bare tool name** with no `:` is normalized to `tool:*`, so it matches any
  call to that tool.
- `*` is the **only** glob metacharacter; every other regex metacharacter is
  escaped. A `*` matches any run of characters **including newlines** (`[\s\S]*`),
  so a `deny tool:*` rule cannot be evaded by an argument containing a line break.
- Matching is anchored to the full key (`^…$`).

## Local data

Local persistence is opt-in and modest. Sessions live under
`~/.config/juno/sessions/`; memory is a bounded (default 64 KiB) key/value file at
`~/.config/juno/memory/memory.json`. No secrets are written to these stores — they
hold transcript messages and user-supplied memory values only.
