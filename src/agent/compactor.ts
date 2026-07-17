// src/agent/compactor.ts
// W6 Context-Compression — the impure orchestration half (Unit 2).
//
// Turns the elided committed prefix into ONE dense summary by running a tools-less
// summarization turn through the SAME selected `ModelClient` (so on the claude-cli
// backend it is a subscription `claude -p` call, never API billing). Best-effort:
// an empty/failed summary returns '' and the caller skips the dispatch, leaving the
// session untouched. The pure `chooseKeepCount` lives here too (unit-testable).
//
// Frozen-seam compliance: consumes the existing `ModelClient.streamTurn(input, [], signal)`
// with NO tools (no tool loop, no recursion); emits NO new AgentEvent.
import type { ModelClient, TurnInput, TurnMessage } from '../core/contracts';
import type { Msg } from '../core/reducer';
import { estimateMessageTokens } from '../core/selectors';

/**
 * The summarization instruction. A structured multi-section handoff template so a
 * fresh session can resume with no loss of context. Deliberately compact — it is
 * PREPENDED to a potentially large folded prefix, so it must not bloat the input.
 *
 * The CARRY-FORWARD clause is load-bearing: juno re-summarizes its OWN prior
 * `compaction-<n>` message every cycle (the folded prefix labels it `[system]`), so
 * without an explicit instruction to preserve it, detail decays across successive
 * compactions. The NO-TOOLS clause keeps this a pure text turn (it is dispatched
 * with `[]` tools, but a model can still try to emit one).
 */
export const COMPACTION_SYSTEM_PROMPT =
  'You are compacting a coding-agent session into ONE dense, faithful handoff ' +
  'summary so a fresh session can resume with no loss of context. Organize the ' +
  'summary under these numbered sections, omitting a section only when it is ' +
  'genuinely empty:\n' +
  '1. Primary task/goal and the current objective.\n' +
  '2. Key decisions and their rationale.\n' +
  '3. Files touched (exact paths) and their current state.\n' +
  '4. Tools/commands run and notable results.\n' +
  '5. Open TODOs and next actions.\n' +
  '6. Current state — exactly where the work left off.\n' +
  '7. User constraints and preferences stated.\n' +
  'CARRY-FORWARD: If the transcript already contains an earlier compaction summary ' +
  '(an earlier [system] summary line), treat it as authoritative for early history ' +
  'and carry every still-relevant fact forward verbatim; never drop detail just ' +
  'because it predates this window.\n' +
  'Produce ONLY the summary text. Do not call any tool, ask questions, or add ' +
  'preamble.';

/** Render one TurnMessage as a flat `[role] ...` line for the folded user payload. */
function serializeTurnMessage(message: TurnMessage): string {
  if (message.role === 'assistant') {
    const toolCalls = message.toolCalls ?? [];
    const tools =
      toolCalls.length > 0
        ? `\n[tools: ${toolCalls.map((call) => call.name).join(', ')}]`
        : '';
    return `[assistant] ${message.content}${tools}`;
  }
  if (message.role === 'tool') {
    return `[tool ${message.toolCallId}] ${message.content}`;
  }
  // system | user
  return `[${message.role}] ${message.content}`;
}

/**
 * Build a tools-less summarization `TurnInput`: a `system` instruction plus the
 * elided-prefix transcript folded into ONE `user` message. Deterministic — the
 * caller supplies `id` (no Date.now / Math.random here).
 */
export function buildCompactionInput(messages: TurnMessage[], id: string): TurnInput {
  const folded = messages.map(serializeTurnMessage).join('\n\n');
  return {
    id,
    messages: [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      { role: 'user', content: folded },
    ],
  };
}

/**
 * Run the summarization turn and return the joined assistant text. Iterates
 * `client.streamTurn(..., [], signal)` (NEVER any tools), accumulating `text-delta`
 * deltas and ignoring everything else. Stops promptly on `signal.aborted` and on a
 * terminal `assistant-done` / `error` / `aborted` event. Returns '' on empty (the
 * caller then skips the dispatch).
 *
 * Failure surfacing (E): a summarizer failure reaches us one of two ways — a THROWN
 * error, or (what every production ModelClient actually does) a yielded
 * `{type:'error'}` AgentEvent. Either one, when NO usable text has streamed and the
 * turn was not aborted, is surfaced by RETHROWING so the MANUAL `/compact` path can
 * report it (auto-compaction swallows it upstream). If some partial text already
 * streamed before the failure, that partial summary is kept and returned instead —
 * never crash the session over a late failure once we have usable output.
 */
