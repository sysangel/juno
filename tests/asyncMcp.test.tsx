// tests/asyncMcp.test.tsx
// Wave 2 async-mcp — the "paint first, connect MCP in background" contract, at the
// mounted-<App> level (the statusStrip mcp-chip states + the cli.ts build-but-don't-
// start wiring are pinned separately in tests/statusStrip.test.tsx and
// tests/cli.test.ts).
//
// cli.ts BUILDS the manager but never `start()`s it; App owns the connect. The four
// behaviors proven here:
//   1. First paint is NOT gated on the connect — the app renders (and the seeded
//      `mcp:connecting…` chip shows) while `start()` is still pending forever.
//   2. Discovered MCP tools LATE-BIND: a turn fired before the connect resolves
//      carries base specs only; a turn after resolution carries the mcp__ specs.
//   3. Connect warnings route to a single transcript notice, NOT process.stderr
//      (a post-render stderr write corrupts the Ink TUI).
//   4. The late-bound append never leaks MCP into the subagent's frozen childTools
//      snapshot (subagents stay a depth-1, MCP-free capability).
//
// Patterns reused: InputBox is mocked to capture onSubmit (as in
// mcpPermission.integration / slashIntercept / resume.integration) so a turn starts
// deterministically; StatusLine is NOT mocked, so the real seeded connecting chip
// renders; the scripted client records the specs of each streamTurn (as in
// subagent.test) so the late-bind is directly observable.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, Tool, ToolCtx, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { McpServerConfig, Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { createDefaultTools } from '../src/tools/registry';
import { createMcpTools } from '../src/tools/mcpTools';
import type { McpDiscoveredTool, McpManager, McpManagerStartResult } from '../src/services/mcpManager';
import type { McpCallToolOutcome } from '../src/services/mcpClient';
import { flushInk, waitFor, waitForFrame } from './helpers/ink';

