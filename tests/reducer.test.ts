// tests/reducer.test.ts
// W3 — covers every reducer Action variant plus the tricky lifecycle paths.
import { describe, it, expect } from 'vitest';
import { reducer, initialState, type State, type Action, type Msg } from '../src/core/reducer';
import { eventToAction, type AgentEvent } from '../src/core/events';
import type { TurnMessage } from '../src/core/contracts';

function step(state: State, action: Action): State {
  return reducer(state, action);
}

/** A streaming turn: one committed user msg + an open live assistant msg. */
function streamingState(): State {
  let s = initialState();
  s = step(s, { t: 'user-submit', id: 'u1', text: 'hello world' });
  s = step(s, { t: 'assistant-start', id: 'a1' });
  return s;
}

/** The dim `session cleared` notice `clear` leaves in the (emptied) viewport (F). */
const CLEARED_NOTICE: Msg = {
  id: 'notice-cleared',
  role: 'system',
  done: true,
  blocks: [{ kind: 'notice', id: 'notice-cleared:block:1', text: 'session cleared' }],
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe('reducer — initialState', () => {
  it('has sane defaults', () => {
    expect(initialState()).toEqual({
      committed: [],
      live: null,
      tools: {},
      phase: 'idle',
      overlay: 'none',
      effort: 'medium',
      permissionMode: 'default',
      tokens: { in: 0, out: 0 },
      pendingPermissionToolCallId: null,
      errorMessage: null,
    });
  });
});

describe('reducer — user-submit', () => {
  it('commits a user msg with a single text block and does NOT touch tokens.in', () => {
    const s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hello world' });
    expect(s.committed).toHaveLength(1);
    expect(s.committed[0]).toEqual({
      id: 'u1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello world' }],
      done: true,
    });
    // tokens.in is populated by the provider's real `usage` event, not estimated
    // here. The pre-W9 estimate was removed to stop double-counting input.
    expect(s.tokens.in).toBe(0);
  });

  it('input double-count regression: user-submit then a usage event yields the PROVIDER value, not estimate+value', () => {
    let s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'a much longer prompt that would have estimated several tokens' });
    s = step(s, { t: 'usage', tokensIn: 42, tokensOut: 0 });
    // Exactly the provider value — no leftover estimate added on submit.
    expect(s.tokens.in).toBe(42);
  });
});

describe('reducer — assistant-start', () => {
  it('creates a fresh empty live assistant msg and sets streaming', () => {
    const s = step(initialState(), { t: 'assistant-start', id: 'a1' });
    expect(s.live).toEqual({ id: 'a1', role: 'assistant', blocks: [], done: false });
    expect(s.phase).toBe('streaming');
  });
});

describe('reducer — text-delta', () => {
  it('appends to the trailing text block keeping the same block id', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'foo ' });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'bar' });
    expect(s.live!.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'foo bar' }]);
  });

  it('creates a new text block when a tool block splits text', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'before' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'after' });
    expect(s.live!.blocks).toEqual([
      { kind: 'text', id: 'a1:block:1', text: 'before' },
      { kind: 'tool', id: 'a1:block:2', toolCallId: 'tc1' },
      { kind: 'text', id: 'a1:block:3', text: 'after' },
    ]);
  });

  it('left-trims the opening delta of a NEW text block after a tool, keeping interior space', () => {
    // Unified-rendering wave 1: a text block resuming after a tool call must not
    // inherit the provider's leading separator space. The OPENING delta is
    // left-trimmed; interior + subsequently-appended whitespace is preserved.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'before' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'text-delta', id: 'a1', delta: '  Now a  gated action.' });
    expect(s.live!.blocks.at(-1)).toEqual({
      kind: 'text',
      id: 'a1:block:3',
      text: 'Now a  gated action.',
    });
  });

  it('left-trims the opening delta of the FIRST text block', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: '   hello' });
    expect(s.live!.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'hello' }]);
  });

  it('ignores deltas with no live msg', () => {
    const s = initialState();
    expect(step(s, { t: 'text-delta', id: 'a1', delta: 'x' })).toBe(s);
  });

  it('ignores deltas with an id mismatch', () => {
    const s = streamingState();
    expect(step(s, { t: 'text-delta', id: 'other', delta: 'x' })).toBe(s);
  });
});

describe('reducer — tool-call', () => {
  it('creates a pending tools entry and pushes a tool block', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: { dir: '.' } });
    // A top-level call in a live turn is stamped with its own concurrency batch id (grouped-
    // tool-rows) — alone here, so the batch is just itself.
    expect(s.tools['tc1']).toEqual({
      status: 'pending',
      name: 'list_files',
      args: { dir: '.' },
      concurrencyGroupId: 'tc1',
    });
    expect(s.live!.blocks.at(-1)).toEqual({ kind: 'tool', id: 'a1:block:1', toolCallId: 'tc1' });
  });

  it('records the tool even when there is no live msg (no block pushed)', () => {
    const s = step(initialState(), { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: { path: 'x' } });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'read', args: { path: 'x' } });
    expect(s.live).toBeNull();
  });
});

