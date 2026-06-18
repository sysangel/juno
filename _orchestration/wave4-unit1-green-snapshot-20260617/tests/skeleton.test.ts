import { describe, it, expect } from 'vitest';

describe('skeleton', () => {
  it('vitest is wired', () => {
    expect(true).toBe(true);
  });

  it('node version is >= 20', () => {
    const [major] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
