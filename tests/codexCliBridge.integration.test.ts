// tests/codexCliBridge.integration.test.ts — Wave 8 (codex-bridge): the FULL
// in-process path a codex PARENT takes to spawn a juno subagent, exercised end to
// end with fakes (no real codex — the GATE forbids live subprocess calls; no port).
//
// PROVEN LIVE-WITH-FAKES here:
//   - a codex turn (fake `codex exec --json` child) runs while, mid-turn, a real SDK
//     MCP Client (the codex side) calls spawn_subagent on juno's real in-process MCP
//     server; the bridge runs a real subagent (fake child model) and its summary
//     round-trips back as the MCP result;
//   - the spawn card + nested child tool card interleave LIVE into the codex turn's
//     event stream and, fed through eventToAction+reducer, nest in parent state.tools
//     exactly like a raw-API parent's subagent;
//   - while the spawn is in flight the codex idle/stale STALL timers are SUSPENDED
//     (a blocked-on-MCP codex is not a wedged stream), and resume once it completes.
//
// NOT exercised here (see codexBridgeHost.ts header): a real HTTP port bind and a
// LIVE codex CLI connecting over it. The seam between "codex calls the MCP tool" and
// "juno runs the subagent" is the SDK Client/Server pair, which is real.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  ModelClient,
  Tool,
  ToolCtx,
  ToolResult,
  ToolSpec,
  TurnInput,
} from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { eventToAction, type AgentEvent as Evt } from '../src/core/events';
import { initialState, reducer, type State } from '../src/core/reducer';
import { createSubagentTool } from '../src/tools/subagentTool';
import { createDefaultTools } from '../src/tools/registry';
import { createCodexBridgeSpawnTool } from '../src/cli';
import { createBackgroundAgentRunner } from '../src/services/backgroundAgents';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createModelCatalog, type ModelEntry } from '../src/services/catalog';
import { createCodexSpawnBridge } from '../src/providers/codexSpawnBridge';
import { createSubagentMcpServer, SPAWN_SUBAGENT_TOOL } from '../src/services/subagentMcpServer';
import {
  createCodexCliClient,
  type ChildProcessLike,
  type SpawnImpl,
  type TimerHandle,
} from '../src/providers/codexCliClient';

const policy = createPermissionPolicy({ autoAllowSafe: true });
const catalog = createModelCatalog([
  { id: 'gpt-5.6-sol', provider: 'codex-cli', label: 'Codex', contextWindow: 200_000, default: true },
] as ModelEntry[]);

const codexEntry: ModelEntry = {
  id: 'gpt-5.6-sol',
  provider: 'codex-cli',
  label: 'Codex',
  contextWindow: 200_000,
};
const noTools: ToolSpec[] = [];

/** A subagent child model that emits ONE self-contained tool card + a summary. */
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

interface FakeChild extends ChildProcessLike {
  killed: boolean;
}

/** A fake `codex exec --json` child whose stdout emits `preLines`, then PARKS until
 * `release()` (or, if `hangForever`, blocks until aborted/killed), then emits
 * `postLines` and exits 0. Lets a test run an MCP call DURING the quiet window. */
function makeGatedCodexChild(opts: {
  preLines: string[];
  postLines?: string[];
  hangForever?: boolean;
}): { spawn: SpawnImpl; release: () => void; child: () => FakeChild | undefined } {
  let created: FakeChild | undefined;
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const spawn: SpawnImpl = () => {
    const exitListeners: Array<(code: number | null) => void> = [];
    const child: FakeChild = {
      killed: false,
      stdout: (async function* (): AsyncIterable<string> {
        for (const line of opts.preLines) {
          yield `${line}\n`;
        }
        if (opts.hangForever === true) {
          await new Promise<never>(() => {});
          return;
        }
        await gate;
        for (const line of opts.postLines ?? []) {
          yield `${line}\n`;
        }
        for (const listener of exitListeners) listener(0);
      })(),
      stderr: {
        on: () => undefined,
        destroy: () => {},
      },
      kill(): boolean {
        this.killed = true;
        return true;
      },
      unref(): void {},
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'exit' || event === 'close') {
          exitListeners.push(listener as (code: number | null) => void);
        }
        return this;
      },
    };
    created = child;
    return child;
  };

  return { spawn, release: () => releaseGate?.(), child: () => created };
}

