// src/core/contracts.ts
// W3 — interfaces ONLY. Implemented by W7 (tools), W8 (permissions), W9 (LLM adapters).
// No impls live here. TurnInput / ToolSpec / ToolCtx / ToolResult are W3-PROPOSED
// shapes (flagged in NOTES): kept minimal, but sufficient for the named consumers.
import type { AgentEvent, PermissionDecision, RiskLevel } from './events';
import type { State } from './reducer';

/**
 * PROPOSED (W3): one message in a turn's conversation history. The `tool` role
 * (and the assistant's `toolCalls`) is what lets W6 RE-ENTER tool results into
 * the model: after a turn stops with `stopReason:'tool_use'`, W6 appends the
 * prior assistant message (with its `toolCalls`) plus one `tool` message per
 * resolved call, then runs the next turn. `toolCallId` correlates a `tool`
 * result back to the assistant `toolCalls[].toolCallId` that requested it.
 */
export type TurnMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: Array<{ toolCallId: string; name: string; args: unknown }>;
    }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * PROPOSED (W3): minimal input to one model turn. W9 adapters may carry their own
 * richer internal types but MUST accept this shape (or a superset) from the
 * coordinator (W6). `id` lets the adapter stamp `assistant-start`/`assistant-done`.
 */
export interface TurnInput {
  /** Stable id for the assistant turn this input drives. */
  id: string;
  messages: TurnMessage[];
  /** Model identifier (e.g. 'claude-...'); optional so the fake/default can omit. */
  model?: string;
  /** Working directory the turn runs against. */
  cwd?: string;
  /** Active effort level; lets adapters route reasoning effort into the request. */
  effort?: State['effort'];
  /** Optional system prompt override. */
  systemPrompt?: string;
}

/**
 * PROPOSED (W3): the tool description handed to the model. `inputSchema` is a JSON
 * Schema object describing args; typed `unknown` so W7 may use its preferred lib.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * PROPOSED (W3): runtime context passed into `Tool.run`. Carries the cancellation
 * signal, the cwd, an `emit` hook (so a tool can stream sub-events / progress as
 * normalized AgentEvents), and a read-only view of reducer State for tools that
 * need to inspect it. Tools MUST NOT mutate `state`.
 *
 * PERMISSION OWNERSHIP (the async round-trip):
 * The executor — NOT the tool — owns calling `PermissionPolicy.evaluate(...)`.
 * When `evaluate(...)` returns `'prompt'`, the executor:
 *   1. emits a `permission-open` event (drives the overlay via the reducer), then
 *   2. `await ctx.awaitPermission(toolCallId)` to block until the user decides.
 * The coordinator (W6) SUPPLIES `awaitPermission`: it parks a pending promise
 * keyed by `toolCallId` and RESOLVES it with the `PermissionDecision` when the
 * UI dispatches `permission-resolved` for that id. (`'auto-allow'`/`'auto-deny'`
 * from `evaluate` skip the prompt and never call `awaitPermission`.)
 */
export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /**
   * Block until the user resolves the permission prompt for `toolCallId`.
   * Supplied by the coordinator (W6); resolves with the user's
   * `PermissionDecision` once `permission-resolved` is dispatched for that id.
   */
  awaitPermission(toolCallId: string): Promise<PermissionDecision>;
  readonly state: Readonly<State>;
}

/** PROPOSED (W3): normalized tool execution result. */
export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * LLM adapter contract (W9 implements; the fake client implements it for tests).
 * `streamTurn` yields ONLY normalized AgentEvents and must stop promptly when
 * `signal.aborted`. It must not yield provider-specific shapes.
 */
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

/**
 * Drives one tool call's lifecycle, emitting AgentEvents (W7 implements).
 * Implementations emit `tool-status('running')` then `tool-status('result'|'error')`
 * via `emit`; they own permission-gated dispatch in coordination with W8.
 *
 * The executor OWNS the permission decision: it calls `PermissionPolicy.evaluate`
 * and, on `'prompt'`, emits `permission-open` then awaits the user's decision via
 * the `ToolCtx.awaitPermission` round-trip described on {@link ToolCtx}. On
 * `'auto-deny'` (or a `deny` decision) it must NOT run the tool and should emit a
 * terminal `tool-status('error')`.
 */
export interface ToolExecutor {
  execute(
    toolCallId: string,
    name: string,
    args: unknown,
    emit: (e: AgentEvent) => void,
  ): Promise<void>;
}

/**
 * Permission gate (W8 implements). `evaluate` is a synchronous policy decision;
 * `'prompt'` means the coordinator must open the permission overlay and wait for
 * the user's interactive `PermissionDecision`. `remember` persists an
 * always-allow / bypass pattern for future `evaluate` calls.
 */
export interface PermissionPolicy {
  evaluate(name: string, args: unknown, risk: RiskLevel): 'auto-allow' | 'auto-deny' | 'prompt';
  remember(pattern: string, decision: PermissionDecision): void;
}
