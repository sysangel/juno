// tests/subagentMcpServer.test.ts — Wave 8 (codex-bridge): the juno-HOSTED
// spawn_subagent MCP server. Every test is HERMETIC — a real SDK `Client` (the
// codex side) is driven over an InMemoryTransport linked pair against the real
// server, with a FAKE spawn handler. No codex, no subprocess, no port. This proves
// the wire contract (tools/list advertises the identical spawn schema; tools/call
// reaches the handler with the args and round-trips its text + isError flag).
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createSubagentMcpServer,
  SPAWN_SUBAGENT_TOOL,
  type SpawnBridgeHandler,
  type SpawnBridgeResult,
} from '../src/services/subagentMcpServer';
import { spawnSubagentSpec } from '../src/tools/subagentTool';

/** Stand up the real server on one half of a linked pair + a connected SDK Client
 * on the other, with a scripted spawn handler. */
async function connect(handler: SpawnBridgeHandler): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createSubagentMcpServer(handler);
  await server.connect(serverTransport);
  const client = new Client({ name: 'codex-fake', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('subagentMcpServer — tools/list', () => {
  it('advertises spawn_subagent with the SAME schema the raw-API tool uses', async () => {
    const { client, close } = await connect(async () => ({ text: '', isError: false }));
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(1);
      const tool = listed.tools[0]!;
      expect(tool.name).toBe(SPAWN_SUBAGENT_TOOL);
      expect(tool.name).toBe(spawnSubagentSpec.name);
      // The advertised input schema is the tool's own schema, verbatim.
      expect(tool.inputSchema).toEqual(spawnSubagentSpec.inputSchema);
      expect(tool.description).toBe(spawnSubagentSpec.description);
    } finally {
      await close();
    }
  });
});

describe('subagentMcpServer — tools/call', () => {
  it('routes the call to the handler with its args and returns the summary text', async () => {
    let seen: Record<string, unknown> | undefined;
    const handler: SpawnBridgeHandler = async (args) => {
      seen = args;
      return { text: 'the subagent summary', isError: false };
    };
    const { client, close } = await connect(handler);
    try {
      const result = await client.callTool({
        name: SPAWN_SUBAGENT_TOOL,
        arguments: { task: 'summarize the repo', model: 'gpt-5.6-sol' },
      });
      expect(seen).toEqual({ task: 'summarize the repo', model: 'gpt-5.6-sol' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: 'the subagent summary' }]);
    } finally {
      await close();
    }
  });

  it('maps an isError result to an MCP tool-level error', async () => {
    const { client, close } = await connect(async () => ({
      text: 'sub-agent error: boom',
      isError: true,
    }));
    try {
      const result = await client.callTool({
        name: SPAWN_SUBAGENT_TOOL,
        arguments: { task: 'x' },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'sub-agent error: boom' }]);
    } finally {
      await close();
    }
  });

  it('a handler that THROWS is folded into a tool-level error (never crashes the session)', async () => {
    const { client, close } = await connect(async () => {
      throw new Error('kaboom');
    });
    try {
      const result = await client.callTool({
        name: SPAWN_SUBAGENT_TOOL,
        arguments: { task: 'x' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain('kaboom');
      // Session survives — a second call still works.
      const again = await client.callTool({ name: SPAWN_SUBAGENT_TOOL, arguments: { task: 'y' } });
      expect(again.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('an unknown tool name is a tool-level error, not a crash', async () => {
    const handler: SpawnBridgeHandler = async () => ({ text: 'ok', isError: false });
    const { client, close } = await connect(handler);
    try {
      const result = await client.callTool({ name: 'not_a_tool', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
