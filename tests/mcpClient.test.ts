import { describe, expect, it } from 'vitest';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createMcpClientConnection } from '../src/services/mcpClient';
import { createMcpManager } from '../src/services/mcpManager';
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
});