// ---------------------------------------------------------------------------
// InputBox mock — capture onSubmit to drive a turn. StatusLine stays REAL so the
// seeded mcp:connecting chip renders for the first-paint proof.
// ---------------------------------------------------------------------------
interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
}
const inputBoxMock = vi.hoisted(() => ({ latestProps: null as CapturedInputBoxProps | null }));
vi.mock('../src/ui/InputBox', () => ({
  InputBox: (props: CapturedInputBoxProps) => {
    inputBoxMock.latestProps = props;
    return <Text>mock-input</Text>;
  },
  // Composer-framing hairline rules: stubbed to null here so the mocked-InputBox App
  // frame is unchanged (the rules are exercised in statusStrip/app.smoke tests).
  ComposerRule: () => null,
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Fixtures — one brain server exposing two tools (read + write).
// ---------------------------------------------------------------------------
const DISCOVERED: McpDiscoveredTool[] = [
  { server: 'brain', tool: { name: 'recall', description: 'read', inputSchema: { type: 'object' } } },
  { server: 'brain', tool: { name: 'remember', description: 'write', inputSchema: { type: 'object' } } },
];
const SERVERS: Record<string, McpServerConfig> = { brain: { command: ['brain-mcp'] } };

/** A manager whose `start()` resolves only when the test calls `resolveStart` —
 * so a test can hold the connect PENDING (first-paint proof) or resolve it with a
 * chosen {connected, warnings} (late-bind / warnings proofs). */
function createControlledManager(): {
  manager: McpManager;
  started: { count: number };
  resolveStart: (result: McpManagerStartResult) => void;
} {
  const started = { count: 0 };
  let resolve!: (result: McpManagerStartResult) => void;
  const startPromise = new Promise<McpManagerStartResult>((r) => {
    resolve = r;
  });
  const manager: McpManager = {
    start: () => {
      started.count += 1;
      return startPromise;
    },
    listTools: () => DISCOVERED,
    status: () => [],
    callTool: async (): Promise<McpCallToolOutcome> => ({ ok: false, error: 'unused' }),
    shutdownAll: async () => {},
  };
  return { manager, started, resolveStart: resolve };
}

/** A client that records the specs handed to each streamTurn and streams a short
 * completing turn. The recorded specs are the observable for the late-bind. */
function createSpyClient(): { client: ModelClient; turns: ToolSpec[][] } {
  const turns: ToolSpec[][] = [];
  const client: ModelClient = {
    async *streamTurn(_input: TurnInput, specs: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      turns.push(specs);
      if (signal.aborted) return;
      yield { type: 'assistant-start', id: 'a' };
      yield { type: 'text-delta', id: 'a', delta: 'streamed-ok' };
      yield { type: 'assistant-done', id: 'a', stopReason: 'end' };
    },
  };
  return { client, turns };
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return { defaultProvider: 'claude-cli', defaultModel: 'claude-fable-5', cwd: '/work', maxContext: 200_000, ...overrides };
}

/** Deps mirroring cli.ts's async assembly: base tools built WITHOUT MCP; the
 * built-but-not-started manager + its servers threaded in `mcp`. */
function fakeDeps(client: ModelClient, manager: McpManager): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  const tools = createDefaultTools();
  return {
    createClient: () => client,
    tools,
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: tools.map((tool) => tool.spec),
    mcp: { manager, servers: SERVERS },
  };
}

async function startTurn(value: string): Promise<void> {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  await act(async () => {
    props.onSubmit(value);
    await tick();
  });
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('async-mcp: paint first, connect in background', () => {
  it('paints the first frame while start() is still pending — render is NOT gated on the MCP connect', async () => {
    const { manager, started } = createControlledManager(); // start() never resolved in this test
    const { client } = createSpyClient();
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);

    // The very first committed frame already carries the seeded connecting chip —
    // proof the render did not wait on the connect. If render were gated on start()
    // (which never resolves here), nothing would ever paint.
    expect(lastFrame() ?? '').toContain('mcp:connecting');

    // The connect is kicked from a POST-paint effect (background), exactly once.
    await flushInk();
    expect(started.count).toBe(1);
    // Still pending → still connecting; the UI stayed live throughout.
    expect(lastFrame() ?? '').toContain('mcp:connecting');

    unmount();
  });

  it('late-binds the discovered MCP tools into the NEXT turn after start() resolves', async () => {
    const { manager, resolveStart } = createControlledManager();
    const { client, turns } = createSpyClient();
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    // Turn 1 fires BEFORE the connect resolves → base specs only (no mcp__ tools).
    await startTurn('before connect');
    await waitFor(() => turns.length >= 1, { label: 'turn 1 recorded' });
    await waitForFrame(lastFrame, 'streamed-ok'); // turn 1 ran to output
    expect(turns[0]?.map((s) => s.name)).not.toContain('mcp__brain__recall');

    // Resolve the connect (all servers up) with a warning used purely as a commit
    // barrier: the notice dispatch happens LAST in the resolution IIFE, so seeing it
    // proves the mcpStatus + activeTools/activeSpecs setStates already committed.
    await act(async () => {
      resolveStart({ connected: ['brain'], warnings: ['barrier'] });
      await tick();
    });
    await waitForFrame(lastFrame, 'mcp: barrier');

    // Turn 2 now carries the late-bound MCP specs (submit closure re-formed).
    await startTurn('after connect');
    await waitFor(() => turns.length >= 2, { label: 'turn 2 recorded' });
    const names = turns[1]?.map((s) => s.name) ?? [];
    expect(names).toContain('mcp__brain__recall');
    expect(names).toContain('mcp__brain__remember');

    unmount();
  });

  it('routes connect warnings to a single transcript notice, NOT process.stderr (which corrupts Ink)', async () => {
    const { manager, resolveStart } = createControlledManager();
    const { client } = createSpyClient();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    await act(async () => {
      resolveStart({ connected: ['brain'], warnings: ['brain skipped', 'weather dropped'] });
      await tick();
    });

    // Both warnings surface, folded under the single dim `mcp:` notice.
    const frame = await waitForFrame(lastFrame, 'brain skipped');
    expect(frame).toContain('weather dropped');
    expect(frame).toContain('mcp:');

    // And NONE of the connect warnings went to stderr (post-render stderr writes
    // corrupt the Ink render — the whole reason the routing moved into the UI).
    const wrote = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(wrote).not.toContain('brain skipped');
    expect(wrote).not.toContain('weather dropped');

    stderrSpy.mockRestore();
    unmount();
  });
});

describe('async-mcp: subagent snapshot is unaffected by the late-bind', () => {
  function ctxWith(): ToolCtx {
    return {
      cwd: '.',
      signal: new AbortController().signal,
      emit: () => {},
      awaitPermission: async () => 'deny',
      state: {} as ToolCtx['state'],
    };
  }

  it('appending late-bound MCP tools to the parent set does NOT leak them into the subagent childTools snapshot', async () => {
    // Scripted client recording the specs the nested subagent turn runs with.
    const recorded: ToolSpec[][] = [];
    const client: ModelClient = {
      async *streamTurn(_input: TurnInput, specs: ToolSpec[]): AsyncIterable<AgentEvent> {
        recorded.push(specs);
        yield { type: 'assistant-start', id: 'a' };
        yield { type: 'assistant-done', id: 'a', stopReason: 'end' };
      },
    };
    const manager: McpManager = {
      start: async () => ({ connected: ['brain'], warnings: [] }),
      listTools: () => DISCOVERED,
      status: () => [],
      callTool: async (): Promise<McpCallToolOutcome> => ({ ok: false, error: 'unused' }),
      shutdownAll: async () => {},
    };

    // cli.ts async path: the subagent snapshots the base tools; MCP is UNDEFINED at
    // build time (App late-binds it), so it is not in the snapshot.
    const tools = createDefaultTools({
      subagent: {
        createClient: () => client,
        catalog: createModelCatalog(BUILTIN_MODELS),
        policy: createPermissionPolicy({ autoAllowSafe: true }),
        defaultModel: 'claude-fable-5',
      },
      mcp: undefined,
    });

    // App's late-bind: MCP tools are appended to the PARENT active set.
    const mcpTools = createMcpTools({ manager, servers: SERVERS });
    const activeTools: Tool[] = [...tools, ...mcpTools];
    // The parent DID gain the MCP tools...
    expect(activeTools.map((t) => t.name)).toContain('mcp__brain__recall');

    // ...but running the SAME subagent instance from the parent's active set uses its
    // frozen childTools snapshot, which never saw MCP.
    const subagent = activeTools.find((t) => t.name === 'spawn_subagent');
    expect(subagent).toBeDefined();
    await subagent!.run({ task: 'delegate' }, ctxWith());

    const childNames = recorded[0]?.map((s) => s.name) ?? [];
    expect(childNames).not.toContain('mcp__brain__recall');
    expect(childNames).not.toContain('mcp__brain__remember');
    expect(childNames).toContain('read_file'); // base tools DID pass through
  });
});
