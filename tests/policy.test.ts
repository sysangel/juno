// tests/policy.test.ts
// The 'sandboxed' risk inversion: run_shell auto-allows ONLY when the tool reports
// risk:'sandboxed' (its child is genuinely OS-confined). 'dangerous' still prompts,
// and the structural guard that an always-allow-pattern cannot satisfy a dangerous
// tool is preserved.
import { describe, expect, it } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';

const ARGS = { command: 'npm test' };

describe("policy — risk:'sandboxed'", () => {
  it("auto-allows run_shell at risk 'sandboxed'", () => {
    const policy = createPermissionPolicy({ autoAllowSafe: true });
    expect(policy.evaluate('run_shell', ARGS, 'sandboxed')).toBe('auto-allow');
    // Independent of autoAllowSafe (which only governs 'safe').
    const noSafe = createPermissionPolicy({ autoAllowSafe: false });
    expect(noSafe.evaluate('run_shell', ARGS, 'sandboxed')).toBe('auto-allow');
  });

  it("still PROMPTS run_shell at risk 'dangerous'", () => {
    const policy = createPermissionPolicy();
    expect(policy.evaluate('run_shell', ARGS, 'dangerous')).toBe('prompt');
  });

  it('a deny rule still beats a sandboxed auto-allow (deny precedence holds)', () => {
    const policy = createPermissionPolicy({ initial: [{ pattern: 'run_shell', decision: 'deny' }] });
    expect(policy.evaluate('run_shell', ARGS, 'sandboxed')).toBe('auto-deny');
  });

  it('REGRESSION: an always-allow-pattern still cannot satisfy a dangerous tool', () => {
    // Pins policy.ts:150 — the structural guard is unchanged by adding 'sandboxed'.
    const bareName = createPermissionPolicy({
      initial: [{ pattern: 'run_shell', decision: 'always-allow-pattern' }],
    });
    expect(bareName.evaluate('run_shell', { command: 'rm -rf /' }, 'dangerous')).toBe('prompt');

    const wildcard = createPermissionPolicy({ allow: ['run_shell:*'] });
    expect(wildcard.evaluate('run_shell', ARGS, 'dangerous')).toBe('prompt');

    // The same always-allow DOES satisfy a non-dangerous tool (guard is scoped).
    const write = createPermissionPolicy({
      initial: [{ pattern: 'write_file', decision: 'always-allow-pattern' }],
    });
    expect(write.evaluate('write_file', { path: 'a.ts' }, 'risky')).toBe('auto-allow');
  });
});
