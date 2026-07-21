import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolSpec } from '../src/core/contracts';
import {
  createCodexBridgeHost,
  httpListener,
  type CodexBridgeHost,
} from '../src/services/codexBridgeHost';
import {
  createSubagentMcpServer,
  type SubagentMcpServer,
} from '../src/services/subagentMcpServer';

const EXPECTED_TOOLS = [
  'spawn_subagent',
  'start_process',
  'poll_process',
  'write_process_stdin',
  'terminate_process',
  'run_verification',
] as const;

const specs: ToolSpec[] = EXPECTED_TOOLS.slice(1).map((name) => ({
  name,
  description: `Juno ${name}`,
  inputSchema: { type: 'object', additionalProperties: true },
}));

const hosts: CodexBridgeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
});

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-http-test', version: '1.0.0' },
  },
} as const;

function postRpc(
  url: string,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (sessionId !== undefined) {
    headers['mcp-session-id'] = sessionId;
    headers['mcp-protocol-version'] = '2025-06-18';
  }
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

function makeClient(name: string, url: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  return { client, transport };
}

async function startHost(): Promise<CodexBridgeHost> {
  const host = await createCodexBridgeHost({
    handler: async () => ({ text: 'spawned', isError: false }),
    tools: {
      specs,
      call: async (name, args) => ({
        text: `${name}:${String(args.process_id)}`,
        isError: false,
      }),
    },
  });
  hosts.push(host);
  return host;
}

/**
 * Production transport regression: unlike the in-memory bridge tests, this uses
 * the same loopback Streamable HTTP client/server pair a real Codex child uses.
 * Two clients pin the per-turn lifecycle: Codex launches a fresh process (and MCP
 * initialization) on a later turn, so a host that only supports its first client
 * is still broken.
 */
describe('Codex bridge — production Streamable HTTP transport', () => {
  it('initializes, lists, and calls through two sequential fresh clients', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host = await createCodexBridgeHost({
      handler: async () => ({ text: 'spawned', isError: false }),
      tools: {
        specs,
        call: async (name, args) => {
          calls.push({ name, args });
          return { text: `${name}:${String(args.process_id)}`, isError: false };
        },
      },
    });
    hosts.push(host);
    expect(host.mcpConfig.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]+$/u);

    for (let turn = 1; turn <= 2; turn += 1) {
      const client = new Client(
        { name: `codex-http-${turn}`, version: '1.0.0' },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(host.mcpConfig.url!));
      await client.connect(transport);
      try {
        const instructions = client.getInstructions() ?? '';
        expect(instructions).toContain('native tool_search');
        expect(instructions).toContain('Do not inspect ALL_TOOLS');
        for (const name of EXPECTED_TOOLS) expect(instructions).toContain(name);

        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);

        const called = await client.callTool({
          name: 'poll_process',
          arguments: { process_id: `process-${turn}` },
        });
        expect(called.isError).toBeFalsy();
        expect(called.content).toEqual([
          { type: 'text', text: `poll_process:process-${turn}` },
        ]);
      } finally {
        await client.close();
      }
    }

    expect(calls).toEqual([
      { name: 'poll_process', args: { process_id: 'process-1' } },
      { name: 'poll_process', args: { process_id: 'process-2' } },
    ]);
  });

  it('does not evict the active client for a malformed headerless POST', async () => {
    const host = await startHost();
    const { client, transport } = makeClient('active-a', host.mcpConfig.url!);
    await client.connect(transport);

    try {
      const malformed = await postRpc(host.mcpConfig.url!, {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
      });
      expect(malformed.status).toBe(400);
      await malformed.text();

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    } finally {
      await client.close();
    }
  });

  it('promotes a valid replacement atomically and rejects the stale session', async () => {
    const host = await startHost();
    const a = makeClient('replacement-a', host.mcpConfig.url!);
    const b = makeClient('replacement-b', host.mcpConfig.url!);
    await a.client.connect(a.transport);
    const staleSessionId = a.transport.sessionId;
    expect(staleSessionId).toBeTruthy();

    await b.client.connect(b.transport);
    try {
      expect(b.transport.sessionId).toBeTruthy();
      expect(b.transport.sessionId).not.toBe(staleSessionId);

      const stale = await postRpc(
        host.mcpConfig.url!,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        staleSessionId,
      );
      expect(stale.status).toBe(404);
      await stale.text();

      const listed = await b.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    } finally {
      await Promise.all([a.client.close(), b.client.close()]);
    }
  });

  it('cleans up a terminated session before accepting a fresh client', async () => {
    const host = await startHost();
    const b = makeClient('terminated-b', host.mcpConfig.url!);
    await b.client.connect(b.transport);
    const terminatedSessionId = b.transport.sessionId;
    expect(terminatedSessionId).toBeTruthy();

    await b.transport.terminateSession();
    expect(b.transport.sessionId).toBeUndefined();

    const stale = await postRpc(
      host.mcpConfig.url!,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      terminatedSessionId,
    );
    expect(stale.status).toBe(404);
    await stale.text();

    const c = makeClient('fresh-c', host.mcpConfig.url!);
    await c.client.connect(c.transport);
    try {
      const listed = await c.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    } finally {
      await Promise.all([b.client.close(), c.client.close()]);
    }
  });

  it('closes a pending candidate once and rejects promotion during shutdown', async () => {
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let signalConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      signalConnectStarted = resolve;
    });
    let closeCalls = 0;

    const bound = await httpListener((): SubagentMcpServer => {
      const inner = createSubagentMcpServer(async () => ({
        text: 'spawned',
        isError: false,
      }));
      return {
        async connect(transport: Transport): Promise<void> {
          signalConnectStarted();
          await connectGate;
          await inner.connect(transport);
        },
        async close(): Promise<void> {
          closeCalls += 1;
          await inner.close();
        },
      };
    }, 'juno');

    const initialization = postRpc(bound.mcpConfig.url!, INITIALIZE_BODY);
    await connectStarted;
    const firstClose = bound.close();
    const secondClose = bound.close();
    expect(secondClose).toBe(firstClose);
    releaseConnect();

    const response = await initialization;
    expect(response.status).toBe(503);
    await response.text();
    await Promise.all([firstClose, secondClose]);
    expect(closeCalls).toBe(1);
  });
});
