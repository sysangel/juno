# Triad Brief A — juno permission policy: add `mode` + seeded `allow`/`deny`

You are writing a focused, correct change to a TypeScript module in the **juno**
terminal-agent codebase. Output the FULL new contents of two files. You CANNOT
browse the repo — everything you need is in this brief.

## Context
- juno is a TS/Ink agent. `src/permissions/policy.ts` is a **headless, pure,
  synchronous** permission gate: no React/Ink, no fs, no clock, no randomness.
- tsconfig: `strict:true`, `exactOptionalPropertyTypes` OFF, `noUncheckedIndexedAccess` OFF.
- Gate that must pass: `npx tsc --noEmit && npx vitest run` (vitest, not jest).
- Scope: add a lean "permission mode" subset. Modes are `default` + `acceptEdits`
  ONLY. Rules are deny + allow only. This module change is config-agnostic — it just
  accepts new options; a different unit wires config→these options.

## Task
1. Extend `PermissionPolicyOptions` and the policy implementation in
   `src/permissions/policy.ts` to support a `mode` plus seeded `allow`/`deny`
   pattern lists.
2. ADD tests to `tests/permissions.test.ts` (append new `describe` blocks; keep ALL
   existing tests unchanged — output the full file with your additions appended).

## Frozen seam (do NOT change the shape)
```ts
export interface PermissionPolicyOptions {
  autoAllowSafe?: boolean;                                                    // existing
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>; // existing
  // NEW:
  mode?: 'default' | 'acceptEdits';
  allow?: ReadonlyArray<string>;
  deny?: ReadonlyArray<string>;
}
```
`evaluate(name, args, risk)` MUST keep returning ONLY `'auto-allow' | 'auto-deny' | 'prompt'`. No new return value.

## MANDATORY correctness invariants (the entire point — get these exactly right)
1. **`acceptEdits` is an explicit tool-NAME allow-set `{ 'write_file', 'edit_file' }`,
   evaluated BEFORE the risk switch.** Under `mode==='acceptEdits'`, a call to
   `write_file` or `edit_file` auto-allows; a call to ANY other tool does NOT get the
   acceptEdits auto-allow. CRITICAL: `write_file`, `edit_file`, AND `spawn_subagent`
   are ALL `risk:'risky'`. A naive "acceptEdits ⇒ auto-allow anything risky" would
   silently auto-allow `spawn_subagent` (an unattended nested agent turn) — that is
   the bug this unit exists to prevent. Use the name Set, never the risk level.
2. **deny-wins precedence**, ahead of allow and ahead of `acceptEdits`. A matching
   `deny` rule returns `'auto-deny'` even under `acceptEdits` and even for
   `write_file`/`edit_file`.
3. **Evaluation order in `evaluate`:** scan `#rules` → if any deny matched return
   `'auto-deny'` → else if any allow matched return `'auto-allow'` → else if
   `mode==='acceptEdits'` AND name is in the allow-set return `'auto-allow'` → else
   fall through to the EXISTING risk switch unchanged.
4. **Seeding:** seeded `allow` entries are remembered as `'always-allow-pattern'`;
   seeded `deny` entries as `'deny'`, reusing the existing `remember`/`#rules`/
   `matchesPattern` machinery (do NOT add a second matcher). In the constructor, seed
   `allow` FIRST, then `deny`, so that if the same normalized pattern appears in both
   lists the deny overwrites (last-write-wins per key) and deny still wins.
5. `default` mode must be byte-for-byte behaviorally identical to today.
6. Keep it pure/synchronous; keep the existing exhaustive `switch` discipline
   (`const exhaustive: never = ...`) intact. Add a `readonly #mode` private field.
   Define the allow-set as a module-level `const ACCEPT_EDITS_TOOLS = new Set([...])`.

## CURRENT FULL CONTENTS of `src/permissions/policy.ts`
```ts
// src/permissions/policy.ts
// W8 — Interactive, policy-driven permissions.
//
// Headless, pure, synchronous permission gate. Decides whether a tool call may
// run based on remembered rules and the call's risk level. The interactive
// prompt UI lives in a different unit (W4); this module never touches React,
// Ink, the filesystem, the clock, or any global. Only `remember` mutates state.

import type { PermissionPolicy } from '../core/contracts';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { matchKey, matchesPattern, normalizePattern } from './patterns';

export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
}

/** Decisions that `remember` actually persists ('allow-once' is one-shot). */
type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

class DefaultPermissionPolicy implements PermissionPolicy {
  readonly #autoAllowSafe: boolean;
  // normalizedPattern -> stored decision. Last write wins per pattern.
  readonly #rules = new Map<string, StoredDecision>();

  public constructor(opts?: PermissionPolicyOptions) {
    this.#autoAllowSafe = opts?.autoAllowSafe ?? true;
    for (const entry of opts?.initial ?? []) {
      this.remember(entry.pattern, entry.decision);
    }
  }

  public evaluate(
    name: string,
    args: unknown,
    risk: RiskLevel,
  ): 'auto-allow' | 'auto-deny' | 'prompt' {
    const key = matchKey(name, args);

    let matchedDeny = false;
    let matchedAllow = false;
    for (const [pattern, decision] of this.#rules) {
      if (!matchesPattern(pattern, key)) {
        continue;
      }
      switch (decision) {
        case 'deny':
          matchedDeny = true;
          break;
        case 'always-allow-pattern':
        case 'dangerous-bypass':
          matchedAllow = true;
          break;
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    }

    // Order: deny wins over allow/bypass, which win over the risk fallback.
    if (matchedDeny) {
      return 'auto-deny';
    }
    if (matchedAllow) {
      return 'auto-allow';
    }

    switch (risk) {
      case 'safe':
        return this.#autoAllowSafe ? 'auto-allow' : 'prompt';
      case 'risky':
        return 'prompt';
      case 'dangerous':
        // Never silently auto-allowed by risk alone — only an explicit
        // remembered bypass (handled above) pre-grants a dangerous call.
        return 'prompt';
      default: {
        const exhaustive: never = risk;
        return exhaustive;
      }
    }
  }

  public remember(pattern: string, decision: PermissionDecision): void {
    switch (decision) {
      case 'allow-once':
        // One-shot UI decision; never persisted as a rule.
        return;
      case 'deny':
      case 'always-allow-pattern':
      case 'dangerous-bypass':
        this.#rules.set(normalizePattern(pattern), decision);
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }
}

/** Build a permission policy. Callers use this factory, not `new`. */
export function createPermissionPolicy(
  opts?: PermissionPolicyOptions,
): PermissionPolicy {
  return new DefaultPermissionPolicy(opts);
}
```