describe('reducer — tool-status', () => {
  it('transitions pending→running→result and flips phase', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(s.tools['tc1'].status).toBe('running');
    expect(s.phase).toBe('running-tool');
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 42 });
    expect(s.tools['tc1']).toEqual({ status: 'result', name: 'n', args: {}, result: 42, concurrencyGroupId: 'tc1' });
    expect(s.phase).toBe('streaming');
  });

  it('returns to idle on terminal status when no live turn', () => {
    let s = step(initialState(), { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 });
    expect(s.phase).toBe('idle');
  });

  it('race guard: error is not clobbered by a late result', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'boom' });
    const errored = s;
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'late' });
    expect(s).toBe(errored); // no-op, same ref
    expect(s.tools['tc1']).toEqual({ status: 'error', name: 'n', args: {}, error: 'boom', concurrencyGroupId: 'tc1' });
  });

  it('ignores status for an unknown toolCallId', () => {
    const s = streamingState();
    expect(step(s, { t: 'tool-status', toolCallId: 'nope', status: 'running' })).toBe(s);
  });
});

describe('reducer — permission-open / permission-resolved', () => {
  it('opens the permission overlay and awaits, then resolves back to streaming', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc2', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc2', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.overlay).toBe('permission');
    expect(s.phase).toBe('awaiting-permission');
    expect(s.pendingPermissionToolCallId).toBe('tc2');
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc2', decision: 'allow-once' });
    expect(s.overlay).toBe('none');
    expect(s.phase).toBe('streaming');
    expect(s.pendingPermissionToolCallId).toBeNull();
  });

  it('permission-open is defensive: registers a tools entry if tool-call did not precede', () => {
    let s = initialState();
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: { p: 1 }, risk: 'dangerous' });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'write_file', args: { p: 1 } });
  });

  it('permission-resolved without a live turn goes to idle', () => {
    let s = step(initialState(), { t: 'permission-open', toolCallId: 'tc1', name: 'n', args: {}, risk: 'risky' });
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });
    expect(s.phase).toBe('idle');
    expect(s.overlay).toBe('none');
  });
});

describe('reducer — assistant-done', () => {
  it('commits live with a correct toolSnapshot and clears live', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: ['a'] });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.live).toBeNull();
    expect(s.phase).toBe('idle');
    const last = s.committed.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.toolSnapshot).toEqual({
      tc1: { status: 'result', name: 'list_files', args: {}, result: ['a'], concurrencyGroupId: 'tc1' },
    });
  });

  it('omits toolSnapshot when the turn referenced no tools', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.committed.at(-1)!.toolSnapshot).toBeUndefined();
  });

  it('keeps phase streaming on an intermediate tool_use stop (turn still in flight, no bell)', () => {
    // Completion-bell regression: a `tool_use` stop commits the assistant turn but
    // the runner re-enters the model, so phase must stay 'streaming' (NOT 'idle').
    // An idle transition here is observable between HTTP requests and would ring the
    // completion bell once per tool round instead of once per user turn.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'tool_use' });
    expect(s.live).toBeNull();
    expect(s.committed.at(-1)!.done).toBe(true);
    expect(s.phase).toBe('streaming');
  });

  it('returns to idle on a terminal stop (end/max_tokens)', () => {
    for (const stopReason of ['end', 'max_tokens'] as const) {
      let s = streamingState();
      s = step(s, { t: 'assistant-done', id: 'a1', stopReason });
      expect(s.phase).toBe('idle');
    }
  });

  it('no-op when no live msg or id mismatch', () => {
    const s = step(initialState(), { t: 'assistant-start', id: 'a1' });
    expect(step(s, { t: 'assistant-done', id: 'other', stopReason: 'end' })).toBe(s);
    const empty = initialState();
    expect(step(empty, { t: 'assistant-done', id: 'a1', stopReason: 'end' })).toBe(empty);
  });
});

describe('reducer — usage', () => {
  it('accumulates tokens', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 10, tokensOut: 5 });
    s = step(s, { t: 'usage', tokensIn: 3, tokensOut: 7 });
    expect(s.tokens).toEqual({ in: 13, out: 12 });
  });

  it('multi-turn: two sequential turns ACCUMULATE into the session total (not last-wins)', () => {
    // Guards against the fix turning session-cumulative accumulation into replacement.
    let s = initialState();
    // Turn 1
    s = step(s, { t: 'user-submit', id: 'u1', text: 'first prompt' });
    s = step(s, { t: 'usage', tokensIn: 100, tokensOut: 40 });
    // Turn 2
    s = step(s, { t: 'user-submit', id: 'u2', text: 'second prompt' });
    s = step(s, { t: 'usage', tokensIn: 30, tokensOut: 60 });
    expect(s.tokens).toEqual({ in: 130, out: 100 });
  });
});

