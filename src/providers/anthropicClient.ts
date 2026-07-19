import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { asObject, errorMessage, numberField, parseJsonObject, parseToolArgs, stringField, type JsonObject } from './jsonUtil';
import { retryFetch, type RetryOptions, type TimerHandle } from './retryFetch';
import { classifyHttpStatus, classifyThrown, envelope, readErrorBody } from '../core/errorEnvelope';
import { readWithIdleTimeout } from './sseIdleGuard';

/**
 * Default SSE inactivity window (ms). Anthropic token-streams and sends periodic
 * `ping` events (each counts as a chunk and resets the idle timer), so a fully silent
 * connection is abnormal — but the window is generous to tolerate a long silent
 * reasoning gap before the first token. Overridable per-deps or via
 * JUNO_ANTHROPIC_IDLE_TIMEOUT_MS. NEEDS-USER: confirm the 120s default.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export interface AnthropicDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Bounded pre-first-byte retry policy (transient 429/5xx/network blip). Omit for
   * defaults; the retry wraps ONLY the fetch + status check, never the SSE stream. */
  retry?: RetryOptions;
  /** Wave 13 (retry-ui): transport-retry observer, forwarded as `retryFetch`'s 4th arg.
   * Fires synchronously before each backoff sleep so the UI can surface `retrying n/m`.
   * Omit ⇒ retries stay silent. */
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  /**
   * Wave 14 (a5-stream-resilience): mid-stream SSE inactivity window (ms). Zero bytes
   * for this long ⇒ a retryable `timeout` error event (which the turnRunner's stream
   * retry then re-runs). Default 120_000; env override JUNO_ANTHROPIC_IDLE_TIMEOUT_MS
   * (positive integer ms); `deps` wins over both.
   */
  idleTimeoutMs?: number;
  /** Injectable scheduler for the SSE idle guard (deterministic in tests). Default
   * wraps global setTimeout. DISTINCT from `retry.setTimer` (pre-first-byte backoff). */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable wall clock (Date.now) for the guard's host-sleep detection + tests. */
  now?: () => number;
  /** Injectable monotonic clock (process.hrtime.bigint) for host-sleep detection + tests. */
  mono?: () => bigint;
}

