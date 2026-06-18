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

Additional containment properties:

- **No shell.** There is no bash/exec/shell tool in v1; the registry
  (`src/tools/registry.ts`) exposes only the five file tools.
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
  `deny` rule → `auto-deny`; otherwise a matching `always-allow-pattern` /
  `dangerous-bypass` → `auto-allow`.
- **Otherwise the risk fallback applies:** `safe` → `auto-allow` (when
  `autoAllowSafe`, the default); `risky` → `prompt`; `dangerous` → `prompt`. A
  `dangerous` call is **never** silently auto-allowed by risk alone — only an
  explicit remembered bypass pre-grants it.

When `evaluate` returns `prompt`, the executor opens the interactive
`PermissionPrompt`, which offers four decisions (keys `y` / `a` / `d` / `!`):

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
