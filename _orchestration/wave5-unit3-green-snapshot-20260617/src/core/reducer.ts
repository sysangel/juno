// src/core/reducer.ts
// W3 — the single PURE reducer. Every other unit builds against State/Action/Msg.
//
// Purity contract: no I/O, no Date.now, no Math.random, never mutates its inputs.
// On a no-op it returns the SAME state reference (consumers may rely on `===`).
import type { PermissionDecision, RiskLevel, StopReason, ToolStatus } from './events';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

/**
 * Append-only message blocks with stable, monotonic block ids derived from the
 * owning message id + append index (`<msgId>:block:<n>`). Never a render index,
 * never Math.random — so React keys stay stable across redraws.
 */
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

/** A single tool call's accumulated state in the live `tools` map. */
export interface ToolState {
  status: ToolStatus;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  /**
   * Partial tool-arg JSON accumulated from `tool-call-delta` events while the
   * model streams arguments. The final, parsed `args` arrive on `tool-call`.
   */
  argsText?: string;
  /**
   * For a claude-cli subagent's tool call: the parent `Agent` tool_use id this
   * call was spawned under (`parent_tool_use_id` in the CLI stream). Drives
   * nested rendering — the renderer groups child cards beneath the parent whose
   * `toolCallId` equals this value. Absent for top-level (non-subagent) calls.
   */
  parentToolUseId?: string;
}

export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  /**
   * Accumulated extended-thinking / reasoning text for this message, built from
   * `reasoning-delta` events. Kept off the block list (it renders separately,
   * collapsed by default). Absent until the first reasoning delta arrives.
   */
  reasoning?: string;
  /**
   * Frozen snapshot of every tool call this message references, set ONLY at
   * commit time (`assistant-done`) so the <Static> committed render path never
   * reads the live `tools` map.
   */
  toolSnapshot?: Record<string, ToolState>;
}

export interface State {
  committed: Msg[];                 // -> Ink <Static>, printed once, never redrawn
  live: Msg | null;                 // the current streaming assistant turn
  tools: Record<string, ToolState>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker';
  effort: 'medium' | 'high' | 'xhigh';
  tokens: { in: number; out: number };

  // --- W3-PROPOSED additions to the frozen shape (flagged in NOTES) ---
  /** The tool call the permission overlay is resolving; null when no prompt is open. */
  pendingPermissionToolCallId: string | null;
  /** Surfaced error text for `phase === 'error'`; null otherwise. */
  errorMessage: string | null;
}

/**
 * Action variants map 1:1 to AgentEvent variants, PLUS local UI actions
 * (`user-submit`, `set-effort`, `cycle-effort`, `set-overlay`, `clear`).
 */
