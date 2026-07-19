// tests/toolGroups.test.ts
// Grouped-tool-rows — the PURE grouping logic (state → rows), tested apart from any render so
// the seam is not pty-only. Two layers:
//   1. the reducer STAMP: `ToolState.concurrencyGroupId` marks which top-level calls were in
//      flight together (the honest concurrency signal — see docs/UX-SPEC.md R5);
//   2. src/ui/toolGroups.ts: `planConcurrentToolGroups` (ids → adjacency-run groups) and
//      `summarizeToolGroup` (member states → header/condensed summary).
import { describe, it, expect } from 'vitest';
import { reducer, initialState, type State, type Action, type ToolState } from '../src/core/reducer';
import {
  planConcurrentToolGroups,
  summarizeToolGroup,
  memberLifecycle,
  type GroupingBlock,
} from '../src/ui/toolGroups';

function step(state: State, action: Action): State {
  return reducer(state, action);
}

/** A streaming turn: committed user msg + an open live assistant msg (mirrors reducer.test). */
function streamingState(): State {
  let s = initialState();
  s = step(s, { t: 'user-submit', id: 'u1', text: 'hello' });
  s = step(s, { t: 'assistant-start', id: 'a1' });
  return s;
}

const call = (toolCallId: string, name: string, extra: Partial<Action> = {}): Action =>
  ({ t: 'tool-call', toolCallId, name, args: {}, ...extra }) as Action;

// ---------------------------------------------------------------------------
// Reducer stamp — the concurrency signal
// ---------------------------------------------------------------------------

describe('reducer — concurrencyGroupId stamp', () => {
  it('shares ONE group id across top-level calls that arrive while a sibling is still non-terminal', () => {
    // Three calls all land `pending` before any resolves (the raw-API / parallel-tool_use shape).
    let s = streamingState();
    s = step(s, call('t1', 'grep'));
    s = step(s, call('t2', 'glob'));
    s = step(s, call('t3', 'read_file'));
    const g = s.tools['t1']?.concurrencyGroupId;
    expect(g).toBeDefined();
    expect(s.tools['t2']?.concurrencyGroupId).toBe(g);
    expect(s.tools['t3']?.concurrencyGroupId).toBe(g);
  });

  it('gives SEQUENTIAL calls DIFFERENT group ids (earlier settled before the next arrived)', () => {
    // t1 fully resolves before t2's tool-call — the claude-cli sequential-round shape.
    let s = streamingState();
    s = step(s, call('t1', 'read_file'));
    s = step(s, { t: 'tool-status', toolCallId: 't1', status: 'running' });
    s = step(s, { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'ok' });
    s = step(s, call('t2', 'edit_file'));
    expect(s.tools['t1']?.concurrencyGroupId).toBeDefined();
    expect(s.tools['t2']?.concurrencyGroupId).toBeDefined();
    expect(s.tools['t2']?.concurrencyGroupId).not.toBe(s.tools['t1']?.concurrencyGroupId);
  });

  it('chains a later call into the batch even after the FIRST member settled (partial overlap)', () => {
    // t1 settles, but t2 is still running when t3 arrives → t3 inherits t2's id (== t1's id).
    let s = streamingState();
    s = step(s, call('t1', 'grep'));
    s = step(s, call('t2', 'glob'));
    s = step(s, { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'ok' });
    s = step(s, { t: 'tool-status', toolCallId: 't2', status: 'running' });
    s = step(s, call('t3', 'read_file'));
    const g = s.tools['t1']?.concurrencyGroupId;
    expect(s.tools['t2']?.concurrencyGroupId).toBe(g);
    expect(s.tools['t3']?.concurrencyGroupId).toBe(g);
  });

  it('does NOT stamp a subagent CHILD (grouped by parentToolUseId instead)', () => {
    let s = streamingState();
    s = step(s, call('p1', 'spawn_subagent'));
    s = step(s, call('c1', 'list_files', { parentToolUseId: 'p1' } as Partial<Action>));
    expect(s.tools['c1']?.concurrencyGroupId).toBeUndefined();
    expect(s.tools['c1']?.parentToolUseId).toBe('p1');
  });

  it('does NOT stamp a call registered with no live turn (defensive path)', () => {
    const s = step(initialState(), call('t1', 'grep'));
    expect(s.tools['t1']).toBeDefined();
    expect(s.tools['t1']?.concurrencyGroupId).toBeUndefined();
  });

  it('freezes the group id into toolSnapshot at commit (survives to the committed render)', () => {
    let s = streamingState();
    s = step(s, call('t1', 'grep'));
    s = step(s, call('t2', 'glob'));
    s = step(s, { t: 'tool-status', toolCallId: 't1', status: 'result', result: 'a' });
    s = step(s, { t: 'tool-status', toolCallId: 't2', status: 'result', result: 'b' });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    const committed = s.committed.at(-1);
    const g = committed?.toolSnapshot?.['t1']?.concurrencyGroupId;
    expect(g).toBeDefined();
    expect(committed?.toolSnapshot?.['t2']?.concurrencyGroupId).toBe(g);
  });
});

