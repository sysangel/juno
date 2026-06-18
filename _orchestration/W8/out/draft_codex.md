=== FILE: src/permissions/policy.ts ===
```ts
import type { PermissionPolicy } from '../core/contracts';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { matchKey, normalizePattern, matchesPattern } from './patterns';

export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
}

type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

interface Rule {
  readonly pattern: string;
  readonly decision: StoredDecision;
}

class DefaultPermissionPolicy implements PermissionPolicy {
  readonly #autoAllowSafe: boolean;
  readonly #rules = new Map<string, Rule>();

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
    const matchingRules = [...this.#rules.values()].filter((rule) =>
      matchesPattern(rule.pattern, key),
    );

    if (matchingRules.some((rule) => rule.decision === 'deny')) {
      return 'auto-deny';
    }

    if (
      matchingRules.some(
        (rule) =>
          rule.decision === 'always-allow-pattern' ||
          rule.decision === 'dangerous-bypass',
      )
    ) {
      return 'auto-allow';
    }

    switch (risk) {
      case 'safe':
        return this.#autoAllowSafe ? 'auto-allow' : 'prompt';
      case 'risky':
      case 'dangerous':
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
        return;
      case 'deny':
      case 'always-allow-pattern':
      case 'dangerous-bypass': {
        const normalizedPattern = normalizePattern(pattern);
        this.#rules.set(normalizedPattern, {
          pattern: normalizedPattern,
          decision,
        });
        return;
      }
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }
}

export function createPermissionPolicy(
  opts?: PermissionPolicyOptions,
): PermissionPolicy {
  return new DefaultPermissionPolicy(opts);
}
```

=== FILE: src/permissions/patterns.ts ===
```ts
export function matchKey(name: string, args: unknown): string {
  return `${name}:${salientPath(args)}`;
}

export function normalizePattern(pattern: string): string {
  return pattern.includes(':') ? pattern : `${pattern}:*`;
}

export function matchesPattern(pattern: string, key: string): boolean {
  const normalizedPattern = normalizePattern(pattern);

  if (normalizedPattern === key) {
    return true;
  }

  const source = normalizedPattern
    .split('*')
    .map(escapeRegExp)
    .join('.*');

  return new RegExp(`^${source}$`).test(key);
}

function salientPath(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }

  try {
    const record = args as Record<string, unknown>;
    const value = record.path ?? record.dir ?? '';

    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
```

=== FILE: tests/permissions.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';
import { matchesPattern } from '../src/permissions/patterns';

describe('permission policy', () => {
  it('auto-allows safe tools by default', () => {
    const policy = createPermissionPolicy();

    expect(policy.evaluate('read_file', { path: 'a' }, 'safe')).toBe(
      'auto-allow',
    );
  });

  it('prompts for safe tools when autoAllowSafe is false', () => {
    const policy = createPermissionPolicy({ autoAllowSafe: false });

    expect(policy.evaluate('read_file', { path: 'a' }, 'safe')).toBe('prompt');
  });

  it('prompts for risky tools without remembered rules', () => {
    const policy = createPermissionPolicy();

    expect(policy.evaluate('write_file', { path: 'x' }, 'risky')).toBe(
      'prompt',
    );
  });

  it('prompts for dangerous tools without remembered rules', () => {
    const policy = createPermissionPolicy();

    expect(policy.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe(
      'prompt',
    );
  });

  it('auto-allows matching remembered always-allow patterns', () => {
    const policy = createPermissionPolicy();

    policy.remember('write_file:*', 'always-allow-pattern');

    expect(policy.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('auto-denies exact remembered deny patterns', () => {
    const policy = createPermissionPolicy();

    policy.remember('write_file:secret.txt', 'deny');

    expect(
      policy.evaluate('write_file', { path: 'secret.txt' }, 'risky'),
    ).toBe('auto-deny');
  });

  it('gives deny precedence over broader allow patterns', () => {
    const policy = createPermissionPolicy();

    policy.remember('write_file:*', 'always-allow-pattern');
    policy.remember('write_file:secret.txt', 'deny');

    expect(
      policy.evaluate('write_file', { path: 'secret.txt' }, 'risky'),
    ).toBe('auto-deny');
  });

  it('ignores allow-once remembered decisions', () => {
    const policy = createPermissionPolicy();

    policy.remember('write_file:*', 'allow-once');

    expect(policy.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(
      'prompt',
    );
  });

  it('auto-allows dangerous calls with remembered dangerous bypass', () => {
    const policy = createPermissionPolicy();

    policy.remember('shell:*', 'dangerous-bypass');

    expect(policy.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe(
      'auto-allow',
    );
  });

  it('matches simple glob patterns', () => {
    expect(matchesPattern('write_file:*', 'write_file:anything')).toBe(true);
    expect(matchesPattern('read_file:src/*', 'read_file:src/a.ts')).toBe(true);
    expect(matchesPattern('read_file:src/*', 'read_file:lib/a.ts')).toBe(false);
  });

  it('is deterministic for repeated evaluations', () => {
    const policy = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'always-allow-pattern' }],
    });

    const first = policy.evaluate('write_file', { path: 'x.txt' }, 'risky');

    expect(policy.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(
      first,
    );
    expect(policy.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(
      first,
    );
  });
});
```

=== NOTES ===
This is headless, synchronous, and deterministic. `allow-once` is ignored by `remember`, repeated writes update by normalized pattern, bare tool patterns normalize to `tool:*`, and deny precedence is enforced independently of insertion order.