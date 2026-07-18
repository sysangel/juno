// tests/selectors.test.ts
// W13 — direct pure-unit coverage for src/core/selectors.ts.
//
// No React, no Ink, no render — every selector is a pure function over State.
// Asserts REAL behavior: the context-fraction clamp + max<=0 guard, the
// phase->statusText mapping (including the error->errorMessage fallback), and
// that the token bar's `total` equals in+out.
import { describe, expect, it } from 'vitest';
import type { State, ToolState } from '../src/core/reducer';
import { initialState } from '../src/core/reducer';
import {
  formatBackoff,
  runningChildActivity,
  selectActivity,
  selectContextFraction,
  selectContextPressure,
  selectContextWindow,
  selectCost,
  selectStatusLine,
  selectStatusText,
  selectTokenBar,
  shouldCompact,
} from '../src/core/selectors';
import type { Msg } from '../src/core/reducer';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';

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

describe('selectCost (cumulative session)', () => {
  const pricing = { inputPerMTok: 2, outputPerMTok: 8 };

  it('computes mixed input + output cost from the cumulative session tokens', () => {
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

  it('is 0 for a zero-token session', () => {
    const cost = selectCost(stateWith({ tokens: { in: 0, out: 0 } }), pricing);
    expect(cost?.usd).toBe(0);
  });

  it('returns undefined when pricing is omitted (subscription backend)', () => {
    expect(selectCost(stateWith({ tokens: { in: 100, out: 50 } }))).toBeUndefined();
  });

  it('is 0 at the initial state (no tokens yet)', () => {
    const cost = selectCost(initialState(), pricing);
    expect(cost?.usd).toBe(0);
  });

  it('tracks the cumulative total consistent with the tok:total chip', () => {
    // Same tokens the StatusLine prices, two different model prices -> two costs.
    const sessionState = stateWith({ tokens: { in: 1_000_000, out: 1_000_000 } });
    const cheap = selectCost(sessionState, { inputPerMTok: 2, outputPerMTok: 8 });
    const dear = selectCost(sessionState, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(cheap?.usd).toBe(10); // 2 + 8
    expect(dear?.usd).toBe(18); // 3 + 15
  });

  it('grows as cumulative session tokens grow', () => {
    const small = selectCost(stateWith({ tokens: { in: 10, out: 10 } }), pricing);
    const large = selectCost(stateWith({ tokens: { in: 1_000_000, out: 0 } }), pricing);
    expect(large?.usd).toBeGreaterThan(small?.usd ?? 0);
    expect(large?.usd).toBe(2);
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

describe('selectContextWindow (live window occupancy)', () => {
  const msg = (id: string, text: string): Msg => ({
    id,
    role: 'user',
    blocks: [{ kind: 'text', id: `${id}:block:1`, text }],
    done: true,
  });

  it('prefers the REAL measurement (contextWindowTokens) over the estimate', () => {
    // A long transcript whose char/4 estimate is large, but a small real measurement.
    const state = stateWith({
      committed: [msg('u1', 'x'.repeat(4000))], // estimate ~1000+ tokens
      contextWindowTokens: 250,
    });
    const cw = selectContextWindow(state, 1000);
    expect(cw.used).toBe(250);
    expect(cw.estimated).toBe(false);
    expect(cw.fraction).toBeCloseTo(0.25, 10);
    expect(cw.max).toBe(1000);
  });

  it('falls back to the char/4 transcript estimate when no measurement exists', () => {
    const state = stateWith({ committed: [msg('u1', 'abcd'.repeat(100))] }); // 400 chars -> ~100 + overhead
    const cw = selectContextWindow(state, 10_000);
    expect(cw.estimated).toBe(true);
    expect(cw.used).toBeGreaterThan(100);
    expect(cw.used).toBeLessThan(120);
  });

  it('is estimated and ~0 at the initial state (no transcript, no measurement)', () => {
    const cw = selectContextWindow(initialState(), 1000);
    expect(cw.estimated).toBe(true);
    expect(cw.fraction).toBe(0);
  });

  it('clamps the fraction to 1 when the window is over-full', () => {
    const cw = selectContextWindow(stateWith({ contextWindowTokens: 9999 }), 1000);
    expect(cw.used).toBe(9999);
    expect(cw.fraction).toBe(1);
  });

  it('returns fraction 0 when max <= 0 (guards divide-by-zero)', () => {
    expect(selectContextWindow(stateWith({ contextWindowTokens: 500 }), 0).fraction).toBe(0);
    expect(selectContextWindow(stateWith({ contextWindowTokens: 500 }), -5).fraction).toBe(0);
  });

  it('is surfaced through selectStatusLine using the supplied maxContext', () => {
    const status = selectStatusLine(stateWith({ contextWindowTokens: 100 }), { maxContext: 400 });
    expect(status.contextWindow.used).toBe(100);
    expect(status.contextWindow.max).toBe(400);
    expect(status.contextWindow.fraction).toBeCloseTo(0.25, 10);
    expect(status.contextWindow.estimated).toBe(false);
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
  it('surfaces cumulative cost when pricing is supplied', () => {
    const status = selectStatusLine(stateWith({ tokens: { in: 100, out: 50 } }), {
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    });
    expect(status.cost?.usd).toBeCloseTo(0.0006, 10);
  });

  it('leaves cost undefined when pricing is omitted', () => {
    expect(selectStatusLine(stateWith({ tokens: { in: 100, out: 50 } })).cost).toBeUndefined();
  });

  it('prices the cumulative session tokens through the status line', () => {
    const status = selectStatusLine(stateWith({ tokens: { in: 1_000_000, out: 1_000_000 } }), {
      pricing: { inputPerMTok: 2, outputPerMTok: 8 },
    });
    expect(status.cost?.usd).toBe(10);
  });
});

describe('per-model context window drives the compaction denominator', () => {
  const catalog = createModelCatalog(BUILTIN_MODELS);
  const textMsg = (id: string, text: string): Msg => ({
    id,
    role: 'user',
    blocks: [{ kind: 'text', id: `${id}:block:1`, text }],
    done: true,
  });

  it('locks the catalog windows the app threads into compaction (fable 1M, openrouter 1.048M)', () => {
    expect(catalog.resolve('claude-fable-5')?.contextWindow).toBe(1_000_000);
    expect(catalog.resolve('z-ai/glm-5.2')?.contextWindow).toBe(1_048_576);
  });

  it('compacts under the fable 1M window but NOT under the openrouter 1.048M window for one transcript', () => {
    const fable = catalog.resolve('claude-fable-5')!.contextWindow; // 1_000_000
    const openrouter = catalog.resolve('z-ai/glm-5.2')!.contextWindow; // 1_048_576

    // A transcript whose estimated size sits strictly BETWEEN the two 50% thresholds:
    //   0.5 * 1_000_000 = 500_000  <  ~512_024  <  524_288 = 0.5 * 1_048_576
    // big msg: ceil(2_048_000/4)=512_000 (+4 overhead) + four tiny msgs (5 each).
    const state = stateWith({
      committed: [
        textMsg('big', 'a'.repeat(2_048_000)),
        textMsg('u1', 'x'),
        textMsg('u2', 'x'),
        textMsg('u3', 'x'),
        textMsg('u4', 'x'),
      ],
    });

    const pressureFable = selectContextPressure(state, fable);
    const pressureOpenrouter = selectContextPressure(state, openrouter);
    expect(pressureFable).toBeGreaterThanOrEqual(0.5);
    expect(pressureOpenrouter).toBeLessThan(0.5);
    // Smaller window => higher pressure for the identical transcript.
    expect(pressureFable).toBeGreaterThan(pressureOpenrouter);

    // The compaction trigger fires off the SAME per-model window the app now threads.
    expect(shouldCompact(state, fable)).toBe(true);
    expect(shouldCompact(state, openrouter)).toBe(false);
  });

  it('uses the corrected 1_000_000 fallback window when no per-model size is threaded', () => {
    // 'hello world' => ceil(11/4)=3 + 4 overhead = 7 estimated tokens.
    const state = stateWith({ committed: [textMsg('u1', 'hello world')] });
    expect(selectContextPressure(state)).toBeCloseTo(7 / 1_000_000, 12);
    expect(selectContextWindow(state).max).toBe(1_000_000);
  });
});

describe('runningChildActivity (wave-6 lane C — per-subagent live rollup)', () => {
  /** Build a `state.tools` map from ordered [id, ToolState] entries (order = the
   * reducer's creation order, which the selector uses to pick the NEWEST running child). */
  const toolsFrom = (entries: [string, ToolState][]): State['tools'] =>
    Object.fromEntries(entries);

  it('labels the RUNNING child of a subagent by its tool name', () => {
    const state = stateWith({
      tools: toolsFrom([
        ['p', { status: 'running', name: 'Agent', args: {} }],
        ['c', { status: 'running', name: 'Bash', args: { command: 'echo hi' }, parentToolUseId: 'p' }],
      ]),
    });
    expect(runningChildActivity(state, 'p')).toBe('running Bash…');
  });

  it('falls back to "working…" when the subagent has no running child (settled or none)', () => {
    const settled = stateWith({
      tools: toolsFrom([
        ['p', { status: 'running', name: 'Agent', args: {} }],
        ['c', { status: 'result', name: 'Bash', args: {}, result: 'ok', parentToolUseId: 'p' }],
      ]),
    });
    expect(runningChildActivity(settled, 'p')).toBe('working…');

    // A subagent that just spawned and has no child tools yet also reads "working…".
    const childless = stateWith({ tools: toolsFrom([['p', { status: 'running', name: 'Agent', args: {} }]]) });
    expect(runningChildActivity(childless, 'p')).toBe('working…');
  });

  it('attributes a running GRANDCHILD to the top-ancestor subagent (chain walk)', () => {
    // p (Agent) → c (Task, settled) → g (Bash, running). g's activity rolls up to p.
    const state = stateWith({
      tools: toolsFrom([
        ['p', { status: 'running', name: 'Agent', args: {} }],
        ['c', { status: 'result', name: 'Task', args: {}, result: 'rc', parentToolUseId: 'p' }],
        ['g', { status: 'running', name: 'Bash', args: { command: 'x' }, parentToolUseId: 'c' }],
      ]),
    });
    expect(runningChildActivity(state, 'p')).toBe('running Bash…');
    // The intermediate child, asked directly, still reports its own running descendant.
    expect(runningChildActivity(state, 'c')).toBe('running Bash…');
  });

  it('picks the NEWEST running child when several run in parallel (creation order)', () => {
    // Two running children of p; the later-created one (Bash) wins.
    const state = stateWith({
      tools: toolsFrom([
        ['p', { status: 'running', name: 'Agent', args: {} }],
        ['c1', { status: 'running', name: 'Grep', args: { pattern: 'x' }, parentToolUseId: 'p' }],
        ['c2', { status: 'running', name: 'Bash', args: { command: 'y' }, parentToolUseId: 'p' }],
      ]),
    });
    expect(runningChildActivity(state, 'p')).toBe('running Bash…');
  });

  it('does not attribute a sibling subagent\'s running child to the wrong parent', () => {
    // Two independent subagents; each rollup names only its OWN child.
    const state = stateWith({
      tools: toolsFrom([
        ['p1', { status: 'running', name: 'Agent', args: {} }],
        ['a1', { status: 'running', name: 'Bash', args: {}, parentToolUseId: 'p1' }],
        ['p2', { status: 'running', name: 'Agent', args: {} }],
        ['a2', { status: 'running', name: 'Grep', args: {}, parentToolUseId: 'p2' }],
      ]),
    });
    expect(runningChildActivity(state, 'p1')).toBe('running Bash…');
    expect(runningChildActivity(state, 'p2')).toBe('running Grep…');
  });

  it('terminates (does not loop) on a cyclic parentToolUseId chain', () => {
    // x (running) → cycA → cycB → cycA … a rootless cycle that never reaches 'p'.
    // Reaching the assertion at all proves the visited-set bounded the walk.
    const state = stateWith({
      tools: toolsFrom([
        ['x', { status: 'running', name: 'Bash', args: {}, parentToolUseId: 'cycA' }],
        ['cycA', { status: 'result', name: 'A', args: {}, parentToolUseId: 'cycB' }],
        ['cycB', { status: 'result', name: 'B', args: {}, parentToolUseId: 'cycA' }],
      ]),
    });
    expect(runningChildActivity(state, 'p')).toBe('working…');
  });
});

describe('formatBackoff', () => {
  it('renders sub-second delays in ms and second+ delays in seconds', () => {
    expect(formatBackoff(500)).toBe('500ms');
    expect(formatBackoff(999)).toBe('999ms');
    expect(formatBackoff(1000)).toBe('1s');
    expect(formatBackoff(1500)).toBe('1.5s');
    expect(formatBackoff(2000)).toBe('2s');
    expect(formatBackoff(8000)).toBe('8s');
  });
});

describe('selectActivity — retry indicator (wave-13 retry-ui)', () => {
  it('surfaces the retry line even at phase idle (the tool_use re-entry gap)', () => {
    const state = stateWith({ phase: 'idle', retry: { attempt: 2, max: 3, delayMs: 2000 } });
    const activity = selectActivity(state);
    expect(activity).not.toBeNull();
    expect(activity!.label).toContain('retrying 2/3');
    expect(activity!.label).toContain('2s');
    expect(activity!.abortable).toBe(true);
    expect(activity!.attention).toBe(false);
  });

  it('surfaces the retry line at phase streaming and includes a sub-second backoff', () => {
    const state = stateWith({ phase: 'streaming', retry: { attempt: 1, max: 3, delayMs: 500 } });
    const activity = selectActivity(state);
    expect(activity!.label).toBe('retrying 1/3 · 500ms backoff');
    expect(activity!.abortable).toBe(true);
    expect(activity!.attention).toBe(false);
  });

  it('outranks the awaiting-permission phase (retry is highest precedence)', () => {
    const state = stateWith({
      phase: 'awaiting-permission',
      retry: { attempt: 1, max: 3, delayMs: 1000 },
    });
    expect(selectActivity(state)!.label).toBe('retrying 1/3 · 1s backoff');
  });

  it('falls through to the normal phase mapping when retry is undefined', () => {
    // streaming, no live text ⇒ the ordinary 'thinking…' line.
    expect(selectActivity(stateWith({ phase: 'streaming' }))!.label).toBe('thinking…');
    // idle with no retry ⇒ null (no busy line).
    expect(selectActivity(stateWith({ phase: 'idle' }))).toBeNull();
  });

  it('returns null at phase error (retry is cleared by the reducer before this)', () => {
    expect(selectActivity(stateWith({ phase: 'error' }))).toBeNull();
  });
});