describe('reducer — usage / contextWindowTokens (live window occupancy)', () => {
  it('is absent at the initial state (additive, estimate stands in)', () => {
    expect(initialState().contextWindowTokens).toBeUndefined();
  });

  it('prefers the normalized contextTokens (cache-inclusive) over tokensIn', () => {
    const s = step(initialState(), { t: 'usage', tokensIn: 20, tokensOut: 0, contextTokens: 1500 });
    expect(s.contextWindowTokens).toBe(1500);
  });

  it('falls back to a positive tokensIn when contextTokens is absent', () => {
    const s = step(initialState(), { t: 'usage', tokensIn: 42, tokensOut: 0 });
    expect(s.contextWindowTokens).toBe(42);
  });

  it('REPLACES (not accumulates) across turns — it is current occupancy, not lifetime', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 100, tokensOut: 0, contextTokens: 100 });
    s = step(s, { t: 'usage', tokensIn: 250, tokensOut: 0, contextTokens: 250 });
    expect(s.contextWindowTokens).toBe(250); // not 350
    expect(s.tokens.in).toBe(350); // cumulative side still accumulates
  });

  it('an output-only delta (tokensIn 0, no contextTokens) does NOT clobber the measurement', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 90, tokensOut: 0, contextTokens: 90 });
    s = step(s, { t: 'usage', tokensIn: 0, tokensOut: 40 });
    expect(s.contextWindowTokens).toBe(90);
  });

  it('clear resets the measurement (transcript emptied)', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 500, tokensOut: 0, contextTokens: 500 });
    s = step(s, { t: 'clear' });
    expect(s.contextWindowTokens).toBeUndefined();
  });

  it('compact drops the stale measurement (transcript shrank)', () => {
    let s = initialState();
    for (let i = 0; i < 6; i += 1) {
      s = step(s, { t: 'user-submit', id: `u${i}`, text: `message ${i}` });
    }
    s = step(s, { t: 'usage', tokensIn: 800, tokensOut: 0, contextTokens: 800 });
    s = step(s, { t: 'compact', summaryText: 'summary', keepCount: 2 });
    expect(s.contextWindowTokens).toBeUndefined();
  });
});

describe('reducer — set-effort / cycle-effort', () => {
  it('set-effort sets the effort', () => {
    expect(step(initialState(), { t: 'set-effort', effort: 'high' }).effort).toBe('high');
  });

  it('cycle-effort cycles medium→high→xhigh→medium', () => {
    let s = initialState();
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('high');
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('xhigh');
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('medium');
  });
});

describe('reducer — set-overlay', () => {
  it('sets a neutral overlay without disturbing phase', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    expect(s.overlay).toBe('slash');
    expect(s.phase).toBe('streaming');
  });

  it('opening the permission overlay awaits; clearing it restores phase', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'permission' });
    expect(s.phase).toBe('awaiting-permission');
    s = step(s, { t: 'set-overlay', overlay: 'none' });
    expect(s.phase).toBe('streaming');
  });

  it('accepts the additive skill-picker and permission-mode overlays', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'skill-picker' });
    expect(s.overlay).toBe('skill-picker');
    s = step(s, { t: 'set-overlay', overlay: 'permission-mode' });
    expect(s.overlay).toBe('permission-mode');
  });
});

