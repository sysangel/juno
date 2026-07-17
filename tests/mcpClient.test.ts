import { describe, expect, it } from 'vitest';

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
    expect(await conn.callTool('x')).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
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
    expect(await conn.callTool('x')).toEqual({ ok: false, error: 'mcp[srv]: not connected' });
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

  it('gives up after the hard retry cap and stays terminally failed (bounded)', async () => {
    const first = await startScriptedServer({
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
            return first.clientTransport;
          }
          // Every reconnect attempt fails to build a transport.
          throw new Error('no binary');
        },
      },
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 3 },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

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
    const manager = createMcpManager(
      { brain: { command: ['brain'], toolRisk: { recall: 'safe' } } },
      CWD,
      { transportFactory: () => (built++ === 0 ? first.clientTransport : listFail.transport) },
      // maxRetries:1 → the single reconnect's list-failure is immediately TERMINAL.
      { setTimer: timer.setTimer, baseDelayMs: 1, maxRetries: 1 },
    );

    await manager.start();
    expect(manager.status()[0]?.state).toBe('connected');

    // The server drops mid-session → a reconnect is scheduled.
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
});