// ---------------------------------------------------------------------------
// planConcurrentToolGroups — ids → adjacency-run groups
// ---------------------------------------------------------------------------

const gb = (blockId: string, toolCallId: string, groupId: string | undefined): GroupingBlock => ({
  blockId,
  toolCallId,
  groupId,
});

describe('planConcurrentToolGroups', () => {
  it('groups >= 2 adjacent same-id blocks (anchor = first, rest consumed)', () => {
    const plan = planConcurrentToolGroups([gb('b1', 't1', 'g'), gb('b2', 't2', 'g')]);
    expect(plan.groupByAnchor.has('b1')).toBe(true);
    expect(plan.groupByAnchor.get('b1')?.members.map((m) => m.toolCallId)).toEqual(['t1', 't2']);
    expect([...plan.consumed]).toEqual(['b2']);
  });

  it('leaves a lone id ungrouped (solo card, unchanged behavior)', () => {
    const plan = planConcurrentToolGroups([gb('b1', 't1', 'g')]);
    expect(plan.groupByAnchor.size).toBe(0);
    expect(plan.consumed.size).toBe(0);
  });

  it('treats an undefined id (text / spawn / unstamped) as a run-breaker — no group across it', () => {
    // Same group id on both sides, but a run-breaker between them ⇒ not adjacent ⇒ two solos.
    const plan = planConcurrentToolGroups([
      gb('b1', 't1', 'g'),
      gb('gap', 'text', undefined),
      gb('b2', 't2', 'g'),
    ]);
    expect(plan.groupByAnchor.size).toBe(0);
    expect(plan.consumed.size).toBe(0);
  });

  it('separates two back-to-back bursts by id', () => {
    const plan = planConcurrentToolGroups([
      gb('b1', 't1', 'g1'),
      gb('b2', 't2', 'g1'),
      gb('b3', 't3', 'g2'),
      gb('b4', 't4', 'g2'),
    ]);
    expect([...plan.groupByAnchor.keys()]).toEqual(['b1', 'b3']);
    expect(plan.groupByAnchor.get('b1')?.members).toHaveLength(2);
    expect(plan.groupByAnchor.get('b3')?.members).toHaveLength(2);
    expect([...plan.consumed].sort()).toEqual(['b2', 'b4']);
  });

  it('groups three adjacent same-id blocks into one unit', () => {
    const plan = planConcurrentToolGroups([
      gb('b1', 't1', 'g'),
      gb('b2', 't2', 'g'),
      gb('b3', 't3', 'g'),
    ]);
    expect(plan.groupByAnchor.get('b1')?.members).toHaveLength(3);
    expect([...plan.consumed].sort()).toEqual(['b2', 'b3']);
  });
});

// ---------------------------------------------------------------------------
// summarizeToolGroup — member states → header / condensed summary
// ---------------------------------------------------------------------------

const tool = (name: string, status: ToolState['status'], over: Partial<ToolState> = {}): ToolState => ({
  status,
  name,
  args: {},
  ...over,
});

/** Wrap bare ToolStates as un-gated GroupMembers (the common case in these tests). */
const members = (...tools: ToolState[]) => tools.map((t) => ({ tool: t }));

