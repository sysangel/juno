// src/providers/sseIdleGuard.ts
// Wave 14 (a5-stream-resilience) — an inactivity guard for the raw-API SSE readers
// (anthropic / openai), plus the shared host-sleep detector used by ALL three stream
// guards (these two + the codex/claude CLI pumps).
//
// The two SSE clients previously read their response body in a bare
// `while (!signal.aborted) { reader.read() }` loop: a server that holds the
// connection open with zero bytes blocks FOREVER (no error event ever surfaces).
// `readWithIdleTimeout` races each `reader.read()` against an idle timer (reset on
// EVERY chunk, mirroring the CLI pumps' T1 read guard) so a dead connection throws a
// retryable `StreamStallError` instead — which the client's existing mid-stream catch
// turns into `{type:'error', envelope: timeout(retryable)}` + assistant-done('error'),
// converging the SSE backends onto the same degrade→humanized-stall→retry path the CLI
// backends already have (the turnRunner's mid-stream retry consumes it).
//
// DEPENDENCY-FREE: this module imports only the injectable `TimerHandle` shape from
// `retryFetch` (same directory, no runtime coupling). All timers/clocks are injectable
// so tests drive a deterministic clock and never incur a real multi-second wait.

import type { TimerHandle } from './retryFetch';

/**
 * File-shared sentinel thrown out of a stream guard when its idle timer fires. The
 * name is load-bearing: `classifyThrown` (errorEnvelope.ts) matches
 * `name === 'StreamStallError'` (and the message's `/\bstall/`) → the retryable
 * `timeout` kind. Distinct from the CLI clients' file-local `StreamStallError`
 * copies (which are internal to those modules); this one serves the SSE readers.
 */
export class StreamStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamStallError';
  }
}

/**
 * A host suspend (laptop sleep) advances the wall clock while the monotonic clock —
 * `process.hrtime.bigint()` (macOS mach_absolute_time / Linux CLOCK_MONOTONIC) — and
 * the event loop are frozen; on wake, a Node `setTimeout` that came due during the
 * suspend fires IMMEDIATELY, which a naive idle guard misreads as a stall. When a
 * guard fires, comparing wall-elapsed vs mono-elapsed since the last real activity
 * distinguishes the two: a genuine stall has `wall ≈ mono` (divergence ≈ 0); a suspend
 * has `wall ≫ mono`. A divergence past `thresholdMs` means a suspend happened — the
 * guard gets ONE grace re-arm instead of killing a healthy stream. Single source of
 * truth so the three guards (SSE + codex + claude) can never drift on the heuristic.
 */
export function detectedSleepGap(
  wallElapsedMs: number,
  monoElapsedMs: number,
  thresholdMs = 4000,
): boolean {
  return wallElapsedMs - monoElapsedMs > thresholdMs;
}

const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
};

export interface ReadWithIdleTimeoutOpts {
  /** Idle READ timeout (ms): reset on EVERY chunk. No chunk at all within the window
   * (and no host-sleep divergence) ⇒ a `StreamStallError` is thrown. */
  readonly idleTimeoutMs: number;
  /** Label woven into the stall message (`<label> stalled: …`) — e.g. 'anthropic'. */
  readonly label: string;
  /** Injectable backoff scheduler — deterministic in tests. Default wraps setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable wall clock (Date.now). For host-sleep detection + tests. */
  readonly now?: () => number;
  /** Injectable monotonic clock (process.hrtime.bigint). For host-sleep detection + tests. */
  readonly mono?: () => bigint;
}

/** The shape of a `ReadableStreamDefaultReader.read()` resolution (lib-agnostic). */
type ChunkRead = { value?: Uint8Array; done: boolean };

type RaceResult =
  | { kind: 'chunk'; result: ChunkRead }
  | { kind: 'idle' }
  | { kind: 'abort' };

/**
 * Read a `ReadableStream<Uint8Array>` chunk-by-chunk, throwing `StreamStallError` when
 * the stream goes silent for `idleTimeoutMs` (unless a host suspend is detected, which
 * grants one grace re-arm). Each `reader.read()` is raced against the idle timer and
 * the abort signal:
 *   - a chunk resets the idle timer and re-stamps the wall/mono activity marks, then is
 *     yielded to the caller (which keeps its own decode + `\n\n` SSE-split logic);
 *   - the idle timer winning ⇒ host-sleep check; on a real stall, cancel the body and
 *     throw `StreamStallError`;
 *   - abort winning ⇒ cancel + throw `AbortError` so the caller's existing `isAbort`
 *     branch maps it to `{aborted}` (identical to a fetch-aborted read reject today).
 * The reader lock is always released in `finally` (guarded — a stall/abort leaves the
 * in-flight read outstanding, which `releaseLock` would otherwise reject on).
 */
