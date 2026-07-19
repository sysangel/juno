// tests/transitionPhase.test.ts
// Wave-14 a2-turn-lifecycle — the exhaustive (phase × action) transition table for the
// single phase authority `transitionPhase`. The reducer routes EVERY phase change through
// this pure function, so locking every cell here pins the whole turn/compaction lifecycle.
// The function's own `assertNever` guarantees a NEW action can't compile without a decision;
// this table guarantees the decision for each existing action stays correct.
import { describe, it, expect } from 'vitest';
import { transitionPhase, type Phase, type Action } from '../src/core/reducer';

const ALL_PHASES: Phase[] = [
  'idle',
  'preparing',
  'streaming',
  'running-tool',
  'awaiting-permission',
  'compacting',
  'error',
];

const DEFAULT_CTX = { liveNull: false, isChildTool: false };

/** Apply `transitionPhase` for `action` from every starting phase; assert the whole row. */
function expectRow(
  action: Action,
  expected: Record<Phase, Phase>,
  ctx: { liveNull: boolean; isChildTool: boolean } = DEFAULT_CTX,
): void {
  for (const from of ALL_PHASES) {
    expect({ from, to: transitionPhase(from, action, ctx) }).toEqual({ from, to: expected[from] });
  }
}

/** Row where every starting phase maps to the SAME target. */
function constRow(to: Phase): Record<Phase, Phase> {
  return {
    idle: to,
    preparing: to,
    streaming: to,
    'running-tool': to,
    'awaiting-permission': to,
    compacting: to,
    error: to,
  };
}

/** Row where every starting phase is left UNCHANGED (phase-inert / phase-neutral). */
const IDENTITY_ROW: Record<Phase, Phase> = {
  idle: 'idle',
  preparing: 'preparing',
  streaming: 'streaming',
  'running-tool': 'running-tool',
  'awaiting-permission': 'awaiting-permission',
  compacting: 'compacting',
  error: 'error',
};

/**
 * A mid-turn settle event (top-level tool result/error, permission-resolved): hand back to
 * 'streaming' from any in-flight turn phase, but PRESERVE a settled ('idle'/'error') or
 * non-turn ('compacting') phase — never resurrect a dead turn, never blip to idle mid-turn.
 */
const MID_TURN_SETTLE_ROW: Record<Phase, Phase> = {
  idle: 'idle', // dead turn (e.g. a parked prompt drained on abort) — NOT resurrected
  preparing: 'streaming',
  streaming: 'streaming',
  'running-tool': 'streaming', // the tool settled but the turn continues — no idle blip
  'awaiting-permission': 'streaming',
  compacting: 'compacting', // separate lifecycle — untouched
  error: 'error', // terminal — NOT resurrected
};

describe('transitionPhase — turn lifecycle acquire/release', () => {
  it('turn-start enters preparing only from a settled phase (idle/error); mid-flight is a no-op', () => {
    expectRow({ t: 'turn-start' }, {
      idle: 'preparing',
      error: 'preparing',
      // Already in flight ⇒ untouched (submit self-guards; this is belt-and-suspenders).
      preparing: 'preparing',
      streaming: 'streaming',
      'running-tool': 'running-tool',
      'awaiting-permission': 'awaiting-permission',
      compacting: 'compacting',
    });
  });

  it('turn-settle returns to idle from every busy phase but PRESERVES an error terminal', () => {
    expectRow({ t: 'turn-settle' }, { ...constRow('idle'), error: 'error' });
  });

  it('assistant-start always enters streaming (first byte)', () => {
    expectRow({ t: 'assistant-start', id: 'a1' }, constRow('streaming'));
  });
});

describe('transitionPhase — compaction lifecycle', () => {
  it('compaction-start always enters compacting', () => {
    expectRow({ t: 'compaction-start' }, constRow('compacting'));
  });

  it('compaction-settle settles ONLY from compacting; every other phase is a no-op', () => {
    // Unlike turn-settle (a hung-turn safety net that forces idle from any busy phase),
    // compaction-settle releases a compaction specifically — so it must not clobber a live
    // turn's streaming/preparing, and it preserves an error terminal.
    expectRow({ t: 'compaction-settle' }, { ...IDENTITY_ROW, compacting: 'idle' });
    expect(transitionPhase('streaming', { t: 'compaction-settle' }, DEFAULT_CTX)).toBe('streaming');
    expect(transitionPhase('compacting', { t: 'compaction-settle' }, DEFAULT_CTX)).toBe('idle');
  });
});