## Reference: `PermissionDecision` and `RiskLevel` (from src/core/events.ts — do not redefine)
```ts
type PermissionDecision = 'allow-once' | 'always-allow-pattern' | 'dangerous-bypass' | 'deny';
type RiskLevel = 'safe' | 'risky' | 'dangerous';
```
`PermissionPolicy` (from src/core/contracts.ts) requires `evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt'` and `remember(pattern: string, decision: PermissionDecision): void`.

## Reference: pattern helpers (from src/permissions/patterns.ts — already exist, import them, do NOT rewrite)
- `matchKey(name, args)` → `"${name}:${salientPath(args)}"` where salient = args.path ?? args.dir ?? "".
- `normalizePattern(pattern)` → appends `:*` to a bare tool name.
- `matchesPattern(pattern, key)` → anchored glob, `*` = any run incl. newlines.

## Test requirements (append to tests/permissions.test.ts; keep existing tests verbatim)
Use vitest (`import { describe, it, expect } from 'vitest'`). Cover at minimum:
- `default` mode unchanged: `write_file` risky still `'prompt'`.
- `acceptEdits`: `write_file` ⇒ `'auto-allow'`; `edit_file` ⇒ `'auto-allow'`.
- **`acceptEdits` STILL prompts `spawn_subagent`** (risk:'risky') — the load-bearing test ⇒ `'prompt'`.
- `acceptEdits` does NOT auto-allow some other risky tool (e.g. `shell` risky) ⇒ `'prompt'`.
- deny wins under acceptEdits: a seeded `deny` of `write_file:secret.txt` ⇒ `write_file` on that path is `'auto-deny'` even in acceptEdits; a different path under acceptEdits is `'auto-allow'`.
- seeded `allow` auto-allows a matching risky call in `default` mode.
- seeded `deny` auto-denies a matching call.
- seeded deny beats seeded allow for the same call (both lists contain the colliding pattern).
- safe tools under acceptEdits still auto-allow; mode does not change safe/dangerous handling otherwise.

## CURRENT FULL CONTENTS of `tests/permissions.test.ts` (append your new describe blocks at the END; reproduce the rest verbatim)
```ts
// tests/permissions.test.ts
// W8 — vitest suite for the headless permission policy + pattern helpers.
import { describe, it, expect } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';
import { matchKey, matchesPattern, normalizePattern } from '../src/permissions/patterns';

describe('createPermissionPolicy — risk fallback (no remembered rules)', () => {
  it('auto-allows safe tools by default', () => {
    const p = createPermissionPolicy();
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
  });

  it('prompts safe tools when autoAllowSafe is false', () => {
    const p = createPermissionPolicy({ autoAllowSafe: false });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('prompt');
  });

  it('prompts risky tools', () => {
    const p = createPermissionPolicy();
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('prompts dangerous tools with no remembered rule', () => {
    const p = createPermissionPolicy();
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('prompt');
  });
});
// ... (the file continues with: remembered rules, remember() semantics, initial
// seeding, determinism, patterns matchKey/normalizePattern/matchesPattern, and
// deny-evasion + scoping hardening describe blocks). REPRODUCE THE ENTIRE EXISTING
// FILE VERBATIM, then APPEND your new describe block(s) for the mode/allow/deny
// behavior at the very end. The existing file has these exact describe titles you
// must preserve in order:
//   'createPermissionPolicy — risk fallback (no remembered rules)'
//   'createPermissionPolicy — remembered rules'
//   'createPermissionPolicy — remember() semantics'
//   'createPermissionPolicy — initial seeding'
//   'createPermissionPolicy — determinism'
//   'patterns — matchKey'
//   'patterns — normalizePattern'
//   'patterns — matchesPattern'
//   'createPermissionPolicy — deny-evasion + scoping hardening'
```
NOTE: You only have the first describe block above. To avoid corrupting the file,
**emit your additions as a SEPARATE new file** `tests/permissions.mode.test.ts`
instead of editing the existing file. That keeps the existing 265-line suite
untouched and lets the conductor merge cleanly. Import from
`'../src/permissions/policy'`.

## Output contract (FOLLOW EXACTLY)
Respond with a SINGLE markdown document. For every file you propose, put a line
`=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block
with the full file contents. After all files, add a `=== NOTES ===` section
(<200 words) on key design choices and the seams you expose/consume. Do NOT write
to the filesystem — output only this document.

Files you must output:
1. `=== FILE: src/permissions/policy.ts ===` — full new contents.
2. `=== FILE: tests/permissions.mode.test.ts ===` — a NEW standalone vitest file with the mode/allow/deny tests.
