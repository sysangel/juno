=== FILE: src/core/events.ts ===
```ts
// src/core/events.ts
// W3 — the normalized AgentEvent discriminated union + shared enums.
// FROZEN seam: every LLM adapter (W9) yields ONLY these shapes.
// Do NOT add provider-specific fields here.

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

/** Map an AgentEvent to the matching reducer Action (1:1 for event variants). */
export function eventToAction(e: AgentEvent): import('./reducer.js').Action {
  switch (e.type) {
    case 'assistant-start': return { t: 'assistant-start', id: e.id };
    case 'text-delta': return { t: 'text-delta', id: e.id, delta: e.delta };
    case 'tool-call': return { t: 'tool-call', toolCallId: e.toolCallId, name: e.name, args: e.args };
    case 'tool-status': return { t: 'tool-status', toolCallId: e.toolCallId, status: e.status, result: e.result, error: e.error };
    case 'permission-open': return { t: 'permission-open', toolCallId: e.toolCallId, name: e.name, args: e.args, risk: e.risk };
    case 'permission-resolved': return { t: 'permission-resolved', toolCallId: e.toolCallId, decision: e.decision };
    case 'assistant-done': return { t: 'assistant-done', id: e.id, stopReason: e.stopReason };
    case 'usage': return { t: 'usage', tokensIn: e.tokensIn, tokensOut: e.tokensOut };
    case 'error': return { t: 'error', message: e.message };
  }
}
```

