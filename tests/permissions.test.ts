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

describe('createPermissionPolicy — remembered rules', () => {
  it('remembered always-allow-pattern auto-allows a matching risky call', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe('auto-allow');
  });

  it('auto-denies an exact remembered deny pattern', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:secret.txt', 'deny');
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
  });

  it('deny wins over a broader always-allow-pattern (order-independent)', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'always-allow-pattern');
    p.remember('write_file:secret.txt', 'deny');
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
  });

  it('deny still wins when the deny rule is added FIRST', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:secret.txt', 'deny');
    p.remember('write_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
  });

  it('a remembered deny does not affect non-matching calls', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:secret.txt', 'deny');
    expect(p.evaluate('write_file', { path: 'other.txt' }, 'risky')).toBe('prompt');
  });

  it('dangerous-bypass pre-grants a matching dangerous call', () => {
    const p = createPermissionPolicy();
    p.remember('shell:*', 'dangerous-bypass');
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('auto-allow');
  });

  it('dangerous-bypass does not grant non-matching calls', () => {
    const p = createPermissionPolicy();
    p.remember('shell:specific', 'dangerous-bypass');
    expect(p.evaluate('shell', { dir: 'other' }, 'dangerous')).toBe('prompt');
  });

  it('a bare tool-name pattern matches any call to that tool', () => {
    const p = createPermissionPolicy();
    p.remember('write_file', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'anything.txt' }, 'risky')).toBe('auto-allow');
  });
});

describe('createPermissionPolicy — remember() semantics', () => {
  it('ignores allow-once when remembered (subsequent evaluate still prompts)', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'allow-once');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe('prompt');
  });

  it('re-calling remember with the same pattern updates the decision (last write wins)', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'deny');
    p.remember('write_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });

  it('treats a bare pattern and its tool:* form as the SAME pattern (overwrites)', () => {
    const p = createPermissionPolicy();
    p.remember('write_file', 'deny');
    p.remember('write_file:*', 'always-allow-pattern');
    // Both normalize to 'write_file:*', so the second call overwrites the first.
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });
});

describe('createPermissionPolicy — initial seeding', () => {
  it('seeds remembered rules from the initial option', () => {
    const p = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'always-allow-pattern' }],
    });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
  });

  it('skips allow-once entries when seeding from initial', () => {
    const p = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'allow-once' }],
    });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('seeds a deny that wins over a later allow seed for the same call', () => {
    const p = createPermissionPolicy({
      initial: [
        { pattern: 'write_file:*', decision: 'always-allow-pattern' },
        { pattern: 'write_file:secret.txt', decision: 'deny' },
      ],
    });
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe('auto-deny');
  });
});

describe('createPermissionPolicy — determinism', () => {
  it('returns the same decision across repeated calls', () => {
    const p = createPermissionPolicy({
      initial: [{ pattern: 'write_file:*', decision: 'always-allow-pattern' }],
    });
    const first = p.evaluate('write_file', { path: 'x.txt' }, 'risky');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(first);
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe(first);
    expect(first).toBe('auto-allow');
  });
});

describe('patterns — matchKey', () => {
  it('uses args.path when present', () => {
    expect(matchKey('write_file', { path: 'a.txt' })).toBe('write_file:a.txt');
  });

  it('falls back to args.dir when path is absent', () => {
    expect(matchKey('list_files', { dir: 'src' })).toBe('list_files:src');
  });

  it('prefers path over dir', () => {
    expect(matchKey('x', { path: 'p', dir: 'd' })).toBe('x:p');
  });

  it('returns an empty salient for null args', () => {
    expect(matchKey('x', null)).toBe('x:');
  });

  it('returns an empty salient for undefined args', () => {
    expect(matchKey('x', undefined)).toBe('x:');
  });

  it('returns an empty salient for non-object args', () => {
    expect(matchKey('x', 'str')).toBe('x:');
    expect(matchKey('x', 42)).toBe('x:');
  });

  it('returns an empty salient when path/dir are not strings', () => {
    expect(matchKey('x', { path: 123 })).toBe('x:');
    expect(matchKey('x', { dir: true })).toBe('x:');
  });

  it('does not throw on exotic args (arrays, functions)', () => {
    expect(matchKey('x', [1, 2, 3])).toBe('x:');
    expect(matchKey('x', () => undefined)).toBe('x:');
  });
});

