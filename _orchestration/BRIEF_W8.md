# TEAM BRIEF — W8: Interactive, policy-driven permissions (`src/permissions/`)

You are writing the **permission policy** for a TypeScript + React + Ink terminal product called **`juno`** (a fresh TS/Node20/ESM port of a Python agent harness). Your unit is **W8**: a deterministic, **UI-independent** gate that decides whether a tool call may run. **Wave 1 is done and green.** You CANNOT browse the filesystem — all needed context is inline. You write **zero React/Ink** — the prompt UI lives in a different unit.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**, **no `any`**, exhaustive switches. **ESM only** (`"type":"module"`; ESM `import`/`export`, no `require`).
- **tsconfig:** `moduleResolution:"Bundler"`, `target/lib ES2022`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- **Tests:** vitest (`import { describe, it, expect } from 'vitest'`) — NOT pytest/jest. Deterministic, no I/O, no network, no clock, no randomness.
- **Purity:** this whole unit is pure + synchronous (except `remember` mutates internal state). No React, no filesystem, no `Date.now`, no `Math.random`.

## The exact files you must write
1. `src/permissions/policy.ts` — the `PermissionPolicy` impl + its factory.
2. `src/permissions/patterns.ts` — pattern matching/normalization helpers used by `policy.ts`.
3. `tests/permissions.test.ts` — a vitest suite (see requirements).

Self-contained: import types ONLY from `../core/contracts` (the `PermissionPolicy` interface you implement — annotate the factory's return type with it) and `../core/events` (`RiskLevel`, `PermissionDecision`). Both are type-only imports (erased at compile; zero runtime coupling). Do NOT import React/Ink, W7, W4, or any not-yet-written module.

## FROZEN W3 types you implement against (already exist; import, do not redefine)
From `src/core/events.ts`:
```ts
export type RiskLevel = 'safe' | 'risky' | 'dangerous';
export type PermissionDecision =
  | 'allow-once'
  | 'deny'
  | 'always-allow-pattern'
  | 'dangerous-bypass';
```

## The interface THIS unit must EXPOSE (frozen in `src/core/contracts.ts` — implement EXACTLY)
```ts
export interface PermissionPolicy {
  /** Synchronous policy decision. 'prompt' means the coordinator must open the
   *  interactive overlay and wait for the user's PermissionDecision. */
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  /** Persist an always-allow / bypass pattern for future evaluate() calls. */
  remember(pattern: string, decision: PermissionDecision): void;
}
```
You expose a **factory** (do not force callers to `new`):
```ts
export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
}
export function createPermissionPolicy(opts?: PermissionPolicyOptions): PermissionPolicy;
```

## Behaviour to implement (this is the spec — pin it exactly)
`evaluate(name, args, risk)` returns one of `'auto-allow' | 'auto-deny' | 'prompt'`:
1. First consult remembered patterns (set via `remember`). Compute the **match key** for this call (see patterns.ts below) and check it against every remembered entry:
   - a remembered `'always-allow-pattern'` whose pattern matches → **`'auto-allow'`**.
   - a remembered `'dangerous-bypass'` whose pattern matches → **`'auto-allow'`** (bypass = pre-granted, even for `dangerous`).
   - a remembered `'deny'` whose pattern matches → **`'auto-deny'`** (sticky deny wins over everything below).
   - (`'allow-once'` is NEVER stored by `remember` — it is a one-shot decision the UI returns, not a remembered rule. If passed to `remember`, ignore it / no-op.)
2. If no remembered rule matched, fall back to **risk**:
   - `'safe'`  → `'auto-allow'` when `autoAllowSafe` (default true), else `'prompt'`.
   - `'risky'` → `'prompt'`.
   - `'dangerous'` → `'prompt'` (never silently auto-allowed by risk alone — only an explicit remembered bypass pre-grants it).
3. A remembered **deny** must take precedence over a remembered allow/bypass for the same call (deny is the safe default; order: deny → allow/bypass → risk fallback).

`remember(pattern, decision)`:
- Stores the `(normalizedPattern, decision)` rule for `'deny'`, `'always-allow-pattern'`, `'dangerous-bypass'`.
- Ignores `'allow-once'` (one-shot, never persisted).
- Re-calling with the same pattern updates that pattern's decision (last write wins per pattern).

### `patterns.ts` — match-key + matching (deterministic, total)
- Export `matchKey(name: string, args: unknown): string` — a stable string derived from the tool name and the *salient* arg (for file tools, the `path`/`dir`). Recommended: `` `${name}:${salientPath(args)}` `` where `salientPath` reads `args.path` ?? `args.dir` ?? `''` when `args` is an object, else `''`. Keep it total — never throw on odd `args`.
- Export `matchesPattern(pattern: string, key: string): boolean` — support a simple glob where `*` matches any run of chars (translate to a `RegExp` with `*`→`.*`, escaping other regex metachars). A pattern equal to the key (or a tool-name-only pattern like `write_file:*`) must match. Anchor full-string (`^…$`).
- A bare tool-name pattern (no `:`) should match any call to that tool (treat `write_file` as `write_file:*`).
- No `any`: narrow `args` with a `typeof value === 'object' && value !== null` check before reading fields; cast through `Record<string, unknown>`.

## `tests/permissions.test.ts` requirements (vitest)
- `evaluate('read_file', {path:'a'}, 'safe')` → `'auto-allow'` (default); with `{autoAllowSafe:false}` → `'prompt'`.
- `evaluate('write_file', {path:'x'}, 'risky')` → `'prompt'`.
- `evaluate(..., 'dangerous')` → `'prompt'` (no remembered rule).
- After `remember('write_file:*', 'always-allow-pattern')`, `evaluate('write_file', {path:'x.txt'}, 'risky')` → `'auto-allow'`.
- After `remember('write_file:secret.txt', 'deny')`, that exact call → `'auto-deny'`, and deny **wins** even if a broader `'always-allow-pattern'` also matches.
- `remember(pattern, 'allow-once')` is a no-op (subsequent evaluate still `'prompt'`).
- A `'dangerous-bypass'` remembered for a pattern makes a matching `dangerous` call `'auto-allow'`.
- `matchesPattern` glob: `write_file:*` matches `write_file:anything`; `read_file:src/*` matches `read_file:src/a.ts` but not `read_file:lib/a.ts`.
- Determinism: same inputs → same output across repeated calls.

## Seam you EXPOSE / how it is consumed (do NOT build these consumers)
- **W7's `ToolExecutor` (different unit) owns the round-trip**, not you: it calls `policy.evaluate(name, args, risk)` BEFORE running a tool; on `'prompt'` it emits a `permission-open` event and awaits the user; on `'auto-deny'` it refuses to run. You provide ONLY the decision + the remembered-rule store.
- **W6 (Wave 3, different unit)** calls `policy.remember(pattern, decision)` when the user picks "always allow", then dispatches the resolution. You never see React or events.
- Keep this unit **headless and pure** — it must be fully testable with no UI and no I/O.

---
Respond with a SINGLE markdown document. For every file, a line `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.

## Gate (must pass)
```
cd /c/Users/Core/src/juno && npx tsc --noEmit && npx vitest run tests/permissions.test.ts
```