export async function runCompaction(
  messages: TurnMessage[],
  client: ModelClient,
  signal: AbortSignal,
): Promise<string> {
  if (messages.length === 0 || signal.aborted) {
    return '';
  }
  const input = buildCompactionInput(messages, `compaction-summary-${messages.length}`);
  let summary = '';
  let errorMessage: string | undefined;
  try {
    for await (const event of client.streamTurn(input, [], signal)) {
      if (signal.aborted) {
        break;
      }
      if (event.type === 'text-delta') {
        summary += event.delta;
      } else if (event.type === 'error') {
        // Production clients report failure by YIELDING this (never by throwing);
        // remember it so a genuine failure surfaces below instead of a silent ''.
        errorMessage = event.message;
        break;
      } else if (event.type === 'assistant-done' || event.type === 'aborted') {
        break;
      }
    }
  } catch (error) {
    // Nothing usable streamed before the failure — surface it (the manual /compact
    // path turns this into an honest notice). A partial summary is kept instead.
    if (summary.length === 0) {
      throw error;
    }
  }
  // An error EVENT with no usable text is a genuine failure too — surface it exactly
  // like a throw would. Stay quiet if the turn was aborted (a cancel, not a failure).
  if (summary.length === 0 && errorMessage !== undefined && !signal.aborted) {
    throw new Error(errorMessage);
  }
  return summary;
}

/**
 * Choose how many trailing committed messages to keep VERBATIM. Walk back from the
 * end accumulating the per-message estimate until adding the next message would
 * exceed `budget` (always keeping ≥ 1) OR a `role:'user'` boundary is reached — so
 * the kept tail tends to OPEN on a coherent user turn. Budget-respecting: when the
 * preceding user turn would blow the budget, the boundary stays inside budget rather
 * than ballooning the tail (which would leave the elided prefix too small to shrink
 * the transcript). Pure + unit-testable; never exceeds `committed.length`, ≥ 1 when
 * the transcript is non-empty.
 */
export function chooseKeepCount(committed: Msg[], budget: number): number {
  if (committed.length === 0) {
    return 0;
  }

  const maxBudget = Number.isFinite(budget) && budget > 0 ? budget : 0;
  let total = 0;
  let count = 0;

  for (let index = committed.length - 1; index >= 0; index -= 1) {
    const message = committed[index]!;
    const next = estimateMessageTokens(message);

    // Budget exhausted (keeping at least one message already): stop.
    if (count > 0 && maxBudget <= 0) {
      break;
    }
    if (count > 0 && maxBudget > 0 && total + next > maxBudget) {
      break;
    }

    total += next;
    count += 1;

    // Stop once the tail opens on a user turn (coherent boundary).
    if (message.role === 'user') {
      break;
    }
  }

  return Math.min(committed.length, Math.max(1, count));
}

/**
 * Snap a `chooseKeepCount` result FORWARD past any leading tool-result messages so the
 * kept tail always opens on a `system`/`user`/`assistant` turn. While the first kept
 * message (`committed[committed.length - keepCount]`) is a `role:'tool'` Msg, decrement
 * `keepCount` — folding that orphan tool result back into the summarized prefix.
 *
 * WHY: after compaction `committed = [summary(system), ...tail]`. If the tail opens on a
 * tool Msg, `toAnthropicMessage` maps it to a `{type:'tool_result', tool_use_id}` block
 * whose originating `tool_use` was elided into the summary — Anthropic then 400s with
 * `tool_result without preceding tool_use` on the very NEXT turn. Snapping past it is the
 * cheap fix. Pure + unit-testable.
 *
 * An all-tool tail (rare aborted/in-flight turn ending on parallel tool results) snaps to
 * 0 — that is CORRECT and safe: the reducer already handles `keepCount:0` (summary-only),
 * and an orphan-free summary-only result beats a hard 400. No `>=1` floor here.
 */
export function snapKeepPastToolResults(committed: Msg[], keepCount: number): number {
  while (keepCount > 0 && committed[committed.length - keepCount]?.role === 'tool') {
    keepCount -= 1;
  }
  return keepCount;
}

// ---------------------------------------------------------------------------
// Bounded compaction retry + degenerate-summary detection.
//
// `runCompaction` makes exactly ONE summarization call and silently skips on an
// empty/failed summary — so a transient blip or a stunted reply just leaves the
// context uncompacted. `runCompactionWithRetry` wraps it in a small bounded retry
// (kept OUT of `runCompaction` so its 9 tests, which assert a single call over a
// 7-char summary, stay green). Retry-After header honoring is NOT available here:
// the wrapper only sees AgentEvent error-message STRINGS, never HTTP headers.
// ---------------------------------------------------------------------------

/** Minimum trimmed length for a summary to count as non-degenerate (< this ⇒ retry). */
export const MIN_SUMMARY_SEED = 200;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

