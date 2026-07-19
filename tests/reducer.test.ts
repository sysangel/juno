// tests/reducer.test.ts
// W3 — covers every reducer Action variant plus the tricky lifecycle paths.
import { describe, it, expect } from 'vitest';
import { reducer, initialState, type State, type Action, type Msg } from '../src/core/reducer';
import { eventToAction, type AgentEvent } from '../src/core/events';
import { envelope } from '../src/core/errorEnvelope';
import { shouldRingBell } from '../src/hooks/useCompletionBell';
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
      pendingPermission: null,
      errorMessage: null,
    });
  });

  it('seeds permissionMode from the construction arg (frame-1 honesty)', () => {
    expect(initialState({ permissionMode: 'acceptEdits' }).permissionMode).toBe('acceptEdits');
    // Absent arg ⇒ 'default'; the new optional counters stay ABSENT (additive shape).
    const s = initialState();
    expect(s.permissionMode).toBe('default');
    expect(s.completedTurns).toBeUndefined();
    expect(s.noticeSeq).toBeUndefined();
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

  it('forwarded subagent-child call (parentToolUseId) registers WITHOUT appending a block to the parent live msg', () => {
    // Background use-case: a detached child surfaces a tool-call into the parent's
    // dispatch while the parent is streaming a NEW turn. The child block belongs to
    // the child card (parentToolUseId), never the parent's live assistant message —
    // else a stray render-suppressed block persists into the committed parent msg.
    let s = streamingState();
    const blocksBefore = s.live!.blocks;
    s = step(s, { t: 'tool-call', toolCallId: 'sa-child-1', name: 'read', args: { path: 'x' }, parentToolUseId: 'spawn-1' });
    // Tool is registered (so a later child tool-status isn't dropped) and keyed by parent.
    expect(s.tools['sa-child-1']).toEqual({ status: 'pending', name: 'read', args: { path: 'x' }, parentToolUseId: 'spawn-1' });
    // No child grouping id (children group by parentToolUseId, not concurrency batch).
    expect(s.tools['sa-child-1'].concurrencyGroupId).toBeUndefined();
    // Parent's live blocks are untouched.
    expect(s.live!.blocks).toBe(blocksBefore);
  });

  it('forwarded subagent-child call does NOT stamp the parent thinking clock (endsThinking suppressed)', () => {
    // The parent is mid-think when a background child call arrives. The child must
    // not close the parent's '✻ thought for Ns' marker early.
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'still mulling', ts: 1_000 });
    s = step(s, { t: 'tool-call', toolCallId: 'sa-child-1', name: 'grep', args: {}, parentToolUseId: 'spawn-1', ts: 3_000 });
    expect(s.live!.reasoningStartedAt).toBe(1_000);
    expect(s.live!.reasoningEndedAt).toBeUndefined();
    // A subsequent TOP-LEVEL (parentless) call still closes the phase normally.
    s = step(s, { t: 'tool-call', toolCallId: 'tc-top', name: 'read', args: {}, ts: 5_000 });
    expect(s.live!.reasoningEndedAt).toBe(5_000);
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

  it('a top-level tool result during a raw-API round keeps the turn streaming with live null (no idle blip)', () => {
    // Raw-API rounds null `live` at assistant-done(tool_use) BEFORE the tool result lands.
    // The result must NOT drop phase to 'idle' mid-turn (that briefly cleared the busy line
    // and, pre-fix, rang the bell). turn-settle / the terminal assistant-done own 'idle'.
    let s = streamingState(); // assistant-start → streaming
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'tool_use' }); // commits + nulls live
    expect(s.live).toBeNull();
    expect(s.phase).toBe('streaming');
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(s.phase).toBe('running-tool');
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 });
    expect(s.phase).toBe('streaming'); // NOT idle, even though live is null — the round continues
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

  it('forwarded subagent-child running status is phase-neutral (does NOT re-pin the busy line)', () => {
    // Parent turn is idle (child runs on a detached loop). A child 'running' surfaced
    // through the parent dispatch must NOT flip phase to 'running-tool' and re-pin the
    // spinner for the child's whole duration.
    let s = step(initialState(), { t: 'tool-call', toolCallId: 'sa-child-1', name: 'n', args: {}, parentToolUseId: 'spawn-1' });
    expect(s.phase).toBe('idle');
    s = step(s, { t: 'tool-status', toolCallId: 'sa-child-1', status: 'running' });
    expect(s.tools['sa-child-1'].status).toBe('running'); // status still recorded
    expect(s.phase).toBe('idle'); // …but phase untouched
  });

  it('forwarded subagent-child result does NOT flip the parent phase mid-turn', () => {
    // A real parent tool is running (phase 'running-tool') when a background child
    // settles. The child 'result' must not flip the parent to 'idle'/'streaming'.
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc-parent', name: 'grep', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc-parent', status: 'running' });
    expect(s.phase).toBe('running-tool');
    s = step(s, { t: 'tool-call', toolCallId: 'sa-child-1', name: 'read', args: {}, parentToolUseId: 'spawn-1' });
    s = step(s, { t: 'tool-status', toolCallId: 'sa-child-1', status: 'result', result: 'child done' });
    expect(s.tools['sa-child-1'].status).toBe('result');
    expect(s.phase).toBe('running-tool'); // parent phase held
  });

  it('forwarded subagent-child status still honors the error race guard', () => {
    // Phase-neutrality does not weaken the terminal-error guard for child cards.
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'sa-child-1', name: 'n', args: {}, parentToolUseId: 'spawn-1' });
    s = step(s, { t: 'tool-status', toolCallId: 'sa-child-1', status: 'error', error: 'boom' });
    const errored = s;
    s = step(s, { t: 'tool-status', toolCallId: 'sa-child-1', status: 'result', result: 'late' });
    expect(s).toBe(errored); // no-op, same ref
    expect(s.tools['sa-child-1']).toEqual({ status: 'error', name: 'n', args: {}, error: 'boom', parentToolUseId: 'spawn-1' });
  });
});