/** Deterministic fake clock (records timers; fire by predicate). */
function makeClock(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  fire: (pred: (t: { ms: number }) => boolean) => boolean;
} {
  const timers: Array<{ ms: number; fn: () => void; cleared: boolean }> = [];
  return {
    setTimer: (fn, ms) => {
      const t = { ms, fn, cleared: false };
      timers.push(t);
      return { clear: () => void (t.cleared = true) };
    },
    fire: (pred) => {
      const t = timers.find((x) => !x.cleared && pred(x));
      if (t !== undefined) {
        t.cleared = true;
        t.fn();
        return true;
      }
      return false;
    },
  };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Fold a stream of AgentEvents through the real reducer (skipping the purely-local
 * actions that have no event) to inspect the resulting nested tool state. */
function reduceEvents(events: AgentEvent[]): State {
  let state: State = initialState();
  for (const event of events) {
    const action = eventToAction(event as Evt);
    if (action !== undefined) {
      state = reducer(state, action);
    }
  }
  return state;
}

describe('codex parent spawns a juno subagent — full in-process wire', () => {
  it('renders the spawn card + nested child card, and round-trips the summary as the MCP result', async () => {
    // --- juno side: bridge over the real spawn_subagent tool + a fake subagent model.
    const spawnTool = createSubagentTool({
      createClient: () => toolCardClient('read_file'),
      catalog,
      policy,
      childTools: [],
    });
    const bridge = createCodexSpawnBridge({ spawnTool, nextToolCallId: () => 'codex-spawn-1' });

    // --- the in-process MCP server (juno) + a real SDK client (the codex side).
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSubagentMcpServer(bridge.spawn);
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'codex-fake', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(clientTransport);

    // --- the codex turn: a fake child that parks after thread.started until we
    // finish the MCP call, then completes the turn.
    const clock = makeClock();
    const { spawn, release } = makeGatedCodexChild({
      preLines: ['{"type":"thread.started","thread_id":"t1"}'],
      postLines: [
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":0}}',
      ],
    });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, bridge, setTimer: clock.setTimer });

    // Drain the codex turn in the background.
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const drain = (async () => {
      for await (const event of client.streamTurn(
        { id: 'codex-turn-1', messages: [{ role: 'user', content: 'delegate' }], cwd: '/work/jail' },
        noTools,
        controller.signal,
      )) {
        events.push(event);
      }
    })();

    // The codex child is now parked at the gate. Simulate codex calling the tool.
    await flush();
    const callResult = await mcpClient.callTool({
      name: SPAWN_SUBAGENT_TOOL,
      arguments: { task: 'read the file and summarize' },
    });

    // The subagent's summary came back as the MCP tool result.
    expect(callResult.isError).toBeFalsy();
    expect(callResult.content).toEqual([{ type: 'text', text: 'child summary' }]);

    // Let the codex turn finish.
    release();
    await drain;
    await mcpClient.close();
    await server.close();

    // The spawn card + nested child card interleaved into the codex turn's stream.
    const state = reduceEvents(events);
    expect(state.tools['codex-spawn-1']?.name).toBe('spawn_subagent');
    expect(state.tools['codex-spawn-1']?.status).toBe('result');
    const child = state.tools['codex-spawn-1::c1'];
    expect(child?.name).toBe('read_file');
    expect(child?.parentToolUseId).toBe('codex-spawn-1');
    expect(child?.status).toBe('result');

    // Requirement 3 lands on the RENDER path, not just the tools map: the spawn card must be
    // a BLOCK on the committed message. The reducer's defensive no-live branch also populates
    // state.tools WITHOUT appending a block, so a regression where the bridge's tool-call
    // lands outside a live turn (before assistant-start, or on a turn-id mismatch) would keep
    // the asserts above green while the spawn card became invisible in the transcript — the
    // render parity this test exists to prove.
    //
    // The nested CHILD, by contrast, is intentionally NOT a committed block. A forwarded
    // subagent-child tool-call carries a parentToolUseId, and the reducer now early-returns
    // for those — registering the child in state.tools (parentToolUseId + status round-trip
    // asserted above) WITHOUT appending its block to the parent message. Background children
    // run on a detached loop, so a stray child block would freeze the parent's thinking clock
    // and persist a card the render path already elides: the descendant guard in Message.tsx
    // (isSubagentDescendant) suppresses any subagent descendant from inline render regardless.
    // snapshotTools/toTurnMessages therefore stop carrying child tool cards — the child lives
    // in the tools map alone, and its nested render is driven by that parentToolUseId linkage.
    const blockToolIds = state.committed.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.kind === 'tool' ? [block.toolCallId] : [],
      ),
    );
    expect(blockToolIds).toContain('codex-spawn-1');
    expect(blockToolIds).not.toContain('codex-spawn-1::c1');

    // The turn ended cleanly (render-only collapse → 'end', never 'tool_use').
    const done = events.find((e) => e.type === 'assistant-done') as
      | Extract<AgentEvent, { type: 'assistant-done' }>
      | undefined;
    expect(done?.stopReason).toBe('end');
    // Usage from turn.completed still flows.
    expect(events.some((e) => e.type === 'usage')).toBe(true);
  });
});

