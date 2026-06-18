=== FILE: src/permissions/patterns.ts ===
```ts
/**
 * Pure, deterministic pattern-matching helpers for the permission policy.
 *
 * No I/O, no side effects, no clock, no randomness. Total: never throws on
 * odd inputs.
 */

/**
 * Compute a stable match-key for a tool call. The key is `${name}:${salient}`
 * where `salient` is the `path` (or `dir` fallback) read from `args` when
 * `args` is a non-null object. Otherwise the salient portion is the empty
 * string.
 */
export function matchKey(name: string, args: unknown): string {
  let salient = '';
  if (typeof args === 'object' && args !== null) {
    const rec = args as Record<string, unknown>;
    const pathVal = rec['path'];
    const dirVal = rec['dir'];
    if (typeof pathVal === 'string') {
      salient = pathVal;
    } else if (typeof dirVal === 'string') {
      salient = dirVal;
    }
  }
  return `${name}:${salient}`;
}

/**
 * Glob match: `*` matches any run of characters. All other regex
 * metacharacters are escaped. The match is anchored to the full string.
 *
 * A bare tool-name pattern (no `:`) is treated as `tool:*` and matches any
 * call to that tool.
 */
export function matchesPattern(pattern: string, key: string): boolean {
  let p = pattern;
  if (!p.includes(':')) {
    p = `${p}:*`;
  }

  let body = '';
  for (const ch of p) {
    if (ch === '*') {
      body += '.*';
    } else if (isRegexMeta(ch)) {
      body += '\\' + ch;
    } else {
      body += ch;
    }
  }

  const re = new RegExp(`^${body}$`);
  return re.test(key);
}

function isRegexMeta(ch: string): boolean {
  return /[.*+?^${}()|[\]\\]/.test(ch);
}
```

=== FILE: src/permissions/policy.ts ===
```ts
/**
 * W8 — Interactive, policy-driven permissions.
 *
 * Headless, pure, synchronous permission gate. Decides whether a tool call
 * may run based on remembered rules and the call's risk level. The
 * interactive prompt UI lives in a different unit; this module never touches
 * React, Ink, the filesystem, or the clock.
 */

import type { PermissionPolicy, PermissionPolicyOptions } from '../core/contracts';
import type { RiskLevel, PermissionDecision } from '../core/events';
import { matchKey, matchesPattern } from './patterns';

/**
 * Factory for the permission policy. Does not require `new`.
 */
export function createPermissionPolicy(opts?: PermissionPolicyOptions): PermissionPolicy {
  const autoAllowSafe = opts?.autoAllowSafe ?? true;

  // pattern -> decision. Last write wins per pattern.
  const rules = new Map<string, PermissionDecision>();

  if (opts?.initial) {
    for (const entry of opts.initial) {
      // 'allow-once' is one-shot and never persisted.
      if (entry.decision === 'allow-once') continue;
      rules.set(entry.pattern, entry.decision);
    }
  }

  const evaluate = (
    name: string,
    args: unknown,
    risk: RiskLevel,
  ): 'auto-allow' | 'auto-deny' | 'prompt' => {
    const key = matchKey(name, args);

    let matchedDeny = false;
    let matchedAllow = false;

    for (const [pattern, decision] of rules) {
      if (!matchesPattern(pattern, key)) continue;
      switch (decision) {
        case 'deny':
          matchedDeny = true;
          break;
        case 'always-allow-pattern':
        case 'dangerous-bypass':
          matchedAllow = true;
          break;
        case 'allow-once':
          // Never persisted; defensive no-op.
          break;
        // exhaustive over PermissionDecision
      }
    }

    // Deny is the safe default and wins over any allow/bypass.
    if (matchedDeny) return 'auto-deny';
    if (matchedAllow) return 'auto-allow';

    // Risk fallback.
    switch (risk) {
      case 'safe':
        return autoAllowSafe ? 'auto-allow' : 'prompt';
      case 'risky':
        return 'prompt';
      case 'dangerous':
        return 'prompt';
    }
  };

  const remember = (pattern: string, decision: PermissionDecision): void => {
    // 'allow-once' is a one-shot UI decision; never stored as a rule.
    if (decision === 'allow-once') return;
    rules.set(pattern, decision);
  };

  return { evaluate, remember };
}
```

