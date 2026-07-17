import { describe, expect, it, vi } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createMcpClientConnection } from '../src/services/mcpClient';
import { createMcpManager, type McpManager } from '../src/services/mcpManager';
import type { McpServerConfig } from '../src/services/config';
import type { TimerHandle } from '../src/services/brain';

// ---------------------------------------------------------------------------
// Every test is HERMETIC — no real subprocess is ever spawned. Happy paths run a
// real SDK `Server` scripted over an InMemoryTransport linked pair; timeout/error
// paths use an injected manual timer and/or a fake transport. The default stdio
// transport factory is never exercised.
// ---------------------------------------------------------------------------

interface ScriptedServer {
  clientTransport: InMemoryTransport;
  server: Server;
}

/** Stand up a real MCP Server on one half of a linked pair, scripting its
 * tools/list and tools/call handlers; hand back the other half for a client. */
async function startScriptedServer(opts: {
  listTools?: () => Promise<{ tools: unknown[] }>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<ScriptedServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'scripted', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(
    ListToolsRequestSchema,
    opts.listTools ?? (async () => ({ tools: [] })),
  );
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (opts.callTool !== undefined) {
      return opts.callTool(name, args);
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  await server.connect(serverTransport);
  return { clientTransport, server };
}

/** A manual timer that fires only when told — the single active pending callback
 * (ops are sequential) is fired via `fire()`. Mirrors brainRecall's test timer. */
function makeManualTimer(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  fire: () => void;
} {
  let pending: (() => void) | undefined;
  return {
    setTimer: (fn) => {
      pending = fn;
      return {
        clear: () => {
          pending = undefined;
        },
      };
    },
    fire: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
  };
}

/** A hand-driven transport that leaves the `initialize` handshake in flight until
 * `completeHandshake()` is called, so a test can land close() in the exact window
 * between spawn and a resolved handshake (the quit-during-connect case). `wasClosed()`
 * records the child teardown. With `propagateClose:true` (the realistic stdio
 * behaviour) close() also fires the SDK-wired onclose so the pending handshake
 * unwinds; with `false` the handshake stays resolvable AFTER close, reproducing the
 * cold-start late-success race where a server answers seconds after the user quit. */
function makeInFlightTransport(opts: { propagateClose: boolean }): {
  transport: Transport;
  wasClosed: () => boolean;
  completeHandshake: () => void;
} {
  let initId: RequestId | undefined;
  let closed = false;
  const transport: Transport = {
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if ('method' in message && message.method === 'initialize' && 'id' in message) {
        initId = message.id;
      }
      // notifications/initialized and anything else: swallow (no server behind us).
    },
    async close(): Promise<void> {
      closed = true;
      // The SDK rewires onclose during connect(); firing it rejects the in-flight
      // handshake exactly as a killed stdio child would.
      if (opts.propagateClose) {
        transport.onclose?.();
      }
    },
  };
  return {
    transport,
    wasClosed: () => closed,
    completeHandshake: () => {
      const response: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: initId ?? 0,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: 'fake', version: '1.0.0' },
        },
      };
      transport.onmessage?.(response);
    },
  };
}

/** Records a destroy()/kill()/unref() on a mock of the spawned child. */
interface ChildTeardownSpy {
  destroyed: { stdin: boolean; stdout: boolean; stderr: boolean };
  killSignal: () => NodeJS.Signals | string | undefined;
  unrefed: () => boolean;
}

/** Attach a stdio-like `_process` child spy — destroyable pipes, a `kill`/`unref`, and
 * a `pid` — to a transport, mirroring the field the SDK's StdioClientTransport keeps at
 * `_process`. The `pid` makes the process-GROUP teardown (killpg via `process.kill(-pid)`)
 * observable; the direct-child kill is recorded via `killSignal`. */
function attachChildSpy(transport: Transport, pid: number): ChildTeardownSpy {
  const destroyed = { stdin: false, stdout: false, stderr: false };
  let killSignal: NodeJS.Signals | string | undefined;
  let unrefed = false;
  const mkStream = (key: 'stdin' | 'stdout' | 'stderr'): { destroy: () => void } => ({
    destroy: () => {
      destroyed[key] = true;
    },
  });
  (transport as unknown as { _process: unknown })._process = {
    pid,
    stdin: mkStream('stdin'),
    stdout: mkStream('stdout'),
    stderr: mkStream('stderr'),
    kill: (signal?: NodeJS.Signals): boolean => {
      killSignal = signal;
      return true;
    },
    unref: (): void => {
      unrefed = true;
    },
  };
  return { destroyed, killSignal: () => killSignal, unrefed: () => unrefed };
}

/** Like makeInFlightTransport, but shaped like the SDK's real `StdioClientTransport`:
 * it carries a `_process` with destroyable stdio streams + `kill`/`unref`, so a test
 * can assert the teardown actually releases OUR ends of the child's pipes. This is
 * the exit-hang guard: the real transport leaves those pipe `Socket`s alive on close,
 * and when a descendant of the child holds the pipe open they keep the Node event
 * loop alive forever. `close()` fires the SDK-wired onclose so the in-flight handshake
 * unwinds, exactly as a killed stdio child would. */
function makeStdioLikeInFlightTransport(): {
  transport: Transport;
  spy: ChildTeardownSpy;
  wasClosed: () => boolean;
} {
  const destroyed = { stdin: false, stdout: false, stderr: false };
  let killSignal: NodeJS.Signals | string | undefined;
  let unrefed = false;
  let initId: RequestId | undefined;
  let closed = false;
  const mkStream = (key: 'stdin' | 'stdout' | 'stderr'): { destroy: () => void } => ({
    destroy: () => {
      destroyed[key] = true;
    },
  });
  const child = {
    stdin: mkStream('stdin'),
    stdout: mkStream('stdout'),
    stderr: mkStream('stderr'),
    kill: (signal?: NodeJS.Signals): boolean => {
      killSignal = signal;
      return true;
    },
    unref: (): void => {
      unrefed = true;
    },
  };
  const transport = {
    // The field the client reads to force-release the spawned child (mirrors the
    // SDK's StdioClientTransport internal name).
    _process: child,
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if ('method' in message && message.method === 'initialize' && 'id' in message) {
        initId = message.id;
      }
    },
    async close(): Promise<void> {
      closed = true;
      transport.onclose?.();
    },
  } as unknown as Transport & { onclose?: () => void };
  void initId;
  return {
    transport,
    spy: { destroyed, killSignal: () => killSignal, unrefed: () => unrefed },
    wasClosed: () => closed,
  };
}

/** A stdio-like fake transport (carries a `_process` child spy, like the real
 * `StdioClientTransport`) that COMPLETES the initialize handshake — so connect()
 * succeeds and a child goes LIVE — but answers every `tools/list` with a JSON-RPC
 * ERROR, so listTools() fails on a fully connected client. This reproduces the
 * connect-ok/list-fail reconnect path; the spy lets a test assert the orphaned child
 * is force-released once the manager gives up retrying (the resource-leak gate). */
function makeStdioLikeListFailTransport(): {
  transport: Transport;
  spy: ChildTeardownSpy;
} {
  const destroyed = { stdin: false, stdout: false, stderr: false };
  let killSignal: NodeJS.Signals | string | undefined;
  let unrefed = false;
  const mkStream = (key: 'stdin' | 'stdout' | 'stderr'): { destroy: () => void } => ({
    destroy: () => {
      destroyed[key] = true;
    },
  });
  const child = {
    stdin: mkStream('stdin'),
    stdout: mkStream('stdout'),
    stderr: mkStream('stderr'),
    kill: (signal?: NodeJS.Signals): boolean => {
      killSignal = signal;
      return true;
    },
    unref: (): void => {
      unrefed = true;
    },
  };
  const transport = {
    // Mirrors StdioClientTransport's internal field the client force-releases.
    _process: child,
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if (!('method' in message) || !('id' in message)) {
        return; // notifications (e.g. notifications/initialized): nothing to answer.
      }
      const id = message.id;
      const reply: JSONRPCMessage =
        message.method === 'initialize'
          ? {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'fake', version: '1.0.0' },
              },
            }
          : {
              // Any other request (here: tools/list) fails on the live client.
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'tools/list boom' },
            };
      queueMicrotask(() => transport.onmessage?.(reply));
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  } as unknown as Transport & {
    onmessage?: (message: JSONRPCMessage) => void;
    onclose?: () => void;
  };
  return { transport, spy: { destroyed, killSignal: () => killSignal, unrefed: () => unrefed } };
}

/** A transport that completes the `initialize` handshake, then — on the tools/list
 * request — delivers a VALID tools response and IMMEDIATELY fires onclose in the SAME
 * synchronous read (the "server answered, then its child died" ordering). This is the
 * exact interleaving behind the reconnect latch race: a reconnect attempt sees listTools
 * resolve ok while the connection it just brought up has already dropped. */
function makeAnswerThenDropTransport(tools: unknown[]): Transport {
  const transport: Transport = {
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if (!('method' in message) || !('id' in message)) {
        return; // notifications (e.g. notifications/initialized) — nothing to answer
      }
      if (message.method === 'initialize') {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'answer-then-drop', version: '1.0.0' },
          },
        });
        return;
      }
      if (message.method === 'tools/list') {
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { tools } }); // answered...
        transport.onclose?.(); // ...then the child died in the same read
        return;
      }
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  };
  return transport;
}