describe('reducer — permission-open / permission-resolved', () => {
  it('opens the permission overlay and awaits, then resolves back to streaming', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc2', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc2', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.overlay).toBe('permission');
    expect(s.phase).toBe('awaiting-permission');
    expect(s.pendingPermission).toEqual({ toolCallId: 'tc2', risk: 'risky' });
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc2', decision: 'allow-once' });
    expect(s.overlay).toBe('none');
    expect(s.phase).toBe('streaming');
    expect(s.pendingPermission).toBeNull();
  });

  it('permission-open is defensive: registers a tools entry if tool-call did not precede', () => {
    let s = initialState();
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: { p: 1 }, risk: 'dangerous' });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'write_file', args: { p: 1 } });
  });

  it('permission-resolved returns to the in-flight streaming phase (a prompt only opens mid-turn)', () => {
    // A permission prompt only ever opens while a turn is in flight, so resolving it hands
    // back to 'streaming' unconditionally — never a mid-turn idle blip, even in this
    // synthetic no-live-msg unit (the real drop to idle is owned by turn-settle/aborted).
    let s = step(initialState(), { t: 'permission-open', toolCallId: 'tc1', name: 'n', args: {}, risk: 'risky' });
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });
    expect(s.phase).toBe('streaming');
    expect(s.overlay).toBe('none');
  });

  it('a permission drained to deny AFTER an abort does NOT resurrect the dead turn', () => {
    // Coordinator drain-on-abort ordering: aborted (→ idle) THEN the parked prompt resolves
    // to 'deny' as the registry drains. That late permission-resolved must leave phase 'idle'
    // — it must not re-pin the busy line on a turn that already ended.
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.phase).toBe('awaiting-permission');
    s = step(s, { t: 'aborted', reason: 'user cancelled' });
    expect(s.phase).toBe('idle');
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });
    expect(s.phase).toBe('idle'); // stays idle — dead turn not resurrected
  });

  it('a settling top-level tool-status (result) for the pending id clears pendingPermission', () => {
    // The tool the prompt was for finished before the user answered (e.g. the coordinator
    // resolved it out-of-band): the pending prompt is moot, so the field must drain — the
    // reducer owns this, mirroring the retired permissionRisksRef side-table's tool-terminal prune.
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.pendingPermission).toEqual({ toolCallId: 'tc1', risk: 'risky' });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'ok' });
    expect(s.pendingPermission).toBeNull();
  });

  it('a settling top-level tool-status (error) for the pending id clears pendingPermission', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.pendingPermission).toEqual({ toolCallId: 'tc1', risk: 'risky' });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'boom' });
    expect(s.pendingPermission).toBeNull();
  });

  it('a settling tool-status for a DIFFERENT id leaves an open pendingPermission untouched', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'tool-call', toolCallId: 'tc2', name: 'read_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    // A different tool settling must not disturb the prompt still open for tc1.
    s = step(s, { t: 'tool-status', toolCallId: 'tc2', status: 'result', result: 'ok' });
    expect(s.pendingPermission).toEqual({ toolCallId: 'tc1', risk: 'risky' });
    // A non-terminal status (running) for the pending id also leaves it untouched.
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(s.pendingPermission).toEqual({ toolCallId: 'tc1', risk: 'risky' });
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

  // b6-boundary-honesty item 1 — THE HAZARD: a CHILD (subagent) usage carrying
  // parentToolUseId must feed the cumulative cost meter for display but NEVER clobber
  // the parent's context-window occupancy. A child runs in a fresh, isolated context;
  // its large input size inflating the parent gauge would trigger a needless compaction
  // of a window the child never touched.
  it('a CHILD usage (parentToolUseId set) bubbles tokens but NEVER touches contextWindowTokens', () => {
    // Seed a real parent measurement: the parent window is 1000.
    let s = step(initialState(), { t: 'usage', tokensIn: 1000, tokensOut: 0, contextTokens: 1000 });
    expect(s.contextWindowTokens).toBe(1000);
    // A child spends a LOT (5000 in) with NO contextTokens — the pre-fix fallback would
    // have set contextWindowTokens to 5000. The parentToolUseId marker prevents that.
    s = step(s, { t: 'usage', tokensIn: 5000, tokensOut: 200, parentToolUseId: 'call-x' });
    expect(s.contextWindowTokens).toBe(1000); // NOT clobbered to 5000
    expect(s.tokens.in).toBe(6000); // display/cost meter still bubbles the child spend
    expect(s.tokens.out).toBe(200);
  });

  it('a PARENT usage (no parentToolUseId) still updates contextWindowTokens (regression guard)', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 1000, tokensOut: 0, contextTokens: 1000 });
    // A later parent usage re-measures the window (replaces, as before the fix).
    s = step(s, { t: 'usage', tokensIn: 1800, tokensOut: 50, contextTokens: 1800 });
    expect(s.contextWindowTokens).toBe(1800);
    expect(s.tokens.in).toBe(2800);
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
    expect(s.pendingPermission?.toolCallId).toBe('tc1');
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.overlay).toBe('none');
    // error-while-prompt-open now clears the pending prompt structurally (the old
    // permissionRisksRef side-table MISSED the 'error' case — a real leak, fixed here).
    expect(s.pendingPermission).toBeNull();
    expect(s.live).toBeNull();
  });

  it('leaves a non-permission overlay untouched on error', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.overlay).toBe('slash');
    expect(s.live).toBeNull();
  });

  it('preserves the partially streamed answer and normalizes in-flight tools on a mid-stream error', () => {
    // FREEZE-ON-ERROR (spec item 2, S1 data loss): a provider throw / stall / error
    // frame mid-turn must be NON-DESTRUCTIVE — the text the user was already reading
    // survives, exactly as an abort preserves it. The frozen partial turn is committed
    // AHEAD of the `✗ error` line so scrollback reads partial-answer → failure notice.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'the streamed answer' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'grep', args: { pattern: 'x' } });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    s = step(s, { t: 'error', message: 'provider exploded' });

    // Frozen assistant turn committed BEFORE the error line.
    const frozen = s.committed.at(-2)!;
    expect(frozen.role).toBe('assistant');
    expect(frozen.done).toBe(true);
    expect(frozen.blocks[0]).toMatchObject({ kind: 'text', text: 'the streamed answer' });
    expect(frozen.blocks.at(-1)).toMatchObject({ kind: 'notice', text: 'interrupted' });
    // The in-flight tool is normalized to a settled glyph (no live spinner frozen).
    expect(frozen.toolSnapshot!.tc1.status).toBe('error');

    // The system error line follows, carrying the actual failure text.
    const errorLine = s.committed.at(-1)!;
    expect(errorLine.role).toBe('system');
    expect(errorLine.tone).toBe('error');
    expect(errorLine.blocks[0]).toMatchObject({ text: 'provider exploded' });

    expect(s.live).toBeNull();
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('provider exploded');
  });

  it('zero-streamed-content error adds no empty frozen message', () => {
    // assistant-start fired but nothing streamed (no text/tool/reasoning) → the content
    // guard suppresses an empty frozen turn; only the error line is committed.
    let s = streamingState();
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.committed).toHaveLength(2); // [user, errorLine]
    expect(s.committed.every((m) => m.role !== 'assistant')).toBe(true);
    expect(s.committed.at(-1)!.tone).toBe('error');
    expect(s.live).toBeNull();
  });

  it('no double-commit when an error follows an abort', () => {
    // Once `aborted` commits + nulls `live`, a trailing error must not re-commit the
    // already-frozen turn (`live === null` guard) — only the error line is appended.
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'partial' });
    s = step(s, { t: 'aborted', reason: 'user' });
    const n = s.committed.length;
    s = step(s, { t: 'error', message: 'late error' });
    expect(s.committed.length).toBe(n + 1);
    expect(s.committed.at(-1)!.tone).toBe('error');
    // Exactly one committed copy of turn 'a1' — no duplicate freeze.
    expect(s.committed.filter((m) => m.role === 'assistant' && m.id === 'a1')).toHaveLength(1);
  });

  it('abort path is unchanged (asymmetry lock)', () => {
    // The content guard is deliberately applied to the ERROR path ONLY. An abort with
    // empty-content live still commits a notice-only frozen turn (spec item 1), whereas
    // an error with empty-content live commits nothing extra (covered above). This locks
    // the intentional asymmetry so a future edit can't accidentally quiet the abort path.
    let s = streamingState();
    s = step(s, { t: 'aborted', reason: 'user' });
    expect(s.committed).toHaveLength(2); // [user, notice-only frozen turn]
    const cut = s.committed.at(-1)!;
    expect(cut.role).toBe('assistant');
    expect(cut.blocks).toHaveLength(1);
    expect(cut.blocks[0]).toMatchObject({ kind: 'notice', text: 'interrupted' });
  });

  // Wave 14 (a5-error-envelope): the ADDITIVE machine-readable classification rides
  // alongside the human-facing surface WITHOUT altering it.
  it('stores an enveloped classification on errorEnvelope; message/tone/phase/errorMessage UNCHANGED', () => {
    const s = step(initialState(), { t: 'error', message: 'kaboom', envelope: envelope('network') });
    // Envelope is preserved verbatim (kind + derived retryable).
    expect(s.errorEnvelope).toEqual({ kind: 'network', retryable: true });
    // Byte-identical human-facing surface — same assertions as the plain-error test above.
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('kaboom');
    expect(s.committed.at(-1)).toEqual({
      id: 'system-error-0',
      role: 'system',
      blocks: [{ kind: 'text', id: 'system-error-0:block:1', text: 'kaboom' }],
      done: true,
      tone: 'error',
    });
  });

  it('leaves errorEnvelope undefined when the error action carries NO envelope (additive back-compat)', () => {
    const s = step(initialState(), { t: 'error', message: 'x' });
    expect(s.errorEnvelope).toBeUndefined();
  });

  it('a subsequent envelope-less error CLEARS a stale envelope', () => {
    let s = step(initialState(), { t: 'error', message: 'first', envelope: envelope('rate-limit') });
    expect(s.errorEnvelope).toEqual({ kind: 'rate-limit', retryable: true });
    s = step(s, { t: 'error', message: 'second' });
    expect(s.errorEnvelope).toBeUndefined();
  });

  it('resume-session after an enveloped error clears errorEnvelope (mirrors errorMessage lifecycle)', () => {
    let s = step(initialState(), { t: 'error', message: 'boom', envelope: envelope('timeout') });
    expect(s.errorEnvelope).toEqual({ kind: 'timeout', retryable: true });
    s = step(s, { t: 'resume-session', messages: [] });
    expect(s.errorEnvelope).toBeUndefined();
    expect(s.errorMessage).toBeNull();
  });
});

