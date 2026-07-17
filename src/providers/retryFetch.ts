// src/providers/retryFetch.ts
// Bounded, small-budget retry-with-backoff around the PRE-FIRST-BYTE model call.
//
// This wraps ONLY the initial fetch + HTTP-status check of a streaming turn — the
// window in which a transient 503/429/network blip can be retried WITHOUT any
// observable effect (no assistant-start emitted, no deltas streamed yet). Once the
// SSE loop begins, a mid-stream failure is NOT safely retryable (partial content
// already left the seam), so callers keep that path outside retryFetch.
//
// The budget is deliberately SMALL (500ms base / 8s cap / 3 retries → 4 attempts)
// because this sits on the per-turn latency path, unlike mcpManager's reconnect
// policy (1s / 30s / 5) which absorbs a whole-server outage. The injectable
// setTimer / TimerHandle pattern mirrors mcpManager.ts so tests drive a
// deterministic clock and never incur a real sleep.

/** Injectable timer handle so backoff is deterministic in tests. Same shape as
 * services/brain.ts `TimerHandle`; kept local so this module has no runtime
 * dependency on the services layer. */
export interface TimerHandle {
  clear: () => void;
}

/**
 * Bounded retry policy for the pre-first-byte model call. All fields default; pass
 * `{}` for all-defaults. `setTimer` is the injectable backoff scheduler (a manual
 * clock in tests) — DISTINCT from the request's own AbortSignal so the two never
 * collide.
 */
export interface RetryOptions {
  /** Delay before the FIRST retry; each subsequent retry doubles it (capped at
   * `maxDelayMs`). Default 500ms. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff delay (also the clamp ceiling for a server's
   * `Retry-After`). Default 8000ms. */
  maxDelayMs?: number;
  /** HARD cap on retries AFTER the first attempt. Default 3 ⇒ up to 4 total
   * attempts. Exhaustion surfaces the SAME terminal result the caller sees today
   * (the last non-ok Response, or the last network error rethrown). */
  maxRetries?: number;
  /** Injectable backoff scheduler — deterministic in tests. Default wraps global
   * setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RETRIES = 3;

const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
};

/**
 * A status worth retrying: 429 (rate limit) or any 5xx (transient server fault).
 * Everything else — 400/401/403/404/422/… — is a DETERMINISTIC client error:
 * retrying a bad request or a bad key wastes tokens and latency and would fail
 * identically, so those return immediately for the caller's existing `!response.ok`
 * terminal to surface.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Retry `doFetch` up to `maxRetries` times with exponential backoff.
 *
 * Terminal semantics are preserved exactly: on a RESOLVED response that is `ok` or
 * carries a non-retryable status, it is returned AS-IS (the caller keeps its
 * `!response.ok` handling); when retries are exhausted the LAST non-ok response is
 * returned, or the LAST network error is rethrown — so the caller surfaces the same
 * error it does today, just after N tries. An abort (pre-attempt, between attempts,
 * or during a backoff sleep) throws a `DOMException('AbortError')` so the caller's
 * existing `isAbort()` branch maps it to `{ type: 'aborted' }`, never `error`; no
 * further fetch is issued once aborted.
 */
export async function retryFetch(
  doFetch: () => Promise<Response>,
  opts: RetryOptions,
  signal: AbortSignal,
  onRetry?: (attempt: number, max: number, delayMs: number) => void,
): Promise<Response> {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const setTimer = opts.setTimer ?? defaultSetTimer;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    let response: Response;
    try {
      response = await doFetch();
    } catch (error: unknown) {
      // An abort is terminal — let the caller's isAbort() branch map it.
      if (isAbortError(signal, error)) {
        throw error;
      }
      // A network throw: retry if budget remains, else rethrow the SAME error.
      if (attempt < maxRetries) {
        const delayMs = computeBackoff(baseDelayMs, maxDelayMs, attempt);
        onRetry?.(attempt + 1, maxRetries, delayMs);
        await sleep(delayMs, signal, setTimer);
        continue;
      }
      throw error;
    }

    // Success or a deterministic client error — return as-is for the caller's
    // existing !response.ok handling.
    if (response.ok || !isRetryableStatus(response.status)) {
      return response;
    }

    // Retryable status: return the last non-ok response once the budget is spent.
    if (attempt >= maxRetries) {
      return response;
    }

    const delayMs = retryAfterDelay(response, baseDelayMs, maxDelayMs, attempt);
    // Drain the body so the underlying socket frees before we loop — otherwise a
    // never-read stream can leak the connection for the whole backoff.
    await response.body?.cancel();
    onRetry?.(attempt + 1, maxRetries, delayMs);
    await sleep(delayMs, signal, setTimer);
  }

  // Unreachable: every iteration returns, continues, or throws. Present only so the
  // return type is honoured without a non-null assertion.
  throw new DOMException('Aborted', 'AbortError');
}

/** `min(maxDelayMs, baseDelayMs * 2**attempt)`. Multiply base by the growth
 * factor — NOT `base**attempt`, which overflows almost immediately. */
function computeBackoff(baseDelayMs: number, maxDelayMs: number, attempt: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

/**
 * Delay before retrying a retryable response. On a 429 the server's `Retry-After`
 * wins (integer seconds, else an HTTP-date), clamped to `[0, maxDelayMs]` so a
 * hostile/huge value cannot stall the turn. An absent/unparseable header falls back
 * to the computed exponential backoff.
 */
function retryAfterDelay(response: Response, baseDelayMs: number, maxDelayMs: number, attempt: number): number {
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    if (header !== null) {
      const parsed = parseRetryAfter(header);
      if (parsed !== undefined) {
        return clamp(parsed, 0, maxDelayMs);
      }
    }
  }
  return computeBackoff(baseDelayMs, maxDelayMs, attempt);
}

/** Parse a `Retry-After` value into milliseconds: integer seconds first, else an
 * HTTP-date measured from now. `undefined` when neither form parses. */
function parseRetryAfter(header: string): number | undefined {
  const seconds = parseInt(header, 10);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return dateMs - Date.now();
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Abortable sleep: schedule `ms` via the injectable timer, but ALSO listen for an
 * abort so an Esc during a multi-second backoff resolves at once rather than being
 * swallowed by the pending wait. Both the timer and the listener are cleaned up on
 * whichever path fires first. The caller re-checks `signal.aborted` at the top of
 * the next loop iteration and throws — this only ends the wait early.
 */
function sleep(
  ms: number,
  signal: AbortSignal,
  setTimer: (fn: () => void, ms: number) => TimerHandle,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let handle: TimerHandle | undefined;
    const onAbort = (): void => {
      handle?.clear();
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    handle = setTimer(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function isAbortError(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}
