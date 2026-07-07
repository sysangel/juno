// tests/mcpPermission.integration.test.tsx
// App-level integration: the risky `mcp__brain__remember` MCP tool is
// permission-gated in the REAL UI, not just at the policy-unit level.
//
// The brain MCP wave proved `policy.evaluate('mcp__brain__remember', …) ===
// 'prompt'` in isolation (see tests/mcpTools.test.ts). That leaves a gap: does
// that `prompt` verdict actually raise the overlay in a mounted <App>, block the
// tools/call until the user decides, and drop the manager dispatch on deny? This
// mounts the whole app over:
//   - a STUBBED MCP manager exposing `mcp__brain__remember` (risky) and
//     `mcp__brain__recall` (allow-listed → auto-allow, for contrast), and
//   - a SCRIPTED provider that emits a `tool_use` for each,
// and drives the permission overlay through Ink stdin exactly as a user would.
//
// Established patterns reused: InputBox is mocked to capture onSubmit (as in
// slashIntercept / resume.integration) so a turn can be started deterministically;
// the fake MCP manager mirrors tests/mcpTools.test.ts; the permission keys ('y'
// allow-once / 'd' deny) are driven through the real PermissionPrompt useInput.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { McpServerConfig, Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { createDefaultTools } from '../src/tools/registry';
import type { McpToolsManager } from '../src/tools/mcpTools';
import type { McpDiscoveredTool } from '../src/services/mcpManager';
import type { McpCallToolOutcome } from '../src/services/mcpClient';
import { flushInk, press, waitFor, waitForFrame } from './helpers/ink';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
}

const inputBoxMock = vi.hoisted(() => ({
  latestProps: null as CapturedInputBoxProps | null,
}));

// Mock InputBox to capture onSubmit (the same seam slashIntercept/resume use to
// start a turn deterministically). The real PermissionPrompt is NOT mocked, so
// its useInput still receives the stdin keys that drive the allow/deny decision.
vi.mock('../src/ui/InputBox', () => ({
  InputBox: (props: CapturedInputBoxProps) => {
    inputBoxMock.latestProps = props;
    return <Text>mock-input</Text>;
  },
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Stubbed MCP manager — two brain tools, recording every callTool dispatch.
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly server: string;
  readonly tool: string;
  readonly args: Record<string, unknown> | undefined;
}

const DISCOVERED: McpDiscoveredTool[] = [
  {
    server: 'brain',
    tool: {
      name: 'recall',
      description: 'Search personal memory.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  },
  {
    server: 'brain',
    tool: {
      name: 'remember',
      description: 'Persist a durable memory.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    },
  },
];

/** The one brain server; risk defaults to 'risky' for BOTH its tools (per-server
 * risk mapping in createMcpTools). `recall` is auto-allowed via the policy
 * allow-list below, matching how the real wiring makes reads safe while writes
 * stay prompt-gated. */
const SERVERS: Record<string, McpServerConfig> = { brain: { command: ['brain-mcp'] } };

function createFakeMcpManager(): { manager: McpToolsManager; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const manager: McpToolsManager = {
    listTools: () => DISCOVERED,
    callTool: async (server, tool, args): Promise<McpCallToolOutcome> => {
      calls.push({ server, tool, args });
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }], isError: false } };
    },
  };
  return { manager, calls };
}

// ---------------------------------------------------------------------------
// Scripted provider — emits a `tool_use` turn, then a clean `end` on re-entry.
// ---------------------------------------------------------------------------

/** A clean terminal turn. Reaching its 'FINISHED' text in the frame is the
 * witness that the turn ran to completion (a still-gated call would park the
 * loop on the overlay and this text would never render). */
const DONE_TURN: AgentEvent[] = [
  { type: 'assistant-start', id: 'a-final' },
  { type: 'text-delta', id: 'a-final', delta: 'FINISHED' },
  { type: 'assistant-done', id: 'a-final', stopReason: 'end' },
];

/** Build a `tool_use` turn requesting each of `toolCalls`. */
function toolUseTurn(
  toolCalls: ReadonlyArray<{ toolCallId: string; name: string; args: unknown }>,
): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'assistant-start', id: 'a-tools' }];
  for (const call of toolCalls) {
    events.push({
      type: 'tool-call',
      id: 'a-tools',
      toolCallId: call.toolCallId,
      name: call.name,
      args: call.args,
    });
  }
  events.push({ type: 'assistant-done', id: 'a-tools', stopReason: 'tool_use' });
  return events;
}

