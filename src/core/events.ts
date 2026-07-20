// src/core/events.ts
// W3 — the normalized AgentEvent discriminated union + shared enums.
// FROZEN seam: every LLM adapter (W9) yields ONLY these shapes.
// Do NOT add provider-specific fields here.

export type ToolStatus = 'pending' | 'running' | 'result' | 'error';

/** Provider-neutral evidence describing how a command/process stopped. */
export interface ToolTermination {
  kind: 'exit' | 'signal' | 'timeout' | 'cancelled' | 'unknown';
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
}

/**
 * How dangerous a tool call is, driving the permission gate.
 *   - 'safe'      → auto-allowed (reads).
 *   - 'risky'     → always prompts.
 *   - 'dangerous' → always prompts; NEVER auto-allowed by risk alone (run_shell's
 *                   default: the only control is the prompt).
 *   - 'sandboxed' → run_shell when its child is GENUINELY OS-confined (macOS
 *                   Seatbelt via sandbox-exec). Auto-allowed BECAUSE the OS, not
 *                   the prompt, is the control. This level is single-sourced from
 *                   the same sandbox-available signal that decides wrapping, so a
 *                   'sandboxed' tool provably confines its child (see shellTool +
 *                   shellSandbox). Adding it here forces the two exhaustive risk
 *                   switches (policy + PermissionPrompt) to handle it.
 */
export type RiskLevel = 'safe' | 'risky' | 'dangerous' | 'sandboxed';

export type PermissionDecision =
  | 'allow-once'
  | 'deny'
  | 'always-allow-pattern'
  | 'dangerous-bypass';

/**
 * Why an assistant turn stopped. Normalized across providers (W9) so the
 * coordinator (W6) can branch on it: `'tool_use'` means the model wants tools
 * run and the turn must be resumed with their results; `'end'` is a clean stop;
 * `'max_tokens'`/`'abort'`/`'error'` are early terminations.
 */
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'abort' | 'error';

/**
 * The normalized event stream. Providers (W9) translate their wire formats into
 * this union; the coordinator (W6) maps each event 1:1 to a reducer Action via
 * `eventToAction`. Tools (W7) emit `tool-call`/`tool-status`; the permission
 * layer (W8) drives `permission-open`/`permission-resolved`.
 *
 * `reasoning-delta` and `tool-call-delta` are streaming-accumulation events
 * (extended-thinking text and partial tool-arg JSON respectively); `aborted`
 * is the normalized cancellation signal (distinct from `error`).
 */
export type AgentEvent =
  | { type: 'assistant-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  /**
   * `promptText` (OPTIONAL, normalized — NOT a provider wire field) is juno's
   * model-facing tool re-entry text: when present on a terminal `result`, the
   * turn runner serializes it verbatim as the `role:'tool'` content the model
   * reads, instead of JSON-wrapping `result`. It rides THIS event because the
   * runner reconstructs the re-entry result purely from `tool-status` (the
   * fake-stream and executor paths converge here) and never reads the raw
   * ToolResult. `eventToAction` deliberately does NOT forward it — the reducer
   * Action + UI cards stay byte-identical (cards render `result`); only the
   * runner reads it off the raw event.
   */
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string; promptText?: string; termination?: ToolTermination }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { type: 'assistant-done'; id: string; stopReason: StopReason }
  /**
   * `contextTokens` (OPTIONAL, normalized — NOT provider-specific) is the FULL
   * input size of THIS request: prompt input + any cache-read + cache-creation
   * tokens. It is the live occupancy of the context window for the turn that just
   * fired. Distinct from `tokensIn` (the billable, cache-excluded input the cost
   * meter accumulates): with prompt caching `tokensIn` undercounts the real
   * window, so adapters that can see the cache figures populate `contextTokens`
   * for the context-window monitor. Adapters that cannot omit it; the reducer
   * then falls back to a positive `tokensIn`.
   *
   * `parentToolUseId` (OPTIONAL, normalized — NOT a provider field) marks this as a
   * CHILD (subagent) usage: it mirrors how `tool-call` carries `parentToolUseId`
   * (the spawning tool_use id). A usage that carries it is a subagent's spend, which
   * the reducer folds into the cumulative cost meter (`tokens.in/out`, for display)
   * but NEVER into `contextWindowTokens` — a child runs in a fresh, isolated context
   * the parent window never touched, so its input size must not inflate the parent's
   * compaction pressure. Absent on top-level (parent) usage, so the parent path stays
   * byte-identical.
   */
  | { type: 'usage'; tokensIn: number; tokensOut: number; contextTokens?: number; parentToolUseId?: string }
  | { type: 'aborted'; reason?: string }
  /**
   * `envelope` (OPTIONAL, NORMALIZED — NOT provider-specific) is a machine-readable
   * classification of the failure: a closed-enum `kind` + a derived `retryable` (+
   * an optional bounded `stderrTail` from a CLI child). Because `kind` is a closed
   * enum (like `StopReason` / `contextTokens`), not a provider wire field, it
   * respects the frozen-seam rule — adapters MAY populate it, none MUST. `message`
   * stays the VERBATIM human-facing string; `envelope` never alters it. Downstream
   * lanes branch on `kind` / `retryable`; the reducer stores it on `errorEnvelope`.
   */
  | { type: 'error'; message: string; envelope?: ProviderErrorEnvelope };