describe('patterns — normalizePattern', () => {
  it('leaves a pattern containing ":" unchanged', () => {
    expect(normalizePattern('write_file:secret.txt')).toBe('write_file:secret.txt');
  });

  it('appends ":*" to a bare tool-name pattern', () => {
    expect(normalizePattern('write_file')).toBe('write_file:*');
  });
});

describe('patterns — matchesPattern', () => {
  it('write_file:* matches write_file:anything', () => {
    expect(matchesPattern('write_file:*', 'write_file:anything')).toBe(true);
  });

  it('read_file:src/* matches read_file:src/a.ts', () => {
    expect(matchesPattern('read_file:src/*', 'read_file:src/a.ts')).toBe(true);
  });

  it('read_file:src/* does NOT match read_file:lib/a.ts', () => {
    expect(matchesPattern('read_file:src/*', 'read_file:lib/a.ts')).toBe(false);
  });

  it('an exact pattern matches its exact key', () => {
    expect(matchesPattern('write_file:secret.txt', 'write_file:secret.txt')).toBe(true);
  });

  it('an exact pattern does not match a different key', () => {
    expect(matchesPattern('write_file:secret.txt', 'write_file:other.txt')).toBe(false);
  });

  it('a bare tool name matches any call to that tool', () => {
    expect(matchesPattern('write_file', 'write_file:anything')).toBe(true);
    expect(matchesPattern('write_file', 'write_file:')).toBe(true);
  });

  it('escapes regex metacharacters in the pattern (dots are literal)', () => {
    expect(matchesPattern('read_file:a.b.ts', 'read_file:a.b.ts')).toBe(true);
    expect(matchesPattern('read_file:a.b.ts', 'read_file:axbxts')).toBe(false);
  });

  it('is anchored: a pattern does not partially match a longer key', () => {
    expect(matchesPattern('write_file:secret', 'write_file:secret-extra')).toBe(false);
  });

  it('supports a mid-string wildcard', () => {
    expect(matchesPattern('read_file:src/*/index.ts', 'read_file:src/ui/index.ts')).toBe(true);
    expect(matchesPattern('read_file:src/*/index.ts', 'read_file:src/ui/main.ts')).toBe(false);
  });

  it('* matches across line terminators (deny-evasion hardening)', () => {
    // A bare '.*' would stop at '\n'; '[\s\S]*' must cross it so a
    // `deny tool:*` rule cannot be evaded by a path containing a newline.
    expect(matchesPattern('write_file:*', 'write_file:a\nb')).toBe(true);
    expect(matchesPattern('write_file:*', 'write_file:a\r\nb')).toBe(true);
    expect(matchesPattern('write_file:*', 'write_file:a b')).toBe(true);
  });
});

describe('createPermissionPolicy — deny-evasion + scoping hardening', () => {
  it('a deny tool:* rule still fires for a path containing a newline', () => {
    const p = createPermissionPolicy();
    p.remember('write_file:*', 'deny');
    expect(p.evaluate('write_file', { path: 'a\nb' }, 'risky')).toBe('auto-deny');
  });

  it('an always-allow-pattern for one tool does not leak to another tool', () => {
    const p = createPermissionPolicy();
    p.remember('read_file:*', 'always-allow-pattern');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe('prompt');
  });

  it('a dangerous-bypass for one tool does not leak to another tool', () => {
    const p = createPermissionPolicy();
    p.remember('shell:*', 'dangerous-bypass');
    expect(p.evaluate('write_file', { path: 'x.txt' }, 'risky')).toBe('prompt');
  });

  it('two policy instances do not share remembered rules', () => {
    const a = createPermissionPolicy();
    const b = createPermissionPolicy();
    a.remember('write_file:*', 'always-allow-pattern');
    expect(a.evaluate('write_file', { path: 'x' }, 'risky')).toBe('auto-allow');
    expect(b.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });
});