describe('codex parent calls a Juno-managed tool — provider/bridge wire', () => {
  it('interleaves the real Juno tool lifecycle into the active provider turn', async () => {
    const managedTool: Tool = {
      name: 'poll_process',
      risk: 'safe',
      spec: {
        name: 'poll_process',
        description: 'poll a managed process',
        inputSchema: { type: 'object', properties: { process_id: { type: 'string' } }, required: ['process_id'] },
      },
      async run(args, ctx) {
        return { ok: true, data: { args, cwd: ctx.cwd, status: 'running' } };
      },
    };
    const bridge = createCodexSpawnBridge({
      spawnTool: managedTool,
      tools: [managedTool],
      policy,
      nextBridgeToolCallId: () => 'codex-juno-1',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createSubagentMcpServer(bridge.spawn, {
      specs: [managedTool.spec],
      call: (name, args, signal) => bridge.callTool!(name, args, signal),
    });
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'codex-fake', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(clientTransport);

    const clock = makeClock();
    const { spawn, release } = makeGatedCodexChild({
      preLines: ['{"type":"thread.started","thread_id":"t1"}'],
      postLines: ['{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'],
    });
    const client = createCodexCliClient(codexEntry, { spawnImpl: spawn, bridge, setTimer: clock.setTimer });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const event of client.streamTurn(
        { id: 'codex-turn-1', messages: [{ role: 'user', content: 'poll it' }], cwd: '/exact/workspace' },
        noTools,
        new AbortController().signal,
      )) events.push(event);
    })();

    await flush();
    const call = await mcpClient.callTool({ name: 'poll_process', arguments: { process_id: 'p1' } });
    expect(call.isError).toBeFalsy();
    expect((call.content as Array<{ text: string }>)[0]!.text).toBe(
      '{"args":{"process_id":"p1"},"cwd":"/exact/workspace","status":"running"}',
    );
    release();
    await drain;
    await mcpClient.close();
    await server.close();

    const state = reduceEvents(events);
    expect(state.tools['codex-juno-1']).toMatchObject({
      name: 'poll_process',
      status: 'result',
      result: { args: { process_id: 'p1' }, cwd: '/exact/workspace', status: 'running' },
    });
  });
});

