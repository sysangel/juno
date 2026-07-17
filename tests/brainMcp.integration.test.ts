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
// `remember` (a durable write) stays 'risky' and prompt-gated. The opt-in block
// at the bottom runs the SAME assertions against the real brain server AND
// additionally round-trips a real READ-ONLY `recall` tools/call — verifying the
// live result SHAPE the adapter renders, which the hermetic fixture can only
// approximate. It is guarded behind JUNO_BRAIN_E2E=1 and skipped by default so
// CI stays hermetic.
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
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

// Location of the personal-brain checkout. Derived from $HOME so no username or
// private-repo path is baked into the public tree; override with JUNO_BRAIN_DIR.
const BRAIN_DIR = process.env.JUNO_BRAIN_DIR ?? path.join(os.homedir(), 'src', 'brain');

describe.runIf(E2E)('brain MCP wiring — real brain server (opt-in, JUNO_BRAIN_E2E=1)', () => {
  const REAL_BRAIN_SERVERS: Record<string, McpServerConfig> = {
    brain: {
      command: ['uv', 'run', '--directory', BRAIN_DIR, 'brain-server'],
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

  it(
    'round-trips a real READ-ONLY recall and renders a non-error, text-bearing result',
    async () => {
      const manager = createMcpManager(REAL_BRAIN_SERVERS, process.cwd());
      try {
        await manager.start();
        const recall = createMcpTools({ manager, servers: REAL_BRAIN_SERVERS }).find(
          (t) => t.name === 'mcp__brain__recall',
        );
        if (recall === undefined) throw new Error('unreachable — recall tool should exist');

        // READ-ONLY: a benign query against the live index. `remember` (the only
        // durable-write tool) is deliberately never called from this suite.
        const out = await recall.run({ query: 'juno state', k: 3 }, createCtx());

        // A real tools/call must round-trip to a NON-ERROR ToolResult...
        expect(out.ok).toBe(true);
        if (!out.ok) throw new Error(`recall round-trip failed: ${out.error ?? '(no error)'}`);

        // ...whose `data` is exactly what the adapter hands the transcript to render:
        // joined text (string) OR the server's structuredContent (object). Either way it
        // must flatten to a non-empty, text-bearing payload — an empty render would mean
        // the round-trip produced nothing to show the model/user.
        const { data } = out;
        const rendered = typeof data === 'string' ? data : JSON.stringify(data);
        expect(typeof rendered).toBe('string');
        expect(rendered.length).toBeGreaterThan(0);

        // The real brain `recall` returns structuredContent `{ fts_only, hits: [...] }`;
        // the adapter passes that object through verbatim. Assert that contract so a
        // server-side shape change (or FastMCP no longer surfacing structuredContent)
        // is caught HERE rather than silently mis-rendered downstream.
        if (typeof data !== 'string') {
          expect(data).toMatchObject({ hits: expect.any(Array) });
        }
      } finally {
        await manager.shutdownAll();
      }
    },
    60_000,
  );
});

// --------------------------------------------------------------------------
// Opt-in end-to-end test against the REAL read-only brain server (decision b):
// `brain-server-readonly` exposes ONLY recall + get_episode — the surface juno's
// codex passthrough can wire, since every exposed tool is auto-allowable. Skipped
// unless JUNO_BRAIN_E2E=1 (needs `uv` + ~/src/brain present).
// --------------------------------------------------------------------------
describe.runIf(E2E)('brain read-only MCP server — real server (opt-in, JUNO_BRAIN_E2E=1)', () => {
  const READONLY_BRAIN_SERVERS: Record<string, McpServerConfig> = {
    brain: {
      command: ['uv', 'run', '--directory', BRAIN_DIR, 'brain-server-readonly'],
      toolRisk: { recall: 'safe', get_episode: 'safe' },
      timeoutMs: 30_000,
    },
  };

  it(
    'exposes EXACTLY recall + get_episode (no remember) and both are auto-allowed',
    async () => {
      const manager = createMcpManager(READONLY_BRAIN_SERVERS, process.cwd());
      try {
        const result = await manager.start();
        expect(result.connected).toEqual(['brain']);

        const tools = createMcpTools({ manager, servers: READONLY_BRAIN_SERVERS });
        const names = tools.map((t) => t.name).sort();
        // The write tool is ABSENT by construction — this is the whole point of (b).
        expect(names).toEqual(['mcp__brain__get_episode', 'mcp__brain__recall']);

        // Every exposed tool auto-allows → the codex passthrough would wire the server.
        const policy = createPermissionPolicy({ autoAllowSafe: true });
        for (const tool of tools) {
          expect(policy.evaluate(tool.name, {}, tool.risk)).toBe('auto-allow');
        }
      } finally {
        await manager.shutdownAll();
      }
    },
    60_000,
  );

  it(
    'round-trips a real READ-ONLY recall against the read-only server',
    async () => {
      const manager = createMcpManager(READONLY_BRAIN_SERVERS, process.cwd());
      try {
        await manager.start();
        const recall = createMcpTools({ manager, servers: READONLY_BRAIN_SERVERS }).find(
          (t) => t.name === 'mcp__brain__recall',
        );
        if (recall === undefined) throw new Error('unreachable — recall tool should exist');

        const out = await recall.run({ query: 'juno state', k: 3 }, createCtx());
        expect(out.ok).toBe(true);
        if (!out.ok) throw new Error(`recall round-trip failed: ${out.error ?? '(no error)'}`);
        const { data } = out;
        if (typeof data !== 'string') {
          expect(data).toMatchObject({ hits: expect.any(Array) });
        }
      } finally {
        await manager.shutdownAll();
      }
    },
    60_000,
  );
});
