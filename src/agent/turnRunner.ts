// src/agent/turnRunner.ts
// W6 — drives ONE user submission to completion (looping on `tool_use`).
//
// Consumes `client.streamTurn(...)`, maps each AgentEvent -> Action via
// `eventToAction`, runs tool calls through the executor (which owns the
// permission round-trip), and re-enters tool results into the next turn.
//
// Wiring contract (load-bearing):
//   A. awaitPermission ALWAYS settles. On abort/teardown we drainDeny() the
//      registry so the executor's parked `await` unsticks and emits a terminal
//      error instead of hanging.
//   D. Branch on `assistant-done.stopReason`; `aborted` is itself terminal; a
//      `tool_use` stop with no matching `tool-call` -> emit `error` (no executor
//      call with a phantom call).
import type { Action, ToolState } from '../core/reducer';
import type { AgentEvent, PermissionDecision, StopReason, ToolStatus } from '../core/events';
import { eventToAction } from '../core/events';
import type { ModelClient, ToolExecutor, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { PermissionRegistry } from './eventBus';
import { forceCompactTurnMessages, maybeCompactTurnMessages } from './midTurnCompaction';
import { classifyThrown, envelope } from '../core/errorEnvelope';
import {
  delegationEntry,
  delegationEvidencePrompt,
  isDelegationToolName,
  type DelegationEvidenceEntry,
} from '../core/delegationEvidence';

interface ToolCallRecord {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolResultRecord {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /** Model-facing re-entry text captured off the terminal tool-status event (see
   * events.ts). When present + non-empty on an OK result, it is serialized VERBATIM
   * as the `role:'tool'` content instead of the JSON-wrapped `data`. */
  readonly promptText?: string;
}

export interface TurnRunnerDeps {
  readonly client: ModelClient;
  readonly executor: ToolExecutor;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly dispatch: (action: Action) => void;
  readonly signal: AbortSignal;
  readonly registry: PermissionRegistry;
  /**
   * Per-turn tool-call ceiling (runaway guard) for the raw-API re-entry loop. When the
   * number of tool calls executed in THIS turn reaches the limit, the loop stops with a
   * terminal `error` instead of re-entering the model. Undefined => unbounded. Inert on
   * the claude-cli backend (it never re-loops on `tool_use`).
   */
  readonly maxToolCalls?: number;
  /**
   * Mid-turn (preflight) context compaction knobs for the raw-API re-entry loop. When
   * `maxContext` is set and the LOCAL re-entry transcript crosses `compactionThreshold ×
   * maxContext`, the transcript prefix is folded into one summary (via the SAME `client`)
   * BEFORE re-entering the model, so a long tool-heavy turn cannot blow the context window
   * before it ends. `maxContext` undefined ⇒ the feature is OFF (backward-compat). Defaults
   * match the idle compactor: threshold 0.5, keep-budget ~25% of `maxContext`. See
   * `maybeCompactTurnMessages`.
   */
  readonly maxContext?: number;
  readonly compactionThreshold?: number;
  readonly compactionKeepBudget?: number;
  /**
   * Wave 14 (b8-compaction-resilience): REACTIVE compaction on a main-call
   * context-overflow. Default ON (`undefined` ⇒ enabled) — when the provider yields a
   * `context-overflow` error before any tool ran, the transcript is force-compacted
   * (summary-or-microcompact) ONCE and the SAME turn is retried instead of dead-ending
   * on the overflow. Set `false` to disable (the overflow is then terminal). This is
   * error recovery, so it is NOT threshold-gated and does NOT consume the mid-stream
   * retry budget; it is bounded to one reactive compaction per turn.
   */
  readonly reactiveCompaction?: boolean;
  /** Called after each executed tool call with the running per-turn count (live status mirror). */
  readonly onIteration?: (toolCallsSoFar: number) => void;
  /**
   * Wave 14 (a5-stream-resilience): per-turn budget for TRANSPARENT mid-stream stream
   * retries. When a stream fails mid-flight with a RETRYABLE envelope
   * (network/timeout/rate-limit) BEFORE any provider-side tool executed, the SAME turn
   * input is re-run (up to this many times) instead of surfacing the error — surfaced
   * through the existing `retry-attempt` UI channel, gated so tool side-effects are never
   * re-executed and the reducer's assistant-start reset prevents any duplicate text.
   * Default 2 ⇒ up to 3 stream attempts per turn. 0 disables mid-stream retry.
   */
  readonly maxStreamRetries?: number;
  /**
   * Injectable backoff scheduler for the mid-stream retry (deterministic in tests).
   * Default wraps global setTimeout/clearTimeout.
   */
  readonly setTimer?: (fn: () => void, ms: number) => { clear: () => void };
  /**
   * Drain (return + clear) any guidance queued via `/steer` since the last drain. Drained
   * at TWO re-entry boundaries and appended as the freshest user messages on re-entry:
   *   (a) every raw-API `tool_use` round (claude-cli never emits `tool_use` to the runner);
   *   (b) a CLEAN `end` stop on ANY backend — the turn-end interjection path.
   * (b) DOES reach claude-cli: `cliStopReason` maps end_turn/stop_sequence/tool_use/undefined
   * to `end`, so a steer queued as a cli turn finishes re-enters here too, spawning one more
   * `claude -p --resume`. That is intentional (the interjection is answered without a fresh
   * submit); the resume prompt tail is just the steer — `buildPromptTail` excludes the
   * assistant carry appended below, so the model is not fed its own words. Undefined => no
   * steering (the queue is simply never drained).
   */
  readonly drainSteer?: () => string[];
}

/** Default backoff scheduler for the mid-stream retry — wraps global setTimeout. */
const defaultSetTimer = (fn: () => void, ms: number): { clear: () => void } => {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
};

/**
 * Abortable backoff sleep mirroring `retryFetch.sleep`: schedule `ms` via the
 * injectable timer, but ALSO resolve at once on abort so an Esc during a multi-second
 * backoff is not swallowed by the pending wait. The caller re-checks `signal.aborted`
 * after this resolves; this only ends the wait early.
 */
function abortAwareSleep(
  ms: number,
  signal: AbortSignal,
  setTimer: (fn: () => void, ms: number) => { clear: () => void },
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let handle: { clear: () => void } | undefined;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown turn runner error';
}

/** Capture a terminal tool-status as a re-entry result; null for non-terminal status. */
function resultFromStatus(
  status: ToolStatus,
  result: unknown,
  error: string | undefined,
  promptText?: string,
): ToolResultRecord | null {
  if (status === 'result') {
    return { ok: true, data: result, ...(promptText !== undefined ? { promptText } : {}) };
  }
  if (status === 'error') {
    return { ok: false, error: error ?? 'Tool failed' };
  }
  return null;
}

/**
 * Serialize a tool result into the `role:'tool'` content the model re-reads. An OK
 * result carrying a non-empty `promptText` yields that string VERBATIM (the model
 * reads juno's guidance, not the JSON card payload); everything else keeps the
 * JSON shape. The whitespace guard is load-bearing: an empty/whitespace-only tool
 * content is a hard Anthropic 400, so a blank promptText falls back to JSON.
 */
export function serializeToolResult(
  result: ToolResultRecord,
  maxChars = MAX_MODEL_TOOL_RESULT_CHARS,
): string {
  let serialized: string;
  if (result.ok && result.promptText !== undefined && result.promptText.trim().length > 0) {
    serialized = result.promptText;
  } else {
    try {
      serialized = JSON.stringify(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
    } catch {
      serialized = JSON.stringify({ ok: false, error: 'Tool result was not serializable' });
    }
  }
  const ceiling = Math.max(TOOL_RESULT_ELISION.length, maxChars);
  if (serialized.length <= ceiling) return serialized;
  const half = Math.floor((ceiling - TOOL_RESULT_ELISION.length) / 2);
  return `${serialized.slice(0, half)}${TOOL_RESULT_ELISION}${serialized.slice(-half)}`;
}

/** Per-result model-facing ceiling. Tool implementations may retain an artifact, but a
 * single result must never consume an unbounded share of the next model request. */
export const MAX_MODEL_TOOL_RESULT_CHARS = 100_000;
export const MAX_MODEL_TOOL_RESULTS_PER_TURN_CHARS = 400_000;
export const TOOL_RESULT_ELISION = '\n… [tool result elided to protect context] …\n';
const TOOL_RESULT_BUDGET_EXHAUSTED = '{"ok":false,"error":"Tool-result context budget exhausted; inspect the artifact or rerun a narrower query"}';

/** Decisions the UI must persist on the SHARED policy (allow-once is a no-op by design). */
function isPersistentPermissionDecision(decision: PermissionDecision): boolean {
  return decision === 'always-allow-pattern' || decision === 'dangerous-bypass';
}

export { isPersistentPermissionDecision };

export async function runTurn(input: TurnInput, deps: TurnRunnerDeps): Promise<void> {
  let currentInput = input;
  let abortedDispatched = false;
  // Per-turn tool-call counter (the iteration-budget guard). Reset to 0 here because a
  // fresh `runTurn` is invoked per user submission, so the budget is per-submission by
  // construction. Only incremented for tool calls actually executed (raw-API loop).
  let toolCallsThisTurn = 0;
  let modelToolResultCharsThisTurn = 0;
  // Per-turn TOTAL budget for transparent mid-stream stream retries (persists across
  // attempts — the whole turn shares one budget). See TurnRunnerDeps.maxStreamRetries.
  let streamRetries = 0;
  const maxStreamRetries = deps.maxStreamRetries ?? 2;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  // Wave 14 (b8): reactive compaction on context-overflow is default-ON and bounded to
  // ONE per turn (a second overflow after the retry hits the terminal dispatch, no loop).
  const reactiveCompactionEnabled = deps.reactiveCompaction !== false;
  let reactiveCompactionUsed = false;
  // Evidence ledger for THIS user turn. It is populated only from normalized tool-call
  // and tool-status events, never from model prose. Raw-provider re-entry receives a
  // machine-readable snapshot after each tool round.
  const delegationTools = new Map<string, ToolState>();

  const delegationEntries = (): DelegationEvidenceEntry[] => {
    const entries: DelegationEvidenceEntry[] = [];
    for (const [toolCallId, tool] of delegationTools) {
      const entry = delegationEntry(toolCallId, tool);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  };

  // Track permission overlays we opened but haven't seen resolved. Normally the
  // executor opens (permission-open) and the UI resolves (permission-resolved)
  // within the tool_use branch, leaving this empty. A malformed/fake stream can
  // emit permission-open then terminate non-tool_use, stranding the overlay; we
  // mop those up at the terminal so the prompt can't get stuck (defensive).
  const openPermissionIds = new Set<string>();

  const dispatchEvent = (event: AgentEvent): void => {
    if (event.type === 'permission-open') {
      openPermissionIds.add(event.toolCallId);
    } else if (event.type === 'permission-resolved') {
      openPermissionIds.delete(event.toolCallId);
    }
    if (event.type === 'tool-call' && event.parentToolUseId === undefined && isDelegationToolName(event.name)) {
      delegationTools.set(event.toolCallId, {
        status: 'pending',
        name: event.name,
        args: event.args,
      });
    } else if (event.type === 'tool-status') {
      const existing = delegationTools.get(event.toolCallId);
      if (existing !== undefined) {
        delegationTools.set(event.toolCallId, {
          ...existing,
          status: event.status,
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
        });
      }
    }
    deps.dispatch(eventToAction(event));
  };

  // Resolve/clear any still-open permission overlay at a non-tool_use terminal.
  // Drain the parked await to 'deny' so the executor (if any) unsticks, then
  // dispatch permission-resolved so the reducer drops the overlay. No-op when
  // nothing is open (the normal allow/deny/abort paths already cleared it).
  const clearStrandedPermissions = (): void => {
    if (openPermissionIds.size === 0) {
      return;
    }
    deps.registry.drainDeny();
    for (const toolCallId of openPermissionIds) {
      dispatchEvent({ type: 'permission-resolved', toolCallId, decision: 'deny' });
    }
    openPermissionIds.clear();
  };

  // Drain parked permissions to 'deny' and dispatch the terminal `aborted` action
  // exactly once. drainDeny() is idempotent; the flag guards the reducer action.
  const handleAbort = (reason?: string): void => {
    deps.registry.drainDeny();
    if (!abortedDispatched) {
      abortedDispatched = true;
      dispatchEvent({ type: 'aborted', reason });
    }
  };

  const abortListener = (): void => {
    handleAbort('aborted');
  };

  if (deps.signal.aborted) {
    handleAbort('aborted');
    return;
  }

  deps.signal.addEventListener('abort', abortListener);

  try {
    while (!deps.signal.aborted) {
      const toolCalls: ToolCallRecord[] = [];
      const assistantText: string[] = [];
      const toolResults = new Map<string, ToolResultRecord>();

      let stopReason: StopReason | null = null;
      let deferredDone: Extract<AgentEvent, { type: 'assistant-done' }> | null = null;
      // Mid-stream retry gate + control (per attempt). `sawToolExecution` records that a
      // PROVIDER-side tool ran this attempt (a `tool-status` event — only CLI/fake emit it
      // inside streamTurn, meaning a side-effecting tool ran inside the child); a stream
      // that already ran one must NEVER be re-run. `retryStream` signals a re-run below.
      let sawToolExecution = false;
      let retryStream = false;

      for await (const event of deps.client.streamTurn(currentInput, [...deps.specs], deps.signal)) {
        if (deps.signal.aborted) {
          handleAbort('aborted');
          break;
        }

        if (event.type === 'aborted') {
          handleAbort(event.reason);
          stopReason = 'abort';
          break;
        }

        // Defer EVERY assistant-done — not just `tool_use` — and dispatch it only at the
        // terminal below, AFTER the steer re-entry decision. Two reasons:
        //   - tool_use: tools must run (and their tool-status land) BEFORE we commit the
        //     assistant message, so the <Static> snapshot at commit time has the results.
        //   - end/max_tokens: the commit's phase flip is re-entry-dependent. A steered
        //     turn-end re-entry must commit with `continues:true` (phase stays 'streaming');
        //     a real end commits plain (phase -> 'idle', bell once). Dispatching here — as
        //     the old non-tool_use path did — would flip to 'idle' mid-turn and then, on a
        //     steer re-entry, flicker the spinner/abort off and double-ring the bell.
        if (event.type === 'assistant-done') {
          deferredDone = event;
          stopReason = event.stopReason;
          break;
        }

        // Wave 14: intercept a mid-stream `error` BEFORE it is dispatched (like `aborted`/
        // `assistant-done` above) so a RETRYABLE, pre-tool-execution failure can transparently
        // re-run the SAME turn input instead of surfacing. Gated so tool side-effects are never
        // re-executed and the iteration-budget error (no envelope) can never be picked up here.
        if (event.type === 'error') {
          const retryable = event.envelope?.retryable === true;
          if (retryable && !sawToolExecution && streamRetries < maxStreamRetries && !deps.signal.aborted) {
            streamRetries += 1;
            // 500ms → 1s → 2s → 4s (capped). Mirrors retryFetch's growth on a smaller cap.
            const delayMs = Math.min(4000, 500 * 2 ** (streamRetries - 1));
            // Surface through the EXISTING retry channel: `retry-attempt` sets state.retry
            // (the "retrying n/m · <backoff> backoff" busy line) WITHOUT touching phase; the
            // retry's assistant-start then clears it and hands back to thinking…/responding….
            deps.dispatch({ t: 'retry-attempt', attempt: streamRetries, max: maxStreamRetries, delayMs });
            await abortAwareSleep(delayMs, deps.signal, setTimer);
            retryStream = true;
            // Break WITHOUT dispatching the error and WITHOUT consuming the trailing
            // assistant-done('error'): the generator is abandoned and re-created on re-entry.
            break;
          }
          // Wave 14 (b8): REACTIVE compaction on a context-overflow (which is NOT retryable,
          // so it fell through the transparent-retry gate above). Force-compact the local
          // transcript ONCE and re-enter the SAME turn — like the transparent retry, the error
          // is intercepted BEFORE dispatchEvent, so freeze-on-error never fires and the partial
          // turn is never committed (no double-commit). Bounded by `reactiveCompactionUsed`: a
          // second overflow (retry still too big) falls through to the terminal dispatch below.
          // `!sawToolExecution` mirrors the transparent-retry gate (never re-run a stream after a
          // provider-side tool executed this attempt); context-overflow normally fires at
          // request-build time so this is usually false anyway.
          const overflow = event.envelope?.kind === 'context-overflow';
          if (reactiveCompactionEnabled && overflow && !reactiveCompactionUsed && !sawToolExecution && !deps.signal.aborted) {
            reactiveCompactionUsed = true;
            const result = await forceCompactTurnMessages(currentInput.messages, deps, deps.signal);
            if (deps.signal.aborted) {
              handleAbort('aborted');
              break;
            }
            if (result.changed) {
              deps.dispatch({ t: 'notice', text: 'context overflow — compacted the transcript and retrying' });
              currentInput = { ...currentInput, messages: result.messages };
              // Reuse the transparent-retry re-entry mechanism: line ~363 does `continue` on
              // retryStream, re-running streamTurn with the now-compacted currentInput.
              retryStream = true;
              break;
            }
            // Could not shrink → fall through to the terminal dispatch below (never loop).
          }
          // Terminal: dispatch the error (freeze-on-error commits the partial + ✗ line, stores
          // errorEnvelope, clears retry) and stop. Non-retryable, tool already ran, budget spent,
          // or aborted all land here.
          dispatchEvent(event);
          stopReason = 'error';
          break;
        }

        dispatchEvent(event);

        switch (event.type) {
          case 'assistant-start':
          case 'reasoning-delta':
          case 'tool-call-delta':
          case 'permission-open':
          case 'permission-resolved':
          case 'usage':
            break;

          case 'text-delta':
            assistantText.push(event.delta);
            break;

          case 'tool-call':
            toolCalls.push({ toolCallId: event.toolCallId, name: event.name, args: event.args });
            break;

          case 'tool-status': {
            // A `tool-status` inside streamTurn means a PROVIDER-side tool actually ran
            // (CLI/fake backends; raw-API tools run in the runner AFTER the stream). Once
            // one has run, a mid-stream failure must NOT re-run the stream (re-executing a
            // side-effecting tool). Capture terminal status for re-entry correlation too.
            sawToolExecution = true;
            const terminal = resultFromStatus(event.status, event.result, event.error, event.promptText);
            if (terminal !== null) {
              toolResults.set(event.toolCallId, terminal);
            }
            break;
          }

          default: {
            const exhaustive: never = event;
            throw new Error(`Unhandled agent event: ${JSON.stringify(exhaustive)}`);
          }
        }

        if (stopReason !== null) {
          break;
        }
      }

      // Wave 14: a transparent stream retry was scheduled (retryable, pre-tool-execution,
      // budget remaining; the backoff already elapsed). Re-enter the outer while WITHOUT
      // running the post-stream tool/re-entry logic and WITHOUT mutating currentInput, so
      // streamTurn is re-called with the IDENTICAL input. The while body re-declares fresh
      // accumulators; the provider re-emits assistant-start which resets `live` (no
      // duplicate text reaches the UI). An abort racing the backoff falls through to the
      // handleAbort below instead.
      if (retryStream && !deps.signal.aborted) {
        continue;
      }

      if (deps.signal.aborted) {
        handleAbort('aborted');
        break;
      }

      // Stream ended without a terminal stopReason (e.g. empty stream): stop.
      if (stopReason === null) {
        clearStrandedPermissions();
        break;
      }

      // Only `tool_use` re-enters. end/max_tokens/error/abort are terminal here —
      // EXCEPT a CLEAN `end` with queued steer guidance, which re-enters ONCE more so a
      // user's turn-end interjection is answered without forcing a fresh submission.
      if (stopReason !== 'tool_use') {
        // The terminal assistant-done (if any) is DEFERRED in `deferredDone` and NOT yet
        // dispatched — so we can decide re-entry BEFORE committing it. Turn-end steer
        // re-entry reaches every backend, not just raw-API: `cliStopReason` maps
        // claude-cli's terminal reasons to `end`, so a cli turn-end steer re-enters too
        // (one more `claude -p --resume` whose tail is just the steer). Edge cases:
        //  1. Gate STRICTLY to `end`. Never re-enter on 'max_tokens' (the model was
        //     truncated — re-entering compounds it), 'error', or 'abort' (those already
        //     funnel through handleAbort/clearStrandedPermissions; do not add them).
        //  3. Re-check !signal.aborted so a steer racing an abort LOSES to the abort.
        if (stopReason === 'end' && !deps.signal.aborted) {
          const steers = deps.drainSteer?.() ?? [];
          if (steers.length > 0) {
            // Commit the just-finished answer with `continues:true` so the reducer keeps
            // phase 'streaming' across the re-entry (mirrors the tool_use inter-request
            // gap): no mid-turn idle flicker, and the completion bell rings exactly once at
            // the REAL end. deferredDone is non-null here (stopReason==='end' comes only
            // from an assistant-done event), but guard defensively. Dispatch the action
            // directly (bypassing dispatchEvent/eventToAction) to carry `continues`.
            if (deferredDone !== null) {
              deps.dispatch({
                t: 'assistant-done',
                id: deferredDone.id,
                stopReason: deferredDone.stopReason,
                continues: true,
              });
            }
            // currentInput — the LOCAL array driving streamTurn — was never updated with
            // the assistant-done (only the tool_use branch appends, below). So on re-entry
            // re-show the model its own just-finished answer, THEN the steer. Omit
            // toolCalls: there are none on an `end` stop. (On claude-cli buildPromptTail
            // strips this assistant carry from the resume tail; on raw-API it is re-sent.)
            const text = assistantText.join('');
            //  2. Empty assistantText (end with no text): append ONLY the steer, skip the
            //     empty assistant block — some providers reject empty assistant content.
            const carry: TurnMessage[] =
              text.length > 0 ? [{ role: 'assistant', content: text }] : [];
            const steerMessages: TurnMessage[] = steers.map((content) => ({
              role: 'user',
              content,
            }));
            currentInput = {
              ...currentInput,
              messages: [...currentInput.messages, ...carry, ...steerMessages],
            };
            //  4. Re-entry is user-bounded: drainSteer empties its queue, so this only
            //     continues while the user keeps steering — not a runaway. The maxToolCalls
            //     guard still applies to any tool calls a steer triggers on re-entry, and
            //     toolCallsThisTurn is intentionally NOT reset (keep the budget honest).
            continue;
          }
        }
        // No re-entry: NOW dispatch the deferred terminal assistant-done normally (phase ->
        // 'idle', bell rings once), then clear any stranded permission overlay.
        if (deferredDone !== null) {
          dispatchEvent(deferredDone);
        }
        clearStrandedPermissions();
        break;
      }

      // Malformed-args guard: a tool_use stop with NO tool-call we actually saw.
      if (toolCalls.length === 0) {
        if (deferredDone !== null) {
          dispatchEvent(deferredDone);
        }
        dispatchEvent({
          type: 'error',
          message: 'Model requested tool use but did not provide a tool call.',
          envelope: envelope('tool'),
        });
        break;
      }

      // Run each tool call through the executor. The executor emits
      // permission-open (-> overlay) and the tool-status lifecycle; the runner
      // does NOT separately emit those for executor-driven calls.
      for (const call of toolCalls) {
        const emit = (event: AgentEvent): void => {
          if (event.type === 'tool-status') {
            const terminal = resultFromStatus(event.status, event.result, event.error, event.promptText);
            if (terminal !== null) {
              toolResults.set(event.toolCallId, terminal);
            }
          }
          dispatchEvent(event);
        };

        await deps.executor.execute(call.toolCallId, call.name, call.args, emit);

        // Count this executed tool call against the per-turn budget and surface the
        // running total for the live status indicator.
        toolCallsThisTurn += 1;
        deps.onIteration?.(toolCallsThisTurn);

        if (deps.signal.aborted) {
          handleAbort('aborted');
          break;
        }

        if (!toolResults.has(call.toolCallId)) {
          toolResults.set(call.toolCallId, { ok: false, error: 'Tool did not complete.' });
        }
      }

      if (deps.signal.aborted) {
        handleAbort('aborted');
        break;
      }

      // Now commit the assistant turn (with its tool blocks snapshotted). deferredDone
      // here is the `tool_use` stop — dispatched plain so the reducer keeps phase
      // 'streaming' across the tool-result re-entry (stopReason==='tool_use').
      if (deferredDone !== null) {
        dispatchEvent(deferredDone);
      }

      const assistantMessage: TurnMessage = {
        role: 'assistant',
        content: assistantText.join(''),
        toolCalls: toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          name: call.name,
          args: call.args,
        })),
      };

      const toolMessages: TurnMessage[] = toolCalls.map((call) => {
        const remaining = MAX_MODEL_TOOL_RESULTS_PER_TURN_CHARS - modelToolResultCharsThisTurn;
        const content =
          remaining <= TOOL_RESULT_BUDGET_EXHAUSTED.length
            ? TOOL_RESULT_BUDGET_EXHAUSTED
            : serializeToolResult(
                toolResults.get(call.toolCallId) ?? { ok: false, error: 'Tool did not complete.' },
                Math.min(MAX_MODEL_TOOL_RESULT_CHARS, remaining),
              );
        modelToolResultCharsThisTurn += content.length;
        return { role: 'tool', toolCallId: call.toolCallId, content };
      });

      // Iteration-budget guard (runaway loop breaker). Checked HERE — after the assistant
      // turn + tool results are committed — so the breach message lands as the final
      // committed entry and no half-run tool is orphaned. The `error` event maps to the
      // reducer's terminal `{ t:'error' }` (phase:'error' + committed system Msg), and the
      // `finally` drain still runs. Place this BEFORE the steer splice so a breaching turn
      // never appends a steer it will never send.
      if (deps.maxToolCalls !== undefined && toolCallsThisTurn >= deps.maxToolCalls) {
        // NO envelope: this is a LOCAL runaway-loop breaker, not a provider failure —
        // no consumer lane should transparently retry it. Deliberately unclassified
        // (omit rather than guess `unknown`) so a retry lane cannot pick it up.
        dispatchEvent({
          type: 'error',
          message: `Iteration budget exceeded: ${toolCallsThisTurn} tool calls in one turn (limit ${deps.maxToolCalls}). Stopping to prevent a runaway loop. Send a new message to continue.`,
        });
        break;
      }

      // /steer mid-turn inject: drain any guidance queued since the last boundary and append
      // it LAST so it is the freshest instruction the model reads on re-entry. THIS `tool_use`
      // boundary is raw-API only (claude-cli never emits `tool_use` to the runner); the
      // turn-end `end` boundary above additionally re-enters on claude-cli. On claude-cli a
      // steer queued during a tool_use-less turn therefore rides the turn-end drain, not here.
      const steers = deps.drainSteer?.() ?? [];
      const steerMessages: TurnMessage[] = steers.map((content) => ({ role: 'user', content }));

      // Replace (rather than append beside) the previous evidence block so repeated tool
      // rounds carry one current fact block, not an ever-growing audit trail.
      const messagesWithoutOldEvidence = currentInput.messages.filter(
        (message) =>
          !(
            message.role === 'system' &&
            message.content.startsWith('<juno-delegation-evidence source="recorded-tool-events">')
          ),
      );
      const evidence = delegationEntries();
      const evidenceMessages: TurnMessage[] = evidence.length > 0
        ? [{ role: 'system', content: delegationEvidencePrompt(evidence) }]
        : [];
      const nextMessages: TurnMessage[] = [
        ...messagesWithoutOldEvidence,
        assistantMessage,
        ...toolMessages,
        ...evidenceMessages,
        ...steerMessages,
      ];

      // Mid-turn (preflight) context compaction. Fold the transcript prefix into one summary
      // BEFORE re-entering the model so a long tool-heavy turn cannot blow the context window
      // before it ends (juno's idle compactor only fires AFTER a turn settles). Placed AFTER
      // the iteration-budget guard above so a breaching turn never spends a summarization call.
      //
      // This rewrites ONLY the LOCAL `currentInput.messages` array — it does NOT dispatch to
      // the reducer, so committed state is untouched and the post-turn idle `maybeCompact()`
      // still compacts committed normally (no double-compaction, no conflict). Inert unless a
      // `maxContext` dep is threaded (feature off by default); best-effort, so an empty/failed
      // summary returns the transcript unchanged.
      const compacted = await maybeCompactTurnMessages(nextMessages, deps, deps.signal);

      // Summarization is a network round-trip: an abort during it discards the compaction and
      // routes to the existing teardown path rather than re-entering the model with a signal
      // that just tripped.
      if (deps.signal.aborted) {
        handleAbort('aborted');
        break;
      }

      currentInput = {
        ...currentInput,
        messages: compacted,
      };
    }
  } catch (error) {
    if (deps.signal.aborted) {
      handleAbort('aborted');
      return;
    }
    // Catch-all for errors thrown INSIDE turnRunner (tool executor / compaction /
    // unexpected). Provider-yielded error events already carry their own envelope
    // and pass THROUGH dispatchEvent above with it intact; this only fires here.
    dispatchEvent({ type: 'error', message: toErrorMessage(error), envelope: classifyThrown(error) });
  } finally {
    deps.signal.removeEventListener('abort', abortListener);
    // Teardown drain: any permission still parked (e.g. an early return path)
    // resolves to 'deny' so no awaitPermission caller can hang past this turn.
    deps.registry.drainDeny();
  }
}