describe('codex stall timers are suspended while a spawn is in flight', () => {
  it('a fired idle guard is IGNORED during a spawn and STALLS once it completes', async () => {
    // A subagent tool we hold open to keep a spawn "in flight" deterministically.
    let releaseSpawn: ((result: ToolResult) => void) | undefined;
    const spawnDone = new Promise<ToolResult>((resolve) => {
      releaseSpawn = resolve;
    });
    const gatedTool: Tool = {
      name: 'spawn_subagent',
      risk: 'risky',
      spec: { name: 'spawn_subagent', description: 'x', inputSchema: {} },
      async run(_args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
        return spawnDone;
      },
    };
    // Virtual clock for the bridge's post-spawn grace window (SPAWN_GRACE_MS), so we can
    // advance past it deterministically before expecting a stall.
    let bridgeNowMs = 0;
    const bridge = createCodexSpawnBridge({
      spawnTool: gatedTool,
      nextToolCallId: () => 'sp-1',
      now: () => bridgeNowMs,
    });

    // A codex child that emits one line then hangs forever (a quiet stdout).
    const clock = makeClock();
    const { spawn, child } = makeGatedCodexChild({
      preLines: ['{"type":"thread.started","thread_id":"t1"}'],
      hangForever: true,
    });
    const client = createCodexCliClient(codexEntry, {
      spawnImpl: spawn,
      bridge,
      setTimer: clock.setTimer,
      idleTimeoutMs: 1000,
      staleStreamMs: 5000,
    });

    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const drain = (async () => {
      for await (const event of client.streamTurn(
        { id: 'codex-turn-1', messages: [{ role: 'user', content: 'go' }], cwd: '/work/jail' },
        noTools,
        controller.signal,
      )) {
        events.push(event);
      }
    })();

    // Turn is registered + parked reading the (quiet) stdout; start a spawn.
    await flush();
    const spawnPromise = bridge.spawn({ task: 't' });
    await flush();
    expect(bridge.isSpawnActive()).toBe(true);
    // The spawn card + running status already interleaved into the codex stream.
    expect(
      events.some((e) => e.type === 'tool-call' && e.toolCallId === 'sp-1'),
    ).toBe(true);

    // Fire the idle guard WHILE the spawn is in flight → SUPPRESSED (re-armed, no
    // stall): the child is not killed and no error surfaces.
    expect(clock.fire((t) => t.ms === 1000)).toBe(true);
    await flush();
    expect(child()?.killed).toBeFalsy();
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // Complete the spawn → the card resolves, but a grace window keeps stall suppression on
    // for a beat (activeSpawns is decremented BEFORE codex receives the MCP response).
    releaseSpawn?.({ ok: true, data: { summary: 'done' } });
    await spawnPromise;
    await flush();
    expect(bridge.isSpawnActive()).toBe(true); // still within SPAWN_GRACE_MS
    expect(
      events.some(
        (e) => e.type === 'tool-status' && e.toolCallId === 'sp-1' && e.status === 'result',
      ),
    ).toBe(true);

    // A guard firing INSIDE the grace window is still suppressed — the child a subagent just
    // succeeded on must not be reaped in the gap before codex's next stdout chunk.
    expect(clock.fire((t) => t.ms === 1000)).toBe(true);
    await flush();
    expect(child()?.killed).toBeFalsy();
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // Advance past the grace window → suppression releases.
    bridgeNowMs += 10_000;
    expect(bridge.isSpawnActive()).toBe(false);

    // Now fire the (re-armed) idle guard again → NOT suppressed → the stream stalls:
    // the child is reaped and the turn ends in error.
    expect(clock.fire((t) => t.ms === 1000)).toBe(true);
    await drain;
    expect(child()?.killed).toBe(true);
    const errored = events.find((e) => e.type === 'error') as
      | Extract<AgentEvent, { type: 'error' }>
      | undefined;
    expect(errored?.message).toContain('stalled');
    const done = events.find((e) => e.type === 'assistant-done') as
      | Extract<AgentEvent, { type: 'assistant-done' }>
      | undefined;
    expect(done?.stopReason).toBe('error');
  });
});

