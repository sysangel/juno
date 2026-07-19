// src/core/errorEnvelope.ts
// Wave 14 (a5-error-envelope) — the normalized provider-error envelope.
//
// A typed, machine-readable classification (`kind` + derived `retryable`, plus an
// optional bounded `stderrTail` from a CLI child) that rides the EXISTING `error`
// AgentEvent from provider -> turnRunner -> reducer WITHOUT touching any
// human-facing error string. Purely additive substrate: downstream lanes branch on
// `envelope.kind` / `envelope.retryable`; nothing consumes it here.
//
// STANDALONE + PURE: this module imports NOTHING from `./events` or `./reducer`
// (both import ONLY the TYPE from here), so there is no import cycle. The three
// classifier entry points are pure string/status inspection; `readErrorBody` is the
// only I/O and is safe ONLY on the discarded non-ok response branch (see its doc).

/**
 * Closed enum of normalized provider-failure classes. A closed enum (not a
 * provider-specific field) is what keeps `envelope` compatible with the frozen
 * AgentEvent seam — it is a normalized classification like `StopReason`, not a wire
 * passthrough.
 *   - 'network'          — fetch reject / socket drop / mid-stream read fail / 5xx.
 *   - 'timeout'          — mid-stream stall (StreamStallError, idle/stale guard).
 *   - 'rate-limit'       — HTTP 429.
 *   - 'context-overflow' — prompt-too-long / context-length (HTTP 400 body or CLI stderr).
 *   - 'auth'             — missing API key, HTTP 401/403.
 *   - 'tool'             — tool-protocol error (malformed tool_use).
 *   - 'child-exit'       — codex/claude CLI child died non-zero / by-signal, or spawn failed.
 *   - 'unknown'          — classifiable path with no recognized signal (explicit fallback).
 */
export type ProviderErrorKind =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'context-overflow'
  | 'auth'
  | 'tool'
  | 'child-exit'
  | 'unknown';

export interface ProviderErrorEnvelope {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Raw bounded stderr tail from a CLI child failure; absent otherwise. */
  readonly stderrTail?: string;
}

/**
 * SINGLE SOURCE OF TRUTH for retryability: `retryable` is DERIVED from `kind` via
 * this set, so no two call sites can disagree. Only transient transport-class
 * failures are retryable; deterministic client errors (auth, context-overflow,
 * tool, child-exit, unknown) are not.
 */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'network',
  'timeout',
  'rate-limit',
]);

/**
 * Build an envelope. `retryable` is derived from `kind`. `stderrTail` is included
 * ONLY when a non-empty string is passed, so the field stays ABSENT (not an empty
 * string) on paths with no captured stderr.
 */
export function envelope(kind: ProviderErrorKind, stderrTail?: string): ProviderErrorEnvelope {
  return {
    kind,
    retryable: RETRYABLE.has(kind),
    ...(stderrTail !== undefined && stderrTail.length > 0 ? { stderrTail } : {}),
  };
}

/**
 * Lowercase substrings that mark a context-length / prompt-too-long overflow. Kept
 * as the single source of truth here (core); `src/agent/compactor.ts`
 * `classifyCompactionFailure` imports THIS constant (agent -> core is the correct
 * dependency direction). Ported from grok's `is_context_length_error` list.
 */
export const CONTEXT_MARKERS: readonly string[] = [
  'context length',
  'context_length_exceeded',
  'maximum context',
  'too many tokens',
  'prompt is too long',
  'input is too long',
  'reduce the length',
  'input length',
];

/**
 * Classify an HTTP non-ok response (anthropic / openai clients). `bodyText` is
 * OPTIONAL — pass the (bounded) response body so a 400 carrying a context-length
 * marker classifies as `context-overflow` rather than `unknown`. Context is checked
 * FIRST so it wins over the status buckets.
 */
export function classifyHttpStatus(status: number, bodyText?: string): ProviderErrorEnvelope {
  if (bodyText !== undefined && CONTEXT_MARKERS.some((m) => bodyText.toLowerCase().includes(m))) {
    return envelope('context-overflow');
  }
  if (status === 429) return envelope('rate-limit');
  if (status === 401 || status === 403) return envelope('auth');
  if (status >= 500 && status <= 599) return envelope('network');
  // 400 / 404 / 422 / … without a context marker: a deterministic client error.
  return envelope('unknown');
}

/**
 * Classify a THROWN value (fetch reject after retry exhaustion, spawn failure,
 * mid-stream read error, StreamStallError). Inspects `name`, lowercased `message`,
 * and a Node-style `code`.
 */
export function classifyThrown(error: unknown): ProviderErrorEnvelope {
  const name = error instanceof Error ? error.name : '';
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code).toLowerCase()
      : '';
  // Word-boundary match: /\bstall/ hits the real stall messages ('...stream stalled
  // (idle|stale timeout after Nms)') but NOT 'installed'/'install' (a deterministic
  // failure like 'claude CLI is not installed' must stay 'unknown', not retryable 'timeout').
  if (name === 'StreamStallError' || /\bstall/.test(msg)) return envelope('timeout');
  if (msg.includes('spawn') || code === 'enoent' || msg.includes('enoent')) return envelope('child-exit');
  if (CONTEXT_MARKERS.some((m) => msg.includes(m))) return envelope('context-overflow');
  if (
    ['econnreset', 'etimedout', 'enotfound', 'epipe', 'econnrefused'].includes(code) ||
    ['econnreset', 'etimedout', 'enotfound', 'socket hang up', 'fetch failed', 'network', 'terminated', 'econnrefused'].some(
      (m) => msg.includes(m),
    )
  ) {
    return envelope('network');
  }
  return envelope('unknown');
}

/**
 * Classify a final MESSAGE string (CLI 'failed'/'error' kinds + the turnRunner
 * catch-all fallback). Optionally carries a `stderrTail` through to the envelope
 * (child-exit paths supply the captured stderr).
 */
export function classifyMessage(message: string, stderrTail?: string): ProviderErrorEnvelope {
  const lower = message.toLowerCase();
  const kind: ProviderErrorKind = CONTEXT_MARKERS.some((m) => lower.includes(m))
    ? 'context-overflow'
    : // Word-boundary match so 'installed'/'install' does not read as 'stall' (see classifyThrown).
      /\bstall/.test(lower)
      ? 'timeout'
      : lower.includes('exited with code') ||
          lower.includes('killed by signal') ||
          lower.includes('spawn') ||
          lower.includes('enoent')
        ? 'child-exit'
        : lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')
          ? 'rate-limit'
          : lower.includes('401') ||
              lower.includes('403') ||
              lower.includes('unauthorized') ||
              lower.includes('forbidden') ||
              lower.includes('api key') ||
              lower.includes('missing api key')
            ? 'auth'
            : ['econnreset', 'etimedout', 'enotfound', 'socket hang up', 'fetch failed', 'terminated'].some((m) =>
                  lower.includes(m),
                )
              ? 'network'
              : 'unknown';
  return envelope(kind, stderrTail);
}

/** Cap on the response body we read for context-marker classification. */
const MAX_ERROR_BODY_CHARS = 2000;

/**
 * Read a bounded prefix of a non-ok response body for classification. SAFE ONLY on
 * the non-ok branch, where the body is discarded today and the client returns
 * immediately — NEVER call it on the success / streaming path (it would consume the
 * SSE stream). Returns '' on any read failure so the caller never throws.
 */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}