=== FILE: tests/permissions.test.ts ===
```ts
import { describe, it, expect } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';
import { matchKey, matchesPattern } from '../src/permissions/patterns';

describe('createPermissionPolicy — evaluate', () => {
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
    expect(p.evaluate('rm', { path: 'x' }, 'dangerous')).toBe('prompt');
  });

  it('remembered always-allow-pattern auto-allows matching risky call', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe('auto-allow');
  });

  it('remembered deny wins over broader always-allow-pattern', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'always-allow-pattern');
    p.remember('write_file:secret.txt', 'deny');
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
  });

  it('remembered deny does not affect non-matching calls', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:secret.txt', 'deny');
    expect(p.evaluate('write_file', { path: 'other.txt' }, 'risky')).toBe('prompt');
  });

  it('allow-once is a no-op when remembered', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'allow-once');
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('dangerous-bypass pre-grants a matching dangerous call', () => {
    const p = createPermissionPolicy();
    p.remember('rm:*', 'dangerous-bypass');
    expect(p.evaluate('rm', { path: 'x' }, 'dangerous')).toBe('auto-allow');
  });

  it('dangerous-bypass does not grant non-matching calls', () => {
    const p = createPermissionPolicy();
    p.remember('rm:specific', 'dangerous-bypass');
    expect(p.evaluate('rm', { path: 'other' }, 'dangerous')).toBe('prompt');
  });

  it('re-calling remember with same pattern updates decision (last write wins)', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'deny');
    p.remember('write_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });

  it('seeds remembered rules from initial option', () => {
    const p = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'always-allow-pattern' }],
    });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });

  it('initial allow-once entries are ignored', () => {
    const p = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'allow-once' }],
    });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('is deterministic across repeated calls', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'always-allow-pattern');
    for (let i = 0; i < 5; i++) {
      expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
    }
  });

  it('bare tool-name pattern matches any call to that tool', () => {
    const p = createPermissionPolicy();
    p.remember('write_file', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'anything.txt' }, 'risky')).toBe('auto-allow');
  });
});

describe('patterns — matchKey', () => {
  it('uses args.path when present', () => {
    expect(matchKey('write_file', { path: 'a.txt' })).toBe('write_file:a.txt');
  });

  it('falls back to args.dir when path absent', () => {
    expect(matchKey('ls', { dir: 'src' })).toBe('ls:src');
  });

  it('prefers path over dir', () => {
    expect(matchKey('x', { path: 'p', dir: 'd' })).toBe('x:p');
  });

  it('returns empty salient for null args', () => {
    expect(matchKey('x', null)).toBe('x:');
  });

  it('returns empty salient for undefined args', () => {
    expect(matchKey('x', undefined)).toBe('x:');
  });

  it('returns empty salient for non-object args', () => {
    expect(matchKey('x', 'str')).toBe('x:');
    expect(matchKey('x', 42)).toBe('x:');
  });

  it('returns empty salient when path/dir are not strings', () => {
    expect(matchKey('x', { path: 123 })).toBe('x:');
    expect(matchKey('x', { dir: true })).toBe('x:');
  });
});

describe('patterns — matchesPattern', () => {
  it('write_file:* matches write_file:anything', () => {
    expect(matchesPattern('write_file:*', 'write_file:anything')).toBe(true);
  });

  it('read_file:src/* matches read_file:src/a.ts', () => {
    expect(matchesPattern('read_file:src/*', 'read_file:src/a.ts')).toBe(true);
  });

  it('read_file:src/* does not match read_file:lib/a.ts', () => {
    expect(matchesPattern('read_file:src/*', 'read_file:lib/a.ts')).toBe(false);
  });

  it('exact pattern matches exact key', () => {
    expect(matchesPattern('write_file:secret.txt', 'write_file:secret.txt')).toBe(true);
  });

  it('exact pattern does not match different key', () => {
    expect(matchesPattern('write_file:secret.txt', 'write_file:other.txt')).toBe(false);
  });

  it('bare tool name matches any call to that tool', () => {
    expect(matchesPattern('write_file', 'write_file:anything')).toBe(true);
    expect(matchesPattern('write_file', 'write_file:')).toBe(true);
  });

  it('escapes regex metacharacters in pattern', () => {
    expect(matchesPattern('read_file:a.b.ts', 'read_file:a.b.ts')).toBe(true);
    expect(matchesPattern('read_file:a.b.ts', 'read_file:axbxts')).toBe(false);
  });

  it('anchored: pattern does not partially match', () => {
    expect(matchesPattern('write_file:secret', 'write_file:secret-extra')).toBe(false);
  });
});
```

=== NOTES ===
- `patterns.ts` is total: `matchKey` narrows `args` via `typeof === 'object' && !== null` before reading fields through `Record<string, unknown>`; never throws.
- `matchesPattern` translates `*`→`.*`, escapes all other regex metachars, anchors `^…$`, and treats bare tool names as `tool:*`.
- `policy.ts` consults all remembered rules per call: any matching `deny` wins (`auto-deny`); else any matching `always-allow-pattern`/`dangerous-bypass` yields `auto-allow`; else risk fallback (`safe`→auto-allow unless `autoAllowSafe:false`; `risky`/`dangerous`→`prompt`).
- `remember` ignores `allow-once` (one-shot, UI-only). Same-pattern re-calls overwrite (Map semantics). `initial` seeds the store, also skipping `allow-once`.
- Exhaustive switches over `PermissionDecision` and `RiskLevel` satisfy `noFallthroughCasesInSwitch` and strict control-flow. No `any`, no I/O, no React/Ink — fully headless and deterministic.