/** Parse an env-var string as a positive finite integer (ms), else undefined. */
function envInt(v?: string): number | undefined {
  if (v === undefined) {
    return undefined;
  }
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
/**
 * Raised output ceiling for high/xhigh effort. At 4096 (DEFAULT_MAX_TOKENS) a
 * high/xhigh reasoning turn truncates mid-answer (the thinking budget alone can
 * exceed it). 32000 is a sane, model-appropriate ceiling: comfortably above the
 * reasoning+answer needs of current-gen Claude (Sonnet 4.6 supports far more
 * output) while staying conservative on cost/latency. Effort `medium` keeps the
 * 4096 default (no truncation pressure at the model's default thinking budget).
 */
const EFFORT_MAX_TOKENS = 32000;

interface ToolAccumulator {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

/**
 * Anthropic Messages streaming adapter. Reads the API key INSIDE `streamTurn`
 * at call time; never stores, logs, or emits it. Yields ONLY normalized
 * AgentEvents. Thinking deltas → `reasoning-delta`; `input_json_delta` →
 * `tool-call-delta`; a completed `tool_use` block → `tool-call`.
 */
export function createAnthropicClient(entry: ModelEntry, deps: AnthropicDeps = {}): ModelClient {
  const baseUrl = normalizeBaseUrl(deps.provider?.baseUrl ?? DEFAULT_BASE_URL);
  const apiKeyEnv = deps.provider?.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const retry = deps.retry ?? {};
  const idleTimeoutMs =
    deps.idleTimeoutMs ?? envInt((deps.env ?? process.env).JUNO_ANTHROPIC_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS;

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const apiKey = (deps.env ?? process.env)[apiKeyEnv];
      if (apiKey === undefined || apiKey.length === 0) {
        yield { type: 'error', message: `missing API key for ${entry.provider} (${apiKeyEnv})`, envelope: envelope('auth') };
        return;
      }

      let response: Response;

      try {
        // Retry wraps ONLY the pre-first-byte fetch + status check: a transient
        // 429/5xx/network blip is retried before any assistant-start/delta is
        // yielded. The terminal !ok / body-null branches below and the SSE loop are
        // unchanged — retryFetch returns the final Response or rethrows the final
        // network error into this same catch.
        response = await retryFetch(
          () =>
            fetchImpl(`${baseUrl}/v1/messages`, {
              method: 'POST',
              headers: {
                'anthropic-version': ANTHROPIC_VERSION,
                'content-type': 'application/json',
                'x-api-key': apiKey,
              },
              body: JSON.stringify(buildRequestBody(entry, input, tools)),
              signal,
            }),
          retry,
          signal,
          deps.onRetry,
        );
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errorMessage(error), envelope: classifyThrown(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (!response.ok) {
        // Read the (discarded) body ONLY on this non-ok branch — the client returns
        // immediately, so consuming it is safe. The body feeds classification ONLY
        // (context-length markers); the `message` string is UNCHANGED.
        const bodyText = await readErrorBody(response);
        yield {
          type: 'error',
          message: `provider request failed: ${response.status} ${response.statusText}`,
          envelope: classifyHttpStatus(response.status, bodyText),
        };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (response.body === null) {
        yield { type: 'error', message: 'provider response did not include a stream body', envelope: envelope('unknown') };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      yield { type: 'assistant-start', id: input.id };

      const toolCalls = new Map<number, ToolAccumulator>();
      let stopReason: string | undefined;

      try {
        for await (const event of readAnthropicEvents(response.body, signal, {
          idleTimeoutMs,
          setTimer: deps.setTimer,
          now: deps.now,
          mono: deps.mono,
        })) {
          if (signal.aborted) {
            yield { type: 'aborted' };
            return;
          }

          const data = parseJsonObject(event.data);
          if (data === undefined) {
            continue;
          }

          switch (event.event) {
            case 'message_start': {
              const message = asObject(data.message);
              const usage = message === undefined ? undefined : asObject(message.usage);
              if (usage !== undefined) {
                const tokensIn = numberField(usage, 'input_tokens');
                if (tokensIn !== undefined) {
                  // `contextTokens` = the FULL window occupancy for this request:
                  // billable input + cache-read + cache-creation. `input_tokens` alone
                  // excludes cached tokens, so it would understate the live window when
                  // prompt caching is active; the cost meter still uses the billable
                  // `tokensIn`. Emit input here, but ALWAYS 0 for output: Anthropic
                  // reports the cumulative `output_tokens` again at `message_delta`, and
                  // the reducer's `usage` handler is additive. Counting the message_start
                  // output value too would double-count output by that amount.
                  const cacheRead = numberField(usage, 'cache_read_input_tokens') ?? 0;
                  const cacheCreate = numberField(usage, 'cache_creation_input_tokens') ?? 0;
                  yield {
                    type: 'usage',
                    tokensIn,
                    tokensOut: 0,
                    contextTokens: tokensIn + cacheRead + cacheCreate,
                  };
                }
              }
              break;
            }
            case 'content_block_start': {
              const index = numberField(data, 'index') ?? 0;
              const block = asObject(data.content_block);
              if (block === undefined) {
                break;
              }
              if (stringField(block, 'type') !== 'tool_use') {
                break;
              }
              const id = stringField(block, 'id');
              const name = stringField(block, 'name');
              if (id !== undefined && name !== undefined) {
                toolCalls.set(index, { id, name, argsText: '', emitted: false });
              }
              break;
            }
            case 'content_block_delta': {
              const index = numberField(data, 'index') ?? 0;
              const delta = asObject(data.delta);
              if (delta === undefined) {
                break;
              }
              const type = stringField(delta, 'type');
              if (type === 'text_delta') {
                const text = stringField(delta, 'text');
                if (text !== undefined && text.length > 0) {
                  yield { type: 'text-delta', id: input.id, delta: text };
                }
              } else if (type === 'thinking_delta') {
                const thinking = stringField(delta, 'thinking');
                if (thinking !== undefined && thinking.length > 0) {
                  yield { type: 'reasoning-delta', id: input.id, delta: thinking };
                }
              } else if (type === 'input_json_delta') {
                const argsDelta = stringField(delta, 'partial_json');
                const acc = toolCalls.get(index);
                if (argsDelta !== undefined && argsDelta.length > 0 && acc !== undefined) {
                  acc.argsText += argsDelta;
                  yield { type: 'tool-call-delta', toolCallId: acc.id, argsDelta };
                }
              }
              break;
            }
            case 'content_block_stop': {
              const index = numberField(data, 'index') ?? 0;
              const acc = toolCalls.get(index);
              if (acc !== undefined && !acc.emitted) {
                acc.emitted = true;
                yield {
                  type: 'tool-call',
                  id: input.id,
                  toolCallId: acc.id,
                  name: acc.name,
                  args: parseToolArgs(acc.argsText, index),
                };
              }
              break;
            }
            case 'message_delta': {
              const delta = asObject(data.delta);
              if (delta !== undefined) {
                const stop = stringField(delta, 'stop_reason');
                if (stop !== undefined) {
                  stopReason = stop;
                }
              }
              const usage = asObject(data.usage);
              if (usage !== undefined) {
                const tokensOut = numberField(usage, 'output_tokens');
                if (tokensOut !== undefined) {
                  yield { type: 'usage', tokensIn: 0, tokensOut };
                }
              }
              break;
            }
            case 'ping':
            case 'content_block':
            case 'message_stop':
              break;
            default:
              break;
          }
        }

        yield {
          type: 'assistant-done',
          id: input.id,
          stopReason: stopReasonFromAnthropic(stopReason, toolCalls.size > 0, signal.aborted),
        };
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errorMessage(error), envelope: classifyThrown(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
      }
    },
  };
}

/** Synthetic content for an orphaned tool_use (request-build only; never persisted). */
const ORPHAN_TOOL_RESULT = 'interrupted - no result';

/**
 * Backfill synthetic tool_result entries for any assistant `tool_use` that has no
 * matching `role:'tool'` result in the outgoing history. Anthropic's Messages API
 * returns a hard 400 when a `tool_use` block is not answered by a `tool_result` in
 * the immediately-following user turn, and this backend produces orphans structurally:
 * the reducer never commits a `role:'tool'` message, so `toTurnMessages` rebuilds a
 * committed tool-using assistant turn WITHOUT a following result. On the first model
 * call of any turn whose committed history includes a prior tool-using assistant turn,
 * the direct Anthropic path would otherwise ship an unanswered `tool_use`.
 *
 * This is a PURE request-build transform: it never mutates persisted/reducer state and
 * only ever INSERTS `role:'tool'` entries (never reorders or drops existing ones). The
 * synthetic entry is placed immediately after the assistant, so after map+merge its
 * `tool_result` block lands at the FRONT of the following user turn — satisfying
 * Anthropic's "tool_result ahead of other content in the immediately-following user
 * turn" rule. In-turn re-entry (turnRunner appends real `role:'tool'` results to its
 * local input before re-calling) is a no-op passthrough: those ids are already settled.
 *
 * NOTE: because the reducer never persists real tool results, this stub also lands on
 * committed SUCCESSFUL tool turns on this backend (not just genuine interrupts) — an
 * accepted trade, strictly better than a hard 400. Preserving the real tool output on
 * a committed turn would require a larger change at the toTurnMessages/toolSnapshot
 * layer (out of scope for this lane). Only unmatched `tool_use` gets a synthetic
 * result; a reverse orphan (a `role:'tool'` with no matching `tool_use`) is left as-is.
 */
export function backfillOrphanedToolResults(messages: ReadonlyArray<TurnMessage>): TurnMessage[] {
  const result: TurnMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    result.push(msg);
    if (msg.role !== 'assistant' || msg.toolCalls === undefined || msg.toolCalls.length === 0) {
      continue;
    }
    // A tool_use is "settled" by any role:'tool' result in the CONTIGUOUS run that
    // immediately follows this assistant. Push each real result through unchanged
    // (never reordered, never dropped) and record its id.
    const settled = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const toolMsg = messages[j];
      if (toolMsg.role !== 'tool') break;
      result.push(toolMsg);
      settled.add(toolMsg.toolCallId);
    }
    // Inject a synthetic result for each orphan, in the assistant's original toolCalls
    // order, AFTER any real results so tool_result blocks stay grouped at the FRONT of
    // the following (merged) user turn — a tool_result must precede other content in the
    // turn that answers the tool_use. Non-empty content is required: an empty/
    // whitespace-only tool_result content is itself a hard Anthropic 400.
    for (const call of msg.toolCalls) {
      if (!settled.has(call.toolCallId)) {
        result.push({ role: 'tool', toolCallId: call.toolCallId, content: ORPHAN_TOOL_RESULT });
      }
    }
    // Advance past the contiguous tool run we already consumed so the outer loop does
    // not re-push those results.
    i = j - 1;
  }
  return result;
}

function buildRequestBody(entry: ModelEntry, input: TurnInput, tools: ToolSpec[]): JsonObject {
  // Anthropic renders the request as `tools → system → messages`; ANY byte change
  // in that prefix invalidates the server-side prompt cache for everything after
  // it. So we map ALL of input.messages in original order — toAnthropicMessage
  // already folds a role:'system' transcript entry into the user-role channel
  // (NOT the Opus-4.8-only mid-conversation role:'system' path), which lands
  // volatile content AFTER the cached prefix in conversational position. The only
  // thing kept ahead of the cache breakpoint is the byte-stable input.systemPrompt.
  const body: JsonObject = {
    model: input.model ?? entry.id,
    max_tokens: DEFAULT_MAX_TOKENS,
    stream: true,
    // Backfill runs on TurnMessage[] BEFORE the map: it only INSERTS synthetic
    // role:'tool' entries after an assistant turn (never reorders or drops), so
    // the map+merge below and the §3a cache-prefix ordering commentary above still
    // hold, and the transform is byte-stable across turns for the same history.
    messages: mergeConsecutiveUserMessages(
      backfillOrphanedToolResults(input.messages).map(toAnthropicMessage),
    ),
  };

  // §3c: SECOND ephemeral cache breakpoint on the LAST block of the LAST merged
  // message, so each turn's accumulated history (tools+system PLUS all prior
  // messages) reads from cache. Applied AFTER merge as a post-pass — it never
  // changes which entries exist, their roles, or their order, and never touches
  // the byte-stable system prefix (§3a) above.
  //
  // Verifiable invariants (see applyTrailingCacheBreakpoint below + its tests in
  // tests/modelClients.fake.test.ts):
  //   - exactly ONE breakpoint is added to `messages` — only the single last
  //     block of the single last entry is ever marked; earlier blocks are left
  //     byte-for-byte untouched (test: 'applies exactly one trailing breakpoint'
  //     asserts 1 cache_control in messages, 2 in the whole body incl. §3a).
  //   - empty-content edges (lone empty string, empty `[]` array) are no-ops that
  //     emit no marker — a marked empty block would 400 (tests: 'normalizes a
  //     trailing string-content message…' and 'leaves a trailing assistant entry
  //     with empty content unmarked').
  // The only frozen seam touched is `body.messages`; `body.system` is not read here.
  applyTrailingCacheBreakpoint(body.messages as JsonObject[]);

  // Emit the stable system prompt as a single text block carrying an ephemeral
  // (5-min TTL) cache_control breakpoint, so `tools + system` cache together.
  // Omit body.system entirely when empty/undefined — never emit an empty block.
  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    body.system = [{ type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } }];
  }

  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  return applyEffort(body, input.effort);
}

/**
 * §3c trailing-message cache breakpoint. Marks the LAST content block of the LAST
 * merged message with an ephemeral `cache_control` marker, so the accumulated
 * conversation history (tools + system prefix + all prior messages) is a cache
 * READ each turn (Anthropic's documented incremental prompt-caching pattern; up to
 * 4 breakpoints — we use 2: system prefix + this trailing marker).
 *
 * The marker is INTENTIONALLY volatile: it moves to a new position every turn.
 * That is correct — turn N's breakpoint tells Anthropic to cache the prefix up to
 * that point; turn N+1 then reads up to the OLD breakpoint and writes only the
 * small delta. Do NOT make this byte-stable; byte-stability is the system prefix's
 * job (§3a), not §3c's.
 *
 * Content shapes coexist post-merge, so edges are handled explicitly:
 *  - empty `messages` → no-op (nothing to mark).
 *  - string content (lone unmerged entry): non-empty → normalize to a single marked
 *    text block; empty string → leave as-is (mirrors toContentBlocks dropping empty
 *    strings — fabricating a block would 400).
 *  - non-empty block array → clone the LAST block and add the marker, preserving
 *    order and leaving earlier blocks untouched.
 *  - empty block array `[]` (degenerate trailing assistant) → no-op (no block to
 *    mark; an empty marked block would 400).
 * Only the single last block of the single last entry is ever marked.
 */
function applyTrailingCacheBreakpoint(messages: JsonObject[]): void {
  if (messages.length === 0) {
    return;
  }

  const last = messages[messages.length - 1];
  const content = last.content;

  if (typeof content === 'string') {
    // Non-empty string → normalize to a single marked text block (a bare string
    // cannot carry a per-block cache_control marker). Empty string → normalize to
    // `[]`, the SAME empty-content shape `toContentBlocks` and a trailing empty
    // assistant turn produce, rather than leaving the bare `''` in place: there is
    // no block to mark (a marked empty text block would 400), so the breakpoint is
    // intentionally omitted — but the no-op is now a declared normalization that
    // converges on the empty-array branch below, not a silent string passthrough.
    last.content =
      content.length > 0 ? [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] : [];
    return;
  }

  if (!Array.isArray(content) || content.length === 0) {
    return;
  }

  const blocks = content as JsonObject[];
  const lastBlock = blocks[blocks.length - 1];
  last.content = [...blocks.slice(0, -1), { ...lastBlock, cache_control: { type: 'ephemeral' } }];
}

/**
 * LOAD-BEARING effort hook. Routes the turn's `effort` into the request body for
 * the catalogued current-generation Anthropic model (`claude-sonnet-4-6`):
 *   - `thinking: { type: 'adaptive' }` + `output_config: { effort: <level> }` —
 *     the current-gen path. (Legacy `thinking.budget_tokens` is NOT used: it is
 *     deprecated on 4.6+ and would conflict with adaptive thinking / 400.)
 *   - For high/xhigh, raise `max_tokens` to EFFORT_MAX_TOKENS so the larger
 *     reasoning+answer does not truncate against DEFAULT_MAX_TOKENS (4096).
 * The raw effort string is never emitted as a top-level `effort`/`mode` key — it
 * appears only inside `output_config.effort`. When `effort` is undefined, the
 * body passes through unchanged (model default).
 */
function applyEffort(body: JsonObject, effort: TurnInput['effort']): JsonObject {
  if (effort === undefined) {
    return body;
  }
  body.thinking = { type: 'adaptive' };
  body.output_config = { effort };
  if (effort === 'high' || effort === 'xhigh') {
    body.max_tokens = EFFORT_MAX_TOKENS;
  }
  return body;
}

/**
 * Anthropic's Messages API requires strictly alternating user/assistant turns;
 * two consecutive same-role entries return a 400. `toAnthropicMessage` folds the
 * `role:'system'` transcript channel into a `role:'user'` message (the byte-stable
 * cache prefix lives in body.system, NOT here), and the existing codebase produces
 * two committed conversational paths where a `role:'system'` entry is immediately
 * followed by a `role:'user'` entry — post-compaction ([summary(system), user, ...])
 * and post-error (an error appends a system Msg, then a user submission appends a
 * user Msg). Both map to back-to-back `role:'user'` wire entries. (A `tool` →
 * `role:'user'` entry can also land adjacent to one of these.) Merge any run of
 * consecutive `role:'user'` entries into a single user message with a flattened
 * content array, preserving order, so alternation holds. Assistant entries are
 * pass-through boundaries that break the run.
 */
function mergeConsecutiveUserMessages(messages: JsonObject[]): JsonObject[] {
  const merged: JsonObject[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.role === 'user' && message.role === 'user') {
      previous.content = [...toContentBlocks(previous.content), ...toContentBlocks(message.content)];
      continue;
    }
    merged.push(message);
  }

  return merged;
}

/**
 * Normalize a user-message `content` field (a string from system/user entries, or
 * a block array from tool entries) into a content-block array so adjacent user
 * entries can be concatenated. A string becomes a single `text` block; an empty
 * string contributes no block (an empty text block would 400).
 */
function toContentBlocks(content: unknown): JsonObject[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content as JsonObject[];
  }
  return [];
}

