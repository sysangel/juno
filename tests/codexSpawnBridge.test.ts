// tests/codexSpawnBridge.test.ts — Wave 8 (codex-bridge): the bridge that maps a
// codex parent's MCP spawn call onto juno's subagent orchestrator with PARENT
// ATTRIBUTION. Verifies the outer spawn-card lifecycle (tool-call → running →
// terminal) is synthesized on the active turn, the child's tool events nest under
// it (reusing the real spawn_subagent Tool), isSpawnActive brackets the run, and
// the no-active-turn / error paths fail soft.
import { describe, expect, it } from 'vitest';
import type { ModelClient, Tool, ToolCtx, ToolResult, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createSubagentTool } from '../src/tools/subagentTool';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createModelCatalog, type ModelEntry } from '../src/services/catalog';
import {
  createCodexSpawnBridge,
  type CodexTurnContext,
} from '../src/providers/codexSpawnBridge';

const policy = createPermissionPolicy({ autoAllowSafe: true });

const catalog = createModelCatalog([
  { id: 'gpt-5.6-sol', provider: 'codex-cli', label: 'Codex', contextWindow: 200_000, default: true },
] as ModelEntry[]);

/** A child client that emits ONE self-contained tool card + a prose summary. */
function toolCardClient(toolName: string): ModelClient {
  return {
    async *streamTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      yield { type: 'assistant-start', id: input.id };
      yield { type: 'tool-call', id: input.id, toolCallId: 'c1', name: toolName, args: { q: 1 } };
      yield { type: 'tool-status', toolCallId: 'c1', status: 'running' };
      yield { type: 'tool-status', toolCallId: 'c1', status: 'result', result: 'ok' };
      yield { type: 'text-delta', id: input.id, delta: 'child summary' };
      yield { type: 'assistant-done', id: input.id, stopReason: 'end' };
    },
  };
}