=== FILE: src/core/reducer.ts ===
```ts
// src/core/reducer.ts
// W3 — the single PURE reducer. Every other unit builds against State/Action/Msg.
import type { ToolStatus, RiskLevel, PermissionDecision } from './events.js';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  /** Frozen snapshot of every tool call this message references; set ONLY at commit time. */
  toolSnapshot?: Record<string, State['tools'][string]>;
}

export interface State {
  committed: Msg[];
  live: Msg | null;
  tools: Record<string, { status: ToolStatus; name: string; args: unknown; result?: unknown; error?: string }>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker';
  mode: 'normal' | 'plan' | 'ultracode';
  tokens: { in: number; out: number };
  // --- PROPOSED additions to the frozen shape (flagged in NOTES) ---
  pendingPermissionToolCallId: string | null;
  blockSeq: number;                 // monotonic block id source (never random, never render index)
  errorMessage: string | null;      // surfaced error text for phase==='error'
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
    blockSeq: 0,
    errorMessage: null,
  };
}

const MODE_ORDER: State['mode'][] = ['normal', 'plan', 'ultracode'];

function nextBlockId(state: State): string {
  return `b${state.blockSeq}`;
}

/** PURE reducer. Never mutates inputs; returns a new State (or the same ref for no-ops). */
export function reducer(state: State, action: Action): State {
  switch (action.t) {
    case 'user-submit': {
      const bid = nextBlockId(state);
      const msg: Msg = {
        id: action.id,
        role: 'user',
        blocks: [{ kind: 'text', id: bid, text: action.text }],
        done: true,
      };
      // PROPOSED: deterministic token estimate (Math.ceil(len/4)).
      const estIn = Math.ceil(action.text.length / 4);
      return {
        ...state,
        committed: [...state.committed, msg],
        blockSeq: state.blockSeq + 1,
        tokens: { ...state.tokens, in: state.tokens.in + estIn },
      };
    }

    case 'assistant-start': {
      const live: Msg = { id: action.id, role: 'assistant', blocks: [], done: false };
      return { ...state, live, phase: 'streaming' };
    }

    case 'text-delta': {
      const live = state.live;
      if (!live || live.id !== action.id) return state;
      const blocks = live.blocks.slice();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'text') {
        blocks[blocks.length - 1] = { ...last, text: last.text + action.delta };
        return { ...state, live: { ...live, blocks } };
      }
      const bid = nextBlockId(state);
      blocks.push({ kind: 'text', id: bid, text: action.delta });
      return { ...state, live: { ...live, blocks }, blockSeq: state.blockSeq + 1 };
    }

    case 'tool-call': {
      const live = state.live;
      if (!live) return state;
      const tools: State['tools'] = {
        ...state.tools,
        [action.toolCallId]: { status: 'pending', name: action.name, args: action.args },
      };
      const bid = nextBlockId(state);
      const blocks = live.blocks.slice();
      blocks.push({ kind: 'tool', id: bid, toolCallId: action.toolCallId });
      return {
        ...state,
        tools,
        live: { ...live, blocks },
        blockSeq: state.blockSeq + 1,
      };
    }

    case 'tool-status': {
      const existing = state.tools[action.toolCallId];
      if (!existing) return state;
      // Race guard: once 'error', a later non-error status must NOT clobber.
      if (existing.status === 'error' && action.status !== 'error') return state;
      const updated: State['tools'][string] = {
        ...existing,
        status: action.status,
        ...(action.result !== undefined ? { result: action.result } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
      const tools = { ...state.tools, [action.toolCallId]: updated };
      let phase = state.phase;
      if (action.status === 'running') phase = 'running-tool';
      else if (action.status === 'result' || action.status === 'error') {
        phase = state.live ? 'streaming' : 'idle';
      }
      return { ...state, tools, phase };
    }

    case 'permission-open': {
      // Ensure a tools entry exists (tool-call normally precedes, but be defensive).
      const tools: State['tools'] = state.tools[action.toolCallId]
        ? state.tools
        : { ...state.tools, [action.toolCallId]: { status: 'pending', name: action.name, args: action.args } };
      return {
        ...state,
        tools,
        overlay: 'permission',
        phase: 'awaiting-permission',
        pendingPermissionToolCallId: action.toolCallId,
      };
    }

    case 'permission-resolved': {
      return {
        ...state,
        overlay: 'none',
        phase: state.live ? 'streaming' : 'idle',
        pendingPermissionToolCallId: null,
      };
    }

    case 'assistant-done': {
      const live = state.live;
      if (!live || live.id !== action.id) return state;
      // Build frozen toolSnapshot from the live tool blocks.
      const toolSnapshot: Record<string, State['tools'][string]> = {};
      for (const b of live.blocks) {
        if (b.kind === 'tool') {
          const snap = state.tools[b.toolCallId];
          if (snap) toolSnapshot[b.toolCallId] = { ...snap };
        }
      }
      const committedMsg: Msg = { ...live, done: true, toolSnapshot };
      return {
        ...state,
        committed: [...state.committed, committedMsg],
        live: null,
        phase: 'idle',
      };
    }

    case 'usage': {
      return {
        ...state,
        tokens: {
          in: state.tokens.in + action.tokensIn,
          out: state.tokens.out + action.tokensOut,
        },
      };
    }

    case 'set-mode': {
      return { ...state, mode: action.mode };
    }

    case 'cycle-mode': {
      const idx = MODE_ORDER.indexOf(state.mode);
      const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
      return { ...state, mode: next };
    }

    case 'set-overlay': {
      let phase = state.phase;
      // Keep phase consistent: opening permission overlay implies awaiting.
      if (action.overlay === 'permission' && state.phase !== 'error') phase = 'awaiting-permission';
      else if (action.overlay === 'none' && phase === 'awaiting-permission') {
        phase = state.live ? 'streaming' : 'idle';
      }
      return { ...state, overlay: action.overlay, phase };
    }

    case 'error': {
      // PROPOSED: surface errors as a committed system Msg + errorMessage field.
      const bid = nextBlockId(state);
      const msg: Msg = {
        id: `err-${bid}`,
        role: 'system',
        blocks: [{ kind: 'text', id: bid, text: action.message }],
        done: true,
      };
      return {
        ...state,
        committed: [...state.committed, msg],
        phase: 'error',
        errorMessage: action.message,
        blockSeq: state.blockSeq + 1,
      };
    }

    case 'clear': {
      // Reset conversation/turn state; preserve user prefs (mode) and cumulative tokens.
      return {
        ...initialState(),
        mode: state.mode,
        tokens: state.tokens,
      };
    }

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
```

