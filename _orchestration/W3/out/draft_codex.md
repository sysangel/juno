=== FILE: src/core/events.ts ===
```ts
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
export type RiskLevel = 'safe' | 'risky' | 'dangerous';
export type PermissionDecision =
  | 'allow-once'
  | 'deny'
  | 'always-allow-pattern'
  | 'dangerous-bypass';

export type AgentEvent =
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { type: 'assistant-done'; id: string; stopReason: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'error'; message: string };
```

=== FILE: src/core/reducer.ts ===
```ts
import type { PermissionDecision, RiskLevel, ToolStatus } from './events';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  toolSnapshot?: Record<string, State['tools'][string]>;
}

export interface ToolState {
  status: ToolStatus;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

export interface State {
  committed: Msg[];
  live: Msg | null;
  tools: Record<string, ToolState>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker';
  mode: 'normal' | 'plan' | 'ultracode';
  tokens: { in: number; out: number };

  // W3-proposed addition: needed to identify which tool call the permission overlay resolves.
  pendingPermissionToolCallId: string | null;
}

export type Action =
  | { t: 'user-submit'; id: string; text: string }
  | { t: 'assistant-start'; id: string }
  | { t: 'text-delta'; id: string; delta: string }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { t: 'assistant-done'; id: string; stopReason: string }
  | { t: 'usage'; tokensIn: number; tokensOut: number }
  | { t: 'set-mode'; mode: State['mode'] }
  | { t: 'cycle-mode' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'error'; message: string }
  | { t: 'clear' };

export function initialState(): State {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    mode: 'normal',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.t) {
    case 'user-submit': {
      const msg: Msg = {
        id: action.id,
        role: 'user',
        blocks: [{ kind: 'text', id: blockId(action.id, 0), text: action.text }],
        done: true,
      };

      return {
        ...state,
        committed: [...state.committed, msg],
        tokens: {
          ...state.tokens,
          in: state.tokens.in + estimateTokens(action.text),
        },
      };
    }

    case 'assistant-start':
      return {
        ...state,
        live: {
          id: action.id,
          role: 'assistant',
          blocks: [],
          done: false,
        },
        phase: 'streaming',
      };

    case 'text-delta': {
      if (state.live === null || state.live.id !== action.id) {
        return state;
      }

      const blocks = [...state.live.blocks];
      const last = blocks.at(-1);

      if (last?.kind === 'text') {
        blocks[blocks.length - 1] = { ...last, text: last.text + action.delta };
      } else {
        blocks.push({
          kind: 'text',
          id: blockId(state.live.id, blocks.length),
          text: action.delta,
        });
      }

      return {
        ...state,
        live: { ...state.live, blocks },
      };
    }

    case 'tool-call': {
      if (state.live === null) {
        return {
          ...state,
          tools: {
            ...state.tools,
            [action.toolCallId]: {
              status: 'pending',
              name: action.name,
              args: action.args,
            },
          },
        };
      }

      return {
        ...state,
        tools: {
          ...state.tools,
          [action.toolCallId]: {
            status: 'pending',
            name: action.name,
            args: action.args,
          },
        },
        live: {
          ...state.live,
          blocks: [
            ...state.live.blocks,
            {
              kind: 'tool',
              id: blockId(state.live.id, state.live.blocks.length),
              toolCallId: action.toolCallId,
            },
          ],
        },
      };
    }

    case 'tool-status': {
      const existing = state.tools[action.toolCallId];

      if (existing?.status === 'error' && action.status !== 'error') {
        return state;
      }

      const nextTool: ToolState = {
        status: action.status,
        name: existing?.name ?? action.toolCallId,
        args: existing?.args,
        result: action.result,
        error: action.error,
      };

      return {
        ...state,
        tools: {
          ...state.tools,
          [action.toolCallId]: nextTool,
        },
        phase:
          action.status === 'running'
            ? 'running-tool'
            : state.live !== null
              ? 'streaming'
              : 'idle',
      };
    }

    case 'permission-open':
      return {
        ...state,
        overlay: 'permission',
        phase: 'awaiting-permission',
        pendingPermissionToolCallId: action.toolCallId,
      };

    case 'permission-resolved':
      return {
        ...state,
        overlay: 'none',
        phase: state.live !== null ? 'streaming' : 'idle',
        pendingPermissionToolCallId: null,
      };

    case 'assistant-done': {
      if (state.live === null || state.live.id !== action.id) {
        return state;
      }

      const toolSnapshot = snapshotTools(state.live, state.tools);
      const doneMsg: Msg = {
        ...state.live,
        done: true,
        ...(Object.keys(toolSnapshot).length > 0 ? { toolSnapshot } : {}),
      };

      return {
        ...state,
        committed: [...state.committed, doneMsg],
        live: null,
        phase: 'idle',
      };
    }

    case 'usage':
      return {
        ...state,
        tokens: {
          in: state.tokens.in + action.tokensIn,
          out: state.tokens.out + action.tokensOut,
        },
      };

    case 'set-mode':
      return {
        ...state,
        mode: action.mode,
      };

    case 'cycle-mode':
      return {
        ...state,
        mode:
          state.mode === 'normal'
            ? 'plan'
            : state.mode === 'plan'
              ? 'ultracode'
              : 'normal',
      };

    case 'set-overlay':
      return {
        ...state,
        overlay: action.overlay,
        phase: phaseForOverlay(state, action.overlay),
      };

    case 'error': {
      const msg: Msg = {
        id: `system-error-${state.committed.length}`,
        role: 'system',
        blocks: [{ kind: 'text', id: blockId(`system-error-${state.committed.length}`, 0), text: action.message }],
        done: true,
      };

      return {
        ...state,
        committed: [...state.committed, msg],
        phase: 'error',
      };
    }

    case 'clear':
      return {
        ...initialState(),
        mode: state.mode,
        tokens: state.tokens,
      };
  }
}

function blockId(msgId: string, blockIndex: number): string {
  return `${msgId}:block:${blockIndex + 1}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function snapshotTools(msg: Msg, tools: State['tools']): Record<string, ToolState> {
  const snapshot: Record<string, ToolState> = {};

  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      const tool = tools[block.toolCallId];
      if (tool !== undefined) {
        snapshot[block.toolCallId] = { ...tool };
      }
    }
  }

  return snapshot;
}

