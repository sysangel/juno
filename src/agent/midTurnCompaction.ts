// src/agent/midTurnCompaction.ts
// Wave-12 — MID-TURN (preflight) context compaction for the raw-API re-entry loop.
//
// juno's idle compaction (useStreamingTurn.runCompactionStep) only fires AFTER a turn
// settles, and its early-return guard keeps it off while a turn owns `controllerRef`.
// So a single long tool-heavy turn can grow `currentInput.messages` past the context
// window before it ever ends. This module folds the transcript PREFIX into one summary
// at each tool_use re-entry boundary, operating purely on the LOCAL `TurnMessage[]` the
// turnRunner holds — it never touches committed reducer state, so the post-turn idle
// `maybeCompact()` still compacts committed normally (no double-compaction, no conflict).
//
// Sibling to compactor.ts to keep that file pristine: this depends ONLY on the exported
// `runCompaction(TurnMessage[], client, signal)` surface (the one compactor entry point
// that already accepts `TurnMessage[]`), so the concurrent compaction-core changes to
// compactor.ts internals rebase mechanically. `chooseKeepCount` is NOT reused here — its
// signature takes the reducer `Msg[]`, not `TurnMessage[]`; `chooseTurnKeepCount` below is
// the `TurnMessage` analog.
import type { ModelClient, TurnMessage } from '../core/contracts';
import { runCompaction } from './compactor';
import { microcompactTurnMessages } from './microcompact';
import {
  DEFAULT_COMPACTION_THRESHOLD,
  MIN_MESSAGES_TO_COMPACT,
  estimateTurnMessageTokens,
  estimateTurnTranscriptTokens,
} from '../core/selectors';

/**
 * The compaction knobs the mid-turn path reads. A structural SUBSET of `TurnRunnerDeps`
 * (which carries these same optional fields plus `client`), so the turnRunner passes its
 * own `deps` straight through. `maxContext` undefined ⇒ the feature is OFF (backward-compat:
 * every existing turnRunner/coordinator test that threads no `maxContext` stays inert).
 */
export interface MidTurnCompactionDeps {
  readonly client: ModelClient;
  /** Model context window; the mid-turn pressure estimate is a fraction of this. Absent ⇒ feature off. */
  readonly maxContext?: number;
  /** Pressure fraction (0,1] at which mid-turn compaction fires. Default 0.5 (matches idle). */
  readonly compactionThreshold?: number;
  /** Estimated-token budget for the verbatim kept tail. Default ~25% of maxContext (matches idle). */
  readonly compactionKeepBudget?: number;
}

/** Marker prefix for the folded-prefix summary message injected on the summary side. */
export const MID_TURN_SUMMARY_PREFIX = '<compaction-summary>';

/**
 * Choose how many trailing `TurnMessage`s to keep VERBATIM. Mirrors compactor.ts
 * `chooseKeepCount`'s shape — walk back from the end accumulating
 * `estimateTurnMessageTokens` until adding the next message would exceed `budget`
 * (always keeping ≥ 1) OR a `role:'user'` boundary is reached — but over `TurnMessage[]`.
 *
 * THEN snaps the tail boundary FORWARD while the tail's first message is a `role:'tool'`
 * result, so the kept tail never OPENS on an orphan tool_result (the rank-2
 * tool-pair-safety hazard, which the mid-turn split is equally subject to → handled here
 * rather than assumed covered elsewhere). Anthropic rejects a leading tool_result with a
 * 400 on the next request. Forward-only: the snap can only shrink the tail, never grow it,
 * so it can never SEVER the freshly appended `assistant(tool_use)` + `tool(result)` pair —
 * that pair sits at the tail's END, so either the whole pair is kept (boundary lands on or
 * before the assistant) or the whole pair is folded into the summarized prefix (boundary
 * snaps past both), never split across the two sides.
 *
 * Pure + unit-testable; never exceeds `messages.length`.
 */
export function chooseTurnKeepCount(messages: TurnMessage[], budget: number): number {
  if (messages.length === 0) {
    return 0;
  }

  const maxBudget = Number.isFinite(budget) && budget > 0 ? budget : 0;
  let total = 0;
  let count = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const next = estimateTurnMessageTokens(message);

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

  count = Math.min(messages.length, Math.max(1, count));

  // Snap the boundary FORWARD past any leading tool_result so the kept tail never opens
  // on an orphan `role:'tool'` message. Folds those tool results into the summarized
  // prefix. Forward-only, so it can never sever the fresh tool_use/result pair (see above).
  let startIdx = messages.length - count;
  while (startIdx < messages.length && messages[startIdx]!.role === 'tool') {
    startIdx += 1;
  }
  return messages.length - startIdx;
}

/**
 * Best-effort mid-turn compaction of the LOCAL re-entry transcript. Returns `messages`
 * UNCHANGED (same reference) when ANY of:
 *   - `deps.maxContext` is undefined (feature off / backward-compat), OR
 *   - the transcript is at/below a small message floor (`MIN_MESSAGES_TO_COMPACT`;
 *     summary + tail ≈ original, nothing to shrink), OR
 *   - the estimated transcript is under `threshold × maxContext` (no pressure yet), OR
 *   - the signal is already aborted.
 *
 * Otherwise it summarizes the elided prefix through the SAME client (tools-less, via
 * `runCompaction`) and returns `[{ role:'user', content: '<compaction-summary>\n…' }, …tail]`.
 * If the summarizer yields an empty summary, THROWS, or the signal aborts during the
 * network round-trip, it returns the ORIGINAL messages unchanged — context safety over
 * shrinkage; never drop context, never crash the turn. Because the prefix is fully
 * summarized to TEXT, no dangling tool_use survives into the summary side.
 */