export async function* readWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  opts: ReadWithIdleTimeoutOpts,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const now = opts.now ?? Date.now;
  const mono = opts.mono ?? ((): bigint => process.hrtime.bigint());
  const { idleTimeoutMs, label } = opts;

  // Last real activity marks (a chunk arrival), stamped on both clocks so a fired
  // timer can tell a genuine stall from a host suspend (see detectedSleepGap).
  let lastActivityWall = now();
  let lastActivityMono = mono();

  // The idle guard: a promise that resolves to `{kind:'idle'}` when its timer fires.
  // `reset` cancels-and-rearms a fresh window; `clear` cancels it.
  let idleResolve: (() => void) | undefined;
  let idlePromise!: Promise<RaceResult>;
  let idleHandle: TimerHandle | undefined;
  const armIdle = (): void => {
    idlePromise = new Promise<RaceResult>((res) => {
      idleResolve = () => res({ kind: 'idle' });
    });
    idleHandle = setTimer(() => idleResolve?.(), idleTimeoutMs);
  };
  const resetIdle = (): void => {
    idleHandle?.clear();
    armIdle();
  };
  armIdle();

  // The abort listener is named + removed in `finally` (below). The same turn-lifetime
  // signal is reused across every streamTurn attempt (each raw-API tool-loop iteration
  // AND each Item-A stream retry); `{ once: true }` only auto-removes if it FIRES, so on
  // the non-abort exits (done-close, stall) the listener would otherwise accumulate one
  // per attempt → Node's MaxListenersExceededWarning past 10 attempts (garbling the Ink
  // TUI) plus a closure held until turn end. Mirrors retryFetch.sleep / abortAwareSleep.
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<RaceResult>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'abort' });
    } else {
      onAbort = (): void => resolve({ kind: 'abort' });
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  // The in-flight chunk read, kept ACROSS a grace re-arm (host-sleep) so a `continue`
  // never issues a second concurrent `reader.read()`. Reset only once consumed.
  let nextPromise: Promise<RaceResult> | undefined;

  const teardown = (): void => {
    // Free the socket and settle any outstanding read so `releaseLock` (in finally)
    // does not reject. Errors from cancel are irrelevant on the throw paths.
    void reader.cancel().catch(() => {});
  };

  try {
    while (true) {
      if (nextPromise === undefined) {
        nextPromise = reader.read().then((result) => ({ kind: 'chunk', result }) as const);
      }

      const winner = await Promise.race([nextPromise, idlePromise, abortPromise]);

      if (winner.kind === 'abort') {
        teardown();
        throw new DOMException('Aborted', 'AbortError');
      }

      if (winner.kind === 'idle') {
        // A host suspend advances the wall clock while the monotonic clock stayed
        // frozen (the fired timer came due during sleep): re-arm ONCE and keep reading
        // rather than killing a healthy stream. A genuine stall has wall ≈ mono.
        const wallElapsedMs = now() - lastActivityWall;
        const monoElapsedMs = Number(mono() - lastActivityMono) / 1e6;
        if (detectedSleepGap(wallElapsedMs, monoElapsedMs)) {
          resetIdle();
          lastActivityWall = now();
          lastActivityMono = mono();
          continue; // preserve nextPromise — the in-flight read survives the re-arm.
        }
        teardown();
        throw new StreamStallError(
          `${label} stalled: no output for ${Math.round(idleTimeoutMs / 1000)}s`,
        );
      }

      // A chunk won — consume it; the next iteration issues a fresh read.
      nextPromise = undefined;
      const { value, done } = winner.result;
      if (done === true) {
        break;
      }
      resetIdle();
      lastActivityWall = now();
      lastActivityMono = mono();
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    idleHandle?.clear();
    // Remove the abort listener on EVERY exit (done-close, stall, abort). Idempotent:
    // if it already fired (abort path) `{ once: true }` self-removed and this is a
    // no-op; on the non-abort paths this is the removal that prevents the leak.
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
    // A stall/abort throw leaves the raced read outstanding; releaseLock rejects on
    // an outstanding read, so guard it (the stream is being discarded regardless).
    try {
      reader.releaseLock();
    } catch {
      /* outstanding read on the stall/abort path — the body was cancelled above */
    }
  }
}
