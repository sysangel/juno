// tests/verify-policy.test.ts
// W11 — unit coverage for the pure `evaluatePolicy` decision function and a
// genuine import-safety guard (importing the module must NOT call process.exit).
import { describe, it, expect, vi } from 'vitest';
import { evaluatePolicy } from '../scripts/verify-openrouter-policy';

describe('evaluatePolicy', () => {
  it('returns skipped (code 0) when skip is true', () => {
    const out = evaluatePolicy({ skip: true, hasApiKey: false, remote: 'unchecked' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('skipped');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns unconfigured (code 1) when no API key is present', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: false, remote: 'unchecked' });
    expect(out.code).toBe(1);
    expect(out.status).toBe('unconfigured');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns unverified (code 1) when key present but remote failed', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'failed' });
    expect(out.code).toBe(1);
    expect(out.status).toBe('unverified');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns ok (code 0) when key present and remote ok', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'ok' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns ok (code 0) when key present and remote unchecked', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'unchecked' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('never frames itself as enforcement and never references the retired Western-only screen', () => {
    const outcomes = [
      evaluatePolicy({ skip: true, hasApiKey: false, remote: 'unchecked' }),
      evaluatePolicy({ skip: false, hasApiKey: false, remote: 'unchecked' }),
      evaluatePolicy({ skip: false, hasApiKey: true, remote: 'failed' }),
      evaluatePolicy({ skip: false, hasApiKey: true, remote: 'ok' }),
    ];
    for (const out of outcomes) {
      // No-train is the whole policy; the geographic/Western-only screen is retired.
      expect(out.message.toLowerCase()).not.toContain('western');
    }
  });
});

describe('import safety', () => {
  it('does not invoke process.exit on import', async () => {
    // If importing the script had called process.exit, the test runner would
    // have terminated before this file finished loading. To be explicit, spy on
    // process.exit and re-import via the module cache: no fresh side effects run,
    // and importing under vitest never matches the entry-point guard.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must not be called on import');
    }) as never);
    try {
      const mod = await import('../scripts/verify-openrouter-policy');
      expect(typeof mod.evaluatePolicy).toBe('function');
      expect(typeof mod.main).toBe('function');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