/** Tunable knobs for {@link runCompactionWithRetry}; all optional with safe defaults. */
export interface CompactionRetryOptions {
  /** Max summarization attempts (>=1). Default 3. */
  readonly maxAttempts?: number;
  /** Min trimmed summary length before a reply counts as usable. Default MIN_SUMMARY_SEED. */
  readonly minSummarySeed?: number;
  /** Backoff base (ms) between attempts. Default 250. */
  readonly baseDelayMs?: number;
  /** Backoff cap (ms). Default 2000. */
  readonly maxDelayMs?: number;
  /** Injection seam for the abortable backoff sleep (tests pass a zero/no-op sleep). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Classify a summarizer failure MESSAGE so the retry loop knows whether to bother.
 * Context-length overflow is surfaced distinctly (ports grok's `is_context_length_error`
 * substring list); other 4xx-shaped / validation messages are `deterministic` (no retry);
 * everything else is `transient` (retry). Context-length is checked FIRST so an
 * Anthropic "prompt is too long" 400 classifies as `context_length`, not `deterministic`.
 */
export function classifyCompactionFailure(
  message: string,
): 'context_length' | 'transient' | 'deterministic' {
  const lower = message.toLowerCase();
  const CONTEXT_MARKERS = [
    'context length',
    'context_length_exceeded',
    'maximum context',
    'too many tokens',
    'prompt is too long',
    'input is too long',
    'reduce the length',
    'input length',
  ];
  if (CONTEXT_MARKERS.some((marker) => lower.includes(marker))) {
    return 'context_length';
  }
  const DETERMINISTIC_MARKERS = [
    'invalid',
    'bad request',
    'unprocessable',
    'validation',
    'unauthorized',
    'forbidden',
    'not found',
    'unsupported',
    '400',
    '401',
    '403',
    '404',
    '422',
  ];
  if (DETERMINISTIC_MARKERS.some((marker) => lower.includes(marker))) {
    return 'deterministic';
  }
  return 'transient';
}

/** Exponential backoff (ms) for the delay BEFORE the next attempt, capped. */
function computeBackoff(attempt: number, base: number, cap: number): number {
  return Math.min(base * 2 ** attempt, cap);
}

/** A short sleep that resolves EARLY when `signal` aborts (so a cancel never waits). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run {@link runCompaction} with a bounded, abortable retry. Retries when the returned
 * summary is empty, degenerately short (`< minSummarySeed`), or the call threw a
 * TRANSIENT error; gives up IMMEDIATELY (rethrow) on a deterministic / context-length
 * error. An abort (checked before each attempt and right after each return) is a cancel,
 * not a failure — it returns '' with no further retries. On exhaustion returns the best
 * non-empty summary seen (a short summary still compacts); '' only when truly empty.
 */
export async function runCompactionWithRetry(
  messages: TurnMessage[],
  client: ModelClient,
  signal: AbortSignal,
  opts?: CompactionRetryOptions,
): Promise<string> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const minSeed = opts?.minSummarySeed ?? MIN_SUMMARY_SEED;
  const baseDelayMs = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts?.sleep ?? abortableSleep;

  let best = '';
  let bestLen = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // An abort is a cancel, not a failure — bail with no summary and no retries.
    if (signal.aborted) {
      return '';
    }

    let summary: string;
    try {
      summary = await runCompaction(messages, client, signal);
    } catch (error) {
      if (signal.aborted) {
        return '';
      }
      const message = error instanceof Error ? error.message : String(error);
      // Deterministic / context-length failures never succeed on retry — rethrow now so
      // the caller can surface the (distinct) cause.
      if (classifyCompactionFailure(message) !== 'transient') {
        throw error;
      }
      // Transient: back off and retry, unless this was the final attempt.
      if (attempt < maxAttempts - 1) {
        await sleep(computeBackoff(attempt, baseDelayMs, maxDelayMs), signal);
        continue;
      }
      // Exhausted on a transient error with nothing usable in hand: surface it.
      if (bestLen === 0) {
        throw error;
      }
      break;
    }

    // A post-return abort is still a cancel.
    if (signal.aborted) {
      return '';
    }

    const trimmedLen = summary.trim().length;
    // Keep the longest non-empty summary seen; ties resolve to the latest attempt.
    if (trimmedLen > 0 && trimmedLen >= bestLen) {
      best = summary;
      bestLen = trimmedLen;
    }
    // A summary at/above the seed length is good enough — done.
    if (trimmedLen >= minSeed) {
      return summary;
    }
    // Empty or degenerately short: back off and retry, unless this was the final attempt.
    if (attempt < maxAttempts - 1) {
      await sleep(computeBackoff(attempt, baseDelayMs, maxDelayMs), signal);
    }
  }

  // Exhausted: the best non-empty summary seen (short still compacts); '' if truly empty.
  return best;
}