describe('reducer — local palette actions (W5 Unit 5.2, additive)', () => {
  it('set-permission-mode sets permissionMode and leaves other fields untouched', () => {
    const before = step(streamingState(), { t: 'usage', tokensIn: 10, tokensOut: 5 });
    const after = step(before, { t: 'set-permission-mode', mode: 'acceptEdits' });

    expect(after).not.toBe(before);
    expect(after.permissionMode).toBe('acceptEdits');

    // Everything EXCEPT permissionMode is identical (non-tautological: proves the
    // case touches only the one field).
    const { permissionMode: _beforeMode, ...beforeRest } = before;
    const { permissionMode: _afterMode, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });

  it('skill-select is handled and only closes the open overlay', () => {
    let before = streamingState();
    before = step(before, { t: 'set-overlay', overlay: 'skill-picker' });
    const after = step(before, { t: 'skill-select', name: 'review' });

    expect(after).not.toBe(before);
    expect(after.overlay).toBe('none');

    // Only the overlay changed (phase stays streaming since a live turn is open).
    const { overlay: _beforeOverlay, ...beforeRest } = before;
    const { overlay: _afterOverlay, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });
});

describe('reducer — clear preserves permissionMode (W5 Unit 5.2)', () => {
  it('keeps the runtime permission mode across a clear', () => {
    let s = step(initialState(), { t: 'set-permission-mode', mode: 'acceptEdits' });
    s = step(s, { t: 'user-submit', id: 'u1', text: 'hi' });
    const cleared = step(s, { t: 'clear' });
    expect(cleared.permissionMode).toBe('acceptEdits');
    // F: clear leaves ONLY the `session cleared` notice (no prior conversation).
    expect(cleared.committed).toEqual([CLEARED_NOTICE]);
  });
});

describe('reducer — error', () => {
  it('sets phase=error, commits a system msg, stores errorMessage', () => {
    const s = step(initialState(), { t: 'error', message: 'kaboom' });
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('kaboom');
    expect(s.committed.at(-1)).toEqual({
      id: 'system-error-0',
      role: 'system',
      blocks: [{ kind: 'text', id: 'system-error-0:block:1', text: 'kaboom' }],
      done: true,
      // terminal-error-visibility: the committed failure carries a `tone: 'error'`
      // discriminator so the renderer surfaces `✗ error` instead of the dim `system`
      // heading (a benign `session cleared` notice looks otherwise identical).
      tone: 'error',
    });
  });

  it("stamps tone:'error' on the committed line (renderer failure-vs-chrome discriminator)", () => {
    const s = step(initialState(), { t: 'error', message: 'provider 503' });
    const committed = s.committed.at(-1);
    expect(committed?.tone).toBe('error');
    expect(committed?.role).toBe('system');
    // Multiple errors in one session keep unique ids AND each carry the tone.
    const s2 = step(s, { t: 'error', message: 'provider 429' });
    expect(s2.committed.at(-1)?.id).toBe('system-error-1');
    expect(s2.committed.at(-1)?.tone).toBe('error');
  });

  it('clears the in-flight live turn so the streaming spinner stops (mid-stream error)', () => {
    // A partial assistant msg (done:false) is streaming when the stream errors.
    // StreamingMessage renders an animated Spinner whenever !live.done, so the error
    // case MUST drop `live` (mirroring `aborted`) or the spinner spins forever below
    // the committed error message.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'partial answer' });
    expect(s.live).not.toBeNull();
    expect(s.live!.done).toBe(false);
    s = step(s, { t: 'error', message: 'connection dropped' });
    expect(s.live).toBeNull();
    expect(s.phase).toBe('error');
    // The committed error is still surfaced.
    expect(s.errorMessage).toBe('connection dropped');
  });

  it('drops an open permission overlay on a mid-stream error (no stranded prompt)', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.overlay).toBe('permission');
    expect(s.pendingPermissionToolCallId).toBe('tc1');
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.overlay).toBe('none');
    expect(s.pendingPermissionToolCallId).toBeNull();
    expect(s.live).toBeNull();
  });

  it('leaves a non-permission overlay untouched on error', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.overlay).toBe('slash');
    expect(s.live).toBeNull();
  });
});

describe('reducer — notice (F: feedback + empty states)', () => {
  it('appends a dim system notice as a committed message (append path, no epoch bump)', () => {
    const before = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hi' });
    const text = 'compacted: 3 messages → summary (900 → 120 tokens)';
    const after = step(before, { t: 'notice', text });
    expect(after.committed).toHaveLength(2);
    expect(after.committed[1]).toEqual({
      id: 'notice-1',
      role: 'system',
      done: true,
      blocks: [{ kind: 'notice', id: 'notice-1:block:1', text }],
    });
    // Appending grows <Static> — it must NOT remount (no transcriptEpoch bump).
    expect(after.transcriptEpoch).toBeUndefined();
    // The prior message is preserved (not a wholesale replace like clear/compact).
    expect(after.committed[0]).toEqual(before.committed[0]);
  });

  it('derives a stable id from committed length (mirrors the error case)', () => {
    let s = step(initialState(), { t: 'notice', text: 'first' });
    expect(s.committed[0]?.id).toBe('notice-0');
    s = step(s, { t: 'notice', text: 'second' });
    expect(s.committed[1]?.id).toBe('notice-1');
  });
});

describe('reducer — clear', () => {
  it('resets conversation/turn state (incl. tokens) but preserves effort + permissionMode', () => {
    let s = streamingState();
    s = step(s, { t: 'usage', tokensIn: 100, tokensOut: 50 });
    s = step(s, { t: 'set-effort', effort: 'high' });
    s = step(s, { t: 'error', message: 'x' });
    // Sanity: tokens accumulated before the clear.
    expect(s.tokens).toEqual({ in: 100, out: 50 });
    const cleared = step(s, { t: 'clear' });
    // clear replaces `committed` wholesale → transcriptEpoch bumps so <Static> remounts.
    // F: the emptied transcript carries the single `session cleared` notice.
    // E: cumulative `tokens` are RESET (no longer preserved), so the derived
    // tok/cost/context-fraction readouts zero out on a fresh session.
    expect(cleared).toEqual({
      ...initialState(),
      effort: 'high',
      committed: [CLEARED_NOTICE],
      transcriptEpoch: 1,
    });
    expect(cleared.tokens).toEqual(initialState().tokens);
  });
});

