# TEAM BRIEF — W11: Optional account-policy startup assertion (`scripts/verify-openrouter-policy.ts`)

You are writing a **small, optional, clearly-labeled SECONDARY startup assertion** for a TypeScript + React + Ink terminal product called **`juno`**. Your unit is **W11**. It checks that the OpenRouter account looks correctly configured (no-train + Western-only). It is **NOT** the enforcement — privacy is enforced **ACCOUNT-SIDE** (project decision D2). This script is an optional, skippable convenience check that must **never** sit in the request hot path and must **never** be presented as enforcement. You CANNOT browse the filesystem — all needed context is inline.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**. **ESM only** (ESM `import`/`export`, no `require`). Use `node:`-prefixed builtins.
- **Run as a script:** it is invoked standalone via `tsx scripts/verify-openrouter-policy.ts` (the project uses `tsx`, no build step). It is NOT imported by the app at runtime and is NOT in any request path.
- **Tests:** vitest. Keep the script's checkable logic in a **pure exported function** so it can be unit-tested without the network or `process.exit`.
- **tsconfig:** `moduleResolution: "Bundler"`, `strict`, `target/lib ES2022`, `types: ["node"]`. No `any`; narrow `unknown`.
- **No new deps:** use Node 20's global `fetch` for any network call and `node:process` for argv/env/exit.

## The exact files you must write
1. `scripts/verify-openrouter-policy.ts` — the script.
2. `tests/verify-policy.test.ts` — a small vitest suite over the pure check function.

Self-contained: import ONLY Node builtins (`node:process`). Do NOT import from `src/` (avoid a hard coupling to W10; if you want to *optionally* surface settings, read env vars, not W10's service). Do NOT import React/Ink.

## What this script must do (minimal — do not over-build)
- Read configuration from the **environment** (no W10 import): primarily `OPENROUTER_API_KEY` (whether a key is present) and optional hints like `OPENROUTER_BASE_URL`. Accept a `--skip` flag and/or a `JUNO_SKIP_POLICY_CHECK=1` env var that makes it exit `0` immediately with a clear "skipped" message.
- Perform a **labeled assertion** that the account is configured for the data-secure posture. Concretely:
  - If no API key is present → print a clear NOTICE and exit **non-zero** (the account check cannot be performed). Message must state this is a SECONDARY check, NOT enforcement.
  - If a key is present → optionally call OpenRouter's account/key endpoint (`GET https://openrouter.ai/api/v1/key` or `/auth/key`, `Authorization: Bearer <key>`) to confirm the key resolves. Treat any network/parse failure **gracefully** (print a warning, exit non-zero) — never throw an unhandled error.
  - On a clean check, print a clear success line and exit `0`.
- **Output discipline:** every line is prefixed so it reads as a secondary, advisory check — e.g. `"[account-policy] (secondary, non-enforcing) ..."`. Never imply this gates requests.
- **Never read or print the API key value or any secret.** Only report presence/absence and the endpoint's coarse result.

## Structure (so it stays testable + never throws)
Export a PURE function that decides the outcome from already-gathered inputs, and a thin `main()` that does I/O and calls it:
```ts
export type PolicyOutcome =
  | { code: 0; status: 'ok' | 'skipped'; message: string }
  | { code: 1; status: 'unconfigured' | 'unverified'; message: string };

/** PURE: decide the outcome from gathered inputs. No I/O, no process.exit. */
export function evaluatePolicy(input: {
  skip: boolean;
  hasApiKey: boolean;
  /** Result of the optional remote key check: 'ok' | 'failed' | 'unchecked'. */
  remote: 'ok' | 'failed' | 'unchecked';
}): PolicyOutcome;

/** Thin I/O wrapper: read argv/env, optionally fetch, print, then process.exit(outcome.code). */
export async function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<void>;
```
- `evaluatePolicy`: `skip` → `{code:0,status:'skipped'}`. `!hasApiKey` → `{code:1,status:'unconfigured'}`. `hasApiKey && remote==='failed'` → `{code:1,status:'unverified'}`. `hasApiKey && (remote==='ok'||'unchecked')` → `{code:0,status:'ok'}`. Every message string must include the "secondary / not enforcement" framing.
- `main`: parse `--skip`/`JUNO_SKIP_POLICY_CHECK`, detect `hasApiKey` from env, do the optional `fetch` in a `try/catch` (set `remote` to `'ok'`/`'failed'`; `'unchecked'` if skipped or no fetch), print the outcome message, then `process.exit(outcome.code)`. Guard the auto-run so importing the module in a test does NOT trigger `main()` (e.g. only call `main()` when run as the entry, and keep it import-safe).

## `tests/verify-policy.test.ts` requirements (vitest)
- `evaluatePolicy({skip:true,...})` → `code 0`, `status 'skipped'`.
- `evaluatePolicy({skip:false, hasApiKey:false, remote:'unchecked'})` → `code 1`, `status 'unconfigured'`.
- `evaluatePolicy({skip:false, hasApiKey:true, remote:'failed'})` → `code 1`, `status 'unverified'`.
- `evaluatePolicy({skip:false, hasApiKey:true, remote:'ok'})` → `code 0`, `status 'ok'`.
- Every returned `message` is non-empty and contains a secondary/non-enforcement marker (assert on a substring like `'secondary'` or `'not enforcement'`).
- Importing the module must NOT call `process.exit` (i.e. `main` is not auto-invoked on import).

## Seam you EXPOSE / what consumes it
- **None as a library.** This is a standalone CLI script invoked by `npm`/startup or manually. Exits non-zero with a clear message if the account check can't be confirmed. It must NOT sit in the request hot path and must NOT be presented as enforcement (D2: privacy is account-side). Soft, optional coupling to settings is via ENV only — no import of W10.

---
Respond with a SINGLE markdown document. For every file, a line `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.