/** A stateful provider that yields `scripts[n]` on the n-th streamTurn call. */
function createScriptedClient(scripts: ReadonlyArray<AgentEvent[]>): ModelClient {
  let call = 0;
  return {
    async *streamTurn(
      _input: TurnInput,
      _tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      const script = scripts[call] ?? [];
      call += 1;
      for (const event of script) {
        if (signal.aborted) return;
        yield event;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Deps assembly + turn kickoff.
// ---------------------------------------------------------------------------

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient, manager: McpToolsManager): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  const tools = createDefaultTools({ mcp: { manager, servers: SERVERS } });
  return {
    createClient: () => client,
    tools,
    // Both brain tools are risk:'risky'; the allow-list auto-allows recall while
    // remember (unmatched, risky) resolves to `prompt` → overlay. This is the
    // exact mechanism the mcpTools policy unit test asserts, now driven end-to-end.
    policy: createPermissionPolicy({ autoAllowSafe: true, allow: ['mcp__brain__recall'] }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: tools.map((tool) => tool.spec),
  };
}

function submitCaptured(value: string): void {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  props.onSubmit(value);
}

/** Start a turn by driving the captured InputBox onSubmit, act-wrapped so the
 * synchronous reducer dispatches inside turn.submit don't warn. */
async function startTurn(value: string): Promise<void> {
  await act(async () => {
    submitCaptured(value);
    await tick();
  });
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('MCP permission gating in the mounted app', () => {
  it('auto-allows the safe recall tool: it executes with NO permission overlay', async () => {
    const { manager, calls } = createFakeMcpManager();
    const client = createScriptedClient([
      toolUseTurn([{ toolCallId: 'tc-recall', name: 'mcp__brain__recall', args: { query: 'state' } }]),
      DONE_TURN,
    ]);
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    await startTurn('recall my state');

    // Reaching the terminal turn proves recall was NEVER gated: a permission
    // overlay would have parked the loop before re-entry, so 'FINISHED' (only
    // emitted on the second streamTurn call) could not appear.
    await waitForFrame(lastFrame, 'FINISHED');

    expect(calls).toEqual([{ server: 'brain', tool: 'recall', args: { query: 'state' } }]);
    expect(lastFrame() ?? '').not.toContain('permission required');

    unmount();
  });

  it('raises the permission overlay for the risky remember tool; deny does NOT execute it and the turn completes', async () => {
    const { manager, calls } = createFakeMcpManager();
    const client = createScriptedClient([
      toolUseTurn([
        { toolCallId: 'tc-remember', name: 'mcp__brain__remember', args: { text: 'a durable fact' } },
      ]),
      DONE_TURN,
    ]);
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    await startTurn('remember this');

    // (2) The overlay is raised for the risky tool, and — because the executor
    // parks on awaitPermission — nothing has been dispatched to the manager yet.
    const overlay = await waitForFrame(lastFrame, 'permission required');
    expect(overlay).toContain('mcp__brain__remember');
    expect(overlay).toContain('risky');
    expect(calls).toHaveLength(0);

    // (3) Deny → the tools/call is dropped (never reaches the manager) and the
    // turn continues to a clean completion instead of hanging.
    await press(stdin, 'd');
    await waitForFrame(lastFrame, 'FINISHED');

    expect(calls).toHaveLength(0);
    expect(lastFrame() ?? '').not.toContain('permission required');

    unmount();
  });

  it('allow on the remember overlay executes the tools/call exactly once', async () => {
    const { manager, calls } = createFakeMcpManager();
    const client = createScriptedClient([
      toolUseTurn([
        { toolCallId: 'tc-remember', name: 'mcp__brain__remember', args: { text: 'a durable fact' } },
      ]),
      DONE_TURN,
    ]);
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    await startTurn('remember this');

    await waitForFrame(lastFrame, 'permission required');
    expect(calls).toHaveLength(0);

    // (4) Allow-once → the executor proceeds and dispatches the call to the manager.
    await press(stdin, 'y');
    await waitFor(() => calls.length > 0, { label: 'remember tools/call executed' });
    expect(calls).toEqual([{ server: 'brain', tool: 'remember', args: { text: 'a durable fact' } }]);

    await waitForFrame(lastFrame, 'FINISHED');
    expect(lastFrame() ?? '').not.toContain('permission required');

    unmount();
  });

  it('in one turn: recall auto-runs while remember is gated (safe vs risky contrast)', async () => {
    const { manager, calls } = createFakeMcpManager();
    const client = createScriptedClient([
      toolUseTurn([
        { toolCallId: 'tc-recall', name: 'mcp__brain__recall', args: { query: 'q' } },
        { toolCallId: 'tc-remember', name: 'mcp__brain__remember', args: { text: 't' } },
      ]),
      DONE_TURN,
    ]);
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, manager)} />);
    await flushInk();

    await startTurn('recall then remember');

    // The executor runs the calls in order: recall (auto-allowed) executes
    // unprompted, then remember (risky) parks the turn on the overlay.
    const overlay = await waitForFrame(lastFrame, 'permission required');
    expect(overlay).toContain('mcp__brain__remember');
    expect(calls).toEqual([{ server: 'brain', tool: 'recall', args: { query: 'q' } }]);

    // Allow the gated one; now both have executed and the turn completes.
    await press(stdin, 'y');
    await waitFor(() => calls.length === 2, { label: 'both tools executed' });
    expect(calls.map((call) => call.tool)).toEqual(['recall', 'remember']);
    await waitForFrame(lastFrame, 'FINISHED');

    unmount();
  });
});