describe('summarizeToolGroup', () => {
  it('counts buckets TRUTHFULLY (pending is never folded into running), inFlight, allSettled, names', () => {
    const s = summarizeToolGroup(
      members(tool('grep', 'running'), tool('glob', 'pending'), tool('read_file', 'result')),
    );
    // The sequential-execution state (the raw-API executor runs a batch one at a time): 1
    // actually running + 1 queued. The buckets must stay distinct — a folded "2 running" would
    // contradict the member rows (one spinner + one pending glyph) directly below the header.
    expect(s).toMatchObject({
      total: 3,
      pending: 1,
      running: 1,
      waiting: 0,
      done: 1,
      failed: 0,
      inFlight: 2,
    });
    expect(s.allSettled).toBe(false);
    expect(s.names).toEqual(['grep', 'glob', 'read_file']);
    expect(s.firstFailure).toBeUndefined();
  });

  it('counts a permission-gated member as WAITING, never running/queued (honest state mapping)', () => {
    const s = summarizeToolGroup([
      { tool: tool('grep', 'running') },
      { tool: tool('glob', 'pending') },
      { tool: tool('write_file', 'pending'), waitingOnPermission: true },
    ]);
    expect(s).toMatchObject({ running: 1, pending: 1, waiting: 1, inFlight: 3 });
    expect(s.allSettled).toBe(false);
  });

  it('a settled member stays done/failed under a stale waiting flag (settled always wins)', () => {
    const s = summarizeToolGroup([
      { tool: tool('grep', 'result'), waitingOnPermission: true },
      { tool: tool('glob', 'error', { error: 'boom' }), waitingOnPermission: true },
    ]);
    expect(s).toMatchObject({ waiting: 0, done: 1, failed: 1 });
    expect(s.allSettled).toBe(true);
  });

  it('flags allSettled once nothing is non-terminal', () => {
    const s = summarizeToolGroup(
      members(tool('grep', 'result'), tool('glob', 'error', { error: 'boom' })),
    );
    expect(s.allSettled).toBe(true);
    expect(s.inFlight).toBe(0);
  });

  it('surfaces the FIRST failure name + first non-blank reason line', () => {
    const s = summarizeToolGroup(
      members(
        tool('grep', 'result'),
        tool('mcp__brain__recall', 'error', { error: '\nserver unreachable\nmore' }),
        tool('glob', 'error', { error: 'second failure' }),
      ),
    );
    expect(s.failed).toBe(2);
    expect(s.firstFailure).toEqual({ name: 'mcp__brain__recall', reason: 'server unreachable' });
  });

  it('falls back to "failed" when an errored member carries no reason', () => {
    const s = summarizeToolGroup(members(tool('grep', 'error')));
    expect(s.firstFailure).toEqual({ name: 'grep', reason: 'failed' });
  });

  it('an ABORTED member buckets as cancelled — never failed, never firstFailure (item 1)', () => {
    const s = summarizeToolGroup(members(tool('shell', 'error', { error: 'interrupted' })));
    expect(s).toMatchObject({ cancelled: 1, declined: 0, failed: 0 });
    expect(s.firstFailure).toBeUndefined();
    expect(s.allSettled).toBe(true);
  });

  it('a DECLINED member buckets as declined — never failed, never firstFailure (item 1)', () => {
    const s = summarizeToolGroup(members(tool('shell', 'error', { error: 'denied' })));
    expect(s).toMatchObject({ declined: 1, cancelled: 0, failed: 0 });
    expect(s.firstFailure).toBeUndefined();
    const policy = summarizeToolGroup(members(tool('shell', 'error', { error: 'denied by policy' })));
    expect(policy).toMatchObject({ declined: 1, failed: 0 });
  });

  it('a mix of 1 done + 1 aborted is fully settled but NOT a failure', () => {
    const s = summarizeToolGroup(
      members(tool('read_file', 'result'), tool('shell', 'error', { error: 'interrupted' })),
    );
    expect(s).toMatchObject({ done: 1, cancelled: 1, failed: 0 });
    expect(s.allSettled).toBe(true);
    expect(s.firstFailure).toBeUndefined();
  });

  it('a genuine failure alongside a cancel keeps failed=1 / cancelled=1 distinct', () => {
    const s = summarizeToolGroup(
      members(
        tool('grep', 'error', { error: 'boom' }),
        tool('shell', 'error', { error: 'interrupted' }),
      ),
    );
    expect(s).toMatchObject({ failed: 1, cancelled: 1 });
    expect(s.firstFailure).toEqual({ name: 'grep', reason: 'boom' });
  });
});

describe('memberLifecycle', () => {
  it('maps result → done and passes the rest through', () => {
    expect(memberLifecycle('result')).toBe('done');
    expect(memberLifecycle('error')).toBe('error');
    expect(memberLifecycle('running')).toBe('running');
    expect(memberLifecycle('pending')).toBe('pending');
  });
});
