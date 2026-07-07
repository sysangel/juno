// tests/fixtures/fakeBrainMcpServer.mjs
// A SPAWNABLE, brain-shaped fake MCP stdio server used by the integration tests.
// Unlike the in-memory scripted servers (tests/mcpClient.test.ts), this is a real
// child process spoken to over the DEFAULT StdioClientTransport — so it exercises
// the actual spawn + stdio handshake path, not an in-process InMemoryTransport.
//
// It mirrors the real personal-brain server's tool surface EXACTLY: the three
// tools `recall`, `get_episode`, `remember` (see ~/src/brain server.py). Each call
// echoes a deterministic marker so a test can assert dispatch reached this server.
// Pure fixture: no I/O beyond stdio, no dependence on the real brain being present.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'recall',
    description: 'Hybrid FTS + vector search over the brain (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'number' },
        scope: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_episode',
    description: 'Fetch the full text for an ep_/mem_/sum_ hit (read-only).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'remember',
    description: 'Write a durable memory (commits + pushes to a private remote).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const server = new Server(
  { name: 'fake-brain', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  return { content: [{ type: 'text', text: `fake-brain:${name}:${JSON.stringify(args)}` }] };
});

await server.connect(new StdioServerTransport());