/** Capture a turn context whose emit records events; a fixed abort signal. */
function turnContext(overrides: Partial<CodexTurnContext> = {}): {
  turn: CodexTurnContext;
  events: AgentEvent[];
} {
  const events: AgentEvent[] = [];
  const turn: CodexTurnContext = {
    turnId: 'codex-turn-1',
    cwd: '/work/jail',
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { turn, events };
}

describe('codexSpawnBridge — parent attribution', () => {
  it('synthesizes the spawn card and nests the child tool events under it', async () => {
    const spawnTool = createSubagentTool({
      createClient: () => toolCardClient('read_file'),
      catalog,
      policy,
      childTools: [],
    });
    const bridge = createCodexSpawnBridge({
      spawnTool,
      nextToolCallId: () => 'codex-spawn-1',
    });
    const { turn, events } = turnContext();
    const dispose = bridge.beginTurn(turn);

    const result = await bridge.spawn({ task: 'do it' });
    dispose();

    // The subagent's summary is returned as the MCP result (not an error).
    expect(result).toEqual({ text: 'child summary', isError: false });

    // OUTER spawn card: tool-call on the codex turn, then running, then result.
    const outerCall = events.find(
      (e) => e.type === 'tool-call' && e.toolCallId === 'codex-spawn-1',
    ) as Extract<AgentEvent, { type: 'tool-call' }> | undefined;
    expect(outerCall).toMatchObject({
      type: 'tool-call',
      id: 'codex-turn-1',
      toolCallId: 'codex-spawn-1',
      name: 'spawn_subagent',
    });
    expect(outerCall?.parentToolUseId).toBeUndefined(); // top-level under the turn

    // CHILD card: nested under the spawn id, namespaced — identical to raw-API.
    const childCall = events.find(
      (e) => e.type === 'tool-call' && e.toolCallId === 'codex-spawn-1::c1',
    ) as Extract<AgentEvent, { type: 'tool-call' }> | undefined;
    expect(childCall).toMatchObject({
      name: 'read_file',
      parentToolUseId: 'codex-spawn-1',
    });

    // Ordering: outer tool-call → outer running → (child events) → outer result.
    const outerStatuses = events.filter(
      (e) => e.type === 'tool-status' && e.toolCallId === 'codex-spawn-1',
    ) as Array<Extract<AgentEvent, { type: 'tool-status' }>>;
    expect(outerStatuses.map((s) => s.status)).toEqual(['running', 'result']);
    const firstIdx = events.indexOf(outerCall as AgentEvent);
    const childIdx = events.indexOf(childCall as AgentEvent);
    const resultIdx = events.findIndex(
      (e) => e.type === 'tool-status' && e.toolCallId === 'codex-spawn-1' && e.status === 'result',
    );
    expect(firstIdx).toBeLessThan(childIdx);
    expect(childIdx).toBeLessThan(resultIdx);

    // Child prose is NOT spliced into the parent stream (matches claude parent).
    expect(events.some((e) => e.type === 'text-delta')).toBe(false);
  });

  it('brackets the run with isSpawnActive (for codex stall-timer suppression)', async () => {
    let activeDuringRun: boolean | undefined;
    const gatedTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(_args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
        activeDuringRun = bridge.isSpawnActive();
        return { ok: true, data: { summary: 'done' } };
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: gatedTool });
    const { turn } = turnContext();
    const dispose = bridge.beginTurn(turn);

    expect(bridge.isSpawnActive()).toBe(false);
    await bridge.spawn({ task: 't' });
    expect(activeDuringRun).toBe(true);
    expect(bridge.isSpawnActive()).toBe(false);
    dispose();
  });

  it('passes the spawn card id as ctx.toolCallId so children nest under it', async () => {
    let seenCtxId: string | undefined;
    const probeTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(_args: unknown, ctx: ToolCtx): Promise<ToolResult> {
        seenCtxId = ctx.toolCallId;
        return { ok: true, data: { summary: 's' } };
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: probeTool, nextToolCallId: () => 'spawn-42' });
    const { turn } = turnContext();
    const dispose = bridge.beginTurn(turn);
    await bridge.spawn({ task: 't' });
    dispose();
    expect(seenCtxId).toBe('spawn-42');
  });

  it('maps a failed subagent to an error card + isError result', async () => {
    const failTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(): Promise<ToolResult> {
        return { ok: false, error: 'sub-agent error: nope' };
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: failTool, nextToolCallId: () => 's1' });
    const { turn, events } = turnContext();
    const dispose = bridge.beginTurn(turn);
    const result = await bridge.spawn({ task: 't' });
    dispose();

    expect(result).toEqual({ text: 'sub-agent error: nope', isError: true });
    const status = events.find(
      (e) => e.type === 'tool-status' && e.toolCallId === 's1' && e.status === 'error',
    ) as Extract<AgentEvent, { type: 'tool-status' }> | undefined;
    expect(status?.error).toBe('sub-agent error: nope');
  });

  it('a throwing tool never escapes — folded into an error result', async () => {
    const throwTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(): Promise<ToolResult> {
        throw new Error('kaboom');
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: throwTool, nextToolCallId: () => 's1' });
    const { turn, events } = turnContext();
    const dispose = bridge.beginTurn(turn);
    const result = await bridge.spawn({ task: 't' });
    dispose();

    expect(result.isError).toBe(true);
    expect(result.text).toContain('kaboom');
    expect(bridge.isSpawnActive()).toBe(false);
    expect(
      events.some((e) => e.type === 'tool-status' && e.toolCallId === 's1' && e.status === 'error'),
    ).toBe(true);
  });

  it('spawn with NO active turn fails soft (defensive)', async () => {
    const bridge = createCodexSpawnBridge({
      spawnTool: {
        name: 'spawn_subagent',
        risk: 'risky',
        spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
        run: async () => ({ ok: true, data: { summary: 's' } }),
      },
    });
    const result = await bridge.spawn({ task: 't' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no active codex turn');
  });

  it('combines the MCP-side cancel signal with the turn signal for the child ctx', async () => {
    // A codex-side cancel (tool timeout / notifications/cancelled / connection drop)
    // arrives as the MCP request's AbortSignal. Even when the TURN signal is still
    // live, that cancel must reach the child's ctx.signal so subagentTool aborts its
    // childController — otherwise the subagent runs to completion in the background.
    const mcpController = new AbortController();
    mcpController.abort(); // already cancelled (e.g. codex timed out) before run
    let ctxSignalAborted: boolean | undefined;
    const probeTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(_args: unknown, ctx: ToolCtx): Promise<ToolResult> {
        ctxSignalAborted = ctx.signal.aborted;
        return { ok: true, data: { summary: 's' } };
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: probeTool, nextToolCallId: () => 's1' });
    const { turn, events } = turnContext(); // turn.signal never aborts
    const dispose = bridge.beginTurn(turn);
    const result = await bridge.spawn({ task: 't' }, mcpController.signal);
    dispose();

    // The MCP cancel reached the child ctx even though the turn signal was live.
    expect(ctxSignalAborted).toBe(true);
    // The bridge reports the run as aborted (combined signal is aborted post-run).
    expect(result).toEqual({ text: 'sub-agent aborted', isError: true });
    expect(
      events.some((e) => e.type === 'tool-status' && e.toolCallId === 's1' && e.status === 'error'),
    ).toBe(true);
  });

  it('a live MCP signal leaves the child ctx signal un-aborted (turn signal still governs)', async () => {
    const mcpController = new AbortController(); // never aborted
    let ctxSignalAborted: boolean | undefined;
    const probeTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(_args: unknown, ctx: ToolCtx): Promise<ToolResult> {
        ctxSignalAborted = ctx.signal.aborted;
        return { ok: true, data: { summary: 'ok' } };
      },
    };
    const bridge = createCodexSpawnBridge({ spawnTool: probeTool, nextToolCallId: () => 's1' });
    const { turn } = turnContext();
    const dispose = bridge.beginTurn(turn);
    const result = await bridge.spawn({ task: 't' }, mcpController.signal);
    dispose();

    expect(ctxSignalAborted).toBe(false);
    expect(result).toEqual({ text: 'ok', isError: false });
  });

  it('disposer only clears if the turn is still current (a later turn wins)', async () => {
    const bridge = createCodexSpawnBridge({
      spawnTool: {
        name: 'spawn_subagent',
        risk: 'risky',
        spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
        run: async () => ({ ok: true, data: { summary: 's' } }),
      },
      nextToolCallId: () => 's1',
    });
    const first = turnContext({ turnId: 'turn-A' });
    const disposeFirst = bridge.beginTurn(first.turn);
    const second = turnContext({ turnId: 'turn-B' });
    bridge.beginTurn(second.turn);
    // The stale disposer must NOT unregister turn-B.
    disposeFirst();
    await bridge.spawn({ task: 't' });
    // The spawn card landed on turn-B (the current turn), not turn-A.
    expect(second.events.some((e) => e.type === 'tool-call')).toBe(true);
    expect(first.events.some((e) => e.type === 'tool-call')).toBe(false);
  });
});
