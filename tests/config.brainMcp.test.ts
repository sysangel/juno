// tests/config.brainMcp.test.ts
// Decision (b): the brain READ-ONLY MCP server, wired into juno so it clears the
// codex passthrough's all-tools-must-auto-allow gate. These tests pin the config
// surface (the `serverCommand` field + its default/parse/env survival) and the two
// wiring helpers (`brainReadonlyMcpServer` / `withBrainReadonlyMcpServer`), then
// prove the gate DECISION the wiring exists to satisfy: every exposed tool of the
// read-only server auto-allows, whereas the full server's `remember` never does.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BRAIN_MCP_SERVER_ID,
  brainReadonlyMcpServer,
  createConfigService,
  DEFAULT_BRAIN_SETTINGS,
  withBrainReadonlyMcpServer,
  type BrainSettings,
  type McpServerConfig,
} from '../src/services/config';
import { createPermissionPolicy } from '../src/permissions/policy';
import { classifyRisk, mcpToolName } from '../src/tools/mcpTools';

describe('brain read-only MCP server config surface', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-brain-mcp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('defaults serverCommand to the read-only console script', () => {
    expect(DEFAULT_BRAIN_SETTINGS.serverCommand).toEqual([
      'uv',
      'run',
      '--directory',
      path.join(os.homedir(), 'src', 'brain'),
      'brain-server-readonly',
    ]);
  });

  it('parses a config-file serverCommand override (a partial brain block keeps other defaults)', async () => {
    const configPath = await writeConfig({ brain: { enabled: true, serverCommand: ['my-brain-ro'] } });
    const brain = createConfigService({ configPath, env: {} }).getValue('brain');
    expect(brain?.serverCommand).toEqual(['my-brain-ro']);
    // Untouched sibling command keeps its default.
    expect(brain?.recallCommand).toEqual(DEFAULT_BRAIN_SETTINGS.recallCommand);
  });

  it('carries serverCommand through the JUNO_BRAIN_ENABLED env override', async () => {
    const configPath = await writeConfig({ brain: { serverCommand: ['ro-server'] } });
    const brain = createConfigService({ configPath, env: { JUNO_BRAIN_ENABLED: 'true' } }).getValue('brain');
    expect(brain?.enabled).toBe(true);
    expect(brain?.serverCommand).toEqual(['ro-server']);
  });
});

describe('brainReadonlyMcpServer / withBrainReadonlyMcpServer', () => {
  const brain: BrainSettings = { ...DEFAULT_BRAIN_SETTINGS, serverCommand: ['ro-server', '--stdio'], timeoutMs: 12_345 };

  it('builds a WHOLESALE-safe server (read-only by construction) that carries the timeout', () => {
    const server = brainReadonlyMcpServer(brain);
    expect(server).toEqual({
      command: ['ro-server', '--stdio'],
      risk: 'safe',
      timeoutMs: 12_345,
    });
    // The command is copied, not aliased: a later mutation of the source brain
    // settings never leaks into the already-built server config.
    brain.serverCommand.push('mutated');
    expect(server.command).toEqual(['ro-server', '--stdio']);
    brain.serverCommand.pop();
  });

  it('injects the brain server under the brain id when none is configured', () => {
    const merged = withBrainReadonlyMcpServer(undefined, brain);
    expect(Object.keys(merged)).toEqual([BRAIN_MCP_SERVER_ID]);
    expect(merged[BRAIN_MCP_SERVER_ID]).toEqual(brainReadonlyMcpServer(brain));
  });

  it('preserves other configured servers alongside the injected brain server', () => {
    const docs: McpServerConfig = { command: ['docs-mcp'], toolRisk: { search: 'safe' } };
    const merged = withBrainReadonlyMcpServer({ docs }, brain);
    expect(merged.docs).toBe(docs);
    expect(merged[BRAIN_MCP_SERVER_ID]).toEqual(brainReadonlyMcpServer(brain));
  });

  it('never clobbers a user-configured brain server (explicit config wins)', () => {
    const userBrain: McpServerConfig = { command: ['uv', 'run', 'brain-server'], toolRisk: { recall: 'safe' } };
    const merged = withBrainReadonlyMcpServer({ [BRAIN_MCP_SERVER_ID]: userBrain }, brain);
    expect(merged[BRAIN_MCP_SERVER_ID]).toBe(userBrain);
  });

  it('returns a NEW map and does not mutate the input', () => {
    const input: Record<string, McpServerConfig> = {};
    const merged = withBrainReadonlyMcpServer(input, brain);
    expect(merged).not.toBe(input);
    expect(input).toEqual({});
  });
});

// The gate the wiring exists to clear: the codex passthrough wires a server only if the
// WHOLE server is safe — every EXPOSED tool auto-allows AND the server's default posture
// auto-allows (so a LATER-ADDED tool can't ride codex's own ungated connection). The
// read-only server is WHOLESALE `risk:'safe'`, so recall + get_episode — and any future read
// it might expose — all auto-allow. The FULL brain server (risky default + a `remember`
// write) can never qualify: `remember` is risky, as is any unclassified/late-added tool.
describe('brain read-only server clears the codex passthrough gate', () => {
  const autoAllow = createPermissionPolicy({ autoAllowSafe: true });
  const readonlyServers = { [BRAIN_MCP_SERVER_ID]: brainReadonlyMcpServer(DEFAULT_BRAIN_SETTINGS) };
  // The FULL brain server shape: recall/get_episode marked safe, but a RISKY default (so
  // `remember` and any unclassified/late-added tool stay risky).
  const fullServers: Record<string, McpServerConfig> = {
    [BRAIN_MCP_SERVER_ID]: {
      command: [...DEFAULT_BRAIN_SETTINGS.serverCommand],
      toolRisk: { recall: 'safe', get_episode: 'safe' },
    },
  };

  const evaluates = (
    servers: Record<string, McpServerConfig>,
    tool: string,
  ): 'auto-allow' | 'auto-deny' | 'prompt' => {
    const risk = classifyRisk(servers, BRAIN_MCP_SERVER_ID, tool);
    return autoAllow.evaluate(mcpToolName(BRAIN_MCP_SERVER_ID, tool), {}, risk);
  };

  it('auto-allows both exposed read tools on the wholesale-safe read-only server', () => {
    expect(evaluates(readonlyServers, 'recall')).toBe('auto-allow');
    expect(evaluates(readonlyServers, 'get_episode')).toBe('auto-allow');
  });

  it('auto-allows a hypothetical LATE-ADDED tool too (wholesale-safe covers future tools)', () => {
    // The read-only server is safe BY CONSTRUCTION, so an unconfigured tool inherits the
    // server-wide `risk:'safe'` — exactly what lets the passthrough gate wire it against
    // tools codex might discover on its own live connection.
    expect(evaluates(readonlyServers, 'some_future_read')).toBe('auto-allow');
  });

  it('would NOT auto-allow remember on the FULL server (why the full server is denied)', () => {
    // On the full server config `remember` has no toolRisk entry, so it falls to the 'risky'
    // default — prompt-gated, never auto-allowed. The read-only server never exposes it.
    expect(evaluates(fullServers, 'remember')).toBe('prompt');
  });
});