export type Action =
  | { t: 'user-submit'; id: string; text: string }
  | { t: 'assistant-start'; id: string }
  | { t: 'text-delta'; id: string; delta: string }
  | { t: 'reasoning-delta'; id: string; delta: string }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }
  | { t: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { t: 'assistant-done'; id: string; stopReason: StopReason }
  | { t: 'usage'; tokensIn: number; tokensOut: number }
  | { t: 'aborted'; reason?: string }
  | { t: 'set-effort'; effort: State['effort'] }
  | { t: 'cycle-effort' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'error'; message: string }
  | { t: 'clear' };

const EFFORT_ORDER: ReadonlyArray<State['effort']> = ['medium', 'high', 'xhigh'];

export function initialState(): State {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

/** PURE reducer. Never mutates inputs; returns a new State (or the same ref for no-ops). */
export function reducer(state: State, action: Action): State {
  switch (action.t) {
    case 'user-submit': {
      const msg: Msg = {
        id: action.id,
        role: 'user',
        blocks: [{ kind: 'text', id: blockId(action.id, 0), text: action.text }],
        done: true,
      };
      // tokens.in is populated by the provider's real `usage` event (W9). The old
      // input estimate here was a pre-W9 placeholder; keeping it double-counted
      // input (estimate + real usage). Removed — `user-submit` no longer touches tokens.
      return {
        ...state,
        committed: [...state.committed, msg],
      };
    }

    case 'assistant-start':
      return {
        ...state,
        live: { id: action.id, role: 'assistant', blocks: [], done: false },
        phase: 'streaming',
      };

    case 'text-delta': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      const blocks = live.blocks.slice();
      const last = blocks.at(-1);
      if (last?.kind === 'text') {
        // Keep the same block id; concatenate into the trailing text block.
        blocks[blocks.length - 1] = { ...last, text: last.text + action.delta };
      } else {
        // A tool block (or nothing) precedes — open a new text block.
        blocks.push({ kind: 'text', id: blockId(live.id, blocks.length), text: action.delta });
      }
      return { ...state, live: { ...live, blocks } };
    }

    case 'reasoning-delta': {
      const live = state.live;
      // No-op if no live msg / id mismatch — reasoning belongs to the live turn.
      if (live === null || live.id !== action.id) return state;
      return { ...state, live: { ...live, reasoning: (live.reasoning ?? '') + action.delta } };
    }

    case 'tool-call': {
      const tools: Record<string, ToolState> = {
        ...state.tools,
        [action.toolCallId]: {
          status: 'pending',
          name: action.name,
          args: action.args,
          ...(action.parentToolUseId !== undefined ? { parentToolUseId: action.parentToolUseId } : {}),
        },
      };
      const live = state.live;
      if (live === null) {
        // Defensive: still register the call so a later tool-status isn't dropped.
        return { ...state, tools };
      }
      const blocks = [
        ...live.blocks,
        { kind: 'tool' as const, id: blockId(live.id, live.blocks.length), toolCallId: action.toolCallId },
      ];
      return { ...state, tools, live: { ...live, blocks } };
    }

    case 'tool-call-delta': {
      const existing = state.tools[action.toolCallId];
      // Accumulate partial arg text onto the pending tool entry. If `tool-call`
      // has not registered the entry yet, open a pending one so deltas survive.
      const base: ToolState =
        existing ?? { status: 'pending', name: '', args: undefined };
      const updated: ToolState = { ...base, argsText: (base.argsText ?? '') + action.argsDelta };
      return { ...state, tools: { ...state.tools, [action.toolCallId]: updated } };
    }

    case 'tool-status': {
      const existing = state.tools[action.toolCallId];
      if (existing === undefined) return state;
      // Race guard: once 'error', a later non-error status must NOT clobber it.
      if (existing.status === 'error' && action.status !== 'error') return state;

      const updated: ToolState = {
        ...existing,
        status: action.status,
        ...(action.result !== undefined ? { result: action.result } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
      const tools = { ...state.tools, [action.toolCallId]: updated };

      let phase = state.phase;
      if (action.status === 'running') phase = 'running-tool';
      else if (action.status === 'result' || action.status === 'error') {
        phase = state.live !== null ? 'streaming' : 'idle';
      }
      return { ...state, tools, phase };
    }

    case 'permission-open': {
      // Defensive: ensure a tools entry exists (tool-call normally precedes).
      const tools: Record<string, ToolState> =
        state.tools[action.toolCallId] !== undefined
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

    case 'permission-resolved':
      // The decision's effect on tool execution is W7/W8's job; the reducer only
      // restores UI/phase. (Decision/toolCallId are intentionally not stored.)
      return {
        ...state,
        overlay: 'none',
        phase: state.live !== null ? 'streaming' : 'idle',
        pendingPermissionToolCallId: null,
      };

    case 'assistant-done': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      const toolSnapshot = snapshotTools(live, state.tools);
      const doneMsg: Msg = {
        ...live,
        done: true,
        ...(Object.keys(toolSnapshot).length > 0 ? { toolSnapshot } : {}),
      };
      return { ...state, committed: [...state.committed, doneMsg], live: null, phase: 'idle' };
    }

    case 'usage':
      return {
        ...state,
        tokens: { in: state.tokens.in + action.tokensIn, out: state.tokens.out + action.tokensOut },
      };

    case 'aborted':
      // Cancellation: drop the in-flight turn and any open permission prompt,
      // return to idle, but keep committed history and cumulative tokens.
      return {
        ...state,
        live: null,
        phase: 'idle',
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermissionToolCallId: null,
      };

    case 'set-effort':
      return { ...state, effort: action.effort };

    case 'cycle-effort': {
      const idx = EFFORT_ORDER.indexOf(state.effort);
      const next = EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length]!;
      return { ...state, effort: next };
    }

    case 'set-overlay':
      return { ...state, overlay: action.overlay, phase: phaseForOverlay(state, action.overlay) };

    case 'error': {
      // PROPOSED: surface errors both as a committed system Msg (so <Static>
      // renders them for free) and on `errorMessage` (so the status line reads it).
      const id = `system-error-${state.committed.length}`;
      const msg: Msg = {
        id,
        role: 'system',
        blocks: [{ kind: 'text', id: blockId(id, 0), text: action.message }],
        done: true,
      };
      return {
        ...state,
        committed: [...state.committed, msg],
        phase: 'error',
        errorMessage: action.message,
      };
    }

    case 'clear':
      // Reset conversation/turn state; preserve user prefs (effort) and cumulative tokens.
      return { ...initialState(), effort: state.effort, tokens: state.tokens };
  }
}

/** Stable, monotonic-per-message block id. `n` is the append index. */
function blockId(msgId: string, blockIndex: number): string {
  return `${msgId}:block:${blockIndex + 1}`;
}

function snapshotTools(msg: Msg, tools: Record<string, ToolState>): Record<string, ToolState> {
  const snapshot: Record<string, ToolState> = {};
  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      const tool = tools[block.toolCallId];
      if (tool !== undefined) snapshot[block.toolCallId] = { ...tool };
    }
  }
  return snapshot;
}

function phaseForOverlay(state: State, overlay: State['overlay']): State['phase'] {
  if (state.phase === 'error') return 'error';
  if (overlay === 'permission') return 'awaiting-permission';
  if (state.phase === 'awaiting-permission') return state.live !== null ? 'streaming' : 'idle';
  return state.phase;
}