describe('eventToAction — error envelope forwarding (frozen-seam regression)', () => {
  it('an error event with NO envelope maps to the pre-change action (no envelope key)', () => {
    const action = eventToAction({ type: 'error', message: 'm' });
    // Deep-equals the exact shape emitted before this lane — no `envelope` key.
    expect(action).toEqual({ t: 'error', message: 'm' });
    expect(Object.hasOwn(action, 'envelope')).toBe(false);
  });

  it('an error event WITH an envelope forwards it onto the action', () => {
    const e = envelope('network');
    expect(eventToAction({ type: 'error', message: 'm', envelope: e })).toEqual({
      t: 'error',
      message: 'm',
      envelope: { kind: 'network', retryable: true },
    });
  });
});

describe('reducer — notice (F: feedback + empty states)', () => {
  it('appends a dim system notice as a committed message (append path, no epoch bump)', () => {
    const before = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hi' });
    const text = 'compacted: 3 messages → summary (900 → 120 tokens)';
    const after = step(before, { t: 'notice', text });
    expect(after.committed).toHaveLength(2);
    expect(after.committed[1]).toEqual({
      id: 'notice-0',
      role: 'system',
      done: true,
      blocks: [{ kind: 'notice', id: 'notice-0:block:1', text }],
    });
    // Appending grows <Static> — it must NOT remount (no transcriptEpoch bump).
    expect(after.transcriptEpoch).toBeUndefined();
    // The prior message is preserved (not a wholesale replace like clear/compact).
    expect(after.committed[0]).toEqual(before.committed[0]);
  });

  it('derives a stable id from the monotonic noticeSeq counter (mirrors the error case)', () => {
    let s = step(initialState(), { t: 'notice', text: 'first' });
    expect(s.committed[0]?.id).toBe('notice-0');
    expect(s.noticeSeq).toBe(1); // cursor advanced to the NEXT id to mint
    s = step(s, { t: 'notice', text: 'second' });
    expect(s.committed[1]?.id).toBe('notice-1');
    expect(s.noticeSeq).toBe(2);
  });

  it('a notice/error after a compaction that shrank committed can NOT collide a kept-tail id', () => {
    // Regression: the old `notice-${committed.length}` scheme re-minted an id already worn
    // by a kept-tail message once a compaction shrank `committed` back past it — a duplicate
    // React key inside one <Static> batch. noticeSeq is monotonic per session, so it climbs
    // past every kept id regardless of the length.
    let s = initialState();
    for (const text of ['n1', 'n2', 'n3', 'n4']) s = step(s, { t: 'notice', text });
    expect(s.committed.map((m) => m.id)).toEqual(['notice-0', 'notice-1', 'notice-2', 'notice-3']);
    expect(s.noticeSeq).toBe(4); // cursor sits one past the last minted id

    // Compact, keeping the last two notices (notice-2, notice-3). committed shrinks to 3.
    s = step(s, { t: 'compact', summaryText: 'summary', keepCount: 2 });
    expect(s.committed.map((m) => m.id)).toEqual(['compaction-1', 'notice-2', 'notice-3']);
    expect(s.noticeSeq).toBe(4); // preserved across the compaction

    // The OLD scheme would mint `notice-${committed.length}` = 'notice-3' → COLLISION with
    // the kept notice-3. Prove the pre-fix hazard was real, then that the fix avoids it.
    expect(s.committed.some((m) => m.id === `notice-${s.committed.length}`)).toBe(true);

    // A fresh notice AND a fresh error both climb past every kept id — all ids stay unique.
    s = step(s, { t: 'notice', text: 'after' });
    expect(s.committed.at(-1)!.id).toBe('notice-4');
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.committed.at(-1)!.id).toBe('system-error-5'); // shared counter, distinct prefix
    const ids = s.committed.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // globally unique across the Static batch
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
    expect(s.pendingPermission?.toolCallId).toBe('tc1');

    const priorHistory = s.committed; // just the user msg so far
    s = step(s, { t: 'aborted', reason: 'user cancelled' });
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
    expect(s.overlay).toBe('none');
    expect(s.pendingPermission).toBeNull();
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

describe('reducer — turn/compaction lifecycle actions', () => {
  it('turn-start enters preparing and clears any stale error-frame text', () => {
    let s = step(streamingState(), { t: 'error', message: 'kaboom' });
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('kaboom');
    s = step(s, { t: 'turn-start' });
    expect(s.phase).toBe('preparing');
    expect(s.errorMessage).toBeNull(); // fresh turn after an error frame starts clean
  });

  it('turn-settle drops a hung streaming turn to idle but keeps an error terminal', () => {
    expect(step(streamingState(), { t: 'turn-settle' }).phase).toBe('idle');
    const errored = step(streamingState(), { t: 'error', message: 'x' });
    const settled = step(errored, { t: 'turn-settle' });
    expect(settled.phase).toBe('error');
    expect(settled).toBe(errored); // error → error is a no-op: SAME ref (purity contract)
  });

  it('turn-settle from an already-idle state is a no-op (SAME ref — React bails the re-render)', () => {
    const idle = initialState();
    expect(step(idle, { t: 'turn-settle' })).toBe(idle);
  });

  it('compaction-start/settle move only the phase and no-op off the compacting phase', () => {
    const s = step(initialState(), { t: 'compaction-start' });
    expect(s.phase).toBe('compacting');
    expect(step(s, { t: 'compaction-settle' }).phase).toBe('idle');
    // compaction-settle while a turn streams changes nothing → SAME ref.
    const streaming = streamingState();
    expect(step(streaming, { t: 'compaction-settle' })).toBe(streaming);
  });
});

describe('reducer — completedTurns (completion-bell counter)', () => {
  it('bumps once on a genuinely terminal assistant-done (end)', () => {
    let s = streamingState();
    expect(s.completedTurns).toBeUndefined(); // absent until the first real completion
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.completedTurns).toBe(1);
  });

  it('bumps on a max_tokens completion too', () => {
    let s = streamingState();
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'max_tokens' });
    expect(s.completedTurns).toBe(1);
  });

  it('does NOT bump on a tool_use re-entry or a steer continuation', () => {
    let s = streamingState();
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'tool_use' });
    expect(s.completedTurns ?? 0).toBe(0);
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end', continues: true });
    expect(s.completedTurns ?? 0).toBe(0);
  });

  it('does NOT bump on an abort/error-shaped assistant-done stopReason', () => {
    // A real abort/error rides the `aborted`/`error` actions; even a defensively-shaped
    // assistant-done with stopReason 'abort'/'error' must not ring the bell.
    for (const stopReason of ['abort', 'error'] as const) {
      let s = streamingState();
      s = step(s, { t: 'assistant-done', id: 'a1', stopReason });
      expect(s.completedTurns ?? 0).toBe(0);
    }
  });

  it('Esc-abort (streaming → aborted) leaves the counter untouched — the bell never rings', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'partial' });
    const before = s.completedTurns ?? 0;
    s = step(s, { t: 'aborted', reason: 'user cancelled' });
    expect(s.phase).toBe('idle'); // lands at idle, same terminal phase as a natural end…
    expect(s.completedTurns ?? 0).toBe(before); // …but the counter does NOT advance
    expect(shouldRingBell(before, s.completedTurns ?? 0)).toBe(false);
  });

  it('the error terminal does NOT bump the counter', () => {
    let s = streamingState();
    s = step(s, { t: 'error', message: 'boom' });
    expect(s.phase).toBe('error');
    expect(s.completedTurns ?? 0).toBe(0);
  });

  it('increments monotonically across successive real completions (bell rings once each)', () => {
    let s = initialState();
    let rings = 0;
    let prev = 0;
    for (let i = 0; i < 3; i += 1) {
      s = step(s, { t: 'user-submit', id: `u${i}`, text: 'go' });
      s = step(s, { t: 'assistant-start', id: `a${i}` });
      s = step(s, { t: 'assistant-done', id: `a${i}`, stopReason: 'end' });
      const now = s.completedTurns ?? 0;
      if (shouldRingBell(prev, now)) rings += 1;
      prev = now;
    }
    expect(s.completedTurns).toBe(3);
    expect(rings).toBe(3);
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
    expect(s.pendingPermission).toBeNull();
    expect(s.errorMessage).toBeNull();
  });

  it('rebuilds state.tools by folding committed toolSnapshots (so Ctrl+O has content on resume)', () => {
    // The ctrl+o tool-detail overlay derives its entries from state.tools; a resumed
    // transcript with tool cards must repopulate that map from each assistant msg's frozen
    // toolSnapshot (a later snapshot for the same id wins, transcript order).
    const withTools: Msg[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ kind: 'text', id: 'u1:block:1', text: 'read the file' }],
        done: true,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'text', id: 'a1:block:1', text: 'done' }],
        done: true,
        toolSnapshot: {
          tc1: { status: 'result', name: 'read_file', args: { path: 'x' }, result: 'hi' },
          tc2: { status: 'error', name: 'write_file', args: { path: 'y' }, error: 'nope' },
        },
      },
    ];
    const s = step(dirtyState(), { t: 'resume-session', messages: withTools });
    expect(s.tools.tc1).toEqual({ status: 'result', name: 'read_file', args: { path: 'x' }, result: 'hi' });
    expect(s.tools.tc2).toEqual({ status: 'error', name: 'write_file', args: { path: 'y' }, error: 'nope' });
    expect(Object.keys(s.tools).sort()).toEqual(['tc1', 'tc2']);
  });

  it('seeds noticeSeq PAST the loaded transcript so a resume→notice can not collide a React key', () => {
    const withNotice: Msg[] = [
      { id: 'notice-4', role: 'system', done: true, blocks: [{ kind: 'notice', id: 'notice-4:block:1', text: 'kept' }] },
      {
        id: 'system-error-7',
        role: 'system',
        done: true,
        tone: 'error',
        blocks: [{ kind: 'text', id: 'system-error-7:block:1', text: 'past error' }],
      },
    ];
    let s = step(dirtyState(), { t: 'resume-session', messages: withNotice });
    expect(s.noticeSeq).toBe(8); // one past max(4, 7) — the next id to mint
    // The next notice mints an id strictly past every loaded id — no duplicate key.
    s = step(s, { t: 'notice', text: 'fresh' });
    expect(s.committed.at(-1)!.id).toBe('notice-8');
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

describe('reducer — retry-attempt (wave-13 retry-ui)', () => {
  it('sets state.retry without changing phase (pre-first-byte)', () => {
    const s = step(initialState(), { t: 'retry-attempt', attempt: 2, max: 3, delayMs: 1000 });
    expect(s.retry).toEqual({ attempt: 2, max: 3, delayMs: 1000 });
    // still pre-first-byte: no assistant output has arrived, so phase is untouched.
    expect(s.phase).toBe('idle');
  });

  it('a later retry-attempt overwrites the prior value (sequential, single scalar)', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 1, max: 3, delayMs: 500 });
    s = step(s, { t: 'retry-attempt', attempt: 2, max: 3, delayMs: 1000 });
    expect(s.retry).toEqual({ attempt: 2, max: 3, delayMs: 1000 });
  });

  it('survives an unrelated action (e.g. usage)', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 1, max: 3, delayMs: 500 });
    s = step(s, { t: 'usage', tokensIn: 10, tokensOut: 0 });
    expect(s.retry).toEqual({ attempt: 1, max: 3, delayMs: 500 });
  });

  it('assistant-start clears state.retry (first byte ⇒ retry succeeded)', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 2, max: 3, delayMs: 1000 });
    s = step(s, { t: 'assistant-start', id: 'a1' });
    expect(s.retry).toBeUndefined();
    expect(s.phase).toBe('streaming');
  });

  it('error clears state.retry (exhaustion / terminal failure)', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 3, max: 3, delayMs: 2000 });
    s = step(s, { t: 'error', message: 'provider request failed: 503' });
    expect(s.retry).toBeUndefined();
    expect(s.phase).toBe('error');
  });

  it('aborted clears state.retry (user cancel mid-retry)', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 1, max: 3, delayMs: 500 });
    s = step(s, { t: 'aborted' });
    expect(s.retry).toBeUndefined();
    expect(s.phase).toBe('idle');
  });

  // retry-clear is the compaction-seam escape hatch: compaction drains the same
  // onRetry-wired client OUTSIDE the turnRunner, so none of the normal clearing
  // cases fire. It clears retry without touching anything else.
  it('retry-clear clears state.retry without touching phase', () => {
    let s = step(initialState(), { t: 'retry-attempt', attempt: 2, max: 3, delayMs: 1000 });
    expect(s.retry).toBeDefined();
    s = step(s, { t: 'retry-clear' });
    expect(s.retry).toBeUndefined();
    expect(s.phase).toBe('idle');
  });

  it('retry-clear is a no-op (identical state ref) when there is nothing to clear', () => {
    const base = initialState();
    // No `retry` set ⇒ the reducer must return the SAME reference so the unconditional
    // dispatch in runCompactionStep never forces a needless re-render.
    expect(step(base, { t: 'retry-clear' })).toBe(base);
  });

  // The `compact` action itself does NOT clear retry — which is exactly why the
  // compaction seam needs the separate retry-clear (otherwise a mid-compaction retry
  // would linger as a phantom `retrying n/m` line at idle).
  it('compact does NOT clear a mid-compaction retry on its own', () => {
    let s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hello there' });
    s = step(s, { t: 'retry-attempt', attempt: 1, max: 3, delayMs: 500 });
    s = step(s, { t: 'compact', summaryText: 'a dense summary', keepCount: 1 });
    expect(s.retry).toEqual({ attempt: 1, max: 3, delayMs: 500 });
  });
});
