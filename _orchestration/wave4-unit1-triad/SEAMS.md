# SEAMS — Wave 4 Unit 1 (Permission-mode parity, lean subset)

Frozen contract that every triad unit builds against. Pinned by the conductor from
the live source (2026-06-17). Do not deviate; downstream units embed this verbatim.

## Project facts
- Repo root: `C:/Users/Core/src/juno`. TypeScript + Ink. No local git.
- Gate (must stay green): `cd C:/Users/Core/src/juno && npx tsc --noEmit && npx vitest run` → currently tsc-0, **269/269**.
- tsconfig: `strict:true`, but `exactOptionalPropertyTypes` **OFF** and `noUncheckedIndexedAccess` **OFF**. (Passing `undefined` to an optional prop is fine; `lines[i]` types as `string`.)
- Locked scope: modes `default` + `acceptEdits` ONLY (`bypassPermissions` CUT). Rules = **deny + allow only** (no `ask`). Mode is **config-only** (no session toggle, no reducer event). **Suppressed on claude-cli** (raw-API-only; no `--permission-mode` pass-through). **Touches NO frozen seam** (`src/core/{events,reducer,contracts}.ts` untouched).

## SEAM 1 — `PermissionPolicyOptions` (src/permissions/policy.ts)

Additive-only. `evaluate` keeps returning ONLY `'auto-allow' | 'auto-deny' | 'prompt'` — NO new return value.

```ts
export interface PermissionPolicyOptions {
  autoAllowSafe?: boolean;                                                   // existing
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>; // existing
  // NEW (Unit 1):
  /** Permission mode. 'acceptEdits' auto-allows the edit tools only. Default: 'default'. */
  mode?: 'default' | 'acceptEdits';
  /** Seeded always-allow patterns (config-driven). Same grammar as remembered patterns. */
  allow?: ReadonlyArray<string>;
  /** Seeded deny patterns. Deny wins over allow AND over acceptEdits auto-allow. */
  deny?: ReadonlyArray<string>;
}
```

### MANDATORY invariants (the whole point of the unit)
1. **`acceptEdits` is an explicit name allow-set `{ 'write_file', 'edit_file' }`, checked BEFORE the risk switch.** It must auto-allow `write_file` and `edit_file` and NOTHING else. `write_file`/`edit_file` are `risk:'risky'` — but so is **`spawn_subagent`** (also `risk:'risky'`). A naive "acceptEdits ⇒ auto-allow risky" would silently auto-allow `spawn_subagent` (an unattended nested turn). The name allow-set is the ONLY correct mechanism.
2. **deny-wins precedence**, ahead of any allow and ahead of `acceptEdits`. A seeded/remembered `deny` that matches MUST return `'auto-deny'` even under `acceptEdits` and even for `write_file`/`edit_file`.
3. Order in `evaluate`: scan `#rules` → if any deny matched ⇒ `auto-deny` → else if any allow matched ⇒ `auto-allow` → else if `mode==='acceptEdits'` AND name ∈ allow-set ⇒ `auto-allow` → else the existing risk switch (safe⇒autoAllowSafe?, risky⇒prompt, dangerous⇒prompt).
4. Seeded `allow` → remembered as `'always-allow-pattern'`; seeded `deny` → remembered as `'deny'`, reusing the existing `#rules`/`remember`/`matchesPattern` path (single matcher). Seed `allow` FIRST then `deny`, so an exact-pattern collision (same normalized pattern in both lists) resolves deny-wins (last write per key).
5. `default` mode is behaviorally identical to today (no acceptEdits branch fires).

## SEAM 2 — `Settings` (src/services/config.ts)

```ts
export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
  // NEW (Unit 1):
  permissionMode?: 'default' | 'acceptEdits';
  permissions?: { allow: string[]; deny: string[] };
}
```

- `DEFAULT_SETTINGS` adds `permissionMode: 'default'` and `permissions: { allow: [], deny: [] }`.
- `parseSettings`: parse `permissionMode` ONLY if it equals `'default'` or `'acceptEdits'` (enum-whitelist; any other value is ignored). Parse `permissions` only if it is an object; coerce `allow`/`deny` to `string[]` filtering out non-strings; missing list ⇒ `[]`.
- `mergeSettings`: overlay both fields over the base (`overlay.permissionMode ?? base.permissionMode`; `overlay.permissions ?? base.permissions`).
- `applyEnvOverrides`: `JUNO_PERMISSION_MODE` env var with a **NEW enum-allowlist guard** — apply ONLY if the value is exactly `'default'` or `'acceptEdits'`; a bad value is ignored (the env path has no enum-validating template today; an unguarded bad value would poison the mode).

## SEAM 3 — cli.ts wiring (src/cli.ts, the single shared policy at ~line 63)

```ts
const policy = createPermissionPolicy({
  autoAllowSafe: true,
  mode: settings.permissionMode,
  allow: settings.permissions?.allow,
  deny: settings.permissions?.deny,
});
```
One shared instance flows to BOTH the executor and `SubagentDeps.policy` (subagents inherit the mode/rules). No other cli.ts change.

## SEAM 4 — optional `mode:<m>` chip (selectors.ts + StatusLine.tsx + app.tsx)

Render-only, config-only, **no reducer touch**. Mirror the existing `skills:N` chip.
- `StatusLineState` (selectors.ts) gains `permissionMode?: 'default' | 'acceptEdits'`.
- `selectStatusLine`'s `context` param gains `permissionMode?: 'default' | 'acceptEdits'`; pass it through to the returned object.
- `app.tsx` (~line 120) passes `permissionMode: deps.settings.permissionMode` into the `selectStatusLine(turn.state, { ... })` context.
- `StatusLine.tsx` (~line 34, next to the skills chip) renders `mode:{status.permissionMode}` ONLY when `status.permissionMode !== undefined && status.permissionMode !== 'default'` (keep the default case clean). Use `token('warn', d)` if it exists, else `token('info', d)`.

## Tool-name facts (verified)
- `write_file` → `risk:'risky'` (fileTools.ts:296-297)
- `edit_file` → `risk:'risky'` (fileTools.ts:328-329)
- `spawn_subagent` → `risk:'risky'` (subagentTool.ts:106-107)  ← the trap acceptEdits must NOT auto-allow
- `read_file`/search/list tools → `risk:'safe'`
- executor calls `policy.evaluate(name, args, tool.risk)` with `name` = the tool name → a name-based allow-set works directly.