function toAnthropicMessage(message: TurnMessage): JsonObject {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const content: JsonObject[] = [];
      if (message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.toolCallId,
          name: call.name,
          input: call.args,
        });
      }
      return { role: 'assistant', content };
    }
    case 'tool':
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      };
  }
}

interface SseEvent {
  event: string;
  data: string;
}

interface SseGuardOpts {
  idleTimeoutMs: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  now?: () => number;
  mono?: () => bigint;
}

/**
 * Split the response body's chunks (guarded by `readWithIdleTimeout` — a zero-byte
 * stall throws a retryable `StreamStallError` out of here into streamTurn's catch)
 * into `\n\n`-delimited SSE events. Decode + buffer logic is unchanged; only the raw
 * chunk source moved behind the inactivity guard.
 */
async function* readAnthropicEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  opts: SseGuardOpts,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of readWithIdleTimeout(body, signal, {
    idleTimeoutMs: opts.idleTimeoutMs,
    label: 'anthropic',
    setTimer: opts.setTimer,
    now: opts.now,
    mono: opts.mono,
  })) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const parsed = parseSseEvent(part);
      if (parsed !== undefined) {
        yield parsed;
      }
    }
  }

  buffer += decoder.decode();
  const finalEvent = parseSseEvent(buffer);
  if (finalEvent !== undefined) {
    yield finalEvent;
  }
}

function parseSseEvent(message: string): SseEvent | undefined {
  const lines = message.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length === 0 ? undefined : { event, data: dataLines.join('\n') };
}

function stopReasonFromAnthropic(reason: string | undefined, hasToolCall: boolean, aborted: boolean): StopReason {
  if (aborted) {
    return 'abort';
  }
  if (hasToolCall || reason === 'tool_use') {
    return 'tool_use';
  }
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === undefined) {
    return 'end';
  }
  if (reason === 'max_tokens') {
    return 'max_tokens';
  }
  return 'error';
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}