/** A transport that completes `initialize` + answers `tools/list` NORMALLY (no drop in
 * the same read, UNLIKE makeAnswerThenDropTransport), so a reconnect fully goes LIVE —
 * then drops only when the test calls `drop()` on a LATER macrotask. Models a clean-
 * recover-then-drop flapper: each reconnect succeeds and lives briefly before dropping. */
function makeRecoverThenDropTransport(tools: unknown[]): { transport: Transport; drop: () => void } {
  const transport: Transport = {
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if (!('method' in message) || !('id' in message)) {
        return; // notifications (e.g. notifications/initialized) — nothing to answer
      }
      if (message.method === 'initialize') {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'recover-then-drop', version: '1.0.0' },
          },
        });
        return;
      }
      if (message.method === 'tools/list') {
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { tools } });
        return; // answered — and NO drop in the same read, so the reconnect goes live
      }
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  };
  // `onclose` is rewired by the SDK Client during connect; read it lazily at call time.
  return { transport, drop: () => transport.onclose?.() };
}

/** A transport that handshakes + lists tools normally, but DROPS in the same read on a
 * `tools/call` (fires onclose), so the in-flight call rejects with a transport-class
 * error (`retriable`). Models a child that dies mid-call. */
function makeDropOnCallTransport(tools: unknown[]): Transport {
  const transport: Transport = {
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if (!('method' in message) || !('id' in message)) {
        return;
      }
      if (message.method === 'initialize') {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'drop-on-call', version: '1.0.0' },
          },
        });
        return;
      }
      if (message.method === 'tools/list') {
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { tools } });
        return;
      }
      if (message.method === 'tools/call') {
        transport.onclose?.(); // the child dies mid-call → the pending call rejects
        return;
      }
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  };
  return transport;
}

/** A transport whose `initialize` handshake is HELD until `release()` is called, so a
 * test can keep a manager `bringLive`/reconnect connect() suspended across a manual
 * backoff-timer fire (the concurrent-connect race). On release it answers `initialize`,
 * then serves `tools/list` and `tools/call`. With `failFirstList` the FIRST tools/list
 * errors (a connect-ok/list-fail revive) and later ones succeed — so a re-armed reconnect
 * timer, re-listing on the still-live connection, can recover it (the consumed-timer path). */
function makeHeldHandshakeTransport(opts: { tools?: unknown[]; failFirstList?: boolean }): {
  transport: Transport;
  release: () => void;
} {
  let initId: RequestId | undefined;
  let released = false;
  let listCalls = 0;
  const answerInit = (): void => {
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: initId ?? 0,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'held', version: '1.0.0' },
      },
    });
  };
  const transport: Transport = {
    async start(): Promise<void> {},
    async send(message: JSONRPCMessage): Promise<void> {
      if (!('method' in message) || !('id' in message)) {
        return; // notifications (e.g. notifications/initialized) — nothing to answer
      }
      if (message.method === 'initialize') {
        initId = message.id;
        if (released) {
          answerInit(); // release() already fired — answer straight away
        }
        return;
      }
      if (message.method === 'tools/list') {
        const fail = opts.failFirstList === true && listCalls === 0;
        listCalls += 1;
        transport.onmessage?.(
          fail
            ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'tools/list boom' } }
            : { jsonrpc: '2.0', id: message.id, result: { tools: opts.tools ?? [] } },
        );
        return;
      }
      if (message.method === 'tools/call') {
        const name = (message.params as { name?: string } | undefined)?.name ?? '';
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `revived:${name}` }] },
        });
        return;
      }
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
  };
  return {
    transport,
    release: () => {
      released = true;
      if (initId !== undefined) {
        answerInit();
      }
    },
  };
}

/** Flush pending micro/macro-tasks so the SDK's start() + `initialize` send land. */
async function flushHandshake(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Yield macrotasks until `pred` holds (a reconnect + its teardown span several). */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('waitFor: predicate never became true');
}

/** Poll the manager's per-server state until it reaches `state` (a reconnect runs
 * async after its backoff timer fires; connect+list over the InMemory pair spans
 * several macrotasks). A macrotask yield, never a real sleep. */
