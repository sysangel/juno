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

const ACCEPT_EDITS_TOOLS = new Set(['write_file', 'edit_file']);

export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
  /** Permission mode. Default: 'default'. */
  mode?: 'default' | 'acceptEdits';
  /** Seed allow patterns. Default: none. */
  allow?: ReadonlyArray<string>;
  /** Seed deny patterns. Default: none. */
  deny?: ReadonlyArray<string>;
}

/** Decisions that `remember` actually persists ('allow-once' is one-shot). */
type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

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

    // Order: deny wins over allow/bypass, which win over mode and risk fallback.
    if (matchedDeny) {
      return 'auto-deny';
    }
    if (matchedAllow) {
      return 'auto-allow';
    }
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

=== FILE: tests/permissions.mode.test.ts ===
```ts
// tests/permissions.mode.test.ts
// Mode and seeded allow/deny coverage for the headless permission policy.
import { describe, it, expect } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';

describe('createPermissionPolicy — permission modes', () => {
  it('keeps default mode risky write_file behavior unchanged', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('auto-allows write_file and edit_file under acceptEdits', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });

    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
    expect(p.evaluate('edit_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });

  it('still prompts spawn_subagent under acceptEdits even though it is risky', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });

    expect(p.evaluate('spawn_subagent', { task: 'nested' }, 'risky')).toBe(
      'prompt',
    );
  });

  it('does not auto-allow other risky tools under acceptEdits', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });

    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('prompt');
  });

  it('keeps safe and dangerous risk fallback behavior under acceptEdits', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });

    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('prompt');
  });

  it('respects autoAllowSafe false under acceptEdits', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      autoAllowSafe: false,
    });

    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('prompt');
  });
});

describe('createPermissionPolicy — seeded allow and deny', () => {
  it('lets seeded deny win over acceptEdits for write_file', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      deny: ['write_file:secret.txt'],
    });

    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe(
      'auto-deny',
    );
    expect(p.evaluate('write_file', { path: 'public.txt' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('auto-allows a matching seeded allow in default mode', () => {
    const p = createPermissionPolicy({
      allow: ['shell:repo'],
    });

    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('auto-allow');
  });

  it('auto-denies a matching seeded deny', () => {
    const p = createPermissionPolicy({
      deny: ['shell:repo'],
    });

    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('auto-deny');
  });

  it('lets seeded deny beat seeded allow for the same normalized pattern', () => {
    const p = createPermissionPolicy({
      allow: ['shell'],
      deny: ['shell'],
    });

    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('auto-deny');
  });
});
```

=== NOTES ===

The policy keeps the existing matcher path by seeding `allow` and `deny` through `remember`, so normalization and glob behavior stay centralized in `patterns.ts`. Constructor order is `initial`, then `allow`, then `deny`; the new lists therefore preserve deny last-write-wins for colliding seeded allow/deny patterns.

`acceptEdits` is intentionally checked by explicit tool name after remembered rules and before the existing risk switch. That keeps `spawn_subagent` and other risky tools prompting, while preserving default mode fallback behavior.