=== FILE: src/core/contracts.ts ===
```ts
// src/core/contracts.ts
// W3 — interfaces ONLY. Implemented by W7 (tools), W8 (permissions), W9 (LLM adapters).
import type { AgentEvent, RiskLevel, PermissionDecision } from './events.js';

/**
 * PROPOSED (W3): minimal input to a model turn. W9 adapters may extend their
 * own internal types but must accept this shape (or a superset) from the coordinator.
 */
export interface TurnInput {
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  model: string;
  mode?: 'normal' | 'plan' | 'ultracode';
  systemPrompt?: string;
}

/**
 * PROPOSED (W3): the tool description handed to the model. `schema` is a JSON Schema
 * object describing args; kept as `unknown` so W7 can use its preferred schema lib.
 */
export interface ToolSpec {
  name: string;
  description: string;
  schema: unknown;
}

/** PROPOSED (W3): runtime context passed into Tool.run. */
export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  /** Read-only view of the current reducer state for tools that need it. */
  state: import('./reducer.js').State;
}

/** PROPOSED (W3): normalized tool execution result. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** LLM adapter contract (W9 implements). Yields ONLY normalized AgentEvents. */
export interface ModelClient {
  streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/** A single tool definition (W7 implements). */
export interface Tool {
  name: string;
  risk: RiskLevel;
  spec: ToolSpec;
  run(args: unknown, ctx: ToolCtx): Promise<ToolResult>;
}

/** Drives a tool call lifecycle, emitting AgentEvents (W7 implements). */
export interface ToolExecutor {
  execute(
    toolCallId: string,
    name: string,
    args: unknown,
    emit: (e: AgentEvent) => void,
  ): Promise<void>;
}

/** Permission gate (W8 implements). Pure-ish policy with a memory side-effect. */
export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
}
```

=== FILE: src/core/fakeClient.ts ===
```ts
// src/core/fakeClient.ts
// W3 — deterministic fake ModelClient. No keys, no network, no filesystem, no randomness.
// Yields a FIXED byte-reproducible AgentEvent script so W4/W6/W13 can run with no providers.
import type { AgentEvent } from './events.js';
import type { ModelClient, TurnInput, ToolSpec } from './contracts.js';

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Factory: returns a ModelClient whose streamTurn emits a fixed script:
 *   assistant-start → text-deltas → non-gated tool (running→result)
 *   → text-delta → gated tool (permission-open) → tool-status(running→result)
 *   → usage → assistant-done(end)
 *
 * `permission-resolved` is the coordinator's responsibility (W6), NOT emitted here.
 */
export function createFakeClient(opts: { tickMs?: number } = {}): ModelClient {
  const tick = opts.tickMs ?? 5;
  return {
    async *streamTurn(_input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      const id = 'fake-turn-1';
      const emit = async (e: AgentEvent) => { await delay(tick, signal); return e; };

      yield await emit({ type: 'assistant-start', id });
      if (signal.aborted) return;

      yield await emit({ type: 'text-delta', id, delta: 'Hello ' });
      if (signal.aborted) return;
      yield await emit({ type: 'text-delta', id, delta: 'from ' });
      if (signal.aborted) return;
      yield await emit({ type: 'text-delta', id, delta: 'Juno.' });
      if (signal.aborted) return;

      // Non-gated tool: list_files (safe).
      yield await emit({ type: 'tool-call', id, toolCallId: 'tc-1', name: 'list_files', args: { dir: '.' } });
      if (signal.aborted) return;
      yield await emit({ type: 'tool-status', toolCallId: 'tc-1', status: 'running' });
      if (signal.aborted) return;
      yield await emit({ type: 'tool-status', toolCallId: 'tc-1', status: 'result', result: ['a.txt', 'b.txt'] });
      if (signal.aborted) return;

      yield await emit({ type: 'text-delta', id, delta: ' Now a gated tool.' });
      if (signal.aborted) return;

      // Gated tool: write_file (risky). Coordinator resolves permission externally.
      yield await emit({ type: 'tool-call', id, toolCallId: 'tc-2', name: 'write_file', args: { path: 'x.txt', content: 'hi' } });
      if (signal.aborted) return;
      yield await emit({ type: 'permission-open', toolCallId: 'tc-2', name: 'write_file', args: { path: 'x.txt', content: 'hi' }, risk: 'risky' });
      if (signal.aborted) return;
      // Fake proceeds as if permission was granted (coordinator drives the real round-trip).
      yield await emit({ type: 'tool-status', toolCallId: 'tc-2', status: 'running' });
      if (signal.aborted) return;
      yield await emit({ type: 'tool-status', toolCallId: 'tc-2', status: 'result', result: 'ok' });
      if (signal.aborted) return;

      yield await emit({ type: 'usage', tokensIn: 120, tokensOut: 48 });
      if (signal.aborted) return;
      yield await emit({ type: 'assistant-done', id, stopReason: 'end' });
    },
  };
}

/** Convenience class form, in case W6 prefers `new FakeModelClient()`. */
export class FakeModelClient implements ModelClient {
  private inner: ModelClient;
  constructor(opts?: { tickMs?: number }) { this.inner = createFakeClient(opts); }
  streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.inner.streamTurn(input, tools, signal);
  }
}
```

