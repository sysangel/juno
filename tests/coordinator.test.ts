// tests/coordinator.test.ts
// W6 — integration test for the coordinator: turnRunner + executor + permission
// park/resolve registry + the shared policy, plus a fake-client smoke.
//
// Deterministic: no network, no real FS writes, no real keys. The risky tool's
// `run` is a stub that records its args, so asserting it ran/didn't-run never
// touches IO. A small in-test scripted ModelClient drives stopReason:'tool_use'
// so the EXECUTOR actually runs (the fake's pretend-run path is exercised
// separately by the smoke test).
import { describe, expect, it } from 'vitest';
import type { Action, State } from '../src/core/reducer';
import { initialState, reducer } from '../src/core/reducer';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { ModelClient, Tool, ToolSpec, TurnInput } from '../src/core/contracts';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import type { PermissionPolicy } from '../src/core/contracts';
import { createToolExecutor } from '../src/tools/executor';
import { createPermissionRegistry } from '../src/agent/eventBus';
import type { PermissionRegistry } from '../src/agent/eventBus';
import { isPersistentPermissionDecision, runTurn } from '../src/agent/turnRunner';

interface Harness {
  readonly actions: Action[];
  readonly dispatch: (action: Action) => void;
  readonly getState: () => State;
}

interface ScriptedClient {
  readonly client: ModelClient;
  readonly inputs: TurnInput[];
  readonly calls: () => number;
}

function createHarness(): Harness {
  let state = initialState();
  const actions: Action[] = [];

  return {
    actions,
    dispatch: (action: Action): void => {
      actions.push(action);
      state = reducer(state, action);
    },
    getState: (): State => state,
  };
}

function createScriptedClient(turns: ReadonlyArray<ReadonlyArray<AgentEvent>>): ScriptedClient {
  let callCount = 0;
  const inputs: TurnInput[] = [];

  const client: ModelClient = {
    streamTurn: async function* (
      input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      inputs.push(input);
      const events = turns[callCount] ?? [
        { type: 'assistant-start', id: `assistant-${callCount}` },
        { type: 'assistant-done', id: `assistant-${callCount}`, stopReason: 'end' },
      ];
      callCount += 1;

      for (const event of events) {
        if (signal.aborted) {
          yield { type: 'aborted', reason: 'aborted' };
          return;
        }
        yield event;
        await Promise.resolve();
      }
    },
  };

  return {
    client,
    inputs,
    calls: () => callCount,
  };
}

function createRiskyWriteTool(runCalls: unknown[]): Tool {
  return {
    name: 'write_file',
    risk: 'risky',
    spec: {
      name: 'write_file',
      description: 'test write tool',
      inputSchema: { type: 'object' },
    },
    run: async (args: unknown) => {
      // Stub — records args, performs NO real IO.
      runCalls.push(args);
      return { ok: true, data: { written: false } };
    },
  };
}

function baseInput(): TurnInput {
  return {
    id: 'turn-test',
    messages: [{ role: 'user', content: 'run the tool' }],
    model: 'test-model',
    cwd: '.',
    effort: 'medium',
  };
}

/** A `safe` tool the default policy auto-allows (no parking), so a multi-tool_use loop
 * runs to completion without manual permission round-trips — the setup the iteration-budget
 * and steer tests need. Records every args it ran. */
function createSafeCountingTool(runCalls: unknown[]): Tool {
  return {
    name: 'noop',
    risk: 'safe',
    spec: { name: 'noop', description: 'safe counting tool', inputSchema: { type: 'object' } },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { ran: true } };
    },
  };
}

/** A single `tool_use` turn calling the safe `noop` tool with a distinct toolCallId. */
function noopToolUseTurn(i: number): ReadonlyArray<AgentEvent> {
  return [
    { type: 'assistant-start', id: `a-${i}` },
    { type: 'tool-call', id: `a-${i}`, toolCallId: `tc-${i}`, name: 'noop', args: { i } },
    { type: 'assistant-done', id: `a-${i}`, stopReason: 'tool_use' },
  ];
}

interface ScriptedTurnSetup {
  readonly harness: Harness;
  readonly runCalls: unknown[];
  readonly runPromise: Promise<void>;
  readonly scripted: ScriptedClient;
}

/** Drive a scripted multi-turn run through the REAL runTurn with a safe auto-allowed tool,
 * forwarding extra TurnRunnerDeps (maxToolCalls / drainSteer / onIteration) under test. */
