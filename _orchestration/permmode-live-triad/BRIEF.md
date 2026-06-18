# BRIEF — Make juno's runtime permission-mode selector actually enforce

You are one of two independent writers. Produce a complete, correct implementation
for the unit below. You CANNOT browse the repo or ask questions — everything you
need is embedded here. Output only the document described in the OUTPUT CONTRACT at
the end.

## Problem

juno is a TypeScript/Ink terminal agent harness. It has a runtime permission-mode
selector (a command-palette entry) that lets the user switch between `'default'` and
`'acceptEdits'` permission modes. Today selecting a mode updates the status-line chip
and the reducer state (`turn.state.permissionMode`) — **but the live permission policy
never hears about it.** The policy is constructed ONCE at startup with a frozen mode
and a `readonly #mode` field. So choosing `acceptEdits` at runtime changes the display
but not enforcement: `write_file`/`edit_file` still prompt. The selector is cosmetic.

**Goal:** make the runtime mode flow into the live policy so it actually enforces,
WITHOUT regressing any of the existing, security-critical invariants. Changes take
effect mid-turn (the next tool-call's `evaluate` sees the new mode); this is intended.

## The pinned seam (FROZEN — both writers must match exactly)

Add ONE method to the `PermissionPolicy` interface and implement it:

```ts
setMode(mode: 'default' | 'acceptEdits'): void
```

`setMode` replaces the policy's current mode. It is the ONLY new public surface.
Do not add getters, events, or other methods. Do not change `evaluate`'s signature
or return type. Do not change `remember`.

## Exact current source (authoritative — edit these, do not invent paths)

### FILE: src/core/contracts.ts  (only the relevant interface, lines ~127-136)

```ts
/**
 * Permission gate (W8 implements). `evaluate` is a synchronous policy decision;
 * `'prompt'` means the coordinator must open the permission overlay and wait for
 * the user's interactive `PermissionDecision`. `remember` persists an
 * always-allow / bypass pattern for future `evaluate` calls.
 */
export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
}
```

`DefaultPermissionPolicy` in `src/permissions/policy.ts` is the ONLY implementor.

### FILE: src/permissions/policy.ts  (full current file)

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
  /** Permission mode. `acceptEdits` auto-allows write_file/edit_file by name. */
  mode?: 'default' | 'acceptEdits';
  /** Seed patterns to always-allow (stored as 'always-allow-pattern'). */
  allow?: ReadonlyArray<string>;
  /** Seed patterns to deny (stored as 'deny'). Seeded after `allow` so deny wins ties. */
  deny?: ReadonlyArray<string>;
}

/** Decisions that `remember` actually persists ('allow-once' is one-shot). */
type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

/**
 * Tool names that `acceptEdits` mode auto-allows. Deliberately a NAME set, not a
 * risk check: `spawn_subagent` is also `risk:'risky'`, but auto-allowing an
 * unattended nested agent turn is exactly what this gate exists to prevent.
 */
const ACCEPT_EDITS_TOOLS = new Set<string>(['write_file', 'edit_file']);

class DefaultPermissionPolicy implements PermissionPolicy {
  readonly #autoAllowSafe: boolean;
  readonly #mode: 'default' | 'acceptEdits';
  // normalizedPattern -> stored decision. Last write wins per pattern.
  readonly #rules = new Map<string, StoredDecision>();