// Wave 13 regression guard: the bridge must run a BLOCKING (runner-LESS) spawn tool
// even though the PRODUCTION app toolset now wires a background runner into
// spawn_subagent. If the bridge were handed the app's non-blocking tool (e.g. via a
// naive `tools.find('spawn_subagent')`), a codex parent's spawn would take the
// background path: run() returns a HANDLE ({ status:'spawned', … } — no `summary`)
// and the bridge's summary extraction yields '' — an EMPTY MCP tool result, and the
// "you'll be notified" promptText is on a channel codex never reads. This test wires
// the exact production seam (createDefaultTools with a runner → createCodexBridgeSpawnTool)
// and asserts the child summary still round-trips, so the regression cannot return.
describe('codex bridge stays BLOCKING when the app runner is wired (wave 13)', () => {
  it('round-trips the child summary, not the non-blocking background handle', async () => {
    // A REAL background runner, exactly as cli.ts builds one.
    const runner = createBackgroundAgentRunner({
      createClient: () => toolCardClient('read_file'),
      policy,
      cwd: '/work/jail',
    });
    // The sub-agent deps cli.ts hoists and shares (runner added only at the app call
    // site, never here). Inferred type carries no `runner`, matching the helper param.
    const subagentDeps = {
      createClient: () => toolCardClient('read_file'),
      catalog,
      policy,
    };
    // Production-shape app toolset: this spawn_subagent is NON-BLOCKING (runner-carrying).
    const tools = createDefaultTools({ subagent: { ...subagentDeps, runner } });

    // TRAP — the app's own spawn_subagent, run with a real toolCallId, returns a
    // background HANDLE with NO summary. Handing THIS instance to the bridge is the
    // exact regression this test guards against.
    const appSpawn = tools.find((t) => t.name === 'spawn_subagent');
    expect(appSpawn).toBeDefined();
    const handle = await appSpawn?.run(
      { task: 'delegate' },
      {
        cwd: '/work/jail',
        signal: new AbortController().signal,
        toolCallId: 'card-1',
        emit: () => {},
        awaitPermission: async () => 'deny',
        state: initialState(),
      } as ToolCtx,
    );
    expect(handle?.ok).toBe(true);
    const handleData = (handle as { data?: Record<string, unknown> } | undefined)?.data;
    expect(handleData?.status).toBe('spawned');
    expect(handleData?.summary).toBeUndefined();
    await flush(); // let the detached runner child settle
    runner.abortAll();

    // FIX — the bridge gets the runner-LESS clone from the SAME deps + tools, so it
    // BLOCKS on the child and returns its real summary as the MCP result.
    const bridgeTool = createCodexBridgeSpawnTool(tools, subagentDeps);
    const bridge = createCodexSpawnBridge({
      spawnTool: bridgeTool,
      nextToolCallId: () => 'codex-spawn-1',
    });
    const events: AgentEvent[] = [];
    const dispose = bridge.beginTurn({
      turnId: 'codex-turn-1',
      cwd: '/work/jail',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    const result = await bridge.spawn({ task: 'read the file and summarize' });
    dispose();

    // The regression returned '' here (empty MCP result); the fix returns the summary.
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe('child summary');

    // Nesting parity: the outer spawn card settled + the child card nested under it.
    const state = reduceEvents(events);
    expect(state.tools['codex-spawn-1']?.name).toBe('spawn_subagent');
    expect(state.tools['codex-spawn-1']?.status).toBe('result');
    expect(state.tools['codex-spawn-1::c1']?.parentToolUseId).toBe('codex-spawn-1');
    expect(state.tools['codex-spawn-1::c1']?.status).toBe('result');
  });
});