describe('events — eventToAction', () => {
  it('maps every event variant 1:1', () => {
    expect(eventToAction({ type: 'assistant-start', id: 'a1' })).toEqual({ t: 'assistant-start', id: 'a1' });
    expect(eventToAction({ type: 'text-delta', id: 'a1', delta: 'x' })).toEqual({ t: 'text-delta', id: 'a1', delta: 'x' });
    expect(eventToAction({ type: 'reasoning-delta', id: 'a1', delta: 'r' }))
      .toEqual({ t: 'reasoning-delta', id: 'a1', delta: 'r' });
    expect(eventToAction({ type: 'tool-call', id: 'a1', toolCallId: 'tc', name: 'n', args: 1 }))
      .toEqual({ t: 'tool-call', toolCallId: 'tc', name: 'n', args: 1 });
    expect(eventToAction({ type: 'tool-call-delta', toolCallId: 'tc', argsDelta: '{"a"' }))
      .toEqual({ t: 'tool-call-delta', toolCallId: 'tc', argsDelta: '{"a"' });
    expect(eventToAction({ type: 'tool-status', toolCallId: 'tc', status: 'running' }))
      .toEqual({ t: 'tool-status', toolCallId: 'tc', status: 'running', result: undefined, error: undefined });
    expect(eventToAction({ type: 'permission-open', toolCallId: 'tc', name: 'n', args: 1, risk: 'risky' }))
      .toEqual({ t: 'permission-open', toolCallId: 'tc', name: 'n', args: 1, risk: 'risky' });
    expect(eventToAction({ type: 'permission-resolved', toolCallId: 'tc', decision: 'deny' }))
      .toEqual({ t: 'permission-resolved', toolCallId: 'tc', decision: 'deny' });
    expect(eventToAction({ type: 'assistant-done', id: 'a1', stopReason: 'end' }))
      .toEqual({ t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(eventToAction({ type: 'usage', tokensIn: 1, tokensOut: 2 }))
      .toEqual({ t: 'usage', tokensIn: 1, tokensOut: 2 });
    expect(eventToAction({ type: 'aborted', reason: 'user' }))
      .toEqual({ t: 'aborted', reason: 'user' });
    expect(eventToAction({ type: 'error', message: 'e' })).toEqual({ t: 'error', message: 'e' });
  });
});

describe('reducer — reasoning-delta', () => {
  it('accumulates reasoning text on the live msg', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'Let me ' });
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'think.' });
    expect(s.live!.reasoning).toBe('Let me think.');
    // Reasoning lives off the block list; no blocks created.
    expect(s.live!.blocks).toEqual([]);
  });

  it('ignores reasoning with no live msg or id mismatch (no-op, same ref)', () => {
    const empty = initialState();
    expect(step(empty, { t: 'reasoning-delta', id: 'a1', delta: 'x' })).toBe(empty);
    const s = streamingState();
    expect(step(s, { t: 'reasoning-delta', id: 'other', delta: 'x' })).toBe(s);
  });
});

// thinking-collapse: the reducer freezes the thinking-phase bounds from the
// dispatch-edge `ts` (it never reads a clock itself). Absent `ts` ⇒ no bounds.
describe('reducer — thinking-phase bounds (✻ thought for <n>s)', () => {
  it('stamps reasoningStartedAt on the FIRST reasoning delta only', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'Let me ', ts: 1_000 });
    expect(s.live!.reasoningStartedAt).toBe(1_000);
    // A later delta must NOT move the start.
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'think.', ts: 2_500 });
    expect(s.live!.reasoningStartedAt).toBe(1_000);
    expect(s.live!.reasoningEndedAt).toBeUndefined();
  });

  it('closes the phase at the first visible text delta', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'mull', ts: 1_000 });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'Answer', ts: 4_000 });
    expect(s.live!.reasoningEndedAt).toBe(4_000);
    // A later text delta must NOT move the end.
    s = step(s, { t: 'text-delta', id: 'a1', delta: ' more', ts: 9_000 });
    expect(s.live!.reasoningEndedAt).toBe(4_000);
  });

  it('closes the phase at a tool call when the model thinks then acts (no prose)', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'mull', ts: 1_000 });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'grep', args: {}, ts: 3_000 });
    expect(s.live!.reasoningEndedAt).toBe(3_000);
  });

  it('falls back to assistant-done for a pure-thinking turn (no text/tool followed)', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'mull', ts: 1_000 });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end', ts: 6_000 });
    const done = s.committed.at(-1)!;
    expect(done.reasoningStartedAt).toBe(1_000);
    expect(done.reasoningEndedAt).toBe(6_000);
  });

  it('leaves the bounds absent when the edge supplies no clock (duration unavailable)', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'mull' });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'Answer' });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    const done = s.committed.at(-1)!;
    expect(done.reasoningStartedAt).toBeUndefined();
    expect(done.reasoningEndedAt).toBeUndefined();
  });
});

