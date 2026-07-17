// tests/mcpTools.test.ts
// Wave 3 — the MCP tool adapter. Hermetic: every test drives createMcpTools
// against a FAKE manager (no real connections, no child processes), asserting
// naming, schema passthrough, risk mapping, outcome→ToolResult folding, the
// registry's parent-only gating, and permission-pattern matching.
import { describe, expect, it } from 'vitest';
import type { Tool, ToolCtx } from '../src/core/contracts';
import { createPermissionPolicy } from '../src/permissions/policy';
import type { McpServerConfig } from '../src/services/config';
import type { McpCallToolOutcome, McpToolCallResult } from '../src/services/mcpClient';
import type { McpDiscoveredTool } from '../src/services/mcpManager';
import { createMcpTools, mcpToolName, splitMcpToolName, type McpToolsManager } from '../src/tools/mcpTools';
import { createDefaultTools } from '../src/tools/registry';

interface RecordedCall {
  server: string;
  tool: string;
  args: Record<string, unknown> | undefined;
}

function createFakeManager(
  tools: McpDiscoveredTool[],
  outcome: McpCallToolOutcome,
): { manager: McpToolsManager; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const manager: McpToolsManager = {
    listTools: () => tools,
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return outcome;
    },
  };
  return { manager, calls };
}

function success(result: Partial<McpToolCallResult>): McpCallToolOutcome {
  return { ok: true, result: { content: [], isError: false, ...result } };
}

function createCtx(): ToolCtx {
  return {
    cwd: '/tmp/ws',
    signal: new AbortController().signal,
    emit: () => {},
    awaitPermission: async () => 'allow-once',
    state: {} as ToolCtx['state'],
  };
}

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
};

const DISCOVERED: McpDiscoveredTool[] = [
  {
    server: 'weather',
    tool: { name: 'get_forecast', description: 'Get a forecast.', inputSchema: SCHEMA },
  },
];

const SERVERS: Record<string, McpServerConfig> = {
  weather: { command: ['irrelevant'] },
};

function buildTool(outcome: McpCallToolOutcome, servers = SERVERS): { tool: Tool; calls: RecordedCall[] } {
  const { manager, calls } = createFakeManager(DISCOVERED, outcome);
  const tools = createMcpTools({ manager, servers });
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  if (tool === undefined) throw new Error('unreachable');
  return { tool, calls };
}

describe('createMcpTools — naming + spec', () => {
  it('namespaces each tool as mcp__<server>__<tool> and passes the schema through verbatim', () => {
    const { tool } = buildTool(success({}));
    expect(tool.name).toBe('mcp__weather__get_forecast');
    expect(tool.name).toBe(mcpToolName('weather', 'get_forecast'));
    expect(tool.spec.name).toBe(tool.name);
    expect(tool.spec.inputSchema).toBe(SCHEMA);
  });

  it('annotates the description with the origin server and keeps the remote text', () => {
    const { tool } = buildTool(success({}));
    expect(tool.spec.description).toBe('MCP tool "get_forecast" from server "weather". Get a forecast.');
  });

  it('still describes the tool when the server gave no description', () => {
    const { manager } = createFakeManager(
      [{ server: 'weather', tool: { name: 'bare', inputSchema: {} } }],
      success({}),
    );
    const [tool] = createMcpTools({ manager, servers: SERVERS });
    expect(tool?.spec.description).toBe('MCP tool "bare" from server "weather".');
  });

  it('backstops against a duplicate final name: keeps first, drops the rest', () => {
    // Simulate a future path that bypasses upstream dedup/validation and hands the
    // adapter two discovered tools whose namespaced name is IDENTICAL. Exactly one
    // spec must survive so the model request can never carry a duplicate tool name.
    const { manager } = createFakeManager(
      [
        { server: 'a', tool: { name: 'ping', description: 'first', inputSchema: {} } },
        { server: 'a', tool: { name: 'ping', description: 'second', inputSchema: {} } },
      ],
      success({}),
    );
    const tools = createMcpTools({ manager, servers: {} });
    expect(tools.map((t) => t.name)).toEqual(['mcp__a__ping']);
    expect(tools[0]?.spec.description).toContain('first');
  });

  it('builds one tool per discovered tool across servers, collision-free', () => {
    const { manager } = createFakeManager(
      [
        { server: 'a', tool: { name: 'ping', inputSchema: {} } },
        { server: 'b', tool: { name: 'ping', inputSchema: {} } },
      ],
      success({}),
    );
    const names = createMcpTools({ manager, servers: {} }).map((t) => t.name);
    expect(names).toEqual(['mcp__a__ping', 'mcp__b__ping']);
  });
});

