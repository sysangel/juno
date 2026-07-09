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

/** The summarization instruction. Dense + faithful; chatter omitted. */
export const COMPACTION_SYSTEM_PROMPT =
  'You are compacting a coding-agent session. Produce a dense, faithful summary ' +
  'preserving: task/goal, decisions, file paths touched, open TODOs, and the latest ' +
  'state. Omit chatter.';

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
 * Failure surfacing (E): if the summarizer throws BEFORE any text streamed, the
 * error is RETHROWN so the MANUAL `/compact` path can report it (auto-compaction
 * swallows it upstream). If some partial text already streamed before the throw,
 * that partial summary is kept and returned instead — never crash the session over
 * a late failure once we have usable output.
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
  try {
    for await (const event of client.streamTurn(input, [], signal)) {
      if (signal.aborted) {
        break;
      }
      if (event.type === 'text-delta') {
        summary += event.delta;
      } else if (
        event.type === 'assistant-done' ||
        event.type === 'error' ||
        event.type === 'aborted'
      ) {
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