=== FILE: src/core/selectors.ts ===
```ts
// src/core/selectors.ts
// W3 PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No imports of React/Ink; pure functions over State.
import type { State } from './reducer.js';

export function selectModel(_state: State): string {
  // PROPOSED: model name lives on a future config slice; placeholder until W2/W4 wires it.
  return 'juno-default';
}

export function selectCwd(_state: State): string {
  // PROPOSED: cwd is a runtime/config concern; UI can override. Placeholder.
  return process.cwd();
}

export function selectTokens(state: State): { in: number; out: number } {
  return state.tokens;
}

/** PROPOSED: context-bar fraction. Denominator is a placeholder until config provides max. */
export function selectContextFraction(state: State, max = 128000): number {
  const used = state.tokens.in + state.tokens.out;
  return Math.min(1, used / max);
}

export function selectMode(state: State): State['mode'] {
  return state.mode;
}

export function selectOverlay(state: State): State['overlay'] {
  return state.overlay;
}

export function selectPhase(state: State): State['phase'] {
  return state.phase;
}

export function selectPendingPermission(state: State): string | null {
  return state.pendingPermissionToolCallId;
}

export function selectStatusText(state: State): string {
  switch (state.phase) {
    case 'idle': return 'idle';
    case 'streaming': return 'thinking…';
    case 'awaiting-permission': return 'awaiting permission';
    case 'running-tool': return 'running tool…';
    case 'error': return state.errorMessage ?? 'error';
  }
}
```