async function waitForServerState(
  manager: McpManager,
  server: string,
  state: 'connected' | 'failed',
  tries = 100,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (manager.status().find((row) => row.server === server)?.state === state) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${server} → ${state}`);
}

const CONFIG: McpServerConfig = { command: ['irrelevant'] };
const CWD = '/tmp/ws';

describe('createMcpClientConnection (in-memory scripted server)', () => {
  it('connects (initialize), lists tools, and normalizes their descriptors', async () => {
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
          // A valid tool with no description — exercises the optional-description path.
          { name: 'plain', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });

    expect(conn.serverName).toBe('srv');
    expect(await conn.connect()).toEqual({ ok: true });

    const list = await conn.listTools();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.tools).toEqual([
        { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
        { name: 'plain', inputSchema: { type: 'object' } },
      ]);
    }
    await conn.close();
  });

  it('drops a duplicate tool name from one server (keep first) with a warning', async () => {
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: 'dup', description: 'first', inputSchema: { type: 'object' } },
          { name: 'dup', description: 'second', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const list = await conn.listTools();
    expect(list.ok).toBe(true);
    if (list.ok) {
      // Only the FIRST descriptor survives — no duplicate spec can reach the model.
      expect(list.tools).toEqual([{ name: 'dup', description: 'first', inputSchema: { type: 'object' } }]);
      expect(list.warnings).toHaveLength(1);
      expect(list.warnings[0]).toContain('mcp[srv]: dropped duplicate tool "dup"');
    }
    await conn.close();
  });

  it.each([
    ['double-underscore', 'evil__tool'],
    ['glob star', 'wild*card'],
    ['matchKey colon', 'ns:tool'],
    ['space', 'my tool'],
    ['dot', 'tool.v2'],
    ['unicode', 'öutil'],
    // Over the provider bound (64) on its own.
    ['over-64-char name', 'x'.repeat(70)],
    // Fine alone (55 ≤ 64) but `mcp__srv__` (10) + 55 = 65 > 64 — the FULL
    // namespaced name is what the provider validates, so it must be dropped.
    ['name pushing the namespaced form past 64', 'y'.repeat(55)],
  ])('drops a tool whose name violates the spec-name allowlist (%s) with a warning', async (_label, badName) => {
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: badName, inputSchema: { type: 'object' } },
          { name: 'ok', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const list = await conn.listTools();
    expect(list.ok).toBe(true);
    if (list.ok) {
      // The safe tool survives; the invalid-name one is dropped with a warning.
      expect(list.tools).toEqual([{ name: 'ok', inputSchema: { type: 'object' } }]);
      expect(list.warnings).toHaveLength(1);
      expect(list.warnings[0]).toContain(`dropped tool "${badName}"`);
    }
    await conn.close();
  });

  it('keeps a maximal-length valid name whose namespaced form exactly fits 64 chars', async () => {
    // serverName 'srv' (3) + 'mcp__'+'__' overhead (7) = 10, so a 54-char tool
    // name makes `mcp__srv__<tool>` exactly 64 — the largest name that must survive.
    const maximal = 'z'.repeat(54);
    expect(`mcp__srv__${maximal}`).toHaveLength(64);
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: maximal, inputSchema: { type: 'object' } }] }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const list = await conn.listTools();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.tools).toEqual([{ name: maximal, inputSchema: { type: 'object' } }]);
      expect(list.warnings).toEqual([]);
    }
    await conn.close();
  });

  it('calls a tool and returns its content + isError:false', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: async (name, args) => ({
        content: [{ type: 'text', text: `${name}:${String(args.msg)}` }],
      }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();

    const out = await conn.callTool('echo', { msg: 'hi' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.isError).toBe(false);
      expect(out.result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
    }
    await conn.close();
  });

  it('passes structuredContent through when present', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: async () => ({
        content: [{ type: 'text', text: 'x' }],
        structuredContent: { answer: 42 },
      }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const out = await conn.callTool('q');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.structuredContent).toEqual({ answer: 42 });
    }
    await conn.close();
  });

  it('surfaces a tool-level error as ok:true with isError:true (not a transport failure)', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const out = await conn.callTool('explode');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.isError).toBe(true);
    }
    await conn.close();
  });

  it('is idempotent on a second connect', async () => {
    const { clientTransport } = await startScriptedServer({});
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    expect(await conn.connect()).toEqual({ ok: true });
    expect(await conn.connect()).toEqual({ ok: true });
    await conn.close();
  });

  it('an unexpected transport close nulls the client and fires onDrop (drop detection)', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    let drops = 0;
    const conn = createMcpClientConnection(
      'srv',
      CONFIG,
      CWD,
      { transportFactory: () => clientTransport },
      () => {
        drops += 1;
      },
    );
    await conn.connect();
    expect((await conn.callTool('x')).ok).toBe(true);

    // The child dies / the pipe breaks — the SDK fires the transport's onclose.
    clientTransport.onclose?.();

    expect(drops).toBe(1);
    // The live client is dropped, so the next call short-circuits (was: it would
    // dispatch into a dead client and only fail at the per-call timeout).
    expect(await conn.callTool('x')).toEqual({ ok: false, error: 'mcp[srv]: not connected', retriable: true });
  });

  it('force-releases the spawned child on an UNEXPECTED drop (no leaked pipe keeps the loop alive)', async () => {
    // Wave 9 flipped status to failed on drop, but the drop path never released the
    // child: the SDK transport leaves OUR ends of its stdio pipes as live Node `Socket`s,
    // and when a DESCENDANT of the dropped child holds the stdout pipe open, that readable
    // Socket keeps the Node event loop alive past the drop (the mid-session twin of the
    // quit-during-connect exit-hang). The onclose handler must now destroy our pipe ends
    // and SIGKILL/unref the child, exactly as close()/teardown do.
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // Attach a stdio-like child where the SDK's StdioClientTransport keeps `_process`, so
    // the connection can force-release OUR pipe ends when the transport drops. The real
    // handshake still runs over the scripted InMemory pair; this only adds the child spy.
    const destroyed = { stdin: false, stdout: false, stderr: false };
    let killSignal: NodeJS.Signals | string | undefined;
    let unrefed = false;
    const mkStream = (key: 'stdin' | 'stdout' | 'stderr'): { destroy: () => void } => ({
      destroy: () => {
        destroyed[key] = true;
      },
    });
    (clientTransport as unknown as { _process: unknown })._process = {
      stdin: mkStream('stdin'),
      stdout: mkStream('stdout'),
      stderr: mkStream('stderr'),
      kill: (signal?: NodeJS.Signals): boolean => {
        killSignal = signal;
        return true;
      },
      unref: (): void => {
        unrefed = true;
      },
    };

    let drops = 0;
    const conn = createMcpClientConnection(
      'srv',
      CONFIG,
      CWD,
      { transportFactory: () => clientTransport },
      () => {
        drops += 1;
      },
    );
    await conn.connect();
    expect((await conn.listTools()).ok).toBe(true); // live
    // Nothing torn down while the server is healthy.
    expect(destroyed).toEqual({ stdin: false, stdout: false, stderr: false });

    // The child dies / a pipe breaks — the SDK fires the transport's onclose (a DROP,
    // not a deliberate close()).
    clientTransport.onclose?.();

    expect(drops).toBe(1);
    // OUR ends of every child pipe are destroyed so no held-open pipe Socket can keep the
    // loop alive; the child itself is force-killed and unref'd.
    expect(destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
    expect(killSignal).toBe('SIGKILL');
    expect(unrefed).toBe(true);
    // ...and the live client is still dropped, so the next call short-circuits.
    expect(await conn.listTools()).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
  });

  it('a deliberate close() is not reported as a drop', async () => {
    const { clientTransport } = await startScriptedServer({});
    let drops = 0;
    const conn = createMcpClientConnection(
      'srv',
      CONFIG,
      CWD,
      { transportFactory: () => clientTransport },
      () => {
        drops += 1;
      },
    );
    await conn.connect();
    await conn.close();
    // close() latches `closed` before tearing the transport down, so the onclose it
    // triggers is recognized as deliberate — onDrop must NOT fire.
    expect(drops).toBe(0);
  });

  it('maps a rejected tools/call (server handler throws) to ok:false', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: async () => {
        throw new Error('kaboom');
      },
    });
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => clientTransport,
    });
    await conn.connect();
    const out = await conn.callTool('bad');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('mcp[srv]: tool "bad" failed');
    }
    await conn.close();
  });

  it('rejects listTools / callTool before connect', async () => {
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => {
        throw new Error('should not build');
      },
    });
    expect(await conn.listTools()).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
    expect(await conn.callTool('x')).toEqual({ ok: false, error: 'mcp[srv]: not connected', retriable: true });
  });

  it('errors when the configured command is empty', async () => {
    const conn = createMcpClientConnection('srv', { command: [] }, CWD, {
      transportFactory: () => {
        throw new Error('should not build');
      },
    });
    expect(await conn.connect()).toEqual({ ok: false, error: 'mcp[srv]: no command configured' });
  });

  it('fails soft when the transport factory throws', async () => {
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => {
        throw new Error('no binary');
      },
    });
    const out = await conn.connect();
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('failed to build transport');
    }
  });

  it('fails soft when the transport start rejects', async () => {
    const failing: Transport = {
      async start() {
        throw new Error('spawn ENOENT');
      },
      async send() {},
      async close() {},
    };
    const conn = createMcpClientConnection('srv', CONFIG, CWD, {
      transportFactory: () => failing,
    });
    const out = await conn.connect();
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('mcp[srv]: connect failed');
    }
  });

  it('times out a hung connect and reports it (injected timer)', async () => {
    // A lone client half whose peer is never connected: the initialize request
    // is sent but never answered, so connect hangs until the timer fires.
    const [clientTransport] = InMemoryTransport.createLinkedPair();
    const timer = makeManualTimer();
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 1234 }, CWD, {
      transportFactory: () => clientTransport,
      setTimer: timer.setTimer,
    });
    const promise = conn.connect();
    timer.fire();
    expect(await promise).toEqual({ ok: false, error: 'mcp[srv]: connect timed out after 1234ms' });
  });

  it('terminates the spawned child when close() lands during an in-flight connect', async () => {
    // The wave moved start() to after render, so a ctrl-c can unmount App mid-
    // handshake. Pre-fix, close() no-ops while the client is still connecting, so
    // the spawned child leaks and the process cannot exit (up to the 30s timeout).
    const ctl = makeInFlightTransport({ propagateClose: true });
    // The connect timeout must never be what unwinds this — the child has to die on
    // close, not on the timer — so inject a manual timer that is never fired.
    const timer = makeManualTimer();
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 30_000 }, CWD, {
      transportFactory: () => ctl.transport,
      setTimer: timer.setTimer,
    });

    const connectPromise = conn.connect();
    await flushHandshake(); // the initialize request is out; the handshake now hangs
    expect(ctl.wasClosed()).toBe(false);

    await conn.close(); // quit while the connect is still in flight

    // The freshly spawned child is torn down (not left alive until the timeout)...
    expect(ctl.wasClosed()).toBe(true);
    // ...and the in-flight connect unwinds to a soft failure, never a live client.
    const outcome = await connectPromise;
    expect(outcome.ok).toBe(false);
    expect(await conn.listTools()).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
  });

  it('destroys the spawned child pipes + kills it on close() during connect (exit-hang guard)', async () => {
    // Round 1 killed the child but the SDK transport leaves OUR ends of its stdio
    // pipes as live Node `Socket`s: when a descendant of the child (an npx/sh
    // launcher, a forked worker) holds the stdout pipe open, the child's `close`
    // never fires and that readable Socket keeps the event loop alive forever — juno
    // unmounts but the process never exits (the exit-hang). close() must destroy our
    // pipe ends and terminate the child so the loop can drain regardless.
    const stdio = makeStdioLikeInFlightTransport();
    // The connect timeout must never be what unwinds this — inject a manual timer
    // that is never fired, so a clean unwind proves it was cleared, not that it lapsed.
    let timerCleared = false;
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 30_000 }, CWD, {
      transportFactory: () => stdio.transport,
      setTimer: (_fn) => ({ clear: () => { timerCleared = true; } }),
    });

    const connectPromise = conn.connect();
    await flushHandshake(); // initialize is out; the handshake now hangs
    // Nothing torn down yet.
    expect(stdio.spy.destroyed).toEqual({ stdin: false, stdout: false, stderr: false });

    await conn.close(); // quit while the connect is still in flight

    // OUR ends of every child pipe are destroyed so no held-open pipe Socket can
    // keep the loop alive; the child itself is force-killed and unref'd.
    expect(stdio.spy.destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
    expect(stdio.spy.killSignal()).toBe('SIGKILL');
    expect(stdio.spy.unrefed()).toBe(true);
    expect(stdio.wasClosed()).toBe(true);

    // ...and the connect still unwinds to a soft failure, never a live client.
    const outcome = await connectPromise;
    expect(outcome.ok).toBe(false);
    expect(await conn.listTools()).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
    // The in-flight connect's timeout timer was cleared (not left pending on the
    // loop) as the connect settled — nothing here keeps the event loop alive.
    expect(timerCleared).toBe(true);
  });

  it('does not publish a client whose handshake resolves after close() (late-success leak)', async () => {
    // Cold-start race: the server answers a few seconds after the user already quit.
    // The freshly resolved client must be closed and NOT published — otherwise its
    // child handle keeps the Node event loop alive and juno never exits.
    const ctl = makeInFlightTransport({ propagateClose: false });
    const timer = makeManualTimer();
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 30_000 }, CWD, {
      transportFactory: () => ctl.transport,
      setTimer: timer.setTimer,
    });

    const connectPromise = conn.connect();
    await flushHandshake();

    await conn.close();
    expect(ctl.wasClosed()).toBe(true); // child killed on quit

    // The handshake now completes late — the connection must refuse to go live.
    ctl.completeHandshake();
    const outcome = await connectPromise;
    expect(outcome.ok).toBe(false);
    expect(await conn.listTools()).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
  });

  it('times out a hung tools/list and reports it (injected timer)', async () => {
    const { clientTransport } = await startScriptedServer({
      listTools: () => new Promise(() => {}), // never resolves
    });
    const timer = makeManualTimer();
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 500 }, CWD, {
      transportFactory: () => clientTransport,
      setTimer: timer.setTimer,
    });
    // connect resolves fast; its timer is cleared, so firing now only affects the
    // subsequent (hung) tools/list.
    expect(await conn.connect()).toEqual({ ok: true });
    const listPromise = conn.listTools();
    timer.fire();
    expect(await listPromise).toEqual({ ok: false, error: 'mcp[srv]: tools/list timed out after 500ms' });
    await conn.close();
  });

  it('times out a hung tools/call and reports it (injected timer)', async () => {
    const { clientTransport } = await startScriptedServer({
      callTool: () => new Promise(() => {}), // never resolves
    });
    const timer = makeManualTimer();
    const conn = createMcpClientConnection('srv', { command: ['x'], timeoutMs: 700 }, CWD, {
      transportFactory: () => clientTransport,
      setTimer: timer.setTimer,
    });
    await conn.connect();
    const callPromise = conn.callTool('slow', { a: 1 });
    timer.fire();
    expect(await callPromise).toEqual({ ok: false, error: 'mcp[srv]: tool "slow" timed out after 700ms' });
    await conn.close();
  });
});

describe('process-group teardown (detached stdio children)', () => {
  // The default stdio transport now spawns the child DETACHED (its own process-group
  // leader), so a teardown can reap the WHOLE tree — an npx→node server, a forked
  // worker — via `process.kill(-pid, 'SIGKILL')`, not just the direct child. Both the
  // deliberate close() and the unexpected-drop paths funnel through releaseChild, so a
  // single change covers both. The custom transport's real spawn is not exercised here
  // (the hermetic suite spawns no subprocess); these pin the killpg behaviour via a
  // stdio-like `_process` spy carrying a pid, with process.kill mocked out.

  it('reaps the whole process group (killpg) on an unexpected drop, in addition to the direct child kill', async () => {
    const { clientTransport } = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const spy = attachChildSpy(clientTransport, 4242);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const conn = createMcpClientConnection('srv', CONFIG, CWD, {
        transportFactory: () => clientTransport,
      });
      await conn.connect();
      expect((await conn.listTools()).ok).toBe(true);

      // The child dies / a pipe breaks — the SDK fires the transport's onclose (a DROP).
      clientTransport.onclose?.();

      // The whole GROUP is signalled (negative pid) AND the direct child is SIGKILL-ed,
      // and our pipe ends are destroyed + the child unref'd.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(spy.killSignal()).toBe('SIGKILL');
      expect(spy.destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
      expect(spy.unrefed()).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reaps the whole process group (killpg) on a deliberate close()', async () => {
    const { clientTransport } = await startScriptedServer({});
    const spy = attachChildSpy(clientTransport, 5353);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const conn = createMcpClientConnection('srv', CONFIG, CWD, {
        transportFactory: () => clientTransport,
      });
      await conn.connect();
      await conn.close();

      expect(killSpy).toHaveBeenCalledWith(-5353, 'SIGKILL');
      expect(spy.killSignal()).toBe('SIGKILL');
      expect(spy.destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
      expect(spy.unrefed()).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('skips the negative-pid group kill on win32 (no process groups) but still kills the child', async () => {
    const { clientTransport } = await startScriptedServer({});
    const spy = attachChildSpy(clientTransport, 6464);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const conn = createMcpClientConnection('srv', CONFIG, CWD, {
        transportFactory: () => clientTransport,
      });
      await conn.connect();
      await conn.close();

      // No process-group signal on Windows (there are no process groups)...
      expect(killSpy).not.toHaveBeenCalled();
      // ...but the direct child kill + pipe destroy still run.
      expect(spy.killSignal()).toBe('SIGKILL');
      expect(spy.destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      killSpy.mockRestore();
    }
  });
});

describe('createMcpManager (in-memory scripted servers)', () => {
  it('connects all servers in parallel and aggregates server-tagged tools', async () => {
    const a = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'a_tool', inputSchema: { type: 'object' } }] }),
    });
    const b = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'b_tool', inputSchema: { type: 'object' } }] }),
    });
    const byCmd: Record<string, InMemoryTransport> = { srvA: a.clientTransport, srvB: b.clientTransport };

    const manager = createMcpManager(
      { alpha: { command: ['srvA'] }, beta: { command: ['srvB'] } },
      CWD,
      { transportFactory: (config) => byCmd[config.command[0] ?? ''] as Transport },
    );

    const result = await manager.start();
    expect(result).toEqual({ connected: ['alpha', 'beta'], warnings: [] });
    expect(manager.listTools()).toEqual([
      { server: 'alpha', tool: { name: 'a_tool', inputSchema: { type: 'object' } } },
      { server: 'beta', tool: { name: 'b_tool', inputSchema: { type: 'object' } } },
    ]);
    await manager.shutdownAll();
  });

  it('surfaces per-tool drop warnings (duplicate + reserved name) through start().warnings', async () => {
    // One server returns a duplicate name AND an unsafe (`__`) name; the manager
    // must aggregate only the safe, unique tools and surface a warning for each drop.
    const s = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: 'go', inputSchema: { type: 'object' } },
          { name: 'go', inputSchema: { type: 'object' } },
          { name: 'a__b', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const manager = createMcpManager({ srv: { command: ['s'] } }, CWD, {
      transportFactory: () => s.clientTransport,
    });
    const result = await manager.start();
    expect(result.connected).toEqual(['srv']);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('dropped duplicate tool "go"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('dropped tool "a__b"'))).toBe(true);
    // Only one `go` reaches discovery — no duplicate spec can reach the model request.
    expect(manager.listTools()).toEqual([
      { server: 'srv', tool: { name: 'go', inputSchema: { type: 'object' } } },
    ]);
    await manager.shutdownAll();
  });

  it('is fail-soft: a broken server is skipped with a warning, others still come up', async () => {
    const good = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'ok_tool', inputSchema: { type: 'object' } }] }),
    });
    const manager = createMcpManager(
      { good: { command: ['good'] }, bad: { command: ['bad'] } },
      CWD,
      {
        transportFactory: (config) => {
          if (config.command[0] === 'bad') {
            throw new Error('no binary');
          }
          return good.clientTransport;
        },
      },
    );

    const result = await manager.start();
    expect(result.connected).toEqual(['good']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('mcp[bad]: failed to build transport');
    expect(manager.listTools()).toEqual([
      { server: 'good', tool: { name: 'ok_tool', inputSchema: { type: 'object' } } },
    ]);
    await manager.shutdownAll();
  });

  it('status() snapshots every configured server with connected/failed state and risk-tagged tools', async () => {
    // A two-server fleet: `brain` comes up with three tools whose risk is classified
    // by the SAME shared `classifyRisk` the adapter uses (recall/get_episode → safe
    // via toolRisk, remember → risky default); `down` fails to build a transport and
    // must still appear as a failed, zero-tool row.
    const brain = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: 'recall', inputSchema: { type: 'object' } },
          { name: 'get_episode', inputSchema: { type: 'object' } },
          { name: 'remember', inputSchema: { type: 'object' } },
        ],
      }),
    });
    const manager = createMcpManager(
      {
        brain: { command: ['brain'], toolRisk: { recall: 'safe', get_episode: 'safe' } },
        down: { command: ['down'] },
      },
      CWD,
      {
        transportFactory: (config) => {
          if (config.command[0] === 'down') {
            throw new Error('no binary');
          }
          return brain.clientTransport;
        },
      },
    );

    // BEFORE start(): nothing is live yet, so every server reads 'failed' with zero
    // tools (the panel gates on the connecting state to override these rows).
    expect(manager.status()).toEqual([
      { server: 'brain', state: 'failed', toolCount: 0, tools: [] },
      { server: 'down', state: 'failed', toolCount: 0, tools: [] },
    ]);

    await manager.start();

    // AFTER start(): servers are sorted, the live one carries its risk-tagged tools
    // (also sorted), and the failed one is still a zero-tool row.
    expect(manager.status()).toEqual([
      {
        server: 'brain',
        state: 'connected',
        toolCount: 3,
        tools: [
          { name: 'get_episode', risk: 'safe' },
          { name: 'recall', risk: 'safe' },
          { name: 'remember', risk: 'risky' },
        ],
      },
      { server: 'down', state: 'failed', toolCount: 0, tools: [] },
    ]);

    await manager.shutdownAll();
    // shutdownAll clears discovery, so status() reverts to all-failed zero-tool rows.
    expect(manager.status()).toEqual([
      { server: 'brain', state: 'failed', toolCount: 0, tools: [] },
      { server: 'down', state: 'failed', toolCount: 0, tools: [] },
    ]);
  });

  it('surfaces an unexpected drop: status() flips to failed and callTool short-circuits', async () => {
    const brain = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => brain.clientTransport },
    );
    await manager.start();

    expect(manager.status()[0]?.state).toBe('connected');
    expect((await manager.callTool('brain', 'recall')).ok).toBe(true);

    // The server drops mid-session (child died): the SDK fires the transport onclose.
    brain.clientTransport.onclose?.();

    // The drop is surfaced instead of the server lingering 'connected' until the next
    // per-call timeout: status() flips to 'failed' and callTool short-circuits.
    expect(manager.status()[0]?.state).toBe('failed');
    expect(await manager.callTool('brain', 'recall')).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "brain"',
    });
  });

  it('routes callTool to the right server and rejects unknown/unavailable servers', async () => {
    const a = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `from-A:${name}` }] }),
    });
    const b = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `from-B:${name}` }] }),
    });
    const byCmd: Record<string, InMemoryTransport> = { A: a.clientTransport, B: b.clientTransport };
    const manager = createMcpManager(
      { alpha: { command: ['A'] }, beta: { command: ['B'] } },
      CWD,
      { transportFactory: (config) => byCmd[config.command[0] ?? ''] as Transport },
    );
    await manager.start();

    const fromA = await manager.callTool('alpha', 't');
    expect(fromA.ok && fromA.result.content).toEqual([{ type: 'text', text: 'from-A:t' }]);
    const fromB = await manager.callTool('beta', 't');
    expect(fromB.ok && fromB.result.content).toEqual([{ type: 'text', text: 'from-B:t' }]);

    expect(await manager.callTool('ghost', 't')).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "ghost"',
    });
    await manager.shutdownAll();
  });

  it('start() is idempotent (returns the same result without reconnecting)', async () => {
    const a = await startScriptedServer({ listTools: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) });
    const manager = createMcpManager({ alpha: { command: ['A'] } }, CWD, {
      transportFactory: () => a.clientTransport,
    });
    const first = await manager.start();
    const second = await manager.start();
    expect(second).toEqual(first);
    await manager.shutdownAll();
  });

  it('shutdownAll clears discovered tools and makes servers unavailable', async () => {
    const a = await startScriptedServer({ listTools: async () => ({ tools: [{ name: 't', inputSchema: { type: 'object' } }] }) });
    const manager = createMcpManager({ alpha: { command: ['A'] } }, CWD, {
      transportFactory: () => a.clientTransport,
    });
    await manager.start();
    expect(manager.listTools()).toHaveLength(1);
    await manager.shutdownAll();
    expect(manager.listTools()).toEqual([]);
    expect(await manager.callTool('alpha', 't')).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "alpha"',
    });
  });

  it('handles an empty server map (no servers configured)', async () => {
    const manager = createMcpManager({}, CWD);
    expect(await manager.start()).toEqual({ connected: [], warnings: [] });
    expect(manager.listTools()).toEqual([]);
    await manager.shutdownAll();
  });

  it('reconnects a dropped server with bounded backoff and re-registers its (changed) tools', async () => {
    // The onclose seam flips a dropped server to failed (Wave 9). Reconnect layers a
    // bounded-backoff retry ON TOP: after the backoff timer fires the manager rebuilds
    // the connection on a FRESH transport, re-lists, and re-registers the recovered —
    // here LARGER — tool set, notifying subscribers so the UI late-binds it cleanly.
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const second = await startScriptedServer({
      listTools: async () => ({
        tools: [
          { name: 'recall', inputSchema: { type: 'object' } },
          { name: 'remember', inputSchema: { type: 'object' } },
        ],
      }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `reconnected:${name}` }] }),
    });
    // The transport factory hands out the initial transport, then a fresh one on reconnect.
    const transports = [first.clientTransport, second.clientTransport];
    let built = 0;
    // A manual backoff clock — DISTINCT from the per-connection connect timer (left as the
    // real one, cleared fast by the InMemory handshake) — so the reconnect is deterministic.
    const timer = makeManualTimer();
    let changes = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe', remember: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );
    const unsubscribe = manager.subscribe?.(() => {
      changes += 1;
    });

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall']);

    // The server drops mid-session (child died): the SDK fires the transport onclose.
    first.clientTransport.onclose?.();
    // Wave-9 seam: it flips to failed immediately, firing a change for the UI.
    expect(manager.status()[0]?.state).toBe('failed');
    expect(changes).toBeGreaterThanOrEqual(1);
    const changesAfterDrop = changes;

    // Fire the single bounded-backoff timer → the manager reconnects on a fresh transport
    // and re-lists the now-larger tool set.
    timer.fire();
    await waitForServerState(manager, 'brain', 'connected');

    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall', 'remember']);
    // callTool now routes to the RECONNECTED server (the fresh transport).
    const out = await manager.callTool('brain', 'remember');
    expect(out.ok && out.result.content).toEqual([{ type: 'text', text: 'reconnected:remember' }]);
    // The recovery fired another change so the UI re-syncs the enlarged tool set.
    expect(changes).toBeGreaterThan(changesAfterDrop);

    unsubscribe?.();
    await manager.shutdownAll();
  });

  it('does NOT latch a server that answers tools/list then drops in the same read (reconnect latch race)', async () => {
    // A reconnect attempt connects a fresh transport and lists its tools. If that
    // transport answers tools/list AND drops within the SAME synchronous read (it
    // replied, then its child died), listTools still resolves ok — but onServerDrop has
    // ALREADY cleared `live` and scheduled the next retry. Latching `live.add` on that
    // stale success would mark a DEAD server 'connected' forever: the pending retry then
    // short-circuits on the `live.has` guard, so nothing ever corrects it. The manager
    // must leave the server failed and let the scheduled retry rebuild it cleanly.
    const initial = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const healthy = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // 1: initial connect · 2: the answer-then-drop reconnect · 3: the clean recovery.
    const transports: Transport[] = [
      initial.clientTransport,
      makeAnswerThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
      healthy.clientTransport,
    ];
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');
    expect(built).toBe(1);

    // The live server drops → schedules the first bounded-backoff retry.
    initial.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // Fire it: the attempt connects the answer-then-drop transport and lists ok, but that
    // connection has already dropped mid-attempt. Let the whole attempt settle.
    timer.fire();
    for (let i = 0; i < 10; i += 1) {
      await flushHandshake();
    }

    // The dead server is NOT latched connected — state reflects actual liveness. (A
    // callTool here would now synchronously REVIVE the server on the next transport —
    // call-time reconnect-and-retry — so status() is the liveness probe, not callTool.)
    expect(built).toBe(2);
    expect(manager.status()[0]?.state).toBe('failed');

    // ...and the retry that drop scheduled is still live: firing it recovers cleanly on
    // the healthy transport, proving liveness (not a stale success) is what flips
    // 'connected'.
    timer.fire();
    await waitForServerState(manager, 'brain', 'connected');
    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall']);

    await manager.shutdownAll();
  });

  it('does NOT latch a server that answers tools/list then drops during initial start() (start latch race)', async () => {
    // The SAME answer-then-drop race exists on the startup path: start() connects a fresh
    // transport and lists its tools. If that transport answers tools/list AND drops within the
    // SAME synchronous read, listTools resolves ok — but onServerDrop has already run (a no-op
    // on `live`, which start() hasn't populated yet) and, with reconnect enabled, scheduled the
    // first retry. Latching `live.add` on that stale success would mark a DEAD server 'connected'
    // forever, because the pending retry then short-circuits on the `live.has` guard. start()
    // must leave the server failed and let the scheduled retry rebuild it cleanly.
    const healthy = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // 1: the answer-then-drop initial connect · 2: the clean recovery.
    const transports: Transport[] = [
      makeAnswerThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
      healthy.clientTransport,
    ];
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    const result = await manager.start();
    // The server answered tools/list then dropped in the same read during start(): it must NOT
    // be latched 'connected' — nor reported as a connected server.
    expect(built).toBe(1);
    expect(manager.status()[0]?.state).toBe('failed');
    expect(result.connected).toEqual([]);
    // (callTool would now REVIVE on the next transport — call-time reconnect-and-retry —
    // so status() is the liveness probe here, not callTool.)

    // The retry that the drop scheduled during start() is live: firing it recovers cleanly on
    // the healthy transport, proving liveness (not a stale start() success) is what flips
    // 'connected'.
    timer.fire();
    await waitForServerState(manager, 'brain', 'connected');
    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall']);
    expect(built).toBe(2);

    await manager.shutdownAll();
  });

  it('bounds a pathological answer-then-drop server instead of reconnecting forever', async () => {
    // A server that ALWAYS answers tools/list and then drops in the same read hits the
    // generation-mismatch guard on every reconnect. That guard must still consume a retry-budget
    // unit, or the server would flap forever at baseDelayMs — spawning a fresh child every cycle
    // and never reaching the maxRetries terminal cap. Assert the child spawns stay BOUNDED.
    const healthy = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          if (built === 1) {
            return healthy.clientTransport;
          }
          // Every reconnect answers tools/list, then drops in the same read.
          return makeAnswerThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]);
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 3 },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    // The live server drops → schedules the first bounded-backoff retry.
    healthy.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // Fire far more times than the retry budget, flushing generously so each async attempt
    // settles. Pre-fix this loop never terminates (built grows with every fire); post-fix the
    // budget is consumed each mismatch, so it reaches the hard cap and quiesces.
    for (let i = 0; i < 30; i += 1) {
      timer.fire();
      for (let j = 0; j < 6; j += 1) {
        await flushHandshake();
      }
    }

    // Bounded: 1 initial transport + at most a few reconnect children capped by maxRetries — far
    // below the 30 fires. An unbounded flap would have built ~30 fresh transports.
    expect(built).toBeLessThanOrEqual(10);
    expect(manager.status()[0]?.state).toBe('failed');

    await manager.shutdownAll();
  });

  it('gives up after the hard retry cap and stays terminally failed (bounded)', async () => {
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    let built = 0;
    const timer = makeManualTimer();
    // A deterministic uptime clock: advancing it past the stability window before the
    // drop makes this a genuine long-lived-session drop (a fresh incident with a full
    // retry budget), rather than the anti-flapping gate charging the first drop.
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          if (built === 1) {
            return first.clientTransport;
          }
          // Every reconnect attempt fails to build a transport.
          throw new Error('no binary');
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 3, now: () => clockMs },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    clockMs += 1_000; // the session lived well past the stability window
    first.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // Three bounded retries, each failing to build a transport. flush between fires so
    // the async attempt reaches its next schedule before the next tick.
    for (let i = 0; i < 3; i += 1) {
      timer.fire();
      await flushHandshake();
    }
    // Built once at start + exactly three reconnect attempts, then TERMINAL.
    expect(built).toBe(4);
    expect(manager.status()[0]?.state).toBe('failed');

    // Past the cap: a further tick does nothing (no timer is pending), the server stays
    // terminally failed, and callTool short-circuits.
    timer.fire();
    await flushHandshake();
    expect(built).toBe(4);
    expect(await manager.callTool('brain', 'recall')).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "brain"',
    });

    await manager.shutdownAll();
  });

  it('force-releases the orphaned child when a reconnect connects but can never list (resource-leak gate)', async () => {
    // A dropped server's reconnect that CONNECTS but whose tools/list keeps failing leaves
    // a freshly spawned child LIVE (the retry design re-lists on it). When the manager
    // finally gives up at the retry cap, that child MUST be torn down, not orphaned — the
    // same exit-hang guard the connection's own close() applies, now on the give-up path.
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // The reconnect transport handshakes (connect ok → child live) but errors every
    // tools/list, and carries a `_process` spy so we can assert the teardown.
    const listFail = makeStdioLikeListFailTransport();
    let built = 0;
    const timer = makeManualTimer();
    // A deterministic uptime clock, advanced past the stability window before the drop:
    // a long-lived-session drop gets a fresh retry budget, so the scheduled reconnect
    // actually runs (the anti-flapping gate would otherwise charge this first drop and,
    // with maxRetries:1, latch terminal before the list-fail reconnect ever spawns).
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => (built++ === 0 ? first.clientTransport : listFail.transport) },
      // maxRetries:1 → the single reconnect's list-failure is immediately TERMINAL.
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 1, now: () => clockMs },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    // The server drops mid-session (after real uptime) → a reconnect is scheduled.
    clockMs += 1_000;
    first.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // Fire the backoff timer: the attempt connects (child goes live) but tools/list errors;
    // with maxRetries:1 the manager gives up at once and must release the live child.
    timer.fire();
    await waitFor(() => listFail.spy.unrefed());

    expect(built).toBe(2); // initial scripted server + one reconnect transport
    // OUR ends of the orphaned child's stdio pipes are destroyed, then it is SIGKILL-ed
    // and unref-ed — nothing left to keep the Node event loop alive.
    expect(listFail.spy.destroyed).toEqual({ stdin: true, stdout: true, stderr: true });
    expect(listFail.spy.killSignal()).toBe('SIGKILL');
    expect(listFail.spy.unrefed()).toBe(true);
    // Terminally failed, no live child; callTool short-circuits.
    expect(manager.status()[0]?.state).toBe('failed');
    expect(await manager.callTool('brain', 'recall')).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "brain"',
    });

    await manager.shutdownAll();
  });

  it('does NOT reconnect when the reconnect policy is omitted (Wave-9 drop-is-terminal)', async () => {
    // Opt-in guard: with no reconnect options a drop is terminal — the connection is
    // never rebuilt, so the pure-discovery managers keep their timer-free behaviour.
    const scripted = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    let built = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          return scripted.clientTransport;
        },
      },
      // reconnect omitted → disabled.
    );

    await manager.start();
    expect(built).toBe(1);
    scripted.clientTransport.onclose?.();
    // Give any (erroneously scheduled) synchronous reconnect ample room to rebuild.
    for (let i = 0; i < 5; i += 1) {
      await flushHandshake();
    }

    expect(manager.status()[0]?.state).toBe('failed'); // stays terminally failed
    expect(built).toBe(1); // the transport is NEVER rebuilt → no reconnect attempt
    await manager.shutdownAll();
  });

  it('bounds a clean-recover-then-drop flapper instead of reconnecting forever (stability gate)', async () => {
    // A server that recovers cleanly on every reconnect (each attempt goes fully LIVE)
    // and then drops again within the stability window is a FLAP. Because its reconnect
    // attempts all SUCCEED, failReconnect never fires on its own, so gating the budget
    // reset is not enough: onServerDrop must CHARGE a budget unit for each short-lived
    // drop, or the child re-spawns forever. Here each recovery lives only 10ms (< the
    // 100ms threshold), so the flapper must latch terminal within maxRetries.
    let built = 0;
    const current: { drop: () => void } = { drop: () => {} };
    const timer = makeManualTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          const t = makeRecoverThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]);
          current.drop = t.drop;
          return t.transport;
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 3, stableThresholdMs: 100, now: () => clockMs },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    // Flap many times: advance the clock only 10ms (< 100ms) per live window, so every
    // drop counts against the budget. Pre-fix this loops unbounded (a fresh child every
    // cycle); post-fix the budget caps it and it latches terminal-failed.
    for (let i = 0; i < 30; i += 1) {
      clockMs += 10;
      current.drop();
      timer.fire();
      for (let j = 0; j < 6; j += 1) {
        await flushHandshake();
      }
    }

    // Bounded: 1 initial + at most a few recoveries before the cap — far below 30.
    expect(built).toBeLessThanOrEqual(6);
    expect(manager.status()[0]?.state).toBe('failed');

    await manager.shutdownAll();
  });

  it('a stable recovery resets the reconnect budget (fresh incident, not an early cap)', async () => {
    // The budget accumulates across rapid flaps, but a session that lives PAST the
    // stability window before dropping is a fresh incident: onServerDrop resets the
    // budget so the server reconnects again rather than terminating early.
    let built = 0;
    const current: { drop: () => void } = { drop: () => {} };
    const timer = makeManualTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          const t = makeRecoverThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]);
          current.drop = t.drop;
          return t.transport;
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 3, stableThresholdMs: 100, now: () => clockMs },
    );

    const reconnect = async (): Promise<void> => {
      timer.fire();
      for (let j = 0; j < 6; j += 1) {
        await flushHandshake();
      }
    };

    await manager.start();

    // Two rapid flaps accumulate budget toward the cap (2 of 3).
    clockMs += 10;
    current.drop();
    await reconnect();
    clockMs += 10;
    current.drop();
    await reconnect();
    expect(manager.status()[0]?.state).toBe('connected');

    // A LONG-lived window (>= 100ms) before the next drop → stable → budget reset to 0.
    // A third CONSECUTIVE flap would have capped here; instead it reconnects.
    clockMs += 500;
    current.drop();
    await reconnect();
    expect(manager.status()[0]?.state).toBe('connected');

    // Fresh budget: it now tolerates a full maxRetries of flaps before latching failed.
    clockMs += 10;
    current.drop();
    await reconnect();
    clockMs += 10;
    current.drop();
    await reconnect();
    expect(manager.status()[0]?.state).toBe('connected');
    clockMs += 10;
    current.drop();
    await reconnect();
    expect(manager.status()[0]?.state).toBe('failed');

    await manager.shutdownAll();
  });

  it('callTool revives a server that dropped moments earlier (synchronous connect on a fresh transport)', async () => {
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `first:${name}` }] }),
    });
    const second = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `revived:${name}` }] }),
    });
    const transports = [first.clientTransport, second.clientTransport];
    let built = 0;
    const timer = makeManualTimer(); // background reconnect timer — never fired here
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    expect(built).toBe(1);

    // Drop the server WITHOUT firing the background reconnect timer.
    first.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // callTool synchronously revives on a fresh transport and returns the tool result —
    // the call survives the blip instead of failing the whole turn.
    const out = await manager.callTool('brain', 'recall');
    expect(out.ok && out.result.content).toEqual([{ type: 'text', text: 'revived:recall' }]);
    expect(built).toBe(2); // exactly one revive (the fresh transport)

    await manager.shutdownAll();
  });

  it('retries once on a mid-call transport error (revives + re-calls exactly once)', async () => {
    const healthy = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `revived:${name}` }] }),
    });
    // 1: a transport that drops mid-call (transport-class error) · 2: the healthy revive.
    const transports: Transport[] = [
      makeDropOnCallTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
      healthy.clientTransport,
    ];
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    expect(built).toBe(1);

    const out = await manager.callTool('brain', 'recall');
    expect(out.ok && out.result.content).toEqual([{ type: 'text', text: 'revived:recall' }]);
    expect(built).toBe(2); // exactly one revive

    await manager.shutdownAll();
  });

  it('does NOT revive on a per-call timeout (side-effect safety)', async () => {
    const server = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: () => new Promise(() => {}), // the call hangs → the per-call timeout trips
    });
    let built = 0;
    const clientTimer = makeManualTimer(); // drives the per-call timeout
    const reconnectTimer = makeManualTimer(); // background reconnect — unused
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          return server.clientTransport;
        },
        setTimer: clientTimer.setTimer,
      },
      { setTimer: reconnectTimer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    expect(built).toBe(1);

    const callPromise = manager.callTool('brain', 'recall');
    clientTimer.fire(); // trip the per-call timeout
    const out = await callPromise;
    // A timeout is NOT retriable (the call may have run server-side): returned as-is,
    // with NO revive — no fresh transport is built.
    expect(out).toEqual({ ok: false, error: 'mcp[brain]: tool "recall" timed out after 30000ms' });
    expect(built).toBe(1);

    await manager.shutdownAll();
  });

  it('does NOT revive on a tool-level isError (ok:true passthrough)', async () => {
    const server = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    });
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          return server.clientTransport;
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    const out = await manager.callTool('brain', 'recall');
    // The server executed the call and reported a tool-level error → ok:true, isError:
    // true. This is NOT a transport failure, so there is no revive.
    expect(out.ok && out.result.isError).toBe(true);
    expect(built).toBe(1);

    await manager.shutdownAll();
  });

  it('revives at most once — a persistent transport failure returns the (retriable) error', async () => {
    // Both transports drop mid-call, so the re-call fails too. The at-most-one-revive
    // latch must stop after a single revive and surface the error rather than looping.
    const transports: Transport[] = [
      makeDropOnCallTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
      makeDropOnCallTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
    ];
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    await manager.start();
    expect(built).toBe(1);

    const out = await manager.callTool('brain', 'recall');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.retriable).toBe(true);
      expect(out.error).toContain('mcp[brain]: tool "recall" failed');
    }
    expect(built).toBe(2); // exactly ONE revive, then the error is returned

    await manager.shutdownAll();
  });

  it('a call-time revive and a racing background reconnect do NOT both connect (no orphaned child)', async () => {
    // The concurrent-connect race: a callTool revive (bringLive) begins a connect on a
    // fresh transport; while it is in flight the server's backoff timer fires and the
    // background attemptReconnect would ALSO connect — two in-flight connects clobber the
    // connection's pending client/transport and orphan the loser's live child. bringLive
    // must CLAIM the `reconnecting` slot so the background attempt skips: exactly one
    // fresh transport is built for the revive.
    const initial = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // The revive connect is HELD so the manual backoff timer can fire mid-connect; the held
    // transport also serves tools/list + tools/call, so the revived call returns.
    const held = makeHeldHandshakeTransport({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] });
    // A third transport that must NEVER be built — a background second connect would grab it.
    const spare = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const transports: Transport[] = [initial.clientTransport, held.transport, spare.clientTransport];
    let built = 0;
    const timer = makeManualTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5, stableThresholdMs: 100, now: () => clockMs },
    );

    await manager.start();
    expect(built).toBe(1);

    // A stable, long-lived session drops → onServerDrop schedules the (attempt-0) backoff timer.
    clockMs += 1_000;
    initial.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // callTool begins the revive: it builds the held transport and suspends on connect,
    // holding the `reconnecting` slot.
    const callPromise = manager.callTool('brain', 'recall');
    await flushHandshake();
    expect(built).toBe(2); // the revive's fresh transport

    // Fire the background backoff timer WHILE the revive's connect is in flight. The
    // attempt must see `reconnecting` held and SKIP — it must not build a second transport.
    timer.fire();
    await flushHandshake();
    expect(built).toBe(2); // still 2 — no clobbering background connect

    // Release the held handshake → the revive completes and the call returns.
    held.release();
    const out = await callPromise;
    expect(out.ok && out.result.content).toEqual([{ type: 'text', text: 'revived:recall' }]);
    expect(built).toBe(2); // spare transport was never built
    expect(manager.status()[0]?.state).toBe('connected');

    await manager.shutdownAll();
  });

  it('a callTool before start() resolves does NOT double-connect (start-in-flight guard)', async () => {
    // start()'s per-server connect() does NOT claim the `reconnecting` slot, so a callTool
    // whose bringLive runs WHILE that connect is still in flight would pass the slot guard
    // and run a SECOND concurrent connection.connect() — connect() is only idempotent after a
    // client is published, so the two in-flight connects clobber the connection's pending
    // client/transport and orphan the loser's live (detached) child. Unreachable via the UI
    // (MCP tools register only after start() resolves) but reachable through the public
    // callTool API. bringLive must refuse to revive until start() has published its result:
    // exactly ONE connect happens.
    const held = makeHeldHandshakeTransport({
      tools: [{ name: 'recall', inputSchema: { type: 'object' } }],
    });
    // A spare transport a second (buggy) connect would grab — it must NEVER be built.
    const spare = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const transports: Transport[] = [held.transport, spare.clientTransport];
    let built = 0;
    const timer = makeManualTimer();
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5 },
    );

    // start() begins connecting; its per-server connect suspends on the held handshake, so
    // it is IN FLIGHT with startResult still unset.
    const startPromise = manager.start();
    await flushHandshake();
    expect(built).toBe(1); // start()'s connect built the held transport

    // A callTool lands BEFORE start() resolves. bringLive must NOT spawn a second connect on
    // the in-flight connection: it surfaces the unavailable error and builds no transport.
    const preStart = await manager.callTool('brain', 'recall');
    expect(preStart).toEqual({ ok: false, error: 'mcp: unknown or unavailable server "brain"' });
    expect(built).toBe(1); // no second (clobbering) connect — the spare was never built

    // Release the held handshake → start() completes cleanly on the SINGLE connection.
    held.release();
    const result = await startPromise;
    expect(result.connected).toEqual(['brain']);
    expect(manager.status()[0]?.state).toBe('connected');
    expect(built).toBe(1); // still exactly one transport

    // And a callTool now dispatches on the live server (no lingering clobbered client).
    const out = await manager.callTool('brain', 'recall');
    expect(out.ok && out.result.content).toEqual([{ type: 'text', text: 'revived:recall' }]);
    expect(built).toBe(1);

    await manager.shutdownAll();
  });

  it('reschedules the background reconnect when a revive fails after consuming its timer', async () => {
    // The consumed-timer case: a callTool revive holds `reconnecting` while the backoff
    // timer fires, so the background attempt skips WITHOUT rescheduling. If the revive then
    // FAILS (connect ok, tools/list errors), the outage's recovery sequence would be
    // stranded — bringLive must re-arm the backoff so a later attempt still recovers the
    // server by re-listing on the connect-ok/list-fail connection it left live.
    const initial = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    // The revive connects (handshake completes on release) but its FIRST tools/list ERRORS;
    // a later re-list on the same live connection succeeds.
    const held = makeHeldHandshakeTransport({
      tools: [{ name: 'recall', inputSchema: { type: 'object' } }],
      failFirstList: true,
    });
    const transports: Transport[] = [initial.clientTransport, held.transport];
    let built = 0;
    const timer = makeRecordingTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5, stableThresholdMs: 100, now: () => clockMs },
    );

    await manager.start();
    expect(built).toBe(1);

    // A stable drop schedules the first (attempt-0) backoff.
    clockMs += 1_000;
    initial.clientTransport.onclose?.();
    expect(timer.delays).toEqual([1]);

    // callTool begins the revive (builds held transport #2), holding `reconnecting`.
    const callPromise = manager.callTool('brain', 'recall');
    await flushHandshake();
    expect(built).toBe(2);

    // Fire the pending backoff timer: the background attempt skips (slot held) — CONSUMING
    // the timer without rescheduling.
    timer.fire();
    await flushHandshake();

    // Release: connect resolves, the first tools/list errors → the revive fails. It must
    // re-arm the backoff (a second scheduled delay) so recovery is not stranded, and the
    // call returns the unavailable error.
    held.release();
    const out = await callPromise;
    expect(out).toEqual({ ok: false, error: 'mcp: unknown or unavailable server "brain"' });
    expect(timer.delays).toEqual([1, 1]); // the consumed timer was re-armed
    expect(manager.status()[0]?.state).toBe('failed');

    // Fire the re-armed backoff: the attempt now runs (slot free), re-lists on the still-live
    // connection (connect() is idempotent), and recovers — proving the sequence RESUMED
    // rather than stalling. No fresh transport is built (the connection was kept live).
    timer.fire();
    await waitForServerState(manager, 'brain', 'connected');
    expect(built).toBe(2);
    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall']);

    await manager.shutdownAll();
  });

  it('does NOT dead-latch on a revive whose server answers-then-drops (background timer still recovers)', async () => {
    // The Wave-11 dead-latch, reintroduced on the CALL-TIME path. bringLive revives a dropped
    // server whose fresh transport answers tools/list then drops in the SAME read: onServerDrop
    // fires first (clears `live`, its scheduleReconnect no-ops on the already-armed timer), so
    // WITHOUT the generation guard bringLive would publishLive on the now-DEAD connection —
    // status() would read 'connected' while the pending retry short-circuits on `live.has` and
    // every later callTool takes bringLive's `live.has` fast path and re-calls the nulled client
    // → permanent 'not connected'. The guard must refuse to latch it, leaving the still-armed
    // background timer free to recover cleanly on the next healthy transport.
    const initial = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const recovered = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      callTool: async (name) => ({ content: [{ type: 'text', text: `recovered:${name}` }] }),
    });
    // 1: the initial live connection · 2: the answer-then-drop revive · 3: the clean recovery.
    const transports: Transport[] = [
      initial.clientTransport,
      makeAnswerThenDropTransport([{ name: 'recall', inputSchema: { type: 'object' } }]),
      recovered.clientTransport,
    ];
    let built = 0;
    const timer = makeManualTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5, stableThresholdMs: 100, now: () => clockMs },
    );

    await manager.start();
    expect(built).toBe(1);

    // A stable, long-lived session drops → onServerDrop schedules the (attempt-0) backoff timer
    // WITHOUT firing it.
    clockMs += 1_000;
    initial.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');

    // callTool revives on the answer-then-drop transport. It answers tools/list then drops in the
    // same read; the generation guard must refuse to latch it live, so the call surfaces the
    // unavailable error rather than a phantom-connected dead-latch.
    const out = await manager.callTool('brain', 'recall');
    expect(out).toEqual({ ok: false, error: 'mcp: unknown or unavailable server "brain"' });
    expect(built).toBe(2); // exactly the one revive transport
    expect(manager.status()[0]?.state).toBe('failed'); // NOT 'connected'

    // The background retry the initial drop armed is still live: firing it recovers cleanly on the
    // healthy transport, proving the revive left the reconnect machinery intact (not dead-latched).
    timer.fire();
    await waitForServerState(manager, 'brain', 'connected');
    expect(built).toBe(3);
    expect(manager.status()[0]?.state).toBe('connected');
    expect(manager.listTools().map((d) => d.tool.name)).toEqual(['recall']);

    // And a callTool now dispatches on the recovered connection (no lingering dead-latch).
    const ok = await manager.callTool('brain', 'recall');
    expect(ok.ok && ok.result.content).toEqual([{ type: 'text', text: 'recovered:recall' }]);

    await manager.shutdownAll();
  });

  it('shutdownAll racing an in-flight call-time revive leaves the server failed (no phantom-connected)', async () => {
    // A shutdownAll that lands while bringLive's revive connect() is in flight must win. bringLive
    // re-checks `stopped` after each await (mirroring attemptReconnect), so an in-flight revive can
    // never re-add live/discovered/connectedAt or notify listeners after teardown cleared them —
    // status() must not report 'connected' post-shutdown, and the call surfaces the unavailable
    // error rather than resurrecting a torn-down connection.
    const initial = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    const held = makeHeldHandshakeTransport({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] });
    const transports: Transport[] = [initial.clientTransport, held.transport];
    let built = 0;
    const timer = makeManualTimer();
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => transports[built++] as Transport },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 5, stableThresholdMs: 100, now: () => clockMs },
    );

    await manager.start();
    clockMs += 1_000;
    initial.clientTransport.onclose?.(); // stable drop → arms the backoff timer
    expect(manager.status()[0]?.state).toBe('failed');

    // Begin the revive: bringLive builds the held transport and suspends on the held handshake,
    // holding the `reconnecting` slot.
    const callPromise = manager.callTool('brain', 'recall');
    await flushHandshake();
    expect(built).toBe(2);

    // Tear the manager down WHILE the revive's connect is in flight: shutdownAll latches `stopped`
    // and closes the connection (unwinding the held handshake), so the revive resolves to the
    // unavailable error and never publishes a live server.
    await manager.shutdownAll();
    held.release(); // a late handshake answer after teardown must change nothing
    const out = await callPromise;
    expect(out).toEqual({ ok: false, error: 'mcp: unknown or unavailable server "brain"' });

    // The invariant: no server reports 'connected' after shutdown, and discovery is empty.
    expect(manager.status().every((row) => row.state === 'failed')).toBe(true);
    expect(manager.listTools()).toEqual([]);
  });
});

// A manual timer that ALSO records every scheduled delay (in call order). The
// manager keeps at most one pending backoff timer per server, so `fire()` runs the
// single live callback; `delays` accumulates the ms each schedule requested so a
// test can pin the exact backoff cadence. Distinct from makeManualTimer, which
// drops the ms.
function makeRecordingTimer(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  fire: () => void;
  delays: number[];
} {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  return {
    setTimer: (fn, ms) => {
      pending = fn;
      delays.push(ms);
      return {
        clear: () => {
          pending = undefined;
        },
      };
    },
    fire: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    delays,
  };
}

// Production PINS the reconnect policy through the empty opt-in object at
// cli.ts initMcpWiring (`createMcpManager(servers, fallbackCwd, {}, {})`): passing
// `{}` enables reconnect and every field falls through to createMcpManager's
// `?? 1_000` / `?? 30_000` / `?? 5` defaults. The reconnect SEAM tests above always
// pass explicit baseDelayMs/maxRetries, so those production defaults were unpinned —
// a regression to `?? 5_000` or a shrunk retry cap would ship silently. These tests
// drive an all-defaults reconnect (only the deterministic clock is injected, which
// does NOT alter the delay values) and assert the exact production cadence.
describe('createMcpManager reconnect defaults (production opt-in pinned)', () => {
  it('the empty opt-in uses the 1s base, doubling backoff, and 5-retry cap defaults', async () => {
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    let built = 0;
    const timer = makeRecordingTimer();
    // A deterministic uptime clock (does NOT alter the delay defaults); advanced past
    // the default 2s stability window before the drop so this is a fresh-incident drop
    // scheduling from attempt 0, not a flap the anti-flapping gate would charge.
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          if (built === 1) {
            return first.clientTransport;
          }
          // Every reconnect attempt fails to build a transport → the backoff advances.
          throw new Error('no binary');
        },
      },
      // ALL delay/retry fields defaulted — exactly what the production `{}` resolves to.
      { setTimer: timer.setTimer, now: () => clockMs },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    clockMs += 3_000; // lived past the 2s default stability window
    first.clientTransport.onclose?.();
    expect(manager.status()[0]?.state).toBe('failed');
    // The drop synchronously schedules the FIRST retry at the 1s base default.
    expect(timer.delays).toEqual([1_000]);

    // Drive the full retry budget: each fire → a failed rebuild → the next schedule.
    for (let i = 0; i < 5; i += 1) {
      timer.fire();
      await flushHandshake();
    }

    // Backoff doubles off the 1s base and stops after exactly 5 attempts (maxRetries
    // default): 1s, 2s, 4s, 8s, 16s — no sixth schedule.
    expect(timer.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    // Built once at start + exactly five reconnect attempts, then TERMINAL.
    expect(built).toBe(6);
    expect(manager.status()[0]?.state).toBe('failed');

    // Past the cap nothing is pending: a further tick schedules no new timer.
    timer.fire();
    await flushHandshake();
    expect(timer.delays).toHaveLength(5);
    expect(built).toBe(6);

    await manager.shutdownAll();
  });

  it('caps the backoff delay at the 30s maxDelayMs default', async () => {
    const first = await startScriptedServer({
      listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
    });
    let built = 0;
    const timer = makeRecordingTimer();
    // Raise ONLY maxRetries so the backoff runs past 16s into the cap; baseDelayMs and
    // maxDelayMs stay defaulted, so the tail pins the 30s ceiling. The uptime clock is
    // advanced past the default stability window so the first drop is a fresh incident.
    let clockMs = 0;
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      {
        transportFactory: () => {
          built += 1;
          if (built === 1) {
            return first.clientTransport;
          }
          throw new Error('no binary');
        },
      },
      { setTimer: timer.setTimer, maxRetries: 7, now: () => clockMs },
    );

    await manager.start();
    clockMs += 3_000; // lived past the 2s default stability window
    first.clientTransport.onclose?.();
    for (let i = 0; i < 7; i += 1) {
      timer.fire();
      await flushHandshake();
    }

    // 1s→2s→4s→8s→16s doubling, then min(maxDelayMs, base·2^n) SATURATES at the 30s
    // default (32s and 64s both clamp to 30s) rather than growing unbounded.
    expect(timer.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(manager.status()[0]?.state).toBe('failed');

    await manager.shutdownAll();
  });

  it('pins the stability-gate default to 2× the base delay (2000ms)', async () => {
    // The anti-flapping window defaults to `2 * baseDelayMs` = 2000ms. Pin the exact
    // boundary: a drop at 1999ms uptime is a FLAP (the budget is charged, so the FIRST
    // scheduled retry is already the attempt-1 delay of 2000ms), while a drop at exactly
    // 2000ms is a fresh incident (attempt-0 delay of 1000ms). Only the clock is injected;
    // every delay/threshold field is defaulted, exactly as production's `{}` resolves.
    const firstDelayAfterUptime = async (uptimeMs: number): Promise<number | undefined> => {
      const scripted = await startScriptedServer({
        listTools: async () => ({ tools: [{ name: 'recall', inputSchema: { type: 'object' } }] }),
      });
      let built = 0;
      const timer = makeRecordingTimer();
      let clockMs = 0;
      const manager = createMcpManager(
        { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
        CWD,
        {
          transportFactory: () => {
            built += 1;
            if (built === 1) {
              return scripted.clientTransport;
            }
            throw new Error('no binary');
          },
        },
        { setTimer: timer.setTimer, now: () => clockMs },
      );
      await manager.start();
      clockMs = uptimeMs;
      scripted.clientTransport.onclose?.();
      const firstDelay = timer.delays[0];
      await manager.shutdownAll();
      return firstDelay;
    };

    // 1999ms < 2000ms → flap → the drop charges the budget → first retry is attempt-1.
    expect(await firstDelayAfterUptime(1_999)).toBe(2_000);
    // 2000ms → stable → fresh incident → first retry is attempt-0.
    expect(await firstDelayAfterUptime(2_000)).toBe(1_000);
  });
});