describe('reducer — tool-call-delta', () => {
  it('accumulates partial arg text onto a pending tool entry', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: undefined });
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '{"dir":' });
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '"."}' });
    expect(s.tools['tc1'].argsText).toBe('{"dir":"."}');
    expect(s.tools['tc1'].name).toBe('list_files');
  });

  it('opens a pending entry if a delta arrives before tool-call', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc9', argsDelta: '{"x"' });
    expect(s.tools['tc9']).toEqual({ status: 'pending', name: '', args: undefined, argsText: '{"x"' });
  });
});

describe('reducer — aborted', () => {
  it('drops live + pending permission, returns to idle, keeps prior history + tokens', () => {
    let s = streamingState();
    s = step(s, { t: 'usage', tokensIn: 10, tokensOut: 5 });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'partial' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.pendingPermissionToolCallId).toBe('tc1');

    const priorHistory = s.committed; // just the user msg so far
    s = step(s, { t: 'aborted', reason: 'user cancelled' });
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
    expect(s.overlay).toBe('none');
    expect(s.pendingPermissionToolCallId).toBeNull();
    // The prior turns are untouched; the cancelled turn is committed AFTER them.
    expect(s.committed.slice(0, priorHistory.length)).toEqual(priorHistory);
    // user-submit no longer estimates input; tokens come only from the usage event.
    expect(s.tokens).toEqual({ in: 10, out: 5 });
  });

  it('commits the partial live turn (spec item 1: transcript preserved) with an interrupted marker', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'the partial answer the user was reading' });
    const committedCountBefore = s.committed.length;

    s = step(s, { t: 'aborted', reason: 'user' });

    // A first-press Ctrl+C must NOT vanish the partially streamed text.
    expect(s.committed).toHaveLength(committedCountBefore + 1);
    const cut = s.committed.at(-1)!;
    expect(cut.role).toBe('assistant');
    expect(cut.done).toBe(true);
    // The partial text survives verbatim as the frozen turn's first block…
    expect(cut.blocks[0]).toEqual({
      kind: 'text',
      id: 'a1:block:1',
      text: 'the partial answer the user was reading',
    });
    // …trailed by a dim `interrupted` notice marking the turn as cut short.
    expect(cut.blocks.at(-1)).toEqual({
      kind: 'notice',
      id: 'a1:block:2',
      text: 'interrupted',
    });
  });

  it('freezes cancelled turn tool calls into a toolSnapshot (Static never reads the live map)', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'calling a tool then interrupted' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'read_file', args: { path: 'x' } });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });

    s = step(s, { t: 'aborted' });
    const cut = s.committed.at(-1)!;
    // name/args are preserved verbatim (turn-replay reads them off the snapshot)…
    expect(cut.toolSnapshot?.tc1).toMatchObject({ name: 'read_file', args: { path: 'x' } });
    // The tool block is retained alongside the interrupted marker.
    expect(cut.blocks.some((b) => b.kind === 'tool' && b.toolCallId === 'tc1')).toBe(true);
    expect(cut.blocks.at(-1)).toMatchObject({ kind: 'notice', text: 'interrupted' });
  });

  it('NORMALIZES a still-in-flight member so <Static> never freezes a live spinner/dot', () => {
    // A member left 'running' at abort renders an ANIMATED spinner; committed into the
    // append-only <Static> path (printed once, never redrawn) that spinner freezes into a
    // stuck frame. commitInterrupted rewrites in-flight members to a settled glyph.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'four tools then interrupted' });
    // running → normalized to a terminal error carrying the 'interrupted' reason
    s = step(s, { t: 'tool-call', toolCallId: 'tc-run', name: 'grep', args: { pattern: 'x' } });
    s = step(s, { t: 'tool-status', toolCallId: 'tc-run', status: 'running' });
    // pending (queued, never started) → also normalized (a live dot must not freeze either)
    s = step(s, { t: 'tool-call', toolCallId: 'tc-pend', name: 'read_file', args: { path: 'y' } });
    // already-settled result → preserved untouched (never re-marked as interrupted)
    s = step(s, { t: 'tool-call', toolCallId: 'tc-done', name: 'list_files', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc-done', status: 'result', result: 'ok' });
    // already-errored → keeps its OWN reason, not overwritten with 'interrupted'
    s = step(s, { t: 'tool-call', toolCallId: 'tc-err', name: 'write_file', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc-err', status: 'error', error: 'disk full' });

    s = step(s, { t: 'aborted' });
    const snap = s.committed.at(-1)!.toolSnapshot!;
    // No committed member is left in a non-terminal state (no spinner/dot to freeze).
    for (const tool of Object.values(snap)) {
      expect(tool.status === 'result' || tool.status === 'error').toBe(true);
    }
    expect(snap['tc-run']).toMatchObject({ name: 'grep', status: 'error', error: 'interrupted' });
    expect(snap['tc-pend']).toMatchObject({ name: 'read_file', status: 'error', error: 'interrupted' });
    expect(snap['tc-done']).toMatchObject({ status: 'result', result: 'ok' });
    expect(snap['tc-err']).toMatchObject({ status: 'error', error: 'disk full' }); // own reason kept
  });

  it('is a no-op on committed when there is no live turn to preserve', () => {
    let s = initialState();
    s = step(s, { t: 'user-submit', id: 'u1', text: 'hi' });
    const committedBefore = s.committed;
    s = step(s, { t: 'aborted' }); // aborted with live === null
    expect(s.committed).toBe(committedBefore);
    expect(s.live).toBeNull();
    expect(s.phase).toBe('idle');
  });

  it('accepts an aborted action without a reason', () => {
    const s = step(streamingState(), { t: 'aborted' });
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
  });

  it('leaves a non-permission overlay untouched', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    s = step(s, { t: 'aborted' });
    expect(s.overlay).toBe('slash');
  });
});

describe('reducer — assistant-done stopReason union', () => {
  it('accepts every StopReason variant', () => {
    const reasons = ['end', 'tool_use', 'max_tokens', 'abort', 'error'] as const;
    for (const stopReason of reasons) {
      let s = streamingState();
      s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
      s = step(s, { t: 'assistant-done', id: 'a1', stopReason });
      expect(s.live).toBeNull();
      expect(s.committed.at(-1)!.done).toBe(true);
    }
  });
});

describe('contracts — TurnMessage tool shape (type-level)', () => {
  it('admits system/user, assistant-with-toolCalls, and tool messages', () => {
    // Compile-time coverage: each branch of the TurnMessage union must type-check.
    const messages: TurnMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: 'calling tool',
        toolCalls: [{ toolCallId: 'tc1', name: 'list_files', args: { dir: '.' } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: '["a.txt","b.txt"]' },
    ];
    const toolMsg = messages[3]!;
    expect(toolMsg).toEqual({ role: 'tool', toolCallId: 'tc1', content: '["a.txt","b.txt"]' });
    // The tool result content is a string keyed back to the assistant's toolCall.
    if (toolMsg.role === 'tool') expect(toolMsg.toolCallId).toBe('tc1');
  });
});

describe('events — AgentEvent new variants are total', () => {
  it('reducer handles every new event end-to-end via eventToAction', () => {
    const events: AgentEvent[] = [
      { type: 'assistant-start', id: 'a1' },
      { type: 'reasoning-delta', id: 'a1', delta: 'hm' },
      { type: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '{}' },
      { type: 'aborted', reason: 'stop' },
    ];
    let s = initialState();
    for (const e of events) s = reducer(s, eventToAction(e));
    expect(s.phase).toBe('idle'); // aborted last
  });
});

describe('reducer — purity / immutability', () => {
  it('never mutates the input state across a full lifecycle', () => {
    let s = initialState();
    const actions: Action[] = [
      { t: 'user-submit', id: 'u1', text: 'hi' },
      { t: 'assistant-start', id: 'a1' },
      { t: 'text-delta', id: 'a1', delta: 'x' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} },
      { t: 'tool-status', toolCallId: 'tc1', status: 'running' },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 },
      { t: 'assistant-done', id: 'a1', stopReason: 'end' },
      { t: 'usage', tokensIn: 1, tokensOut: 1 },
      { t: 'cycle-effort' },
      { t: 'clear' },
    ];
    for (const a of actions) {
      const snapshot = JSON.parse(JSON.stringify(s)) as State;
      const next = step(s, a);
      expect(JSON.parse(JSON.stringify(s))).toEqual(snapshot); // input unchanged
      if (JSON.stringify(next) !== JSON.stringify(s)) {
        expect(next).not.toBe(s); // new ref when state changed
      }
      s = next;
    }
  });

  it('works with a deep-frozen input without throwing', () => {
    const frozen = deepFreeze(step(initialState(), { t: 'assistant-start', id: 'a1' }));
    const next = step(frozen, { t: 'text-delta', id: 'a1', delta: 'hello' });
    expect(next).not.toBe(frozen);
    expect(frozen.live!.blocks).toEqual([]);
    expect(next.live!.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'hello' }]);
  });
});