function phaseForOverlay(state: State, overlay: State['overlay']): State['phase'] {
  if (overlay === 'permission') {
    return 'awaiting-permission';
  }

  if (state.phase === 'awaiting-permission') {
    return state.live !== null ? 'streaming' : 'idle';
  }

  return state.phase;
}
```

=== FILE: src/core/contracts.ts ===
```ts
import type { AgentEvent, PermissionDecision, RiskLevel } from './events';

export interface TurnInput {
  id: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  cwd?: string;
  model?: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface ToolResult {
  output: unknown;
}

export interface ModelClient {
  streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export interface Tool {
  name: string;
  risk: RiskLevel;
  spec: ToolSpec;
  run(args: unknown, ctx: ToolCtx): Promise<ToolResult>;
}

export interface ToolExecutor {
  execute(toolCallId: string, name: string, args: unknown, emit: (e: AgentEvent) => void): Promise<void>;
}

export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
}
```

=== FILE: src/core/fakeClient.ts ===
```ts
import type { AgentEvent } from './events';
import type { ModelClient, ToolSpec, TurnInput } from './contracts';

export class FakeModelClient implements ModelClient {
  async *streamTurn(_input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
    const events: AgentEvent[] = [
      { type: 'assistant-start', id: 'fake-assistant-1' },
      { type: 'text-delta', id: 'fake-assistant-1', delta: 'I will inspect the workspace ' },
      { type: 'text-delta', id: 'fake-assistant-1', delta: 'and prepare a deterministic response.' },
      {
        type: 'tool-call',
        id: 'fake-assistant-1',
        toolCallId: 'fake-tool-safe-1',
        name: 'read_context',
        args: { path: 'README.md' },
      },
      { type: 'tool-status', toolCallId: 'fake-tool-safe-1', status: 'running' },
      {
        type: 'tool-status',
        toolCallId: 'fake-tool-safe-1',
        status: 'result',
        result: { ok: true, summary: 'fake context loaded' },
      },
      { type: 'text-delta', id: 'fake-assistant-1', delta: ' Next I need permission for a risky action.' },
      {
        type: 'tool-call',
        id: 'fake-assistant-1',
        toolCallId: 'fake-tool-risky-1',
        name: 'write_file',
        args: { path: 'src/generated.txt', content: 'fake output' },
      },
      {
        type: 'permission-open',
        toolCallId: 'fake-tool-risky-1',
        name: 'write_file',
        args: { path: 'src/generated.txt', content: 'fake output' },
        risk: 'risky',
      },
      { type: 'tool-status', toolCallId: 'fake-tool-risky-1', status: 'running' },
      {
        type: 'tool-status',
        toolCallId: 'fake-tool-risky-1',
        status: 'result',
        result: { ok: true, skippedRealIo: true },
      },
      { type: 'usage', tokensIn: 12, tokensOut: 34 },
      { type: 'assistant-done', id: 'fake-assistant-1', stopReason: 'end' },
    ];

    for (const event of events) {
      if (signal.aborted) {
        return;
      }

      await delay(1);

      if (signal.aborted) {
        return;
      }

      yield event;
    }
  }
}

export function createFakeModelClient(): ModelClient {
  return new FakeModelClient();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
```

=== FILE: src/core/selectors.ts ===
```ts
import type { State } from './reducer';

export interface TokenBar {
  in: number;
  out: number;
  total: number;
}

export interface StatusLineState {
  model: string;
  cwd: string;
  tokens: TokenBar;
  mode: State['mode'];
  overlay: State['overlay'];
  phase: State['phase'];
}

export function selectTokenBar(state: State): TokenBar {
  return {
    in: state.tokens.in,
    out: state.tokens.out,
    total: state.tokens.in + state.tokens.out,
  };
}

export function selectStatusLine(
  state: State,
  context: { model?: string; cwd?: string } = {},
): StatusLineState {
  return {
    model: context.model ?? 'fake',
    cwd: context.cwd ?? '.',
    tokens: selectTokenBar(state),
    mode: state.mode,
    overlay: state.overlay,
    phase: state.phase,
  };
}

export function selectCurrentOverlay(state: State): State['overlay'] {
  return state.overlay;
}

export function selectCurrentMode(state: State): State['mode'] {
  return state.mode;
}
```

=== FILE: tests/reducer.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import { initialState, reducer, type State } from '../src/core/reducer';

describe('reducer', () => {
  it('creates the initial state', () => {
    expect(initialState()).toEqual({
      committed: [],
      live: null,
      tools: {},
      phase: 'idle',
      overlay: 'none',
      mode: 'normal',
      tokens: { in: 0, out: 0 },
      pendingPermissionToolCallId: null,
    });
  });

  it('commits user-submit and estimates input tokens', () => {
    const state = reducer(initialState(), { t: 'user-submit', id: 'u1', text: 'hello world' });

    expect(state.committed).toEqual([
      {
        id: 'u1',
        role: 'user',
        blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello world' }],
        done: true,
      },
    ]);
    expect(state.tokens.in).toBe(3);
  });

  it('starts an assistant turn', () => {
    const state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });

    expect(state.live).toEqual({ id: 'a1', role: 'assistant', blocks: [], done: false });
    expect(state.phase).toBe('streaming');
  });

  it('appends text deltas to the same text block id', () => {
    const started = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    const first = reducer(started, { t: 'text-delta', id: 'a1', delta: 'hello' });
    const second = reducer(first, { t: 'text-delta', id: 'a1', delta: ' world' });

    expect(second.live?.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'hello world' }]);
  });

  it('ignores text deltas when the live id does not match', () => {
    const started = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    const next = reducer(started, { t: 'text-delta', id: 'other', delta: 'ignored' });

    expect(next).toBe(started);
  });

  it('records a tool call and splits later text into a new block', () => {
    let state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    state = reducer(state, { t: 'text-delta', id: 'a1', delta: 'before' });
    state = reducer(state, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: { path: 'x' } });
    state = reducer(state, { t: 'text-delta', id: 'a1', delta: 'after' });

    expect(state.tools.tc1).toEqual({ status: 'pending', name: 'read', args: { path: 'x' } });
    expect(state.live?.blocks).toEqual([
      { kind: 'text', id: 'a1:block:1', text: 'before' },
      { kind: 'tool', id: 'a1:block:2', toolCallId: 'tc1' },
      { kind: 'text', id: 'a1:block:3', text: 'after' },
    ]);
  });

  it('records a tool call even when no live message exists', () => {
    const state = reducer(initialState(), {
      t: 'tool-call',
      toolCallId: 'tc1',
      name: 'read',
      args: { path: 'x' },
    });

    expect(state.tools.tc1).toEqual({ status: 'pending', name: 'read', args: { path: 'x' } });
    expect(state.live).toBeNull();
  });

  it('updates tool status and phase', () => {
    let state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    state = reducer(state, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });

    const running = reducer(state, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(running.tools.tc1.status).toBe('running');
    expect(running.phase).toBe('running-tool');

    const result = reducer(running, {
      t: 'tool-status',
      toolCallId: 'tc1',
      status: 'result',
      result: { ok: true },
    });
    expect(result.tools.tc1).toEqual({ status: 'result', name: 'read', args: {}, result: { ok: true } });
    expect(result.phase).toBe('streaming');
  });

  it('does not clobber an errored tool with a late non-error status', () => {
    let state = reducer(initialState(), { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });
    state = reducer(state, { t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'failed' });

    const late = reducer(state, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'late' });

    expect(late).toBe(state);
    expect(late.tools.tc1).toEqual({ status: 'error', name: 'read', args: {}, error: 'failed' });
  });

  it('tracks permission-open and permission-resolved overlay transitions', () => {
    let state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });

    state = reducer(state, {
      t: 'permission-open',
      toolCallId: 'tc1',
      name: 'write',
      args: { path: 'x' },
      risk: 'risky',
    });

    expect(state.overlay).toBe('permission');
    expect(state.phase).toBe('awaiting-permission');
    expect(state.pendingPermissionToolCallId).toBe('tc1');

    state = reducer(state, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'allow-once' });

    expect(state.overlay).toBe('none');
    expect(state.phase).toBe('streaming');
    expect(state.pendingPermissionToolCallId).toBeNull();
  });

  it('returns to idle on permission-resolved without a live turn', () => {
    let state = reducer(initialState(), {
      t: 'permission-open',
      toolCallId: 'tc1',
      name: 'write',
      args: {},
      risk: 'risky',
    });

    state = reducer(state, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });

    expect(state.phase).toBe('idle');
    expect(state.overlay).toBe('none');
  });

  it('commits assistant-done with a tool snapshot and clears live', () => {
    let state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    state = reducer(state, { t: 'text-delta', id: 'a1', delta: 'before' });
    state = reducer(state, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });
    state = reducer(state, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'ok' });

    const done = reducer(state, { t: 'assistant-done', id: 'a1', stopReason: 'end' });

    expect(done.live).toBeNull();
    expect(done.phase).toBe('idle');
    expect(done.committed).toHaveLength(1);
    expect(done.committed[0]?.done).toBe(true);
    expect(done.committed[0]?.toolSnapshot).toEqual({
      tc1: { status: 'result', name: 'read', args: {}, result: 'ok' },
    });
  });

  it('ignores assistant-done when ids do not match', () => {
    const state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    const next = reducer(state, { t: 'assistant-done', id: 'other', stopReason: 'end' });

    expect(next).toBe(state);
  });

  it('adds usage tokens', () => {
    const state = reducer(initialState(), { t: 'usage', tokensIn: 10, tokensOut: 20 });

    expect(state.tokens).toEqual({ in: 10, out: 20 });
  });

  it('sets and cycles modes', () => {
    let state = reducer(initialState(), { t: 'set-mode', mode: 'plan' });
    expect(state.mode).toBe('plan');

    state = reducer(state, { t: 'cycle-mode' });
    expect(state.mode).toBe('ultracode');

    state = reducer(state, { t: 'cycle-mode' });
    expect(state.mode).toBe('normal');

    state = reducer(state, { t: 'cycle-mode' });
    expect(state.mode).toBe('plan');
  });

  it('sets overlays and keeps permission phase consistent', () => {
    let state = reducer(initialState(), { t: 'assistant-start', id: 'a1' });

    state = reducer(state, { t: 'set-overlay', overlay: 'slash' });
    expect(state.overlay).toBe('slash');
    expect(state.phase).toBe('streaming');

    state = reducer(state, { t: 'set-overlay', overlay: 'permission' });
    expect(state.overlay).toBe('permission');
    expect(state.phase).toBe('awaiting-permission');

    state = reducer(state, { t: 'set-overlay', overlay: 'none' });
    expect(state.overlay).toBe('none');
    expect(state.phase).toBe('streaming');
  });

  it('surfaces errors as committed system messages', () => {
    const state = reducer(initialState(), { t: 'error', message: 'boom' });

    expect(state.phase).toBe('error');
    expect(state.committed).toEqual([
      {
        id: 'system-error-0',
        role: 'system',
        blocks: [{ kind: 'text', id: 'system-error-0:block:1', text: 'boom' }],
        done: true,
      },
    ]);
  });

  it('clears transient turn state while preserving mode and tokens', () => {
    let state = reducer(initialState(), { t: 'set-mode', mode: 'ultracode' });
    state = reducer(state, { t: 'usage', tokensIn: 1, tokensOut: 2 });
    state = reducer(state, { t: 'user-submit', id: 'u1', text: 'hello' });
    state = reducer(state, { t: 'assistant-start', id: 'a1' });
    state = reducer(state, { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} });
    state = reducer(state, {
      t: 'permission-open',
      toolCallId: 'tc1',
      name: 'read',
      args: {},
      risk: 'risky',
    });

    const cleared = reducer(state, { t: 'clear' });

    expect(cleared).toEqual({
      ...initialState(),
      mode: 'ultracode',
      tokens: state.tokens,
    });
  });

  it('does not mutate the input state object', () => {
    const original: State = reducer(initialState(), { t: 'assistant-start', id: 'a1' });
    const frozen = deepFreeze(original);
    const next = reducer(frozen, { t: 'text-delta', id: 'a1', delta: 'hello' });

    expect(next).not.toBe(original);
    expect(original.live?.blocks).toEqual([]);
    expect(next.live?.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'hello' }]);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }

  return value;
}
```

=== NOTES ===

Proposed additions: `State.pendingPermissionToolCallId` is added so W4 can render and resolve the active permission prompt deterministically. `TurnInput`, `ToolSpec`, `ToolCtx`, and `ToolResult` are minimal W3-proposed interfaces for W6-W9. `selectors.ts` is also proposed for W4 StatusLine derived state.

The reducer is pure: block ids are derived from message id plus append index, errors become committed system messages, and `clear` resets transient conversation state while preserving mode and token counters. User input token counting uses the proposed deterministic `Math.ceil(text.length / 4)` estimate.

`FakeModelClient` emits normalized `AgentEvent`s only, uses fixed ids and delays, honors `AbortSignal`, and performs no real I/O.