describe('transitionPhase — permission prompt', () => {
  it('permission-open always enters awaiting-permission', () => {
    expectRow({ t: 'permission-open', toolCallId: 'tc1', name: 'n', args: {}, risk: 'risky' }, constRow('awaiting-permission'));
  });

  it('permission-resolved hands an in-flight turn back to streaming, but never resurrects a settled one', () => {
    // No liveNull dependency (so no mid-turn idle blip), but idle/error are preserved — a
    // parked prompt drained to deny AFTER an abort must not re-pin the busy line.
    expectRow({ t: 'permission-resolved', toolCallId: 'tc1', decision: 'allow-once' }, MID_TURN_SETTLE_ROW, { liveNull: true, isChildTool: false });
    expectRow({ t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' }, MID_TURN_SETTLE_ROW, { liveNull: false, isChildTool: false });
    // Key cells: awaiting-permission → streaming (the real flow); idle → idle (post-abort drain).
    expect(transitionPhase('awaiting-permission', { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' }, DEFAULT_CTX)).toBe('streaming');
    expect(transitionPhase('idle', { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' }, DEFAULT_CTX)).toBe('idle');
  });
});

describe('transitionPhase — tool-status', () => {
  it('a top-level running tool pins running-tool', () => {
    expectRow({ t: 'tool-status', toolCallId: 'tc1', status: 'running' }, constRow('running-tool'));
  });

  it('a top-level result/error keeps an in-flight turn streaming (no idle blip) but never resurrects a settled one', () => {
    // The key regression cell: running-tool → streaming with live null (raw-API round) — was
    // `idle` under the old liveNull logic. idle/error are preserved (a late result drained
    // after an abort must not re-pin the busy line).
    expectRow({ t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 }, MID_TURN_SETTLE_ROW, { liveNull: true, isChildTool: false });
    expectRow({ t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'x' }, MID_TURN_SETTLE_ROW, { liveNull: false, isChildTool: false });
    expect(transitionPhase('running-tool', { t: 'tool-status', toolCallId: 'tc1', status: 'result' }, { liveNull: true, isChildTool: false })).toBe('streaming');
    expect(transitionPhase('idle', { t: 'tool-status', toolCallId: 'tc1', status: 'result' }, DEFAULT_CTX)).toBe('idle');
  });

  it('a top-level pending status is phase-inert', () => {
    expectRow({ t: 'tool-status', toolCallId: 'tc1', status: 'pending' }, IDENTITY_ROW);
  });

  it('a subagent-child status (parentToolUseId set) is phase-NEUTRAL for every status', () => {
    const childCtx = { liveNull: false, isChildTool: true };
    for (const status of ['running', 'result', 'error', 'pending'] as const) {
      expectRow({ t: 'tool-status', toolCallId: 'sa-1', status }, IDENTITY_ROW, childCtx);
    }
  });
});

describe('transitionPhase — turn end', () => {
  it('assistant-done(tool_use) or continues:true stays streaming (re-entry in flight)', () => {
    expectRow({ t: 'assistant-done', id: 'a1', stopReason: 'tool_use' }, constRow('streaming'));
    expectRow({ t: 'assistant-done', id: 'a1', stopReason: 'end', continues: true }, constRow('streaming'));
  });

  it('a genuinely terminal assistant-done returns to idle', () => {
    expectRow({ t: 'assistant-done', id: 'a1', stopReason: 'end' }, constRow('idle'));
    expectRow({ t: 'assistant-done', id: 'a1', stopReason: 'max_tokens' }, constRow('idle'));
  });

  it('aborted always returns to idle', () => {
    expectRow({ t: 'aborted', reason: 'user cancelled' }, constRow('idle'));
  });

  it('error always enters the error terminal', () => {
    expectRow({ t: 'error', message: 'boom' }, constRow('error'));
  });
});

describe('transitionPhase — phase-inert actions', () => {
  it('a delta/usage/effort-style action never perturbs the phase', () => {
    for (const action of [
      { t: 'text-delta', id: 'a1', delta: 'x' },
      { t: 'reasoning-delta', id: 'a1', delta: 'x' },
      { t: 'usage', tokensIn: 1, tokensOut: 2 },
      { t: 'cycle-effort' },
      { t: 'notice', text: 'hi' },
      { t: 'retry-attempt', attempt: 1, max: 3, delayMs: 100 },
      { t: 'retry-clear' },
    ] as Action[]) {
      expectRow(action, IDENTITY_ROW);
    }
  });
});