describe('reducer — resume-session (Session Resume, Unit 1)', () => {
  const loadedMsgs: Msg[] = [
    {
      id: 'u1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello from a past session' }],
      done: true,
    },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ kind: 'text', id: 'a1:block:1', text: 'welcome back' }],
      done: true,
    },
  ];

  /** A dirty in-flight state: streaming, open overlay, pending permission, tokens, error. */
  function dirtyState(): State {
    let s = initialState();
    s = step(s, { t: 'set-effort', effort: 'high' });
    s = step(s, { t: 'set-permission-mode', mode: 'acceptEdits' });
    s = step(s, { t: 'user-submit', id: 'old', text: 'old turn' });
    s = step(s, { t: 'assistant-start', id: 'aOld' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });
    s = step(s, { t: 'usage', tokensIn: 99, tokensOut: 42 });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'read', args: {}, risk: 'risky' });
    return s;
  }

  it('replaces committed wholesale and clears live/tools/phase/overlay/pendingPermission/error', () => {
    const before = dirtyState();
    const s = step(before, { t: 'resume-session', messages: loadedMsgs });
    expect(s.committed).toEqual(loadedMsgs);
    expect(s.live).toBeNull();
    expect(s.tools).toEqual({});
    expect(s.phase).toBe('idle');
    expect(s.overlay).toBe('none');
    expect(s.pendingPermissionToolCallId).toBeNull();
    expect(s.errorMessage).toBeNull();
  });

  it('resets token totals to zero (session totals are not persisted)', () => {
    const before = dirtyState();
    expect(before.tokens).toEqual({ in: 99, out: 42 });
    const s = step(before, { t: 'resume-session', messages: loadedMsgs });
    expect(s.tokens).toEqual({ in: 0, out: 0 });
  });

  it('PRESERVES the user prefs effort + permissionMode (same class as clear)', () => {
    const before = dirtyState();
    const s = step(before, { t: 'resume-session', messages: loadedMsgs });
    expect(s.effort).toBe('high');
    expect(s.permissionMode).toBe('acceptEdits');
  });

  it('is pure: returns a NEW state ref and does not mutate the deep-frozen input', () => {
    const before = deepFreeze(dirtyState());
    const s = step(before, { t: 'resume-session', messages: loadedMsgs });
    expect(s).not.toBe(before);
    // input untouched
    expect(before.committed.map((m) => m.id)).toEqual(['old']);
    expect(before.tokens).toEqual({ in: 99, out: 42 });
  });

  it('empty-array resume yields empty committed + idle phase', () => {
    const s = step(dirtyState(), { t: 'resume-session', messages: [] });
    expect(s.committed).toEqual([]);
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
  });

  it('resets compactions (a fresh resumed transcript must not inherit the prior session compaction count)', () => {
    // dirtyState() never compacts → state.compactions stays undefined and the bug
    // hides. Build a state WITH compaction history to expose the carry-over.
    let before = dirtyState();
    before = step(before, { t: 'compact', summaryText: 'prior summary', keepCount: 0 });
    expect(before.compactions).toBe(1);
    const s = step(before, { t: 'resume-session', messages: loadedMsgs });
    expect(s.compactions).toBeUndefined();
    // and the next compact on the resumed transcript starts a fresh compaction-1 id
    const after = step(s, { t: 'compact', summaryText: 'fresh summary', keepCount: 0 });
    expect(after.compactions).toBe(1);
    expect(after.committed[0].id).toBe('compaction-1');
  });
});