function runScriptedTurn(
  turns: ReadonlyArray<ReadonlyArray<AgentEvent>>,
  extraDeps: Partial<Pick<Parameters<typeof runTurn>[1], 'maxToolCalls' | 'drainSteer' | 'onIteration'>>,
): ScriptedTurnSetup {
  const harness = createHarness();
  const registry = createPermissionRegistry();
  const controller = new AbortController();
  const policy = createPermissionPolicy(); // autoAllowSafe defaults true
  const runCalls: unknown[] = [];
  const tool = createSafeCountingTool(runCalls);
  const scripted = createScriptedClient(turns);
  const executor = createToolExecutor({
    tools: [tool],
    policy,
    cwd: '.',
    signal: controller.signal,
    getState: harness.getState,
    awaitPermission: registry.await,
  });

  const runPromise = runTurn(baseInput(), {
    client: scripted.client,
    executor,
    specs: [tool.spec],
    dispatch: harness.dispatch,
    signal: controller.signal,
    registry,
    ...extraDeps,
  });

  return { harness, runCalls, runPromise, scripted };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function actionCount(actions: ReadonlyArray<Action>, predicate: (action: Action) => boolean): number {
  return actions.filter(predicate).length;
}

interface ToolTurnSetup {
  readonly harness: Harness;
  readonly registry: PermissionRegistry;
  readonly controller: AbortController;
  readonly runCalls: unknown[];
  readonly runPromise: Promise<void>;
  readonly policy: PermissionPolicy;
  readonly scripted: ScriptedClient;
}

function startScriptedToolTurn(turns: ReadonlyArray<ReadonlyArray<AgentEvent>>): ToolTurnSetup {
  const harness = createHarness();
  const registry = createPermissionRegistry();
  const controller = new AbortController();
  const policy = createPermissionPolicy();
  const runCalls: unknown[] = [];
  const tool = createRiskyWriteTool(runCalls);
  const scripted = createScriptedClient(turns);
  const executor = createToolExecutor({
    tools: [tool],
    policy,
    cwd: '.',
    signal: controller.signal,
    getState: harness.getState,
    awaitPermission: registry.await,
  });

  const runPromise = runTurn(baseInput(), {
    client: scripted.client,
    executor,
    specs: [tool.spec],
    dispatch: harness.dispatch,
    signal: controller.signal,
    registry,
  });

  return { harness, registry, controller, runCalls, runPromise, policy, scripted };
}

/**
 * Mirror useStreamingTurn.resolvePermission EXACTLY (contract B + C):
 * remember-if-persistent on the SHARED policy, then resolve the parked promise,
 * then dispatch permission-resolved (which dismisses the overlay). Driving the
 * test through this proves the real wiring, not just policy internals.
 *
 * Deliberate divergence from the real resolvePermission: we do NOT call
 * flushDeltas() here. The harness applies actions synchronously to its own
 * State (no React, no ~16ms delta batching), so there is no queued delta to
 * flush before resolving — flushDeltas would be a pure no-op in this context.
 * This is a batching-only omission, not a behavioral difference in the
 * remember -> resolve -> dispatch sequence the test is asserting on.
 */
function resolveLikeUi(
  setup: Pick<ToolTurnSetup, 'harness' | 'registry' | 'policy'>,
  toolCallId: string,
  decision: PermissionDecision,
): void {
  if (isPersistentPermissionDecision(decision)) {
    const tool = setup.harness.getState().tools[toolCallId];
    if (tool !== undefined) {
      // By design (per BRIEF_W6): we remember the BARE tool name, which
      // normalizePattern() turns into `name:*` — a tool-wide always-allow that
      // matches any future call to this tool regardless of args. This is why
      // test (d) skips the SECOND prompt for the same tool with different args.
      setup.policy.remember(tool.name, decision);
    }
  }
  setup.registry.resolve(toolCallId, decision);
  setup.harness.dispatch({ t: 'permission-resolved', toolCallId, decision });
}

describe('coordinator turn runner', () => {
  it('(a) parks a risky tool permission and runs after allow-once', async () => {
    const setup = startScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'text-delta', id: 'assistant-2', delta: 'done' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    expect(setup.harness.getState().phase).toBe('awaiting-permission');
    expect(setup.harness.getState().overlay).toBe('permission');
    expect(setup.harness.getState().pendingPermissionToolCallId).toBe('tc1');

    resolveLikeUi(setup, 'tc1', 'allow-once');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(1);
    expect(setup.harness.getState().overlay).toBe('none');
    expect(setup.registry.pending()).toBe(0);
    expect(setup.scripted.calls()).toBe(2);
    expect(
      setup.harness.actions.some(
        (a) => a.t === 'tool-status' && a.toolCallId === 'tc1' && a.status === 'running',
      ),
    ).toBe(true);
    expect(
      setup.harness.actions.some(
        (a) => a.t === 'tool-status' && a.toolCallId === 'tc1' && a.status === 'result',
      ),
    ).toBe(true);
  });

  it('(b) resolves deny without running the risky tool', async () => {
    const setup = startScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    resolveLikeUi(setup, 'tc1', 'deny');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(0);
    expect(setup.harness.getState().overlay).toBe('none');
    expect(
      setup.harness.actions.some(
        (a) => a.t === 'tool-status' && a.toolCallId === 'tc1' && a.status === 'running',
      ),
    ).toBe(false);
    expect(
      setup.harness.actions.some(
        (a) => a.t === 'tool-status' && a.toolCallId === 'tc1' && a.status === 'error',
      ),
    ).toBe(true);
  });

  it('(c) drains parked permissions on abort so the turn cannot hang', async () => {
    const setup = startScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    // Observe the same parked promise to prove it settles to 'deny'.
    const parked = setup.registry.await('tc1');
    setup.controller.abort();
    setup.registry.drainDeny();

    await expect(parked).resolves.toBe('deny');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(0);
    expect(setup.registry.pending()).toBe(0);
    expect(setup.harness.getState().phase).toBe('idle');
    expect(setup.harness.actions.some((a) => a.t === 'aborted')).toBe(true);
  });

  it('(d) remembers always-allow on the shared policy and skips the second prompt', async () => {
    const setup = startScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'same.txt', content: 'one' },
        },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc2',
          name: 'write_file',
          args: { path: 'same.txt', content: 'two' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'first permission park');

    // Drive through the SAME wiring the UI uses: remember on the shared policy.
    resolveLikeUi(setup, 'tc1', 'always-allow-pattern');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(2);
    expect(
      actionCount(setup.harness.actions, (a) => a.t === 'permission-open' && a.toolCallId === 'tc1'),
    ).toBe(1);
    expect(
      actionCount(setup.harness.actions, (a) => a.t === 'permission-open' && a.toolCallId === 'tc2'),
    ).toBe(0);
    expect(
      setup.harness.actions.some(
        (a) => a.t === 'tool-status' && a.toolCallId === 'tc2' && a.status === 'running',
      ),
    ).toBe(true);
  });

  it('(e) registry: resolve() before await() returns the early decision (no hang)', async () => {
    const registry = createPermissionRegistry();

    // Out-of-order: the decision lands BEFORE anything is parked. Previously this
    // no-op'd and a later await() would hang forever; now it is stashed.
    registry.resolve('x', 'allow-once');
    expect(registry.pending()).toBe(0);

    // The later await must settle immediately to the stashed decision.
    const decision = await registry.await('x');
    expect(decision).toBe('allow-once');

    // The early decision is one-shot: a fresh await for the same id parks again.
    expect(registry.pending()).toBe(0);
    const reparked = registry.await('x');
    expect(registry.pending()).toBe(1);

    // And drainDeny() still settles that freshly-parked promise.
    registry.drainDeny();
    await expect(reparked).resolves.toBe('deny');
    expect(registry.pending()).toBe(0);
  });

  it('(smoke) streams the fake client and accumulates additive usage', async () => {
    const harness = createHarness();
    const registry = createPermissionRegistry();
    const controller = new AbortController();
    const policy = createPermissionPolicy();
    const runCalls: unknown[] = [];
    const tool = createRiskyWriteTool(runCalls);
    const executor = createToolExecutor({
      tools: [tool],
      policy,
      cwd: '.',
      signal: controller.signal,
      getState: harness.getState,
      awaitPermission: registry.await,
    });

    await runTurn(baseInput(), {
      client: createFakeModelClient({ tickMs: 0 }),
      executor,
      specs: [tool.spec],
      dispatch: harness.dispatch,
      signal: controller.signal,
      registry,
    });

    const assistantText = harness
      .getState()
      .committed.filter((message) => message.role === 'assistant')
      .flatMap((message) => message.blocks)
      .filter((block): block is { kind: 'text'; id: string; text: string } => block.kind === 'text')
      .map((block) => block.text)
      .join('');

    expect(assistantText).toContain('Hello from Juno.');
    expect(harness.getState().tokens.in).toBe(120);
    expect(harness.getState().tokens.out).toBe(48);
  });
});

