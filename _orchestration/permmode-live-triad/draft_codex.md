=== FILE: src/core/contracts.ts ===
```ts
/**
 * Permission gate (W8 implements). `evaluate` is a synchronous policy decision;
 * `'prompt'` means the coordinator must open the permission overlay and wait for
 * the user's interactive `PermissionDecision`. `remember` persists an
 * always-allow / bypass pattern for future `evaluate` calls. `setMode` changes
 * the live mode for subsequent `evaluate` calls.
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

=== FILE: src/app.tsx ===
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

  useEffect(() => {
    deps.policy.setMode(turn.state.permissionMode);
  }, [deps.policy, turn.state.permissionMode]);

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: turn.state.permissionMode,
  });
```

=== FILE: tests/permissions.mode.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';

/*
 * Keep all existing tests in this file unchanged.
 * Add the describe block below to the existing suite.
 */

describe('runtime permission mode changes', () => {
  it('enforces acceptEdits for write_file and edit_file after a runtime flip', () => {
    const policy = createPermissionPolicy();

    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('prompt');
    expect(policy.evaluate('edit_file', { path: 'a' }, 'risky')).toBe('prompt');

    policy.setMode('acceptEdits');

    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('auto-allow');
    expect(policy.evaluate('edit_file', { path: 'a' }, 'risky')).toBe('auto-allow');
  });

  it('still prompts spawn_subagent after a runtime flip to acceptEdits', () => {
    const policy = createPermissionPolicy();

    policy.setMode('acceptEdits');

    expect(policy.evaluate('spawn_subagent', { path: '' }, 'risky')).toBe('prompt');
  });

  it('keeps deny precedence over acceptEdits after a runtime flip', () => {
    const policy = createPermissionPolicy({ deny: ['write_file:secret.txt'] });

    policy.setMode('acceptEdits');

    expect(policy.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
    expect(policy.evaluate('write_file', { path: 'normal.txt' }, 'risky')).toBe('auto-allow');
  });

  it('returns write_file to prompt when flipped back to default', () => {
    const policy = createPermissionPolicy();

    policy.setMode('acceptEdits');
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('auto-allow');

    policy.setMode('default');
    expect(policy.evaluate('write_file', { path: 'a' }, 'risky')).toBe('prompt');
  });

  it('does not treat acceptEdits as a general risky-tool grant', () => {
    const policy = createPermissionPolicy();

    policy.setMode('acceptEdits');

    expect(policy.evaluate('shell', { dir: 'r' }, 'risky')).toBe('prompt');
  });
});
```

=== NOTES ===

The only new public surface is `PermissionPolicy.setMode(mode)`. `DefaultPermissionPolicy` keeps all existing `evaluate` ordering intact: deny, remembered allow or bypass, acceptEdits name-set, then risk fallback. The mutable field is enough because `evaluate` already reads `#mode` at call time.

The app keeps reducer state as the source of truth. A single mirror effect after the config seed effect pushes `turn.state.permissionMode` into the shared live policy instance, covering both config initialization and command-palette changes. Since subagents receive the same `deps.policy` instance, no separate subagent wiring is needed.