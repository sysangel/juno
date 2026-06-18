=== FILE: src/core/contracts.ts ===
```ts
/**
 * Permission gate (W8 implements). `evaluate` is a synchronous policy decision;
 * `'prompt'` means the coordinator must open the permission overlay and wait for
 * the user's interactive `PermissionDecision`. `remember` persists an
 * always-allow / bypass pattern for future `evaluate` calls. `setMode` changes
 * the live permission mode for subsequent `evaluate` calls (mid-turn flips are
 * intended and take effect on the next tool call).
 */
export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
  setMode(mode: 'default' | 'acceptEdits'): void;
}
```

=== FILE: src/permissions/policy.ts ===
```ts
// src/permissions/policy.ts
// W8 — Interactive, policy-driven permissions.
//
// Headless, pure, synchronous permission gate. Decides whether a tool call may
// run based on remembered rules and the call's risk level. The interactive
// prompt UI lives in a different unit (W4); this module never touches React,
// Ink, the filesystem, the clock, or any global. Only `remember` and `setMode`
// mutate state.

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
  #mode: 'default' | 'acceptEdits';
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

  public setMode(mode: 'default' | 'acceptEdits'): void {
    this.#mode = mode;
  }
}

/** Build a permission policy. Callers use this factory, not `new`. */
export function createPermissionPolicy(
  opts?: PermissionPolicyOptions,
): PermissionPolicy {
  return new DefaultPermissionPolicy(opts);
}
```

=== FILE: src/app.tsx (focused patch) ===
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

  // Mirror reducer state into the live permission policy so runtime mode flips
  // (config-seed dispatch above AND the palette selector's
  // `acceptPermissionMode` dispatch) actually reach enforcement. State stays the
  // single source of truth; this effect is the ONLY writer to the policy mode.
  // `deps.policy` is the shared instance also handed to the subagent tool, so a
  // flip here propagates to subagents automatically.
  useEffect(() => {
    deps.policy.setMode(turn.state.permissionMode);
  }, [turn.state.permissionMode, deps.policy]);

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: turn.state.permissionMode,
  });
```

=== FILE: tests/permissions.mode.test.ts (additions) ===
```ts
import { describe, expect, it } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';

// ... existing tests remain unchanged above this point ...

describe('runtime mode flips via setMode', () => {
  it('flips write_file from prompt to auto-allow after setMode(acceptEdits)', () => {
    const policy = createPermissionPolicy();
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('prompt');
    policy.setMode('acceptEdits');
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('auto-allow');
  });

  it('flips edit_file from prompt to auto-allow after setMode(acceptEdits)', () => {
    const policy = createPermissionPolicy();
    expect(policy.evaluate('edit_file', { path: 'a' }, 'risky')).toBe('prompt');
    policy.setMode('acceptEdits');
    expect(policy.evaluate('edit_file', { path: 'a' }, 'risky')).toBe('auto-allow');
  });

  it('still prompts spawn_subagent under acceptEdits after a runtime flip', () => {
    const policy = createPermissionPolicy();
    policy.setMode('acceptEdits');
    expect(policy.evaluate('spawn_subagent', { path: '' }, 'risky')).toBe('prompt');
  });

  it('seeded deny still wins over acceptEdits after a runtime flip', () => {
    const policy = createPermissionPolicy({ deny: ['write_file:secret.txt'] });
    policy.setMode('acceptEdits');
    expect(policy.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
    expect(policy.evaluate('write_file', { path: 'normal.txt' }, 'risky')).toBe('auto-allow');
  });

  it('round-trips: acceptEdits then default returns write_file to prompt', () => {
    const policy = createPermissionPolicy();
    policy.setMode('acceptEdits');
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('auto-allow');
    policy.setMode('default');
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('prompt');
  });

  it('does not grant risky non-edit tools under acceptEdits (shell)', () => {
    const policy = createPermissionPolicy();
    policy.setMode('acceptEdits');
    expect(policy.evaluate('shell', { dir: 'r' }, 'risky')).toBe('prompt');
  });
});
```

=== NOTES ===
Design choices: `#mode` is the only field made mutable; `setMode` is a trivial assignment so `evaluate`'s existing read-at-call-time path picks up the new value with zero ordering changes. The deny→allow→acceptEdits→risk precedence and the `ACCEPT_EDITS_TOOLS` name-set are untouched, so `spawn_subagent` can never be auto-allowed by a mode flip — it isn't in the set and isn't a risk grant. The interface gains exactly one method; no getters/events. In `app.tsx`, a single mirror effect keyed on `[turn.state.permissionMode, deps.policy]` is the sole writer to the policy mode, keeping reducer state as the single source of truth and covering both the config-seed dispatch and the palette-selector dispatch. Because `deps.policy` is the same shared instance handed to the subagent tool, the flip propagates to subagents with no extra wiring. Tests cover escalation, de-escalation, the spawn_subagent invariant, deny precedence, and the name-set (not risk) boundary.