describe('createMcpTools — risk mapping', () => {
  it("defaults to 'risky' when the server config sets no risk", () => {
    const { tool } = buildTool(success({}));
    expect(tool.risk).toBe('risky');
  });

  it("defaults to 'risky' when the server is missing from config entirely", () => {
    const { tool } = buildTool(success({}), {});
    expect(tool.risk).toBe('risky');
  });

  it('honors a per-server risk override', () => {
    const safe = buildTool(success({}), { weather: { command: ['x'], risk: 'safe' } });
    expect(safe.tool.risk).toBe('safe');
    const dangerous = buildTool(success({}), { weather: { command: ['x'], risk: 'dangerous' } });
    expect(dangerous.tool.risk).toBe('dangerous');
  });

  it('a per-tool toolRisk entry wins over the server-wide risk', () => {
    // Server default is 'dangerous', but the specific tool is classified 'safe'.
    const { tool } = buildTool(success({}), {
      weather: { command: ['x'], risk: 'dangerous', toolRisk: { get_forecast: 'safe' } },
    });
    expect(tool.risk).toBe('safe');
  });

  it('falls back to the server-wide risk for a tool absent from toolRisk', () => {
    const { tool } = buildTool(success({}), {
      weather: { command: ['x'], risk: 'safe', toolRisk: { some_other_tool: 'dangerous' } },
    });
    expect(tool.risk).toBe('safe');
  });

  it("falls back to the 'risky' default when neither toolRisk nor risk is set", () => {
    const { tool } = buildTool(success({}), { weather: { command: ['x'], toolRisk: { other: 'safe' } } });
    expect(tool.risk).toBe('risky');
  });

  it('classifies brain-shaped read tools safe and the write tool risky (the standing decision)', () => {
    // recall + get_episode are READ tools → 'safe'; remember is a durable WRITE → 'risky'.
    const brainTools: McpDiscoveredTool[] = [
      { server: 'brain', tool: { name: 'recall', inputSchema: {} } },
      { server: 'brain', tool: { name: 'get_episode', inputSchema: {} } },
      { server: 'brain', tool: { name: 'remember', inputSchema: {} } },
    ];
    const { manager } = createFakeManager(brainTools, success({}));
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['uv', 'run', 'brain-server'], toolRisk: { recall: 'safe', get_episode: 'safe' } },
    };
    const byName = new Map(createMcpTools({ manager, servers }).map((t) => [t.name, t.risk]));
    expect(byName.get('mcp__brain__recall')).toBe('safe');
    expect(byName.get('mcp__brain__get_episode')).toBe('safe');
    expect(byName.get('mcp__brain__remember')).toBe('risky');
  });
});

