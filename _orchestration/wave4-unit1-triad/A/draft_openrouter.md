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

=== FILE: tests/permissions.mode.test.ts ===
```ts
// tests/permissions.mode.test.ts
// W8 — vitest suite for the mode/allow/deny subset of the permission policy.
// Standalone so the existing permissions.test.ts suite stays untouched.
import { describe, it, expect } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';

describe('createPermissionPolicy — mode default (unchanged baseline)', () => {
  it('prompts risky write_file in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('prompts risky edit_file in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('edit_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('still auto-allows safe tools in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
  });

  it('omitting mode is identical to default', () => {
    const p = createPermissionPolicy();
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });
});

describe('createPermissionPolicy — mode acceptEdits', () => {
  it('auto-allows write_file by name', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('write_file', { path: 'a/b.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('auto-allows edit_file by name', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('edit_file', { path: 'a/b.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('STILL prompts spawn_subagent even though it is risky (load-bearing)', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('spawn_subagent', { path: '' }, 'risky')).toBe('prompt');
  });

  it('does NOT auto-allow other risky tools (e.g. shell)', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('prompt');
  });

  it('still auto-allows safe tools under acceptEdits', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
  });

  it('still prompts dangerous tools under acceptEdits with no bypass', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('prompt');
  });
});

describe('createPermissionPolicy — seeded allow', () => {
  it('auto-allows a matching risky call in default mode', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:src/*'],
    });
    expect(p.evaluate('write_file', { path: 'src/a.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('does not allow a non-matching path', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:src/*'],
    });
    expect(p.evaluate('write_file', { path: 'other/a.ts' }, 'risky')).toBe(
      'prompt',
    );
  });

  it('bare tool name in allow covers all paths for that tool', () => {
    const p = createPermissionPolicy({ mode: 'default', allow: ['edit_file'] });
    expect(p.evaluate('edit_file', { path: 'anywhere/x' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});

describe('createPermissionPolicy — seeded deny', () => {
  it('auto-denies a matching call', () => {
    const p = createPermissionPolicy({ deny: ['shell:*'] });
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe(
      'auto-deny',
    );
  });

  it('deny beats acceptEdits for write_file on a denied path', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      deny: ['write_file:secret.txt'],
    });
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe(
      'auto-deny',
    );
  });

  it('deny on one path does not block acceptEdits auto-allow on another', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      deny: ['write_file:secret.txt'],
    });
    expect(p.evaluate('write_file', { path: 'normal.txt' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});

describe('createPermissionPolicy — deny beats allow (collision)', () => {
  it('seeded deny wins over seeded allow for the same pattern', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:locked/*'],
      deny: ['write_file:locked/*'],
    });
    expect(p.evaluate('write_file', { path: 'locked/a.ts' }, 'risky')).toBe(
      'auto-deny',
    );
  });

  it('deny wins over allow even under acceptEdits', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      allow: ['write_file:*'],
      deny: ['write_file:forbidden.ts'],
    });
    expect(p.evaluate('write_file', { path: 'forbidden.ts' }, 'risky')).toBe(
      'auto-deny',
    );
    // sibling path still allowed via the seeded allow
    expect(p.evaluate('write_file', { path: 'ok.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});
```

=== NOTES ===
Design choices:
- **Name set, not risk check.** `ACCEPT_EDITS_TOOLS = new Set(['write_file','edit_file'])` is evaluated by tool NAME after the rule scan. This is the load-bearing guard: `spawn_subagent` is also `risk:'risky'` but is correctly NOT auto-allowed under `acceptEdits`.
- **Single matcher.** Seeded `allow`/`deny` reuse `remember`/`#rules`/`matchesPattern` — no second matcher. `allow`→`'always-allow-pattern'`, `deny`→`'deny'`.
- **Last-write-wins seeding.** Constructor seeds `initial`, then `allow`, then `deny`. A pattern present in both `allow` and `deny` ends up stored as `'deny'`, and the evaluate-time scan independently enforces deny-wins, so precedence holds even if a future caller reorders.
- **Evaluation order** is exactly: scan `#rules` → deny → allow → acceptEdits name-set → existing risk switch. The risk switch and exhaustive `never` discipline are byte-for-byte unchanged, so `default` mode is behaviorally identical to before.
- **Frozen seam preserved.** `PermissionPolicyOptions` adds only `mode`/`allow`/`deny`; `evaluate` still returns only `'auto-allow' | 'auto-deny' | 'prompt'`. Pure/synchronous; no fs/clock/random/React.
- **Tests** are isolated in a new file so the existing 265-line suite is untouched; the conductor can merge cleanly.