export async function maybeCompactTurnMessages(
  messages: TurnMessage[],
  deps: MidTurnCompactionDeps,
  signal: AbortSignal,
): Promise<TurnMessage[]> {
  // Feature off unless a real context window is threaded. Keeps existing turnRunner and
  // coordinator tests (which pass no maxContext) byte-for-byte inert.
  if (deps.maxContext === undefined) {
    return messages;
  }
  // Below the floor a compaction cannot meaningfully shrink the transcript.
  if (messages.length <= MIN_MESSAGES_TO_COMPACT) {
    return messages;
  }
  const threshold = deps.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  if (estimateTurnTranscriptTokens(messages) < threshold * deps.maxContext) {
    return messages;
  }
  // Abort before spending a summarization round-trip.
  if (signal.aborted) {
    return messages;
  }

  // Deterministic no-LLM tier FIRST: clearing the bulk of older tool-result content is
  // pure + I/O-free and often relieves the pressure on its own. If the microcompacted
  // transcript already drops under threshold, RETURN it and skip the LLM round-trip
  // entirely. Otherwise summarize the microcompacted PREFIX so the LLM tier benefits too,
  // and use `micro` (still shrunk, still a valid transcript) as the best-effort FALLBACK.
  const micro = microcompactTurnMessages(messages);
  if (estimateTurnTranscriptTokens(micro) < threshold * deps.maxContext) {
    return micro;
  }

  const budget = deps.compactionKeepBudget ?? Math.floor(deps.maxContext * 0.25);
  const keepCount = chooseTurnKeepCount(micro, budget);
  const splitIdx = micro.length - keepCount;
  const prefix = micro.slice(0, splitIdx);
  const tail = micro.slice(splitIdx);

  let summaryText: string;
  try {
    summaryText = await runCompaction(prefix, deps.client, signal);
  } catch {
    // Best-effort: a summarizer failure still leaves the deterministic microcompaction.
    return micro;
  }
  // Abort during the round-trip, or an empty/degenerate summary: fall back to the
  // deterministic microcompaction (still shrinks context) and let any abort tear the
  // turn down via the existing path.
  if (signal.aborted || summaryText.trim().length === 0) {
    return micro;
  }

  return [{ role: 'user', content: `${MID_TURN_SUMMARY_PREFIX}\n${summaryText}` }, ...tail];
}

/** Conservative fixed tail budget (est. tokens) for reactive compaction when no
 * `maxContext` is threaded — aggressive shrink is fine since we already overflowed. */
export const DEFAULT_REACTIVE_KEEP_BUDGET = 4000;

/** Result of a FORCED reactive compaction: the (possibly rewritten) transcript plus
 * whether it actually shrank (so the caller only retries when there is a point). */
export interface ReactiveCompactionResult {
  readonly messages: TurnMessage[];
  readonly changed: boolean;
}

/**
 * FORCED reactive compaction for the context-overflow recovery path — the sibling of
 * {@link maybeCompactTurnMessages} used AFTER a main call already 400'd on context. It
 * is NOT threshold-gated and NOT feature-gated (there is no `maxContext===undefined`
 * early-out): it is error recovery, so it always attempts to shrink.
 *
 * Budget: `compactionKeepBudget`, else 25% of `maxContext`, else the fixed
 * {@link DEFAULT_REACTIVE_KEEP_BUDGET}. On a minimal transcript (at/below the message
 * floor) there is no room for a summary+tail split, so it deterministically
 * microcompacts. Otherwise it summarizes the elided prefix through the SAME client;
 * on a summarizer throw / empty summary it falls back to the deterministic
 * microcompaction (still a valid, shrunk transcript). An abort mid-roundtrip returns
 * the original unchanged (`changed:false`) so the turn tears down via the existing
 * abort path rather than re-entering on a tripped signal.
 */
export async function forceCompactTurnMessages(
  messages: TurnMessage[],
  deps: MidTurnCompactionDeps,
  signal: AbortSignal,
): Promise<ReactiveCompactionResult> {
  const budget =
    deps.compactionKeepBudget ??
    (deps.maxContext !== undefined
      ? Math.floor(deps.maxContext * 0.25)
      : DEFAULT_REACTIVE_KEEP_BUDGET);

  // Best-effort deterministic shrink used both on the minimal-transcript path and as the
  // fallback when the summarizer yields nothing usable.
  const microResult = (): ReactiveCompactionResult => {
    const micro = microcompactTurnMessages(messages);
    return {
      messages: micro,
      changed: estimateTurnTranscriptTokens(micro) < estimateTurnTranscriptTokens(messages),
    };
  };

  // Below the floor a summary+tail split cannot meaningfully shrink — microcompact only.
  if (messages.length <= MIN_MESSAGES_TO_COMPACT) {
    return microResult();
  }

  const keepCount = chooseTurnKeepCount(messages, budget);
  const splitIdx = messages.length - keepCount;
  const prefix = messages.slice(0, splitIdx);
  const tail = messages.slice(splitIdx);

  let summaryText = '';
  let threw = false;
  try {
    summaryText = await runCompaction(prefix, deps.client, signal);
  } catch {
    threw = true;
  }
  if (!threw && !signal.aborted && summaryText.trim().length > 0) {
    return {
      messages: [{ role: 'user', content: `${MID_TURN_SUMMARY_PREFIX}\n${summaryText}` }, ...tail],
      changed: true,
    };
  }
  // Aborted mid-roundtrip: let the existing abort teardown run; do not rewrite.
  if (signal.aborted) {
    return { messages, changed: false };
  }
  // Threw or empty summary: deterministic fallback still shrinks context.
  return microResult();
}
