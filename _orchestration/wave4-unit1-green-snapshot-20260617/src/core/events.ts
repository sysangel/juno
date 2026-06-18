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
  | { type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { type: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { type: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { type: 'assistant-done'; id: string; stopReason: StopReason }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'aborted'; reason?: string }
  | { type: 'error'; message: string };

/** Narrow helper: the literal `type` tag of every AgentEvent variant. */
export type AgentEventType = AgentEvent['type'];

import type { Action } from './reducer';

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
      return { t: 'tool-call', toolCallId: e.toolCallId, name: e.name, args: e.args };
    case 'tool-call-delta':
      return { t: 'tool-call-delta', toolCallId: e.toolCallId, argsDelta: e.argsDelta };
    case 'tool-status':
      return { t: 'tool-status', toolCallId: e.toolCallId, status: e.status, result: e.result, error: e.error };
    case 'permission-open':
      return { t: 'permission-open', toolCallId: e.toolCallId, name: e.name, args: e.args, risk: e.risk };
    case 'permission-resolved':
      return { t: 'permission-resolved', toolCallId: e.toolCallId, decision: e.decision };
    case 'assistant-done':
      return { t: 'assistant-done', id: e.id, stopReason: e.stopReason };
    case 'usage':
      return { t: 'usage', tokensIn: e.tokensIn, tokensOut: e.tokensOut };
    case 'aborted':
      return { t: 'aborted', reason: e.reason };
    case 'error':
      return { t: 'error', message: e.message };
  }
}
