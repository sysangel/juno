// tests/executorDeny.test.ts
// Wave-14 a1 (lifecycle-core): the executor's two DENY emit sites route through the shared
// `DENIED` / `DENIED_BY_POLICY` markers, and `emitAborted` through `ABORTED_NOTICE` (src/core/abort)
// so a routine permission-deny classifies as `declined` and an abort as `aborted` (both neutral ⊘)
// on every surface. Guards against future wording drift — a hand-typed 'denied'/'aborted' string
// that no longer matches isDenyReason/isAbortReason would silently regress to a red ✗.
import { describe, expect, it } from 'vitest';
import { createToolExecutor } from '../src/tools/executor';
import { createPermissionPolicy } from '../src/permissions/policy';
import {
  ABORTED_NOTICE,
  DENIED,
  DENIED_BY_POLICY,
  isAbortReason,
  isDenyReason,
} from '../src/core/abort';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { PermissionPolicy, Tool, ToolResult } from '../src/core/contracts';
import type { State } from '../src/core/reducer';

/** A dangerous tool that would succeed if run — the deny paths must terminate BEFORE this. */
function trackedTool(onRun: () => void): Tool {
  return {
    name: 'write_file',
    risk: 'dangerous',
    spec: { name: 'write_file', description: 'x', inputSchema: {} },
    run: async (): Promise<ToolResult> => {
      onRun();
      return { ok: true, data: 'wrote' };
    },
  };
}

/** Drive one execute() and collect the emitted events. */
async function runExecute(
  policy: PermissionPolicy,
  awaitPermission: (id: string) => Promise<PermissionDecision>,
  onRun: () => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const executor = createToolExecutor({
    tools: [trackedTool(onRun)],
    policy,
    cwd: '.',
    signal: new AbortController().signal,
    getState: () => ({}) as State,
    awaitPermission,
  });
  await executor.execute('tc1', 'write_file', { path: 'secret.txt' }, (e) => events.push(e));
  return events;
}

const errorText = (events: AgentEvent[]): string | undefined => {
  const err = events.find((e) => e.type === 'tool-status' && e.status === 'error');
  return err !== undefined && err.type === 'tool-status' ? err.error : undefined;
};

describe('executor deny wording — routed through the shared markers', () => {
  it('auto-deny emits exactly DENIED_BY_POLICY and never runs the tool', async () => {
    let ran = false;
    // A seeded deny pattern makes policy.evaluate return 'auto-deny' for this call.
    const policy = createPermissionPolicy({ deny: ['write_file:*'] });
    const events = await runExecute(policy, async () => 'allow-once', () => { ran = true; });
    expect(errorText(events)).toBe(DENIED_BY_POLICY);
    expect(errorText(events)).toBe('denied by policy');
    expect(isDenyReason(errorText(events))).toBe(true);
    expect(ran).toBe(false);
    // A deny never runs the tool → no 'running' status emitted.
    expect(events.some((e) => e.type === 'tool-status' && e.status === 'running')).toBe(false);
  });

  it('a user [d] deny emits exactly DENIED and never runs the tool', async () => {
    let ran = false;
    // Default policy: a dangerous tool is not auto-allowed → 'prompt'; the user answers 'deny'.
    const policy = createPermissionPolicy();
    const events = await runExecute(policy, async () => 'deny', () => { ran = true; });
    expect(errorText(events)).toBe(DENIED);
    expect(errorText(events)).toBe('denied');
    expect(isDenyReason(errorText(events))).toBe(true);
    expect(ran).toBe(false);
    expect(events.some((e) => e.type === 'tool-status' && e.status === 'running')).toBe(false);
    // The prompt WAS opened before the deny.
    expect(events.some((e) => e.type === 'permission-open')).toBe(true);
  });
});

describe('executor abort wording — routed through the shared ABORTED_NOTICE marker', () => {
  it('an already-aborted signal makes emitAborted emit exactly ABORTED_NOTICE, matched by isAbortReason', async () => {
    let ran = false;
    const controller = new AbortController();
    controller.abort(); // entry-gate abort path (executor.ts: `if (deps.signal.aborted)`)
    const events: AgentEvent[] = [];
    const executor = createToolExecutor({
      tools: [trackedTool(() => { ran = true; })],
      policy: createPermissionPolicy(),
      cwd: '.',
      signal: controller.signal,
      getState: () => ({}) as State,
      awaitPermission: async () => 'allow-once',
    });
    await executor.execute('tc1', 'write_file', { path: 'secret.txt' }, (e) => events.push(e));
    expect(errorText(events)).toBe(ABORTED_NOTICE);
    expect(errorText(events)).toBe('aborted');
    // The drift-guard: the executor's literal and the classifier's predicate share one constant,
    // so an executor abort reads neutral (⊘), never a red ✗.
    expect(isAbortReason(errorText(events))).toBe(true);
    expect(ran).toBe(false);
  });
});
