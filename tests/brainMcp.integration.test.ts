// tests/brainMcp.integration.test.ts
// Brain integration Phase 3 — the personal-brain MCP server wired into juno.
//
// Unlike mcpClient.test.ts (in-process InMemoryTransport), these tests spawn a
// REAL child process: a brain-shaped fake stdio server (tests/fixtures/
// fakeBrainMcpServer.mjs) reached over the DEFAULT StdioClientTransport. So the
// actual spawn + `initialize` + `tools/list` + `tools/call` path is exercised.
//
// They assert (a) discovery + namespacing of the three brain-shaped tools and
// (b) the standing risk-classification decision: the READ tools (recall,
// get_episode) are 'safe' and auto-allowed by the permission layer, while
// `remember` (a durable write) stays 'risky' and prompt-gated. One opt-in test
// at the bottom runs the SAME assertions against the real brain server, guarded
// behind JUNO_BRAIN_E2E=1 and skipped by default so CI stays hermetic.
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolCtx } from '../src/core/contracts';
import { createPermissionPolicy } from '../src/permissions/policy';
import type { McpServerConfig } from '../src/services/config';
import { createMcpManager, type McpManager } from '../src/services/mcpManager';
import { createMcpTools } from '../src/tools/mcpTools';

/** Absolute path to the spawnable fake brain server (resolved from this file). */
const FIXTURE = fileURLToPath(new URL('./fixtures/fakeBrainMcpServer.mjs', import.meta.url));

/** Mirrors the wiring's real brain entry: the READ tools are classified 'safe',
 * `remember` is left to the 'risky' default (prompt-gated). */
const FAKE_BRAIN_SERVERS: Record<string, McpServerConfig> = {
  brain: {
    command: [process.execPath, FIXTURE],
    toolRisk: { recall: 'safe', get_episode: 'safe' },
  },
};

function createCtx(): ToolCtx {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    emit: () => {},
    awaitPermission: async () => 'allow-once',
    state: {} as ToolCtx['state'],
  };
}

describe('brain MCP wiring (spawnable fake stdio server)', () => {
  // Track every started manager so a failing assertion never leaks a child.
  const started: McpManager[] = [];
  afterEach(async () => {
    await Promise.all(started.map((m) => m.shutdownAll()));
    started.length = 0;
  });

  function start(servers: Record<string, McpServerConfig> = FAKE_BRAIN_SERVERS): McpManager {
    const manager = createMcpManager(servers, process.cwd());
    started.push(manager);
    return manager;
  }

  it('spawns the child, connects, and namespaces the three brain-shaped tools', async () => {
    const manager = start();
    const result = await manager.start();
    expect(result.connected).toEqual(['brain']);
    expect(result.warnings).toEqual([]);

    const names = createMcpTools({ manager, servers: FAKE_BRAIN_SERVERS }).map((t) => t.name);
    // Sorted by the manager (server, then tool name) — Claude Code's exact names.
    expect(names).toEqual([
      'mcp__brain__get_episode',
      'mcp__brain__recall',
      'mcp__brain__remember',
    ]);
  });

  it('classifies reads safe + remember risky, and the policy auto-allows reads while gating remember', async () => {
    const manager = start();
    await manager.start();
    const tools = new Map(createMcpTools({ manager, servers: FAKE_BRAIN_SERVERS }).map((t) => [t.name, t]));

    const recall = tools.get('mcp__brain__recall');
    const getEpisode = tools.get('mcp__brain__get_episode');
    const remember = tools.get('mcp__brain__remember');
    if (recall === undefined || getEpisode === undefined || remember === undefined) {
      throw new Error('unreachable — all three brain tools should exist');
    }

    // (a) Risk classification came through from toolRisk.
    expect(recall.risk).toBe('safe');
    expect(getEpisode.risk).toBe('safe');
    expect(remember.risk).toBe('risky');

    // (b) The default juno policy auto-allows the reads and prompt-gates the write.
    const policy = createPermissionPolicy({ autoAllowSafe: true });
    expect(policy.evaluate(recall.name, { query: 'x' }, recall.risk)).toBe('auto-allow');
    expect(policy.evaluate(getEpisode.name, { id: 'ep_1' }, getEpisode.risk)).toBe('auto-allow');
    expect(policy.evaluate(remember.name, { text: 'x' }, remember.risk)).toBe('prompt');
  });

  it('dispatches a tools/call through the namespaced tool to the spawned server', async () => {
    const manager = start();
    await manager.start();
    const recall = createMcpTools({ manager, servers: FAKE_BRAIN_SERVERS }).find(
      (t) => t.name === 'mcp__brain__recall',
    );
    if (recall === undefined) throw new Error('unreachable — recall tool should exist');

    const out = await recall.run({ query: 'hello' }, createCtx());
    // The fixture echoes `fake-brain:<tool>:<args-json>`, proving the call reached
    // the real spawned child and round-tripped through the namespaced juno tool.
    expect(out).toEqual({ ok: true, data: 'fake-brain:recall:{"query":"hello"}' });
  });
});

// --------------------------------------------------------------------------
// Opt-in end-to-end test against the REAL personal-brain server. Skipped unless
// JUNO_BRAIN_E2E=1 so CI stays hermetic (it needs `uv` + ~/src/brain present).
// Run with: JUNO_BRAIN_E2E=1 npx vitest run tests/brainMcp.integration.test.ts
// --------------------------------------------------------------------------
const E2E = process.env.JUNO_BRAIN_E2E === '1';

describe.runIf(E2E)('brain MCP wiring — real brain server (opt-in, JUNO_BRAIN_E2E=1)', () => {
  const REAL_BRAIN_SERVERS: Record<string, McpServerConfig> = {
    brain: {
      command: ['uv', 'run', '--directory', '/Users/aidenangel/src/brain', 'brain-server'],
      toolRisk: { recall: 'safe', get_episode: 'safe' },
      timeoutMs: 30_000,
    },
  };

  it(
    'connects to the real brain server and discovers recall/get_episode/remember with the right risks',
    async () => {
      const manager = createMcpManager(REAL_BRAIN_SERVERS, process.cwd());
      try {
        const result = await manager.start();
        expect(result.connected).toEqual(['brain']);

        const tools = new Map(
          createMcpTools({ manager, servers: REAL_BRAIN_SERVERS }).map((t) => [t.name, t]),
        );
        expect([...tools.keys()].sort()).toEqual([
          'mcp__brain__get_episode',
          'mcp__brain__recall',
          'mcp__brain__remember',
        ]);
        expect(tools.get('mcp__brain__recall')?.risk).toBe('safe');
        expect(tools.get('mcp__brain__get_episode')?.risk).toBe('safe');
        expect(tools.get('mcp__brain__remember')?.risk).toBe('risky');
      } finally {
        await manager.shutdownAll();
      }
    },
    60_000,
  );
});
