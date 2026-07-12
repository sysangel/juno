// tests/codexBridgeHost.test.ts — Wave 8 (codex-bridge): the host that wires the
// spawn_subagent MCP server to a transport + emits the codex config, and the
// codexToolArgs flag surface that points codex at it. Hermetic: the transport is an
// InMemory linked pair (no port), the handler is a fake.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createCodexBridgeHost,
  inMemoryListener,
  DEFAULT_CODEX_MCP_SERVER_NAME,
} from '../src/services/codexBridgeHost';
import { SPAWN_SUBAGENT_TOOL, type SpawnBridgeHandler } from '../src/services/subagentMcpServer';
import { codexToolArgs, type CodexMcpConfig } from '../src/providers/codexCliClient';

describe('createCodexBridgeHost — wiring', () => {
  it('binds the server to the injected transport, exposes the config, and a client can call it', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let seen: Record<string, unknown> | undefined;
    const handler: SpawnBridgeHandler = async (args) => {
      seen = args;
      return { text: 'summary', isError: false };
    };
    const mcpConfig: CodexMcpConfig = { serverName: 'juno', command: ['juno-mcp'] };

    const host = await createCodexBridgeHost({
      handler,
      listen: inMemoryListener(serverTransport, mcpConfig),
    });
    expect(host.mcpConfig).toEqual(mcpConfig);

    const client = new Client({ name: 'codex', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: SPAWN_SUBAGENT_TOOL,
      arguments: { task: 'do it' },
    });
    expect(seen).toEqual({ task: 'do it' });
    expect(result.content).toEqual([{ type: 'text', text: 'summary' }]);

    await client.close();
    await host.shutdown();
  });

  it('defaults the server name to "juno"', async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const host = await createCodexBridgeHost({
      handler: async () => ({ text: '', isError: false }),
      listen: inMemoryListener(serverTransport, { serverName: DEFAULT_CODEX_MCP_SERVER_NAME }),
    });
    expect(host.mcpConfig.serverName).toBe('juno');
    await host.shutdown();
  });
});

describe('codexToolArgs — MCP config flag surface', () => {
  const spec = [{ name: 'spawn_subagent', description: 'x', inputSchema: {} }];

  it('returns [] when no mcpConfig is supplied (backend keeps built-in toolset)', () => {
    expect(codexToolArgs(spec)).toEqual([]);
  });

  it('emits a JSON-quoted url override for a streamable-HTTP endpoint', () => {
    expect(codexToolArgs(spec, { serverName: 'juno', url: 'http://127.0.0.1:5123/mcp' })).toEqual([
      '-c',
      'mcp_servers.juno.url="http://127.0.0.1:5123/mcp"',
    ]);
  });

  it('emits command (+ args) overrides for a stdio launcher', () => {
    expect(
      codexToolArgs(spec, { serverName: 'juno', command: ['node', 'shim.js', '--x'] }),
    ).toEqual([
      '-c',
      'mcp_servers.juno.command="node"',
      '-c',
      'mcp_servers.juno.args=["shim.js","--x"]',
    ]);
  });

  it('a single-element command emits no args flag', () => {
    expect(codexToolArgs(spec, { serverName: 'juno', command: ['juno-mcp'] })).toEqual([
      '-c',
      'mcp_servers.juno.command="juno-mcp"',
    ]);
  });

  it('a config with neither url nor command yields no flags', () => {
    expect(codexToolArgs(spec, { serverName: 'juno' })).toEqual([]);
  });
});
