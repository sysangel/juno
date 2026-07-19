// src/agent/microcompact.ts
// Wave-14 (b8-compaction-resilience) — DETERMINISTIC no-LLM microcompaction tier.
//
// A PURE, I/O-free, client-free shrink of a `TurnMessage[]` re-entry transcript: it
// clears the CONTENT of older `role:'tool'` results (the bulk that dominates a
// tool-heavy turn) to a short placeholder while keeping the most-recent N verbatim,
// and passes every user/assistant/system message through UNCHANGED. Decisions and
// recent narrative are preserved, which is what makes it safe to apply without a model.
//
// Load-bearing invariant (the whole point over an LLM summary): message COUNT, ORDER,
// ROLES, and every `toolCallId` are invariant — so tool_use/tool_result pairing
// survives by construction and this tier can NEVER 400 on orphan pairing the way a
// prefix-fold summary can. Used two ways: as the first tier inside
// `maybeCompactTurnMessages` (skip the LLM round-trip when clearing tool bulk alone
// relieves the pressure) and as the deterministic FALLBACK when the summarizer fails.
import type { TurnMessage } from '../core/contracts';

/** Knobs for {@link microcompactTurnMessages}; all optional with safe defaults. */
export interface MicrocompactOptions {
  /** How many of the MOST-RECENT tool results to keep verbatim. Default 3. */
  keepRecentToolResults?: number;
  /** Chars of the original tool content to keep as a head prefix before the placeholder. Default 0. */
  headChars?: number;
  /** Replacement text for a cleared older tool result. */
  placeholder?: string;
}

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 3;
const DEFAULT_HEAD_CHARS = 0;
const DEFAULT_PLACEHOLDER = '[tool output cleared to save context]';

/**
 * Return a NEW transcript in which every `role:'tool'` message OLDER than the last
 * `keepRecentToolResults` tool messages has its `content` replaced by a short
 * placeholder (optionally keeping a `headChars`-long head prefix), while the recent
 * tool results, and all user/assistant/system messages, pass through unchanged.
 *
 * The replacement is applied ONLY when it is actually shorter than the original — a
 * short tool result is never expanded. Inputs are never mutated (a fresh array is
 * returned; unchanged messages are returned by reference). Message count, order,
 * roles, and every `toolCallId` are invariant, so tool_use/tool_result pairing is
 * preserved by construction. A transcript with `<= keepRecentToolResults` tool
 * messages is returned equivalent (no shrink).
 */
export function microcompactTurnMessages(
  messages: TurnMessage[],
  opts?: MicrocompactOptions,
): TurnMessage[] {
  const keepRecent = opts?.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const headChars = opts?.headChars ?? DEFAULT_HEAD_CHARS;
  const placeholder = opts?.placeholder ?? DEFAULT_PLACEHOLDER;

  // Indices of every role:'tool' message, in order.
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]!.role === 'tool') {
      toolIndices.push(index);
    }
  }

  // The LAST keepRecent tool messages are kept verbatim; earlier ones are candidates
  // for clearing. `<= keepRecent` tool messages ⇒ nothing to clear (all verbatim).
  const firstVerbatim = Math.max(0, toolIndices.length - Math.max(0, keepRecent));
  const keptVerbatim = new Set<number>(toolIndices.slice(firstVerbatim));

  return messages.map((message, index) => {
    if (message.role !== 'tool' || keptVerbatim.has(index)) {
      return message;
    }
    const replacement =
      headChars > 0 ? `${message.content.slice(0, headChars)}\n${placeholder}` : placeholder;
    // Never EXPAND a short tool result — only replace when it strictly shrinks.
    if (replacement.length >= message.content.length) {
      return message;
    }
    return { role: 'tool', toolCallId: message.toolCallId, content: replacement };
  });
}