describe('coordinator iteration budget + steer (W6 robustness)', () => {
  it('(budget) stops the re-entry loop at maxToolCalls, emits the budget error, runs exactly N tools', async () => {
    const N = 2;
    // 3 tool_use turns are scripted (N+1) so a NON-breaking loop WOULD run a 3rd tool; the
    // ceiling must stop it after exactly N. The final turn is never reached.
    const setup = runScriptedTurn(
      [noopToolUseTurn(0), noopToolUseTurn(1), noopToolUseTurn(2)],
      { maxToolCalls: N },
    );

    await setup.runPromise;

    // Exactly N tools executed (the breach check fires AFTER the Nth commit, before re-entry).
    expect(setup.runCalls).toHaveLength(N);
    // Only N model turns were streamed (the loop never re-entered for the 3rd).
    expect(setup.scripted.calls()).toBe(N);
    // A terminal `error` action carrying the budget message was dispatched.
    const budgetError = setup.harness.actions.find(
      (a): a is Extract<Action, { t: 'error' }> => a.t === 'error',
    );
    expect(budgetError).toBeDefined();
    expect(budgetError!.message).toContain('Iteration budget exceeded');
    expect(budgetError!.message).toContain(`limit ${N}`);
    // Clean terminal, not an abort.
    expect(setup.harness.actions.some((a) => a.t === 'aborted')).toBe(false);
    expect(setup.harness.getState().phase).toBe('error');
  });

  it('(budget) absent maxToolCalls leaves the loop unbounded (no premature budget error)', async () => {
    // Two tool_use turns then a clean end — with no ceiling the whole script runs.
    const setup = runScriptedTurn(
      [
        noopToolUseTurn(0),
        noopToolUseTurn(1),
        [
          { type: 'assistant-start', id: 'a-end' },
          { type: 'text-delta', id: 'a-end', delta: 'done' },
          { type: 'assistant-done', id: 'a-end', stopReason: 'end' },
        ],
      ],
      {},
    );

    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(2);
    expect(setup.harness.actions.some((a) => a.t === 'error')).toBe(false);
    expect(setup.harness.getState().phase).toBe('idle');
  });

  it('(steer) drained guidance is appended as the freshest user message on re-entry, no abort', async () => {
    let drained = false;
    // One-shot drain: returns the steer the FIRST time (the single re-entry), [] after.
    const drainSteer = (): string[] => {
      if (drained) {
        return [];
      }
      drained = true;
      return ['focus X'];
    };

    const setup = runScriptedTurn(
      [
        noopToolUseTurn(0), // tool_use -> re-enter (drains the steer here)
        [
          { type: 'assistant-start', id: 'a-1' },
          { type: 'text-delta', id: 'a-1', delta: 'ok' },
          { type: 'assistant-done', id: 'a-1', stopReason: 'end' },
        ],
      ],
      { drainSteer },
    );

    await setup.runPromise;

    expect(drained).toBe(true);
    // The SECOND streamTurn input must end with the steer as a fresh user message.
    expect(setup.scripted.inputs).toHaveLength(2);
    const secondInput = setup.scripted.inputs[1]!;
    expect(secondInput.messages.at(-1)).toEqual({ role: 'user', content: 'focus X' });
    // The turn completed normally — a steer never aborts.
    expect(setup.harness.actions.some((a) => a.t === 'aborted')).toBe(false);
    expect(setup.harness.getState().phase).toBe('idle');
  });

  it('(onIteration) reports the running tool-call count per executed call', async () => {
    const seen: number[] = [];
    const setup = runScriptedTurn(
      [
        noopToolUseTurn(0),
        noopToolUseTurn(1),
        [
          { type: 'assistant-start', id: 'a-end' },
          { type: 'assistant-done', id: 'a-end', stopReason: 'end' },
        ],
      ],
      { onIteration: (n) => seen.push(n) },
    );

    await setup.runPromise;

    // One callback per executed tool, monotonically increasing from 1.
    expect(seen).toEqual([1, 2]);
  });
});