  public constructor(opts?: PermissionPolicyOptions) {
    this.#autoAllowSafe = opts?.autoAllowSafe ?? true;
    this.#mode = opts?.mode ?? 'default';
    for (const entry of opts?.initial ?? []) {
      this.remember(entry.pattern, entry.decision);
    }
    // Seed allow FIRST, then deny, so a colliding normalized pattern ends up as
    // 'deny' (last-write-wins per key) and deny precedence is preserved even
    // before the evaluate-time scan enforces it.
    for (const pattern of opts?.allow ?? []) {
      this.remember(pattern, 'always-allow-pattern');
    }
    for (const pattern of opts?.deny ?? []) {
      this.remember(pattern, 'deny');
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

    // Order: deny wins over allow/bypass, which win over acceptEdits, which
    // wins over the risk fallback.
    if (matchedDeny) {
      return 'auto-deny';
    }
    if (matchedAllow) {
      return 'auto-allow';
    }

    // acceptEdits auto-allows ONLY the explicit name set, evaluated by tool
    // NAME — never by risk level. spawn_subagent is risky but NOT in the set.
    if (this.#mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(name)) {
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

### FILE: src/app.tsx  (the two relevant regions — DO NOT rewrite the whole file)

The policy lives on `deps.policy` (typed as `PermissionPolicy`). `turn.dispatch`
updates reducer state; `turn.state.permissionMode` is the current mode (a
`'default' | 'acceptEdits'`). `useEffect`, `useRef`, `useCallback` are already
imported in this file.

Region 1 — the existing config-seed effect (lines ~164-183):

```tsx
  // Seed the runtime permission mode from config ONCE so the status chip and the
  // palette selector reflect the configured value (reducer initialState hardcodes
  // 'default'). Additive: dispatches the additive set-permission-mode action.
  useEffect(() => {
    if (seededPermissionModeRef.current) {
      return;
    }
    seededPermissionModeRef.current = true;
    if (turn.state.permissionMode !== configuredPermissionMode) {
      turn.dispatch({ t: 'set-permission-mode', mode: configuredPermissionMode });
    }
  }, [configuredPermissionMode, turn]);

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: turn.state.permissionMode,
  });
```

Region 2 — the runtime selector accept callback (lines ~347-350):

```tsx
  const acceptPermissionMode = useCallback((): void => {
    turn.dispatch({ t: 'set-permission-mode', mode: selectedPermissionMode });
    closeOverlay();
  }, [closeOverlay, selectedPermissionMode, turn]);
```

`deps` is in scope in this component. `deps.policy` is the shared
`PermissionPolicy` instance constructed at startup (in `src/cli.ts`) and also
handed to the subagent tool, so syncing this one instance propagates to subagents.

### FILE: src/tools/subagentTool.ts  (confirmation only — do NOT edit)

The subagent tool stores `readonly policy: PermissionPolicy` and hands the SAME
instance to its child executor (`policy: deps.policy`). So mutating the single
shared policy via `setMode` automatically reaches subagents — no separate wiring.

### FILE: tests/permissions.mode.test.ts  (current — you will ADD to this)

The existing suite tests construction-time behavior only. Imports:
`import { createPermissionPolicy } from '../src/permissions/policy';`
It already asserts (construction-time): default prompts write_file; acceptEdits
auto-allows write_file/edit_file by name; **acceptEdits STILL prompts
spawn_subagent** (load-bearing); deny beats acceptEdits; deny beats allow.

## The three changes to implement

### Change A — `src/permissions/policy.ts`
1. Make `#mode` mutable: change `readonly #mode: 'default' | 'acceptEdits';` to a
   non-readonly private field (still typed `'default' | 'acceptEdits'`).
2. Add a public method `setMode(mode: 'default' | 'acceptEdits'): void` that
   assigns `this.#mode = mode;`. Nothing else.
3. `evaluate` is UNCHANGED — it already reads `this.#mode` at call time, so once
   the field is mutable the existing deny→allow→acceptEdits→risk order and the
   `ACCEPT_EDITS_TOOLS` name-set check at line ~98 just re-evaluate against the
   live value. Do not alter the order or the name set.

### Change B — `src/core/contracts.ts`
Add `setMode(mode: 'default' | 'acceptEdits'): void;` to the `PermissionPolicy`
interface (after `remember`). Update the interface doc comment with one line noting
`setMode` changes the live mode for subsequent `evaluate` calls.

### Change C — `src/app.tsx`
Add ONE new `useEffect` that mirrors reducer state into the live policy:
- Keyed on `[turn.state.permissionMode, deps.policy]` (or equivalent), it calls
  `deps.policy.setMode(turn.state.permissionMode)`.
- This single effect covers BOTH paths: the config-seed effect (Region 1) dispatches
  into state, and the runtime selector (Region 2) dispatches into state; both land in
  `turn.state.permissionMode`, and this mirror effect pushes that into the policy.
- Place it right AFTER the existing config-seed effect. Do NOT modify Region 1 or
  Region 2's logic; do NOT call `setMode` directly inside `acceptPermissionMode`
  (state stays the single source of truth; the mirror effect is the only writer to
  the policy mode). Show the surrounding ~5 lines of context so the synthesizer can
  place the insert unambiguously. Provide it as a focused snippet/patch, NOT a full
  rewrite of app.tsx.

### Change D — `tests/permissions.mode.test.ts`  (ADD a new describe block)
Add tests proving runtime mode changes enforce AND preserve every invariant:
1. Construct with default; `evaluate('write_file', {path:'a'}, 'risky')` → `'prompt'`;
   then `setMode('acceptEdits')`; same call → `'auto-allow'`. Same for `edit_file`.
2. After `setMode('acceptEdits')`, `evaluate('spawn_subagent', {path:''}, 'risky')`
   → STILL `'prompt'` (the load-bearing invariant must survive a runtime flip).
3. After `setMode('acceptEdits')`, a seeded deny still wins:
   `createPermissionPolicy({ deny: ['write_file:secret.txt'] })`, then
   `setMode('acceptEdits')`, `evaluate('write_file', {path:'secret.txt'}, 'risky')`
   → `'auto-deny'`; sibling `normal.txt` → `'auto-allow'`.
4. Round-trip: `setMode('acceptEdits')` then `setMode('default')` returns write_file
   to `'prompt'` (de-escalation works too).
5. After `setMode('acceptEdits')`, `evaluate('shell', {dir:'r'}, 'risky')` → still
   `'prompt'` (acceptEdits is a name-set, not a risk grant).

Keep tests in the same file, same import style, as new `describe(...)` blocks. Do
NOT modify or delete existing tests.

## Constraints
- TypeScript strict; must pass `tsc --noEmit` with zero errors and the full vitest
  suite (currently 323 passing) plus your new tests.
- Additive only. No behavior change to `default` mode. No new dependencies.
- Do NOT touch `src/cli.ts` (the startup construction stays; the policy still gets
  its initial `mode` there — the effect just keeps it in sync afterward).
- Do NOT change `evaluate`'s order, the `ACCEPT_EDITS_TOOLS` set, or `remember`.
- The `spawn_subagent`-always-prompts invariant is the single most important thing
  to preserve through a runtime flip. If your design could ever auto-allow
  spawn_subagent under acceptEdits, it is wrong.

## OUTPUT CONTRACT
Respond with a SINGLE markdown document. For every file you propose, put a line
`=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block
with the full file contents (for app.tsx, instead provide a clearly-marked focused
patch snippet with enough surrounding context to place it unambiguously — do NOT
paste the whole file). After all files, add a `=== NOTES ===` section (<200 words)
on key design choices and the seams you expose/consume. Do NOT write to the
filesystem — output only this document.
