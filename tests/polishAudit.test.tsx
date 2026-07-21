import { describe, expect, it } from 'vitest';
import { POLISH_CASES, runPolishAuditCase } from '../scripts/polishAudit';

describe('Observatory automated polish matrix', () => {
  for (const auditCase of POLISH_CASES) {
    it(`${auditCase.name} keeps every visual and capability invariant`, () => {
      const result = runPolishAuditCase(auditCase);
      const failures = result.invariants
        .filter((check) => !check.pass)
        .map((check) => `${check.name}: ${check.detail}`);
      expect(failures).toEqual([]);
    });
  }
});
