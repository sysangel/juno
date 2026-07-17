// tests/permissionPromptRisk.test.ts
// Exhaustiveness pin for the PermissionPrompt risk tint. The `riskToken` switch is
// exhaustive over RiskLevel with no `default`, so adding a union member (here
// 'sandboxed') is a COMPILE error until handled; this unit assertion is the
// runtime backstop that every level resolves to a real theme token.
import { describe, expect, it } from 'vitest';
import type { RiskLevel } from '../src/core/events';
import { riskToken } from '../src/ui/PermissionPrompt';

describe('PermissionPrompt riskToken', () => {
  it('resolves EVERY RiskLevel to a defined, non-empty token', () => {
    const risks: RiskLevel[] = ['safe', 'risky', 'dangerous', 'sandboxed'];
    for (const risk of risks) {
      const t = riskToken(risk);
      expect(t).toBeTruthy();
      expect(typeof t).toBe('string');
    }
  });

  it("tints 'sandboxed' as the confined cue ('warning')", () => {
    expect(riskToken('sandboxed')).toBe('warning');
  });
});