=== FILE: tests/reducer.test.ts ===
```ts
// tests/reducer.test.ts
import { describe, it, expect } from 'vitest';
import { reducer, initialState, type State, type Action } from '../src/core/reducer';

function step(state: State, action: Action): State {
  return reducer(state, action);
}

function streamingState(): State {
  let s = initialState();
  s = step(s, { t: 'user-submit', id: 'u1', text: 'hello world' });
  s = step(s, { t: 'assistant-start', id: 'a1' });
  return s;
}

describe('reducer — initialState', () => {
  it('has sane defaults', () => {
    const s = initialState();
    expect(s.committed).toEqual([]);
    expect(s.live).toBeNull();
    expect(s.tools).toEqual({});
    expect(s.phase).toBe('idle');
    expect(s.overlay).toBe('none');
    expect(s.mode).toBe('normal');
    expect(s.tokens).toEqual({ in: 0, out: 0 });
    expect(s.pendingPermissionToolCallId).toBeNull();
    expect(s.blockSeq).toBe(0);
  });
});

describe('reducer — user-submit', () => {
  it('commits a user msg with a single text block and estimates tokens.in', () => {
    const s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hello world' });
    expect(s.committed).toHaveLength(1);
    expect(s.committed[0].role).toBe('user');
    expect(s.committed[0].blocks).toEqual([{ kind: 'text', id: 'b0', text: 'hello world' }]);
    expect(s.committed[0].done).toBe(true);
    // Math.ceil(11/4) = 3
    expect(s.tokens.in).toBe(3);
    expect(s.blockSeq).toBe(1);
  });
});

describe('reducer — assistant-start', () => {
  it('creates a fresh empty live assistant msg and sets streaming', () => {
    const s = step(initialState(), { t: 'assistant-start', id: 'a1' });
    expect(s.live).toEqual({ id: 'a1', role: 'assistant', blocks: [], done: false });
    expect(s.phase).toBe('streaming');
  });
});

describe('reducer — text-delta', () => {
  it('appends to the trailing text block keeping the same block id', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'foo ' });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'bar' });
    expect(s.live!.blocks).toEqual([{ kind: 'text', id: 'b1', text: 'foo bar' }]);
  });

  it('creates a new text block when a tool block splits text', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'before' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'after' });
    expect(s.live!.blocks).toHaveLength(3);
    expect(s.live!.blocks[0]).toEqual({ kind: 'text', id: 'b1', text: 'before' });
    expect(s.live!.blocks[1]).toEqual({ kind: 'tool', id: 'b2', toolCallId: 'tc1' });
    expect(s.live!.blocks[2]).toEqual({ kind: 'text', id: 'b3', text: 'after' });
  });

  it('ignores deltas with no live msg or id mismatch', () => {
    const s = initialState();
    const s2 = step(s, { t: 'text-delta', id: 'a1', delta: 'x' });
    expect(s2).toBe(s);
  });
});

describe('reducer — tool-call', () => {
  it('creates a pending tools entry and pushes a tool block', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: { dir: '.' } });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'list_files', args: { dir: '.' } });
    expect(s.live!.blocks.at(-1)).toEqual({ kind: 'tool', id: 'b1', toolCallId: 'tc1' });
  });
});

describe('reducer — tool-status', () => {
  it('transitions pending→running→result and flips phase', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(s.tools['tc1'].status).toBe('running');
    expect(s.phase).toBe('running-tool');
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 42 });
    expect(s.tools['tc1'].status).toBe('result');
    expect(s.tools['tc1'].result).toBe(42);
    expect(s.phase).toBe('streaming');
  });

  it('race guard: error is not clobbered by a late result', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'boom' });
    expect(s.tools['tc1'].status).toBe('error');
    const before = s;
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'late' });
    expect(s).toBe(before); // no-op
    expect(s.tools['tc1'].status).toBe('error');
    expect(s.tools['tc1'].result).toBeUndefined();
  });

  it('ignores status for unknown toolCallId', () => {
    const s = streamingState();
    const s2 = step(s, { t: 'tool-status', toolCallId: 'nope', status: 'running' });
    expect(s2).toBe(s);
  });
});

describe('reducer — permission-open / permission-resolved', () => {
  it('opens the permission overlay and awaits, then resolves back to streaming', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc2', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc2', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.overlay).toBe('permission');
    expect(s.phase).toBe('awaiting-permission');
    expect(s.pendingPermissionToolCallId).toBe('tc2');
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc2', decision: 'allow-once' });
    expect(s.overlay).toBe('none');
    expect(s.phase).toBe('streaming');
    expect(s.pendingPermissionToolCallId).toBeNull();
  });

  it('permission-resolved without live msg goes to idle', () => {
    let s = initialState();
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'n', args: {}, risk: 'risky' });
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });
    expect(s.phase).toBe('idle');
  });
});

describe('reducer — assistant-done', () => {
  it('commits live with a toolSnapshot and clears live', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: ['a'] });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.live).toBeNull();
    expect(s.phase).toBe('idle');
    expect(s.committed.at(-1)!.done).toBe(true);
    expect(s.committed.at(-1)!.toolSnapshot).toBeDefined();
    expect(s.committed.at(-1)!.toolSnapshot!['tc1']).toEqual({
      status: 'result', name: 'list_files', args: {}, result: ['a'],
    });
  });

  it('no-op when no live msg or id mismatch', () => {
    const s = initialState();
    const s2 = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s2).toBe(s);
  });
});

describe('reducer — usage', () => {
  it('accumulates tokens', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 10, tokensOut: 5 });
    s = step(s, { t: 'usage', tokensIn: 3, tokensOut: 7 });
    expect(s.tokens).toEqual({ in: 13, out: 12 });
  });
});

describe('reducer — set-mode / cycle-mode', () => {
  it('set-mode sets the mode', () => {
    const s = step(initialState(), { t: 'set-mode', mode: 'plan' });
    expect(s.mode).toBe('plan');
  });

  it('cycle-mode cycles normal→plan→ultracode→normal', () => {
    let s = initialState();
    s = step(s, { t: 'cycle-mode' }); expect(s.mode).toBe('plan');
    s = step(s, { t: 'cycle-mode' }); expect(s.mode).toBe('ultracode');
    s = step(s, { t: 'cycle-mode' }); expect(s.mode).toBe('normal');
  });
});

describe('reducer — set-overlay', () => {
  it('sets the overlay', () => {
    const s = step(initialState(), { t: 'set-overlay', overlay: 'slash' });
    expect(s.overlay).toBe('slash');
  });

  it('clearing permission overlay restores phase', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'permission' });
    expect(s.phase).toBe('awaiting-permission');
    s = step(s, { t: 'set-overlay', overlay: 'none' });
    expect(s.phase).toBe('streaming');
  });
});

describe('reducer — error', () => {
  it('sets phase=error, commits a system msg, stores errorMessage', () => {
    const s = step(initialState(), { t: 'error', message: 'kaboom' });
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('kaboom');
    expect(s.committed.at(-1)!.role).toBe('system');
    expect(s.committed.at(-1)!.blocks[0]).toMatchObject({ kind: 'text', text: 'kaboom' });
  });
});

describe('reducer — clear', () => {
  it('resets conversation/turn state but preserves mode and tokens', () => {
    let s = streamingState();
    s = step(s, { t: 'usage', tokensIn: 100, tokensOut: 50 });
    s = step(s, { t: 'set-mode', mode: 'plan' });
    s = step(s, { t: 'error', message: 'x' });
    s = step(s, { t: 'clear' });
    expect(s.committed).toEqual([]);
    expect(s.live).toBeNull();
    expect(s.tools).toEqual({});
    expect(s.overlay).toBe('none');
    expect(s.phase).toBe('idle');
    expect(s.pendingPermissionToolCallId).toBeNull();
    expect(s.errorMessage).toBeNull();
    expect(s.mode).toBe('plan');      // preserved
    expect(s.tokens).toEqual({ in: 100 + 3, out: 50 }); // preserved (3 from user-submit)
  });
});

describe('reducer — purity / immutability', () => {
  it('never mutates the input state', () => {
    let s = initialState();
    // Deep-freeze a snapshot we feed in for a representative sequence.
    const actions: Action[] = [
      { t: 'user-submit', id: 'u1', text: 'hi' },
      { t: 'assistant-start', id: 'a1' },
      { t: 'text-delta', id: 'a1', delta: 'x' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} },
      { t: 'tool-status', toolCallId: 'tc1', status: 'running' },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 },
      { t: 'assistant-done', id: 'a1', stopReason: 'end' },
      { t: 'usage', tokensIn: 1, tokensOut: 1 },
      { t: 'cycle-mode' },
      { t: 'clear' },
    ];
    for (const a of actions) {
      const frozen = JSON.parse(JSON.stringify(s)) as State;
      const next = step(s, a);
      // Input must be unchanged.
      expect(JSON.parse(JSON.stringify(s))).toEqual(frozen);
      // Returned object must be a new reference when state changes (not the same).
      if (JSON.stringify(next) !== JSON.stringify(s)) {
        expect(next).not.toBe(s);
      }
      s = next;
    }
  });

  it('works with Object.freeze inputs without throwing', () => {
    const s = Object.freeze(initialState()) as State;
    const s2 = step(s, { t: 'user-submit', id: 'u1', text: 'hi' });
    expect(s2.committed).toHaveLength(1);
  });
});
```