describe('createMcpTools — run() result mapping', () => {
  it('dispatches to the manager with the origin server + remote tool name and the args', async () => {
    const { tool, calls } = buildTool(success({ content: [{ type: 'text', text: 'sunny' }] }));
    const result = await tool.run({ city: 'Indy' }, createCtx());
    expect(calls).toEqual([{ server: 'weather', tool: 'get_forecast', args: { city: 'Indy' } }]);
    expect(result).toEqual({ ok: true, data: 'sunny' });
  });

  it('joins multiple text blocks', async () => {
    const { tool } = buildTool(
      success({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    );
    expect(await tool.run({}, createCtx())).toEqual({ ok: true, data: 'a\nb' });
  });

  it('prefers structuredContent over text blocks', async () => {
    const { tool } = buildTool(
      success({
        content: [{ type: 'text', text: 'ignored' }],
        structuredContent: { temp: 71 },
      }),
    );
    expect(await tool.run({}, createCtx())).toEqual({ ok: true, data: { temp: 71 } });
  });

  it('surfaces unexpected content shapes as the raw content array', async () => {
    const weird = [{ type: 'image', data: 'zzz' }, 42, null];
    const { tool } = buildTool(success({ content: weird }));
    expect(await tool.run({}, createCtx())).toEqual({ ok: true, data: weird });
  });

  it('folds isError:true into { ok:false } with the text content as the error', async () => {
    const { tool } = buildTool(
      success({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    );
    expect(await tool.run({}, createCtx())).toEqual({ ok: false, error: 'boom' });
  });

  it('folds isError:true with no text into a descriptive fallback error', async () => {
    const { tool } = buildTool(success({ content: [], isError: true }));
    expect(await tool.run({}, createCtx())).toEqual({
      ok: false,
      error: 'mcp: tool "get_forecast" on server "weather" reported an error',
    });
  });

  it('maps a call-failure outcome straight through', async () => {
    const { tool } = buildTool({ ok: false, error: 'mcp: unknown or unavailable server "weather"' });
    expect(await tool.run({}, createCtx())).toEqual({
      ok: false,
      error: 'mcp: unknown or unavailable server "weather"',
    });
  });

  it('passes undefined args through as undefined', async () => {
    const { tool, calls } = buildTool(success({}));
    await tool.run(undefined, createCtx());
    expect(calls).toEqual([{ server: 'weather', tool: 'get_forecast', args: undefined }]);
  });

  it('rejects non-object args without calling the manager', async () => {
    const { tool, calls } = buildTool(success({}));
    expect(await tool.run('nope', createCtx())).toEqual({
      ok: false,
      error: 'invalid args: expected an object',
    });
    expect(await tool.run([1, 2], createCtx())).toEqual({
      ok: false,
      error: 'invalid args: expected an object',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('registry — mcp option', () => {
  const subagent = {
    createClient: () => ({ streamTurn: async function* () {} }),
    catalog: {} as never,
    policy: {} as never,
    defaultModel: 'm',
  };

  function mcpOption() {
    const { manager } = createFakeManager(DISCOVERED, success({}));
    return { manager, servers: SERVERS };
  }

  it('registers MCP tools for the parent agent when the mcp option is provided', () => {
    const names = createDefaultTools({ mcp: mcpOption() }).map((t) => t.name);
    expect(names).toContain('mcp__weather__get_forecast');
  });

  it('omits MCP tools when the option is absent (BUILTIN specs stay stable)', () => {
    const names = createDefaultTools().map((t) => t.name);
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false);
  });

  it('pushes MCP tools AFTER spawn_subagent (parent-agent-only)', () => {
    const names = createDefaultTools({ subagent, mcp: mcpOption() }).map((t) => t.name);
    expect(names.indexOf('mcp__weather__get_forecast')).toBeGreaterThan(names.indexOf('spawn_subagent'));
  });

  it("keeps MCP tools OUT of the sub-agent's childTools snapshot", () => {
    const tools = createDefaultTools({ subagent, mcp: mcpOption() });
    // The snapshot is whatever existed before the subagent push: assert by
    // construction order — every tool BEFORE spawn_subagent is the snapshot.
    const names = tools.map((t) => t.name);
    const childNames = names.slice(0, names.indexOf('spawn_subagent'));
    expect(childNames.some((n) => n.startsWith('mcp__'))).toBe(false);
  });
});

describe('permission policy — mcp__<server>__<tool> patterns', () => {
  it('an exact-name allow pattern auto-allows the risky MCP tool', () => {
    const policy = createPermissionPolicy({ allow: ['mcp__weather__get_forecast'] });
    expect(policy.evaluate('mcp__weather__get_forecast', { city: 'Indy' }, 'risky')).toBe('auto-allow');
  });

  it('a per-server wildcard matches every tool on that server only', () => {
    const policy = createPermissionPolicy({ allow: ['mcp__weather__*'] });
    expect(policy.evaluate('mcp__weather__get_forecast', {}, 'risky')).toBe('auto-allow');
    expect(policy.evaluate('mcp__other__get_forecast', {}, 'risky')).toBe('prompt');
  });

  it('deny wins over allow for an MCP tool', () => {
    const policy = createPermissionPolicy({
      allow: ['mcp__weather__*'],
      deny: ['mcp__weather__get_forecast'],
    });
    expect(policy.evaluate('mcp__weather__get_forecast', {}, 'risky')).toBe('auto-deny');
  });

  it('an unmatched risky MCP tool prompts; a dangerous one is never auto-allowed by name-allow', () => {
    const policy = createPermissionPolicy({});
    expect(policy.evaluate('mcp__weather__get_forecast', {}, 'risky')).toBe('prompt');
    const allowing = createPermissionPolicy({ allow: ['mcp__weather__get_forecast'] });
    expect(allowing.evaluate('mcp__weather__get_forecast', {}, 'dangerous')).toBe('prompt');
  });
});

describe('permission classification — brain reads auto-allow via risk, writes gated', () => {
  // Drives each brain-shaped tool's OWN classified risk (from toolRisk) through the
  // default juno policy (autoAllowSafe:true, no allow/deny seeds). This proves the
  // standing decision holds WITHOUT any per-tool allow-pattern: reads are 'safe' so
  // they auto-allow; remember is 'risky' so it prompts.
  function brainTools(): Map<string, Tool> {
    const discovered: McpDiscoveredTool[] = [
      { server: 'brain', tool: { name: 'recall', inputSchema: {} } },
      { server: 'brain', tool: { name: 'get_episode', inputSchema: {} } },
      { server: 'brain', tool: { name: 'remember', inputSchema: {} } },
    ];
    const { manager } = createFakeManager(discovered, success({}));
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['uv', 'run', 'brain-server'], toolRisk: { recall: 'safe', get_episode: 'safe' } },
    };
    return new Map(createMcpTools({ manager, servers }).map((t) => [t.name, t]));
  }

  it('auto-allows the read tools and prompt-gates remember under the default policy', () => {
    const policy = createPermissionPolicy({ autoAllowSafe: true });
    const tools = brainTools();
    for (const readName of ['mcp__brain__recall', 'mcp__brain__get_episode']) {
      const tool = tools.get(readName);
      expect(tool).toBeDefined();
      if (tool === undefined) throw new Error('unreachable');
      expect(policy.evaluate(tool.name, { query: 'x' }, tool.risk)).toBe('auto-allow');
    }
    const remember = tools.get('mcp__brain__remember');
    expect(remember).toBeDefined();
    if (remember === undefined) throw new Error('unreachable');
    expect(policy.evaluate(remember.name, { text: 'x' }, remember.risk)).toBe('prompt');
  });

  it('still prompts the reads when autoAllowSafe is turned off (nothing is hardcoded)', () => {
    const policy = createPermissionPolicy({ autoAllowSafe: false });
    const recall = brainTools().get('mcp__brain__recall');
    if (recall === undefined) throw new Error('unreachable');
    expect(policy.evaluate(recall.name, {}, recall.risk)).toBe('prompt');
  });
});

// The reverse of `mcpToolName`, now the SINGLE authority both delegating CLI
// backends (claude-cli + codex-cli) call to project juno's gate onto a child.
// These pin the two subtle behaviours the duplicated copies each had to get
// right: LONGEST-server-prefix disambiguation (a server key may contain `__`),
// and deny-by-default for an unconfigured server.
describe('splitMcpToolName', () => {
  const srv = (): McpServerConfig => ({ command: ['x'] });

  it('splits a namespaced tool into its server + tool parts', () => {
    expect(splitMcpToolName('mcp__brain__recall', { brain: srv() })).toEqual({
      server: 'brain',
      tool: 'recall',
    });
  });

  it('keeps a `__` inside the tool segment intact', () => {
    expect(splitMcpToolName('mcp__brain__get__episode', { brain: srv() })).toEqual({
      server: 'brain',
      tool: 'get__episode',
    });
  });

  it('matches the LONGEST configured server whose prefix fits (server key contains `__`)', () => {
    const servers = { brain: srv(), brain__sub: srv() };
    // `brain__sub` is the longer prefix, so it wins over `brain` — the tool is
    // `recall`, NOT server `brain` with tool `sub__recall`.
    expect(splitMcpToolName('mcp__brain__sub__recall', servers)).toEqual({
      server: 'brain__sub',
      tool: 'recall',
    });
  });

  it('returns undefined for a tool on no configured server (deny-by-default)', () => {
    expect(splitMcpToolName('mcp__weather__forecast', { brain: srv() })).toBeUndefined();
  });

  it('returns undefined when no servers are configured', () => {
    expect(splitMcpToolName('mcp__brain__recall', {})).toBeUndefined();
  });
});