describe('reducer — transcriptEpoch (remounts <Static> on wholesale committed replacement)', () => {
  const loaded: Msg[] = [
    { id: 'r1', role: 'user', blocks: [{ kind: 'text', id: 'r1:block:1', text: 'resumed one' }], done: true },
    { id: 'r2', role: 'assistant', blocks: [{ kind: 'text', id: 'r2:block:1', text: 'resumed two' }], done: true },
  ];

  it('is absent initially and unchanged by appends (user-submit / assistant-done / error)', () => {
    let s = initialState();
    expect(s.transcriptEpoch).toBeUndefined();
    s = step(s, { t: 'user-submit', id: 'u1', text: 'hi' });
    s = step(s, { t: 'assistant-start', id: 'a1' });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'yo' });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    s = step(s, { t: 'error', message: 'boom' });
    // committed grew by appending → Static's index advances naturally, no remount.
    expect(s.transcriptEpoch).toBeUndefined();
  });

  it('bumps on resume-session (committed replaced → Static must remount)', () => {
    const before = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hi' });
    expect(before.transcriptEpoch).toBeUndefined();
    const s = step(before, { t: 'resume-session', messages: loaded });
    expect(s.transcriptEpoch).toBe(1);
  });

  it('bumps on clear (committed emptied → Static must remount)', () => {
    const before = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hi' });
    const s = step(before, { t: 'clear' });
    expect(s.transcriptEpoch).toBe(1);
  });

  it('bumps on compact (committed replaced by summary + tail → Static must remount)', () => {
    let before = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hi' });
    before = step(before, { t: 'user-submit', id: 'u2', text: 'again' });
    const s = step(before, { t: 'compact', summaryText: 'summary', keepCount: 1 });
    expect(s.transcriptEpoch).toBe(1);
  });

  it('is strictly monotonic across a sequence of replacements', () => {
    let s = step(initialState(), { t: 'resume-session', messages: loaded });
    expect(s.transcriptEpoch).toBe(1);
    s = step(s, { t: 'compact', summaryText: 'sum', keepCount: 1 });
    expect(s.transcriptEpoch).toBe(2);
    s = step(s, { t: 'clear' });
    expect(s.transcriptEpoch).toBe(3);
    // an append in between does not bump it
    s = step(s, { t: 'user-submit', id: 'u9', text: 'mid' });
    expect(s.transcriptEpoch).toBe(3);
    s = step(s, { t: 'resume-session', messages: loaded });
    expect(s.transcriptEpoch).toBe(4);
  });
});