=== NOTES ===
**Proposed additions to the frozen State shape** (flagged for team ratification): `pendingPermissionToolCallId: string | null`, `blockSeq: number` (monotonic block-id source — never random, never a render index), and `errorMessage: string | null`. The reducer surfaces errors as a committed `system` Msg plus `errorMessage`; alternative would be a dedicated field without a Msg — chose Msg so `<Static>` renders them for free.

**Token estimate** on `user-submit` is `Math.ceil(len/4)` — a placeholder until W9 reports real usage; flagged as proposed.

**`clear`** preserves `mode` (user preference) and cumulative `tokens`; resets everything else. Flag if the team prefers a hard reset.

**Contracts**: `TurnInput`/`ToolSpec`/`ToolCtx`/`ToolResult` are W3-proposed minimal shapes; W7/W9 may extend internally but must accept these. `ToolCtx` carries a read-only `State` view so tools can inspect without importing the reducer mutator.

**Seam exposed**: W4 consumes `State` + `selectors.ts` (proposed); W6 maps `AgentEvent→Action` via `eventToAction` and drives `ModelClient`/`ToolExecutor`/`PermissionPolicy`; W7 emits `tool-call`→`tool-status`; W8 implements `PermissionPolicy`; W9 yields only `AgentEvent`. `fakeClient.ts` unlocks W4/W6/W13 with zero providers.

**Purity**: reducer never mutates inputs, uses no `Date.now`/`Math.random`/I/O; all arrays/objects are shallow-copied on change.
