// tests/selectors.test.ts
// W13 — direct pure-unit coverage for src/core/selectors.ts.
//
// No React, no Ink, no render — every selector is a pure function over State.
// Asserts REAL behavior: the context-fraction clamp + max<=0 guard, the
// phase->statusText mapping (including the error->errorMessage fallback), and
// that the token bar's `total` equals in+out.
import { describe, expect, it } from 'vitest';
import type { State } from '../src/core/reducer';
import { initialState } from '../src/core/reducer';
import {
  selectContextFraction,
  selectCost,
  selectStatusLine,
  selectStatusText,
  selectTokenBar,
} from '../src/core/selectors';

/** Build a State from the real initialState with token/phase overrides. */
function stateWith(overrides: Partial<State>): State {
  return { ...initialState(), ...overrides };
}

describe('selectTokenBar', () => {
  it('total equals in + out', () => {
    const bar = selectTokenBar(stateWith({ tokens: { in: 120, out: 48 } }));
    expect(bar.in).toBe(120);
    expect(bar.out).toBe(48);
    expect(bar.total).toBe(168);
    expect(bar.total).toBe(bar.in + bar.out);
  });

  it('total is 0 when both sides are 0', () => {
    const bar = selectTokenBar(stateWith({ tokens: { in: 0, out: 0 } }));
    expect(bar.total).toBe(0);
  });
});

describe('selectCost', () => {
  const pricing = { inputPerMTok: 2, outputPerMTok: 8 };

  it('computes mixed input + output cost', () => {
    // 100/1e6*2 + 50/1e6*8 = 0.0002 + 0.0004 = 0.0006
    const cost = selectCost(stateWith({ tokens: { in: 100, out: 50 } }), pricing);
    expect(cost?.usd).toBeCloseTo(0.0006, 10);
  });

  it('computes input-only cost (1M input tokens)', () => {
    const cost = selectCost(stateWith({ tokens: { in: 1_000_000, out: 0 } }), pricing);
    expect(cost?.usd).toBe(2);
  });

  it('computes output-only cost (1M output tokens)', () => {
    const cost = selectCost(stateWith({ tokens: { in: 0, out: 1_000_000 } }), pricing);
    expect(cost?.usd).toBe(8);
  });

  it('is 0 for zero tokens', () => {
    const cost = selectCost(stateWith({ tokens: { in: 0, out: 0 } }), pricing);
    expect(cost?.usd).toBe(0);
  });

  it('returns undefined when pricing is omitted (subscription backend)', () => {
    expect(selectCost(stateWith({ tokens: { in: 100, out: 50 } }))).toBeUndefined();
  });
});

describe('selectContextFraction', () => {
  it('returns the in+out / max ratio inside [0, 1]', () => {
    const frac = selectContextFraction(stateWith({ tokens: { in: 30, out: 70 } }), 1000);
    expect(frac).toBeCloseTo(0.1, 10);
    expect(frac).toBeGreaterThanOrEqual(0);
    expect(frac).toBeLessThanOrEqual(1);
  });

  it('clamps to 1 when used tokens exceed max (never > 1)', () => {
    const frac = selectContextFraction(stateWith({ tokens: { in: 5000, out: 5000 } }), 100);
    expect(frac).toBe(1);
  });

  it('returns 0 when max <= 0 (guards divide-by-zero / negative)', () => {
    expect(selectContextFraction(stateWith({ tokens: { in: 50, out: 50 } }), 0)).toBe(0);
    expect(selectContextFraction(stateWith({ tokens: { in: 50, out: 50 } }), -10)).toBe(0);
  });
});

describe('selectStatusText', () => {
  it('maps each non-error phase to its fixed label', () => {
    expect(selectStatusText(stateWith({ phase: 'idle' }))).toBe('idle');
    expect(selectStatusText(stateWith({ phase: 'streaming' }))).toBe('thinking…');
    expect(selectStatusText(stateWith({ phase: 'awaiting-permission' }))).toBe(
      'awaiting permission',
    );
    expect(selectStatusText(stateWith({ phase: 'running-tool' }))).toBe('running tool…');
  });

  it('error phase surfaces errorMessage when present', () => {
    expect(
      selectStatusText(stateWith({ phase: 'error', errorMessage: 'boom: disk full' })),
    ).toBe('boom: disk full');
  });

  it('error phase falls back to "error" when errorMessage is null', () => {
    expect(selectStatusText(stateWith({ phase: 'error', errorMessage: null }))).toBe('error');
  });
});

describe('selectStatusLine toolBudget passthrough', () => {
  it('surfaces toolBudget when the context supplies it', () => {
    const status = selectStatusLine(stateWith({}), { toolBudget: { used: 3, max: 10 } });
    expect(status.toolBudget).toEqual({ used: 3, max: 10 });
  });

  it('passes through an open-ended budget (max undefined) untouched', () => {
    const status = selectStatusLine(stateWith({}), { toolBudget: { used: 2, max: undefined } });
    expect(status.toolBudget).toEqual({ used: 2, max: undefined });
  });

  it('leaves toolBudget undefined when no context is given', () => {
    expect(selectStatusLine(stateWith({})).toolBudget).toBeUndefined();
  });
});

describe('selectStatusLine cost passthrough', () => {
  it('surfaces cost when pricing is supplied', () => {
    const status = selectStatusLine(stateWith({ tokens: { in: 100, out: 50 } }), {
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    });
    expect(status.cost?.usd).toBeCloseTo(0.0006, 10);
  });

  it('leaves cost undefined when pricing is omitted', () => {
    expect(selectStatusLine(stateWith({ tokens: { in: 100, out: 50 } })).cost).toBeUndefined();
  });
});