/** Narrow helper: the literal `type` tag of every AgentEvent variant. */
export type AgentEventType = AgentEvent['type'];

import type { Action } from './reducer';
import type { ProviderErrorEnvelope } from './errorEnvelope';

/**
 * Map a normalized AgentEvent to its reducer Action (1:1 for every event variant).
 * The coordinator (W6) calls this for each streamed event; local UI actions
 * (`user-submit`, `set-effort`, `cycle-effort`, `set-overlay`, `clear`) have no
 * corresponding event and are dispatched directly by the UI.
 */
export function eventToAction(e: AgentEvent): Action {
  switch (e.type) {
    case 'assistant-start':
      return { t: 'assistant-start', id: e.id };
    case 'text-delta':
      return { t: 'text-delta', id: e.id, delta: e.delta };
    case 'reasoning-delta':
      return { t: 'reasoning-delta', id: e.id, delta: e.delta };
    case 'tool-call':
      return { t: 'tool-call', toolCallId: e.toolCallId, name: e.name, args: e.args, parentToolUseId: e.parentToolUseId };
    case 'tool-call-delta':
      return { t: 'tool-call-delta', toolCallId: e.toolCallId, argsDelta: e.argsDelta };
    case 'tool-status':
      return { t: 'tool-status', toolCallId: e.toolCallId, status: e.status, result: e.result, error: e.error, termination: e.termination };
    case 'permission-open':
      return { t: 'permission-open', toolCallId: e.toolCallId, name: e.name, args: e.args, risk: e.risk };
    case 'permission-resolved':
      return { t: 'permission-resolved', toolCallId: e.toolCallId, decision: e.decision };
    case 'assistant-done':
      return { t: 'assistant-done', id: e.id, stopReason: e.stopReason };
    case 'usage':
      return {
        t: 'usage',
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        ...(e.contextTokens !== undefined ? { contextTokens: e.contextTokens } : {}),
        // Conditional spread keeps a top-level (parent) usage action BYTE-IDENTICAL
        // to today — the `parentToolUseId` key is absent unless a child stamped it.
        ...(e.parentToolUseId !== undefined ? { parentToolUseId: e.parentToolUseId } : {}),
      };
    case 'aborted':
      return { t: 'aborted', reason: e.reason };
    case 'error':
      // Spread keeps the action BYTE-IDENTICAL to today when no envelope is present
      // (the `envelope` key is absent), so existing eventToAction assertions hold.
      return { t: 'error', message: e.message, ...(e.envelope !== undefined ? { envelope: e.envelope } : {}) };
  }
}
