import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createCodexSpawnBridge } from '../src/providers/codexSpawnBridge';
import { createSubagentMcpServer } from '../src/services/subagentMcpServer';
import { createProcessManager } from '../src/tools/processTools';
import { createVerificationTool } from '../src/tools/verificationTool';

const roots: string[] = [];
const managers: Array<ReturnType<typeof createProcessManager>> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const unusedSpawn: Tool = {
  name: 'spawn_subagent',
  risk: 'risky',
  spec: { name: 'spawn_subagent', description: 'unused', inputSchema: {} },
  async run() { return { ok: false, error: 'unused' }; },
};

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'juno-codex-tools-'));
  roots.push(root);
  return root;
}

function resultText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('expected MCP content');
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('expected an MCP text result');
  }
  return first.text;
}

async function connect(opts: {
  cwd: string;
  tools: Tool[];
  allow?: ReadonlySet<string>;
  deny?: string[];
}): Promise<{
  client: Client;
  events: AgentEvent[];
  close: () => Promise<void>;
}> {
  const events: AgentEvent[] = [];
  let nextId = 0;
  const bridge = createCodexSpawnBridge({
    spawnTool: unusedSpawn,
    tools: opts.tools,
    policy: createPermissionPolicy({ deny: opts.deny }),
    preauthorizedTools: opts.allow,
    nextBridgeToolCallId: () => `codex-juno-${++nextId}`,
  });
  const turnController = new AbortController();
  const dispose = bridge.beginTurn({
    turnId: 'codex-turn-1',
    cwd: opts.cwd,
    signal: turnController.signal,
    emit: (event) => events.push(event),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createSubagentMcpServer(async () => ({ text: 'unused', isError: true }), {
    specs: opts.tools.map((tool) => tool.spec),
    call: (name, args, signal) => bridge.callTool!(name, args, signal),
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'codex-fake', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    events,
    close: async () => {
      dispose();
      turnController.abort();
      await client.close();
      await server.close();
    },
  };
}

async function pollUntilTerminal(client: Client, processId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await client.callTool({ name: 'poll_process', arguments: { process_id: processId } });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(resultText(result)) as Record<string, unknown>;
    if (data.status !== 'running') return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('managed process did not settle');
}

describe('Codex MCP parity bridge — real Juno managed tools', () => {
  it('runs process sessions and structured verification through real Juno events and the exact cwd', async () => {
    const root = await workspace();
    const canonicalRoot = await realpath(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.stdout.write(\'verified\')"' },
    }));
    const manager = createProcessManager({ id: () => 'managed-1', killGraceMs: 10 });
    managers.push(manager);
    const tools = [...manager.tools, createVerificationTool({ timeoutMs: 10_000 })];
    const { client, events, close } = await connect({
      cwd: root,
      tools,
      allow: new Set(tools.map((tool) => tool.name)),
    });

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'spawn_subagent',
        'start_process',
        'poll_process',
        'write_process_stdin',
        'terminate_process',
        'run_verification',
      ]);

      const started = await client.callTool({
        name: 'start_process',
        arguments: { command: 'read line; printf "got:%s" "$line"' },
      });
      expect(started.isError).toBeFalsy();
      expect(JSON.parse(resultText(started))).toMatchObject({
        processId: 'managed-1',
        status: 'running',
        cwd: canonicalRoot,
      });

      const wrote = await client.callTool({
        name: 'write_process_stdin',
        arguments: { process_id: 'managed-1', text: 'hello\n' },
      });
      expect(JSON.parse(resultText(wrote))).toMatchObject({ processId: 'managed-1', bytesWritten: 6 });
      const terminal = await pollUntilTerminal(client, 'managed-1');
      expect(terminal).toMatchObject({ status: 'exited', exitCode: 0 });
      expect(terminal.chunks).toEqual([{ stream: 'stdout', text: 'got:hello' }]);

      const longRunning = await client.callTool({
        name: 'start_process',
        arguments: { command: 'sleep 10' },
      });
      expect(longRunning.isError).toBeFalsy();
      const terminated = await client.callTool({
        name: 'terminate_process',
        arguments: { process_id: 'managed-1' },
      });
      expect(JSON.parse(resultText(terminated))).toMatchObject({
        processId: 'managed-1',
        status: 'terminated',
        signal: 'SIGTERM',
      });
      expect(await pollUntilTerminal(client, 'managed-1')).toMatchObject({
        status: 'terminated',
        reason: 'terminated by request',
      });

      const verification = await client.callTool({
        name: 'run_verification',
        arguments: { checks: ['test'] },
      });
      expect(verification.isError).toBeFalsy();
      expect(JSON.parse(resultText(verification))).toMatchObject({ status: 'passed', passed: 1, failed: 0 });

      for (const name of ['start_process', 'write_process_stdin', 'poll_process', 'terminate_process', 'run_verification']) {
        const call = events.find((event) => event.type === 'tool-call' && event.name === name);
        expect(call).toBeDefined();
        const id = call !== undefined && call.type === 'tool-call' ? call.toolCallId : '';
        expect(events).toContainEqual({ type: 'tool-status', toolCallId: id, status: 'running' });
        expect(events.some((event) => event.type === 'tool-status' && event.toolCallId === id && event.status === 'result')).toBe(true);
      }
    } finally {
      await close();
    }
  });

  it('fails closed without exact preauthorization and never lets a preauthorization override deny', async () => {
    const root = await workspace();
    let allocated = 0;
    const manager = createProcessManager({ id: () => `unexpected-${++allocated}` });
    managers.push(manager);
    const start = manager.tools.find((tool) => tool.name === 'start_process')!;

    const unapproved = await connect({ cwd: root, tools: [start] });
    try {
      const result = await unapproved.client.callTool({
        name: 'start_process',
        arguments: { command: 'touch should-not-exist' },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('JUNO_CODEX_BRIDGE_ALLOW=start_process');
      expect(unapproved.events.map((event) => event.type)).toEqual(['tool-call', 'tool-status']);
      expect(unapproved.events.at(-1)).toMatchObject({ type: 'tool-status', status: 'error' });
      expect(allocated).toBe(0);
    } finally {
      await unapproved.close();
    }

    const denied = await connect({
      cwd: root,
      tools: [start],
      allow: new Set(['start_process']),
      deny: ['start_process'],
    });
    try {
      const result = await denied.client.callTool({
        name: 'start_process',
        arguments: { command: 'touch still-should-not-exist' },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('denied by policy');
      expect(allocated).toBe(0);
    } finally {
      await denied.close();
    }
  });
});
