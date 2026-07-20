// src/core/reducer.ts
// W3 — the single PURE reducer. Every other unit builds against State/Action/Msg.
//
// Purity contract: no I/O, no Date.now, no Math.random, never mutates its inputs.
// On a no-op it returns the SAME state reference (consumers may rely on `===`).
import type { PermissionDecision, RiskLevel, StopReason, ToolStatus } from './events';
import type { ProviderErrorEnvelope } from './errorEnvelope';
import { INTERRUPTED_NOTICE } from './abort';

export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type PermissionMode = 'default' | 'acceptEdits';

/**
 * Append-only message blocks with stable, monotonic block ids derived from the
 * owning message id + append index (`<msgId>:block:<n>`). Never a render index,
 * never Math.random — so React keys stay stable across redraws.
 */
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string }
  /**
   * System-feedback line (F. feedback + empty states): rendered dim, never fed to
   * the model. Carries its own text (unlike `tool`, which references the live map).
   * Emitted by the `notice` action and by `clear` (the `session cleared` line).
   */
  | { kind: 'notice'; id: string; text: string }
  /**
   * Persistence-only forward-compat passthrough for an UNRECOGNIZED block kind.
   * NEVER produced by the reducer — only materialized by the session reader
   * (`src/services/sessions.ts` `parseBlock`) when it loads a block whose `kind`
   * it does not recognize (e.g. a newer juno persisted an `image`/`reasoning`
   * block, or an older/rolled-back build is reading a forward-format file). `raw`
   * holds the ORIGINAL parsed object verbatim so the reader→writer round-trip is
   * byte-identical (the write path re-emits `raw` in place). `toTurnMessages`
   * already strips it (it is never sent to the model) and the renderer draws
   * nothing for it.
   *
   * It MUST be a first-class Block (not a persistence-local type) because the
   * resume path threads loaded messages through reducer State: `load()` →
   * `resume-session` (this reducer copies `action.messages` verbatim into
   * `committed`) → `save()`. A passthrough that was not a real Block would be
   * dropped on the first resume+resave.
   */
  | { kind: 'unknown'; id: string; raw: Record<string, unknown> };

/** A single tool call's accumulated state in the live `tools` map. */
export interface ToolState {
  status: ToolStatus;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  /**
   * Partial tool-arg JSON accumulated from `tool-call-delta` events while the
   * model streams arguments. The final, parsed `args` arrive on `tool-call`.
   */
  argsText?: string;
  /**
   * For a subagent's child tool call: the parent tool_use id this call was
   * spawned under. Set on BOTH subagent paths — the claude-cli native
   * `parent_tool_use_id` from the CLI stream, and the juno orchestrator's
   * re-emitted child events (`spawn_subagent`, which stamps the spawning call's
   * id; see src/tools/subagentTool.ts). Drives nested rendering — the renderer
   * groups child cards beneath the parent whose `toolCallId` equals this value.
   * Absent for top-level (non-subagent) calls.
   */
  parentToolUseId?: string;
  /**
   * The backend a SUBAGENT ran on (decision d): `entry.provider` resolved at the spawn
   * source (`src/tools/subagentTool.ts`), classified for rendering by `providerKindOf`.
   * Absent live and for non-subagent cards; set only on PLAYBACK — the reader rehydrates
   * it onto a resumed subagent's spawn card from the durable provider meta line
   * (`src/services/subagentReader.ts`) so the below-composer panel can tag a rehydrated
   * cross-provider subagent honestly. The live panel derives the same value from the
   * settled spawn card's result (`selectSubagents`), so it never needs this field.
   */
  provider?: string;
  /**
   * Concurrency-batch id (grouped-tool-rows). Stamped on a TOP-LEVEL tool call at
   * dispatch time: a new call joins the batch of any sibling top-level call still
   * non-terminal (pending/running) at that instant — they are "in flight together" —
   * inheriting its id; otherwise it opens a fresh batch keyed on its own id. This is the
   * honest concurrency signal for BOTH runtime paths: on raw-API every tool call of one
   * assistant message lands `pending` before the sequential executor runs any (so each
   * later call sees the earlier ones still non-terminal), and on claude-cli parallel
   * `tool_use`s land `pending` together while sequential rounds resolve before the next
   * call arrives. The renderer groups ADJACENT same-id top-level cards into one live/
   * condensed unit (src/ui/toolGroups.ts + Message.tsx); a lone id renders as today's
   * single card. Absent for subagent children (grouped by `parentToolUseId` instead) and
   * for a call registered with no live turn.
   */
  concurrencyGroupId?: string;
}

export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  /**
   * Accumulated extended-thinking / reasoning text for this message, built from
   * `reasoning-delta` events. Kept off the block list (it renders separately,
   * collapsed by default). Absent until the first reasoning delta arrives.
   */
  reasoning?: string;
  /**
   * Wall-clock instants (ms) bounding the extended-thinking phase, stamped at the
   * dispatch edge (NOT in this pure reducer — carried in on `action.ts`). `start`
   * is the first `reasoning-delta`; `end` is the first visible content that ends
   * thinking (a `text-delta`/`tool-call`, else `assistant-done` for a
   * pure-thinking turn). Both OPTIONAL — absent when the edge supplied no clock
   * (unit tests / non-runtime callers), in which case the committed marker omits
   * its duration (`✻ thought` instead of `✻ thought for <n>s`). thinking-collapse.
   */
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  /**
   * Frozen snapshot of every tool call this message references, set ONLY at
   * commit time (`assistant-done`) so the <Static> committed render path never
   * reads the live `tools` map.
   */
  toolSnapshot?: Record<string, ToolState>;
  /**
   * Optional tone discriminator for a committed message. `'error'` marks a
   * FAILED-turn line (stamped by the `error` case) so the renderer surfaces it
   * with a bold `✗ error` heading in the error token instead of the dim neutral
   * `system` heading — a benign `session cleared` notice and a dropped-provider
   * failure are otherwise visually identical. OPTIONAL/additive so the persisted
   * shape stays forward-compatible; sessions written before this field fall back
   * to the `system-error-` id prefix for the same rendering (Message.tsx).
   */
  tone?: 'error';
}

export interface State {
  committed: Msg[];                 // -> Ink <Static>, printed once, never redrawn
  live: Msg | null;                 // the current streaming assistant turn
  tools: Record<string, ToolState>;
  /**
   * The SOLE authority for "a turn / compaction is in flight." Two busy states were
   * added so the reducer owns the whole lifecycle rather than mirroring it out to a
   * `controllerRef`/`compactingRef`/`optimisticTurn` trio:
   *   - 'preparing'  — a turn has been submitted but `assistant-start` has not arrived
   *                    yet (covers the ambient-recall await, the pre-first-byte gap, and
   *                    the initial-call retry backoff). REPLACES the old optimisticTurn.
   *   - 'compacting' — a compaction LLM call is in flight. REPLACES compactingRef/isCompacting.
   * Every phase change routes through the pure `transitionPhase()` below; `selectBusy`
   * reads this one field and every UI surface reads `selectBusy`/`selectActivity`.
   */
  phase: 'idle' | 'preparing' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'compacting' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker' | 'skill-picker' | 'permission-mode' | 'session-picker' | 'help' | 'mcp' | 'tool-detail' | 'subagents' | 'subagent-viewer' | 'message-agent';
  effort: 'medium' | 'high' | 'xhigh';
  /** Runtime-selectable permission mode (seeded from config; selector-driven). */
  permissionMode: PermissionMode;
  tokens: { in: number; out: number };

  /**
   * Live context-window occupancy: the FULL input-token count of the MOST RECENT
   * request (prompt + cache-read + cache-creation), REPLACED — not accumulated —
   * on every `usage` event that carries a measurement. This is what the
   * context-window monitor reads to answer "how full is the window right now,"
   * distinct from `tokens` (lifetime cumulative spend, which over-counts re-sends).
   *
   * OPTIONAL so the shape stays additive (NOT set by `initialState()`); always read
   * as `state.contextWindowTokens ?? <estimate>`. Reset to absent on `clear` (empty
   * transcript) and `resume-session`/`compact` (the transcript changed structurally,
   * so the last real measurement is stale — the estimate stands in until the next turn
   * re-measures).
   */
  contextWindowTokens?: number;

  // --- W3-PROPOSED additions to the frozen shape (flagged in NOTES) ---
  /**
   * The tool call the permission overlay is resolving, WITH the risk level that
   * governs its prompt; null when no prompt is open. The risk moved INTO reducer
   * state (from a permissionRisksRef side-table) so there is one authority: the
   * `permission-open` action carries the risk and every terminal that closes the
   * prompt (permission-resolved/aborted/error/compact/resume-session, and a settling
   * top-level tool-status — result/error — for that id) clears this field — which
   * structurally fixes the old side-table's error-while-open leak.
   */
  pendingPermission: { toolCallId: string; risk: RiskLevel } | null;
  /** Surfaced error text for `phase === 'error'`; null otherwise. */
  errorMessage: string | null;
  /**
   * Machine-readable classification for `phase === 'error'`; absent when
   * unclassified. ADDITIVE — NOT set by `initialState()` (mirrors
   * `compactions`/`transcriptEpoch`); always read as `state.errorEnvelope`.
   * Downstream lanes branch on `errorEnvelope.kind` / `errorEnvelope.retryable`.
   * Cleared (set undefined) on `resume-session`, mirroring `errorMessage`'s lifecycle.
   */
  errorEnvelope?: ProviderErrorEnvelope;

  /**
   * Reducer-owned monotonic count of GENUINELY-completed user turns (an
   * `assistant-done` whose stopReason is 'end'/'max_tokens' and which is not a
   * tool_use / steer re-entry). Drives the completion bell: the bell rings on a
   * count INCREMENT, not a phase edge, because both a natural completion and an
   * abort land at 'idle' — only this monotonic counter distinguishes them, so an
   * Esc-abort never rings. OPTIONAL/additive (NOT set by `initialState()`); always
   * read as `state.completedTurns ?? 0`. Reset to absent by clear/resume-session.
   */
  completedTurns?: number;

  /**
   * Monotonic per-session cursor holding the NEXT `notice-<n>` / `system-error-<n>`
   * sequence to mint (0-indexed): a mint reads the current value for the id, then
   * stores `value + 1`. So a single `error`/`notice` from `initialState()` is
   * `…-0`, matching the historical `committed.length`-derived id it replaces — that
   * old scheme minted DUPLICATE React keys after a compaction kept-tail shrank
   * `committed` back past a prior notice's index. One shared cursor across notice
   * AND error so the two id families can never collide either. OPTIONAL/additive
   * (NOT set by `initialState()`); always read as `state.noticeSeq ?? 0`. Reset to
   * absent by clear; seeded past the loaded transcript's max on resume-session.
   */
  noticeSeq?: number;

  // --- W6 Context-Compression addition (ADDITIVE, optional — absent/0 initially) ---
  /**
   * Count of summarize-and-rebuild compactions performed this session. OPTIONAL so
   * the State shape stays additive (NOT set by `initialState()`); always read as
   * `state.compactions ?? 0`. Drives the deterministic, pure `compaction-<n>`
   * summary id (no Date.now / Math.random).
   */
  compactions?: number;

  /**
   * Monotonic transcript-generation counter, bumped whenever `committed` is
   * REPLACED wholesale (`resume-session` / `compact` / `clear`) rather than grown
   * by appending. Ink's `<Static>` is append-only — it tracks an internal index
   * that only ever advances to `items.length`, so it renders `items.slice(index)`
   * and would silently DROP the leading messages of a replaced array. The UI passes
   * this as `<Static key={epoch}>`, and a changed key remounts Static (resetting its
   * index to 0) so the whole replaced transcript re-renders from scratch. OPTIONAL so
   * the shape stays additive (NOT set by `initialState()`); always read as
   * `state.transcriptEpoch ?? 0`. NOT bumped by appends (`user-submit`,
   * `assistant-done`, `error`) — remounting on every message would defeat Static.
   */
  transcriptEpoch?: number;

  /**
   * Wave 13 (retry-ui): live transport-retry context while `retryFetch` backs off a
   * transient PRE-FIRST-BYTE model-call failure (503/429/network blip). Fed by
   * `retryFetch`'s `onRetry(attempt, max, delayMs)` callback via the `retry-attempt`
   * LOCAL action (never produced by `eventToAction` — a retry is an HTTP-transport
   * concern, not a normalized AgentEvent). `selectActivity` reads it as the highest-
   * precedence branch so the busy line shows `retrying n/m · <backoff>` DURING the
   * backoff, on BOTH the initial and tool_use re-entry windows (phase is idle/streaming
   * there). OPTIONAL so the shape stays additive (NOT set by `initialState()`); always
   * read as `state.retry`. CLEARED (set to undefined) the moment the model call
   * resolves or ends — `assistant-start` (first byte ⇒ retry succeeded), `error`
   * (exhaustion/terminal), and `aborted` (user cancel mid-retry) — so no stale
   * indicator survives into a terminal phase.
   */
  retry?: { attempt: number; max: number; delayMs: number };
}

/**
 * Action variants map 1:1 to AgentEvent variants, PLUS local UI actions
 * (`user-submit`, `set-effort`, `cycle-effort`, `set-overlay`, `clear`).
 */
export type Action =
  | { t: 'user-submit'; id: string; text: string }
  // Turn lifecycle (LOCAL actions, no wire AgentEvent). `turn-start` is dispatched by
  // useStreamingTurn.submit the instant a turn is submitted (before the ambient-recall
  // await) → phase 'preparing', covering the whole pre-`assistant-start` gap. `turn-settle`
  // fires in submit's finally when the turn fully settles → phase 'idle' (kept 'error' if
  // the turn errored). Together they REPLACE the out-of-reducer optimisticTurn flag.
  | { t: 'turn-start' }
  | { t: 'turn-settle' }
  // Compaction lifecycle (LOCAL actions, no wire AgentEvent). `compaction-start` →
  // 'compacting' the instant a compaction LLM call is dispatched; `compaction-settle` →
  // 'idle' when it finishes. Together they REPLACE the out-of-reducer compactingRef/
  // isCompacting mirror. The `compact` action (applies the summary) stays separate.
  | { t: 'compaction-start' }
  | { t: 'compaction-settle' }
  | { t: 'assistant-start'; id: string }
  // `ts` (OPTIONAL, ms) is the dispatch-edge wall clock used ONLY to bound the
  // thinking phase for the collapsed `✻ thought for <n>s` marker (thinking-collapse).
  // The reducer stays pure — it never reads a clock, only this supplied input.
  | { t: 'text-delta'; id: string; delta: string; ts?: number }
  | { t: 'reasoning-delta'; id: string; delta: string; ts?: number }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown; parentToolUseId?: string; ts?: number }
  | { t: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  // `continues` (raw-stream events never set it) marks an assistant-done the turn
  // runner will immediately RE-ENTER — a turn-end `/steer` interjection. Like a
  // `tool_use` stop it commits the answer but must NOT flip phase to 'idle': doing so
  // opens an observable mid-turn idle gap (spinner + abort affordance vanish) and rings
  // the completion bell early, then again at the real end (double ring). Kept 'streaming'.
  | { t: 'assistant-done'; id: string; stopReason: StopReason; ts?: number; continues?: boolean }
  // `parentToolUseId` (OPTIONAL) marks a CHILD (subagent) usage: its tokens feed the
  // cumulative cost meter for display but must NEVER touch `contextWindowTokens` (the
  // child ran in a fresh, isolated context the parent window never occupied).
  | { t: 'usage'; tokensIn: number; tokensOut: number; contextTokens?: number; parentToolUseId?: string }
  | { t: 'aborted'; reason?: string }
  | { t: 'set-effort'; effort: State['effort'] }
  | { t: 'cycle-effort' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'skill-select'; name: string }
  | { t: 'set-permission-mode'; mode: State['permissionMode'] }
  | { t: 'error'; message: string; envelope?: ProviderErrorEnvelope }
  // System-feedback line (F): append a dim `notice` block as a committed system
  // message. LOCAL action (no wire AgentEvent) — same class as `clear`/`compact`.
  | { t: 'notice'; text: string }
  | { t: 'clear' }
  // Wave 13 (retry-ui): live transport-retry status. LOCAL action (no wire
  // AgentEvent — same class as `notice`/`clear`); `eventToAction` NEVER produces it.
  // Dispatched OUT-OF-BAND from `retryFetch`'s `onRetry` callback (bridged in
  // app.tsx) while a pre-first-byte model call backs off. Sets `state.retry` without
  // touching `phase` (still pre-first-byte); cleared by assistant-start/error/aborted.
  | { t: 'retry-attempt'; attempt: number; max: number; delayMs: number }
  // Wave 13 (retry-ui): clear the live transport-retry status. LOCAL action (no wire
  // AgentEvent); `eventToAction` NEVER produces it. Needed because the COMPACTION seam
  // drains the SAME `onRetry`-wired client OUTSIDE the turnRunner — the compactor
  // consumes the summarization call's assistant-start/error/aborted INTERNALLY, so
  // none of the reducer's normal retry-clearing cases fire. Dispatched in
  // `runCompactionStep`'s finally so a transient blip during summarization leaves NO
  // stale `retrying n/m` line at idle. A no-op when `state.retry` is already undefined.
  | { t: 'retry-clear' }
  // Coalesced stream-delta batch (LOCAL — eventToAction NEVER produces it, same class as
  // notice/retry-clear). useStreamingTurn's ~16ms flush wraps the coalesced text/reasoning/
  // tool-call deltas in ONE action so a single reactDispatch applies the whole set (one
  // React+Yoga pass per flush instead of K). The reducer folds the sub-actions left-to-
  // right; each is an ordinary phase-inert delta, so this wrapper is itself phase-inert.
  | { t: 'deltas'; actions: Action[] }
  // Context-Compression (LOCAL action, no wire AgentEvent — same class as `clear`).
  | { t: 'compact'; summaryText: string; keepCount: number }
  // Session Resume (LOCAL action, no wire AgentEvent — same class as `clear`/`compact`).
  // `messages` is the loaded transcript, supplied by the caller (purity preserved).
  | { t: 'resume-session'; messages: Msg[] };

const EFFORT_ORDER: ReadonlyArray<State['effort']> = ['medium', 'high', 'xhigh'];

/**
 * Fresh reducer state. `init.permissionMode` seeds the runtime permission mode at
 * CONSTRUCTION (from config) so frame 1 is honest — no post-mount seed dispatch that
 * left the first paint showing 'default'. Absent ⇒ 'default'. The `clear` case still
 * calls `initialState()` with no arg (it re-applies `state.permissionMode` right after).
 */
export function initialState(init?: { permissionMode?: PermissionMode }): State {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: init?.permissionMode ?? 'default',
    tokens: { in: 0, out: 0 },
    pendingPermission: null,
    errorMessage: null,
  };
}

/** PURE reducer. Never mutates inputs; returns a new State (or the same ref for no-ops). */
export function reducer(state: State, action: Action): State {
  switch (action.t) {
    case 'user-submit': {
      const msg: Msg = {
        id: action.id,
        role: 'user',
        blocks: [{ kind: 'text', id: blockId(action.id, 0), text: action.text }],
        done: true,
      };
      // tokens.in is populated by the provider's real `usage` event (W9). The old
      // input estimate here was a pre-W9 placeholder; keeping it double-counted
      // input (estimate + real usage). Removed — `user-submit` no longer touches tokens.
      return {
        ...state,
        committed: [...state.committed, msg],
        // Belt-and-suspenders: a fresh submission starts clean (assistant-start always
        // precedes any retry-clear in practice, but this guarantees no stale carry-over).
        retry: undefined,
      };
    }

    case 'deltas':
      // Fold the coalesced deltas through the SAME reducer, left-to-right. Purity + the
      // no-op contract hold: an all-no-op batch returns the initial `state` ref (React bails
      // the re-render). Sub-actions arrive dispatch-edge-stamped (ts) from flushDeltas, so
      // the pure reducer still never reads a clock.
      return action.actions.reduce((s, a) => reducer(s, a), state);

    case 'turn-start':
    case 'turn-settle':
    case 'compaction-start':
    case 'compaction-settle': {
      // Pure lifecycle transitions: they touch ONLY the phase (turn-start must NOT clear
      // live/committed — it can co-occur with an error phase being cleared to 'preparing';
      // compaction-start/settle likewise touch only phase). Routed through the single
      // transition table so `assertNever` fires if a new action is ever added.
      const nextPhase = transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false });
      // Honor the reducer's no-op purity contract (reducer.ts:5 — consumers `===` on a
      // no-op, and React's useReducer bails the re-render): turn-settle from an already
      // 'idle'/'error' phase, or compaction-settle from a non-'compacting' phase, changes
      // nothing → return the SAME ref so the whole App doesn't re-render on every finally.
      if (nextPhase === state.phase && action.t !== 'turn-start') {
        return state;
      }
      // A `turn-start` that flips 'error' → 'preparing' additionally clears the stale
      // error-frame text so a fresh turn after an error frame starts clean (the committed
      // error Msg stays; only the transient errorMessage status is dropped).
      if (action.t === 'turn-start') {
        return nextPhase === state.phase && state.errorMessage === null
          ? state
          : { ...state, phase: nextPhase, errorMessage: null };
      }
      return { ...state, phase: nextPhase };
    }

    case 'assistant-start':
      // First byte arrived ⇒ any in-flight pre-first-byte retry SUCCEEDED; clear the
      // retry indicator so the busy line hands over cleanly to 'thinking…'/'responding…'.
      return {
        ...state,
        live: { id: action.id, role: 'assistant', blocks: [], done: false },
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        retry: undefined,
      };

    // Wave 13 (retry-ui): a pre-first-byte model call is backing off. Record the live
    // retry context so `selectActivity` can surface `retrying n/m · <backoff>`. Does
    // NOT touch `phase` — no assistant output has arrived yet (still pre-first-byte).
    case 'retry-attempt':
      return {
        ...state,
        retry: { attempt: action.attempt, max: action.max, delayMs: action.delayMs },
      };

    // Wave 13 (retry-ui): clear the retry indicator. Dispatched by the COMPACTION seam,
    // which drains the `onRetry`-wired client outside the turnRunner (so no
    // assistant-start/error/aborted ever reaches the reducer to clear `state.retry`).
    // Returns state UNCHANGED when there is nothing to clear, so the unconditional
    // dispatch in `runCompactionStep`'s finally never forces a needless re-render.
    case 'retry-clear':
      return state.retry === undefined ? state : { ...state, retry: undefined };

    case 'text-delta': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      // Visible text ends the thinking phase: stamp the end on the FIRST text delta
      // that follows a reasoning stream (thinking started, not yet ended).
      const endsThinking =
        live.reasoningStartedAt !== undefined &&
        live.reasoningEndedAt === undefined &&
        action.ts !== undefined;

      const blocks = live.blocks.slice();
      const last = blocks.at(-1);
      if (last?.kind === 'text') {
        // Keep the same block id; concatenate into the trailing text block.
        blocks[blocks.length - 1] = { ...last, text: last.text + action.delta };
      } else {
        // A tool block (or nothing) precedes — open a NEW text block. Trim the
        // opening delta's LEADING whitespace so a block resuming after a tool call
        // does not inherit the provider's leading separator space (" Now…" → "Now…").
        // Only this opening delta is trimmed; interior + later-appended whitespace
        // is untouched (the append branch above never trims). Unified-rendering wave 1.
        blocks.push({
          kind: 'text',
          id: blockId(live.id, blocks.length),
          text: action.delta.replace(/^\s+/, ''),
        });
      }
      return {
        ...state,
        live: {
          ...live,
          blocks,
          ...(endsThinking ? { reasoningEndedAt: action.ts } : {}),
        },
      };
    }

    case 'reasoning-delta': {
      const live = state.live;
      // No-op if no live msg / id mismatch — reasoning belongs to the live turn.
      if (live === null || live.id !== action.id) return state;
      // Stamp the thinking-phase start on the FIRST reasoning delta only (when the
      // edge supplied a clock). Later deltas keep the original start.
      const reasoningStartedAt =
        live.reasoningStartedAt ?? (live.reasoning === undefined ? action.ts : undefined);
      return {
        ...state,
        live: {
          ...live,
          reasoning: (live.reasoning ?? '') + action.delta,
          ...(reasoningStartedAt !== undefined ? { reasoningStartedAt } : {}),
        },
      };
    }

    case 'tool-call': {
      const live = state.live;
      // Concurrency batch (grouped-tool-rows): a top-level call joins the in-flight batch
      // of the earliest sibling top-level call still non-terminal here, else opens its own.
      // Computed from PRIOR state (this call is not registered yet). Absent for subagent
      // children (grouped by parentToolUseId) and when there is no live turn.
      const concurrencyGroupId =
        live !== null && action.parentToolUseId === undefined
          ? concurrencyGroupFor(live, state.tools, action.toolCallId)
          : undefined;
      const tools: Record<string, ToolState> = {
        ...state.tools,
        [action.toolCallId]: {
          status: 'pending',
          name: action.name,
          args: action.args,
          ...(action.parentToolUseId !== undefined ? { parentToolUseId: action.parentToolUseId } : {}),
          ...(concurrencyGroupId !== undefined ? { concurrencyGroupId } : {}),
        },
      };
      if (live === null || action.parentToolUseId !== undefined) {
        // No live block, no thinking-clock stamp — just register the call — when:
        //  - live === null (defensive: still register so a later tool-status isn't
        //    dropped), or
        //  - the call carries a parentToolUseId: a forwarded subagent-child call that
        //    belongs to the child card (surfaced under parentToolUseId), NOT the
        //    parent's live assistant message. Appending its block would persist a
        //    stray render-suppressed block into the committed parent message, and the
        //    endsThinking stamp below would freeze the parent's '✻ thought for Ns'
        //    marker early while the parent keeps thinking/streaming its own turn.
        return { ...state, tools };
      }
      const blocks = [
        ...live.blocks,
        { kind: 'tool' as const, id: blockId(live.id, live.blocks.length), toolCallId: action.toolCallId },
      ];
      // A tool call ends the thinking phase too (covers a think→tool turn with no
      // visible prose between them). First transition only.
      const endsThinking =
        live.reasoningStartedAt !== undefined &&
        live.reasoningEndedAt === undefined &&
        action.ts !== undefined;
      return {
        ...state,
        tools,
        live: { ...live, blocks, ...(endsThinking ? { reasoningEndedAt: action.ts } : {}) },
      };
    }

    case 'tool-call-delta': {
      const existing = state.tools[action.toolCallId];
      // Accumulate partial arg text onto the pending tool entry. If `tool-call`
      // has not registered the entry yet, open a pending one so deltas survive.
      const base: ToolState =
        existing ?? { status: 'pending', name: '', args: undefined };
      const updated: ToolState = { ...base, argsText: (base.argsText ?? '') + action.argsDelta };
      return { ...state, tools: { ...state.tools, [action.toolCallId]: updated } };
    }

    case 'tool-status': {
      const existing = state.tools[action.toolCallId];
      if (existing === undefined) return state;
      // Race guard: once 'error', a later non-error status must NOT clobber it.
      if (existing.status === 'error' && action.status !== 'error') return state;

      const updated: ToolState = {
        ...existing,
        status: action.status,
        ...(action.result !== undefined ? { result: capStoredResult(action.result) } : {}),
        ...(action.error !== undefined ? { error: capStoredError(action.error) } : {}),
      };
      const tools = { ...state.tools, [action.toolCallId]: updated };

      // Forwarded subagent-child statuses (existing.parentToolUseId set) are
      // phase-neutral: the child runs on a DETACHED background loop while the parent
      // turn is idle (or running its OWN tool). A child 'running' must not re-pin the
      // busy line ('running <tool>… · esc to abort', with Esc a no-op) for the child's
      // whole duration, and a child 'result'/'error' must not flip the parent to
      // 'idle'/'streaming' mid-turn. Only top-level (parentless) tools move the phase —
      // `transitionPhase` enforces exactly that via `ctx.isChildTool`.
      const isChildTool = existing.parentToolUseId !== undefined;
      // A top-level tool that SETTLES (result/error) drains any permission prompt still
      // pending for THAT id: the tool is done, so a prompt for it is moot. This mirrors
      // the retired permissionRisksRef side-table's tool-terminal prune (and matches the
      // pendingPermission doc-comment + ARCHITECTURE.md, which both list a settling
      // tool-status among the terminals that clear the field).
      const settlesPending =
        !isChildTool &&
        (action.status === 'result' || action.status === 'error') &&
        state.pendingPermission?.toolCallId === action.toolCallId;
      return {
        ...state,
        tools,
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool }),
        ...(settlesPending ? { pendingPermission: null } : {}),
      };
    }

    case 'permission-open': {
      // Defensive: ensure a tools entry exists (tool-call normally precedes).
      const tools: Record<string, ToolState> =
        state.tools[action.toolCallId] !== undefined
          ? state.tools
          : { ...state.tools, [action.toolCallId]: { status: 'pending', name: action.name, args: action.args } };
      return {
        ...state,
        tools,
        overlay: 'permission',
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        pendingPermission: { toolCallId: action.toolCallId, risk: action.risk },
      };
    }

    case 'permission-resolved':
      // The decision's effect on tool execution is W7/W8's job; the reducer only
      // restores UI/phase. (Decision/toolCallId are intentionally not stored.)
      return {
        ...state,
        overlay: 'none',
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        pendingPermission: null,
      };

    case 'assistant-done': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      const toolSnapshot = snapshotTools(live, state.tools);
      // Pure-thinking turn fallback: reasoning streamed but nothing visible followed
      // to close it, so freeze the thinking end at commit.
      const closeThinking =
        live.reasoningStartedAt !== undefined &&
        live.reasoningEndedAt === undefined &&
        action.ts !== undefined;
      const doneMsg: Msg = {
        ...live,
        done: true,
        ...(closeThinking ? { reasoningEndedAt: action.ts } : {}),
        ...(Object.keys(toolSnapshot).length > 0 ? { toolSnapshot } : {}),
      };
      // A `tool_use` stop is NOT the end of the user turn: on raw-API backends the
      // runner re-enters the model with the tool results, so the turn is still in
      // flight. Keep phase 'streaming' across that inter-request gap rather than
      // flipping to 'idle' — an idle transition here is observable (React commits it
      // between requests) and rings the completion bell once per tool round. A turn-end
      // `/steer` re-entry (`continues === true`, ANY backend) is the same shape: commit
      // the answer but stay 'streaming' so the next request has no idle flicker. Only a
      // genuinely terminal stop ('end'/'max_tokens'/'abort'/'error' with no re-entry)
      // returns to 'idle', so the busy line drops exactly once when the whole turn ENDS.
      const phase = transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false });
      // Completion-bell counter: increment ONLY on a genuinely terminal, non-re-entry
      // stop whose reason is a real completion ('end'/'max_tokens'). 'abort'/'error'
      // stopReasons never increment — a real abort/error travels through the
      // 'aborted'/'error' actions, and those never bump the counter — so an Esc-abort
      // (which also lands at 'idle') can never ring the bell.
      const terminal = action.stopReason !== 'tool_use' && action.continues !== true;
      const completed = terminal && (action.stopReason === 'end' || action.stopReason === 'max_tokens');
      return {
        ...state,
        committed: [...state.committed, doneMsg],
        live: null,
        phase,
        ...(completed ? { completedTurns: (state.completedTurns ?? 0) + 1 } : {}),
      };
    }

    case 'usage': {
      // Cumulative cost/display meter ALWAYS accumulates — parent AND child spend both
      // count toward the session total the status line shows.
      const tokens = { in: state.tokens.in + action.tokensIn, out: state.tokens.out + action.tokensOut };
      // CHILD (subagent) usage is display-only: fold its tokens into the meter but NEVER
      // touch `contextWindowTokens`. A subagent runs in a FRESH, isolated context the
      // parent window never occupied, so its input size must not inflate the parent's
      // compaction pressure (the hazard: a big child input clobbering the parent gauge to
      // the child's size, triggering a needless compaction of a window the child never
      // touched). The `parentToolUseId` marker is the discriminator.
      if (action.parentToolUseId !== undefined) {
        return { ...state, tokens };
      }
      // PARENT usage: capture the live context-window occupancy from THIS request. Prefer
      // the adapter's normalized `contextTokens` (cache-inclusive); else fall back to a
      // positive `tokensIn` (a full-input measurement arrives once per request — at
      // message_start for the Anthropic family — while output-only deltas carry tokensIn=0
      // and must NOT clobber it).
      const measured =
        action.contextTokens ?? (action.tokensIn > 0 ? action.tokensIn : undefined);
      return {
        ...state,
        tokens,
        ...(measured !== undefined ? { contextWindowTokens: measured } : {}),
      };
    }

    case 'aborted': {
      // Cancellation: COMMIT the partially-streamed live turn before dropping it,
      // so the text the user was reading survives in scrollback (spec item 1 — a
      // first-press Ctrl+C must NOT erase the partial transcript). The frozen turn
      // carries a dim `interrupted` notice marking it cut short; `assistant-done`
      // never fires for it, so this action owns the commit. Then drop `live`, close
      // any open permission prompt, and return to idle — committed history and
      // cumulative tokens are preserved as before. The Esc-abort path funnels
      // through this same action and inherits the fix.
      const committed =
        state.live !== null
          ? [...state.committed, commitInterrupted(state.live, state.tools)]
          : state.committed;
      return {
        ...state,
        committed,
        live: null,
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermission: null,
        // User cancelled mid-retry: drop the retry indicator (no lingering spinner).
        retry: undefined,
      };
    }

    case 'set-effort':
      return { ...state, effort: action.effort };

    case 'cycle-effort': {
      const idx = EFFORT_ORDER.indexOf(state.effort);
      const next = EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length]!;
      return { ...state, effort: next };
    }

    case 'set-overlay':
      return {
        ...state,
        overlay: action.overlay,
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
      };

    case 'skill-select':
      // UI action: the user picked a skill from the palette. The actual skill
      // body load is the model's `load_skill` tool, not a user invocation — so
      // this minimally closes the overlay. Additive: a new variant + case only.
      return {
        ...state,
        overlay: 'none',
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
      };

    case 'set-permission-mode':
      return { ...state, permissionMode: action.mode };

    case 'error': {
      // PROPOSED: surface errors both as a committed system Msg (so <Static>
      // renders them for free) and on `errorMessage` (so the status line reads it).
      // Id minted from the monotonic per-session `noticeSeq` cursor (shared with
      // `notice`, 0-indexed) so a compaction kept-tail can never collide the React
      // key with a prior error/notice: read the current cursor for the id, advance it.
      const seq = state.noticeSeq ?? 0;
      const id = `system-error-${seq}`;
      const msg: Msg = {
        id,
        role: 'system',
        blocks: [{ kind: 'text', id: blockId(id, 0), text: action.message }],
        done: true,
        // Discriminate this committed line as a FAILED turn (not benign chrome) so
        // Message.tsx renders a bold `✗ error` heading in the error token. The
        // `system-error-` id prefix is the load-time fallback for sessions persisted
        // before `tone` existed; stamping it here is the forward path.
        tone: 'error',
      };
      // FREEZE-ON-ERROR (spec item 2, S1 data loss): a mid-stream error must be
      // NON-DESTRUCTIVE — preserve the partially-streamed answer exactly like
      // `aborted` does, instead of silently dropping `state.live`. Commit the
      // partial turn AHEAD of the `✗ error` line so scrollback reads
      // partial-answer → failure notice. Reuse `commitInterrupted` unchanged: the
      // frozen turn carries the dim `interrupted` notice and its in-flight tools
      // normalize to a settled glyph; the actual failure text lives on the
      // `tone:'error'` Msg below, so it is NOT duplicated here. The three-part
      // guard: `live !== null` prevents a double-commit when an error trails an
      // abort (which already committed + nulled live); the blocks/reasoning clause
      // suppresses an empty frozen turn when nothing streamed yet (error right
      // after assistant-start), while still preserving a reasoning-only partial.
      const frozen =
        state.live !== null &&
        (state.live.blocks.length > 0 || state.live.reasoning !== undefined)
          ? [commitInterrupted(state.live, state.tools)]
          : [];
      return {
        ...state,
        committed: [...state.committed, ...frozen, msg],
        // Clear the in-flight turn the same way `aborted` does. A mid-stream error
        // (dropped connection, 5xx, error frame) leaves `state.live` a partial
        // assistant msg with `done:false`; StreamingMessage renders an animated
        // Spinner whenever `!live.done`, so without this the spinner would spin
        // forever below the committed error until a NEW turn overwrites `live`. Also
        // drop any open permission overlay so an error while it's up can't strand it.
        live: null,
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        errorMessage: action.message,
        // ADDITIVE machine-readable classification, separate from the human-facing
        // `errorMessage`. Always written: an envelope overwrites cleanly, and an
        // absent one (`undefined`) clears any stale envelope from a prior error.
        errorEnvelope: action.envelope,
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        // The reducer now clears the pending prompt in the 'error' case too, so an error
        // while a permission prompt is open can't leak a stale pendingPermission (the old
        // permissionRisksRef side-table missed this, a real leak — now fixed structurally).
        pendingPermission: null,
        noticeSeq: seq + 1,
        // Retry exhaustion / terminal failure funnels here: clear the retry indicator
        // so no stale `retrying n/m` line survives beneath the committed error.
        retry: undefined,
      };
    }

    case 'resume-session':
      // Session Resume: wholesale-replace the transcript with a loaded session.
      // PURE — `messages` is supplied by the caller (no I/O / clock here). The live
      // `tools` map is REBUILT from the committed assistant msgs' `toolSnapshot`s
      // (foldToolSnapshots) so the ctrl+o tool-detail overlay is populated under a
      // resumed transcript instead of reading "No tool calls yet."; `toTurnMessages`
      // still reads each msg's own snapshot first, so replay is unaffected. Token totals
      // are not persisted → reset fresh. effort + permissionMode are user prefs →
      // PRESERVED (same as `clear`). `compactions` intentionally omitted (resets to
      // absent/0). `noticeSeq` is seeded PAST the loaded transcript's highest notice/
      // error id so a resume→notice round-trip can't mint a duplicate React key.
      return {
        ...state,
        committed: action.messages,
        live: null,
        tools: foldToolSnapshots(action.messages),
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        overlay: 'none',
        pendingPermission: null,
        errorMessage: null,
        // Mirror errorMessage's lifecycle: a resumed session carries no stale
        // classification (errorEnvelope is cleared only here + never set by initialState).
        errorEnvelope: undefined,
        tokens: { in: 0, out: 0 },
        contextWindowTokens: undefined,
        compactions: undefined,
        completedTurns: undefined,
        noticeSeq: nextNoticeSeq(action.messages),
        // committed was replaced wholesale → remount <Static> so the whole resumed
        // transcript re-renders (else Static's grown index drops the leading msgs).
        transcriptEpoch: (state.transcriptEpoch ?? 0) + 1,
      };

    case 'notice': {
      // Append a dim system-feedback line to the committed transcript (F). The id is
      // minted from the monotonic per-session `noticeSeq` (shared with `error`), NOT the
      // old committed.length scheme — a compaction kept-tail shrinks committed and the
      // length scheme could re-mint an id already used by a kept notice, colliding React
      // keys. PURE — no Date.now / Math.random. Never fed to the model (see `isNoticeOnly`
      // filtering in the turn-message builder). 0-indexed cursor: mint at the current
      // value, advance it (mirrors the `error` case).
      const seq = state.noticeSeq ?? 0;
      const id = `notice-${seq}`;
      const msg: Msg = {
        id,
        role: 'system',
        done: true,
        blocks: [{ kind: 'notice', id: blockId(id, 0), text: action.text }],
      };
      return { ...state, committed: [...state.committed, msg], noticeSeq: seq + 1 };
    }

    case 'clear': {
      // Reset conversation/turn state; preserve ONLY the user prefs (effort,
      // permissionMode). Cumulative `tokens` are RESET to initialState()'s zero (E):
      // a cleared session starts a fresh conversation, so the tok/cost/context-fraction
      // readouts derived from `tokens` must zero out too (both backends) rather than
      // carrying a stale running total. Leave a single dim `session cleared` notice so
      // the reset is acknowledged in the (now-empty) viewport (F).
      const noticeId = 'notice-cleared';
      const clearedNotice: Msg = {
        id: noticeId,
        role: 'system',
        done: true,
        blocks: [{ kind: 'notice', id: blockId(noticeId, 0), text: 'session cleared' }],
      };
      return {
        ...initialState(),
        effort: state.effort,
        permissionMode: state.permissionMode,
        committed: [clearedNotice],
        // committed was replaced (emptied + notice) → remount <Static> so its internal
        // index resets to 0 and the notice + post-clear appends print from a clean region.
        transcriptEpoch: (state.transcriptEpoch ?? 0) + 1,
      };
    }

    case 'compact': {
      // Context-Compression: replace the elided committed prefix with ONE compact
      // `system` summary, keeping the last `keepCount` messages verbatim. PURE: the
      // id derives from the monotonic `compactions` counter (no Date.now/Math.random),
      // mirroring the `error` case's committed.length-derived id. The reducer always
      // applies — the compactor (Unit 2) owns the decision NOT to dispatch a no-op.
      const n = (state.compactions ?? 0) + 1;
      const id = `compaction-${n}`;
      const summaryMsg: Msg = {
        id,
        role: 'system',
        done: true,
        blocks: [{ kind: 'text', id: blockId(id, 0), text: action.summaryText }],
      };
      // Keep the last `keepCount` committed messages verbatim; the summary stands in
      // for the elided prefix. `tokens`/`effort`/`permissionMode`/`tools` are PRESERVED
      // (kept assistant messages carry their own `toolSnapshot`, so the tools map must
      // not be wiped — that would only risk dangling refs for the kept tail).
      const keep = action.keepCount > 0 ? state.committed.slice(-action.keepCount) : [];
      return {
        ...state,
        committed: [summaryMsg, ...keep],
        live: null,
        phase: transitionPhase(state.phase, action, { liveNull: state.live === null, isChildTool: false }),
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermission: null,
        // The transcript just shrank; the last real measurement reflects the old,
        // larger window. Drop it so the monitor shows the estimate until the next
        // turn re-measures the compacted transcript.
        contextWindowTokens: undefined,
        compactions: n,
        // committed was replaced wholesale (summary + kept tail) → remount <Static>
        // so the new summary at index 0 renders (else Static's grown index skips it).
        transcriptEpoch: (state.transcriptEpoch ?? 0) + 1,
      };
    }
  }
}

/**
 * The concurrency-batch id a NEW top-level tool call joins (grouped-tool-rows): the batch
 * of the EARLIEST sibling top-level tool call still non-terminal (pending/running) in this
 * live turn — those calls are in flight together — inheriting its id; else a fresh batch
 * keyed on the new call's own id. Pure; scans prior siblings only (the new call is not yet
 * registered). Only top-level siblings count (a `parentToolUseId` child is grouped under its
 * spawn, not here). See `ToolState.concurrencyGroupId` + src/ui/toolGroups.ts.
 */
function concurrencyGroupFor(
  live: Msg,
  tools: Record<string, ToolState>,
  newToolCallId: string,
): string {
  for (const block of live.blocks) {
    if (block.kind !== 'tool') continue;
    const sibling = tools[block.toolCallId];
    if (sibling === undefined || sibling.parentToolUseId !== undefined) continue;
    if (sibling.status === 'pending' || sibling.status === 'running') {
      return sibling.concurrencyGroupId ?? block.toolCallId;
    }
  }
  return newToolCallId;
}

/** Stable, monotonic-per-message block id. `n` is the append index. */
function blockId(msgId: string, blockIndex: number): string {
  return `${msgId}:block:${blockIndex + 1}`;
}

/**
 * Per-tool stored-result ceiling. The full tool result is now retained in
 * `state.tools` (the tool-detail overlay renders it in full — the transcript card
 * only shows a one-line tail), so the store is no longer bounded by render-time
 * truncation. Cap the retained bytes so a single pathological tool (a multi-MB
 * shell dump, a huge file read) can't grow the reducer state without bound. The
 * budget is generous — normal results fit comfortably; only genuine giants are
 * clipped, and always with an explicit marker so the overlay reads honestly.
 */
export const MAX_STORED_RESULT_BYTES = 200_000;

/** Explicit marker appended to a result/error clipped at the stored-size ceiling. */
export const TRUNCATION_MARKER = '\n… [truncated: result exceeded 200KB, elided here]';

/**
 * Clip an oversized string tail to {@link MAX_STORED_RESULT_BYTES}, appending the
 * truncation marker. Pure: returns the input unchanged when within budget or not a
 * string. A string result is the realistic large case (shell stdout, file reads);
 * structured (object) results are small and pass through untouched.
 */
function capString(value: string): string {
  if (value.length <= MAX_STORED_RESULT_BYTES) return value;
  return value.slice(0, MAX_STORED_RESULT_BYTES) + TRUNCATION_MARKER;
}

/** Cap a tool result at storage time. Strings are clipped; other shapes pass through. */
function capStoredResult(result: unknown): unknown {
  return typeof result === 'string' ? capString(result) : result;
}

/** Cap a tool error string at storage time (same ceiling as results). */
function capStoredError(error: string): string {
  return capString(error);
}

/**
 * Dim scrollback marker appended to a cancelled turn (the `interrupted` notice
 * block). It is a `notice`, so — like `session cleared` — it renders dim and is
 * NEVER fed back to the model (`toTurnMessages`/`textFromBlocks` drop notices).
 *
 * The literal lives in `./abort` (shared with the subagent tool + the render
 * surfaces via `isAbortReason`); re-exported here so existing `reducer`-relative
 * importers keep resolving it.
 */
export { INTERRUPTED_NOTICE };

/**
 * Freeze a cancelled live turn into a committed, done Msg: snapshot its tool
 * calls (so the <Static> committed render path never reads the live `tools` map,
 * matching the `assistant-done` contract), NORMALIZE any member still in flight to a
 * settled glyph (an abort must not commit a live spinner/pending dot — see
 * `normalizeInterruptedTools`), and append a dim `interrupted` notice block that marks
 * the turn as cut short. No thinking-close clock is applied — an abort carries no
 * completion timestamp, so an unfinished `✻ thinking` region commits as the clockless
 * `✻ thought` marker.
 */
function commitInterrupted(live: Msg, tools: Record<string, ToolState>): Msg {
  const toolSnapshot = normalizeInterruptedTools(snapshotTools(live, tools));
  const interruptedBlock: Block = {
    kind: 'notice',
    id: blockId(live.id, live.blocks.length),
    text: INTERRUPTED_NOTICE,
  };
  return {
    ...live,
    done: true,
    blocks: [...live.blocks, interruptedBlock],
    ...(Object.keys(toolSnapshot).length > 0 ? { toolSnapshot } : {}),
  };
}

function snapshotTools(msg: Msg, tools: Record<string, ToolState>): Record<string, ToolState> {
  const snapshot: Record<string, ToolState> = {};
  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      const tool = tools[block.toolCallId];
      if (tool !== undefined) snapshot[block.toolCallId] = { ...tool };
    }
  }
  return snapshot;
}

/**
 * Settle every still-in-flight snapshot member so an abort never commits a LIVE glyph.
 * A member left 'running' renders an ANIMATED spinner and one left 'pending' a live dot;
 * committed into the append-only <Static> path (printed once, never redrawn) that glyph
 * FREEZES into a stuck spinner frame / a dot that will never resolve. Rewrite each
 * non-terminal member to the terminal 'error' state carrying the `interrupted` reason, so
 * the frozen card reads as a static `✗ … interrupted` instead. Already-settled members
 * ('result'/'error', including their own error text) pass through untouched. Only the
 * RENDER fields (status/error) change — name/args/result are preserved, so turn-replay
 * (`toTurnMessages`, which reads name+args off the snapshot) is unaffected.
 */
function normalizeInterruptedTools(
  snapshot: Record<string, ToolState>,
): Record<string, ToolState> {
  const normalized: Record<string, ToolState> = {};
  for (const [id, tool] of Object.entries(snapshot)) {
    normalized[id] =
      tool.status === 'pending' || tool.status === 'running'
        ? { ...tool, status: 'error', error: tool.error ?? INTERRUPTED_NOTICE }
        : tool;
  }
  return normalized;
}

function phaseForOverlay(phase: Phase, liveNull: boolean, overlay: State['overlay']): Phase {
  if (phase === 'error') return 'error';
  if (overlay === 'permission') return 'awaiting-permission';
  if (phase === 'awaiting-permission') return liveNull ? 'idle' : 'streaming';
  return phase;
}

/** The reducer's phase union — exported so the transition table is unit-testable. */
export type Phase = State['phase'];

/**
 * The busy phases that belong to an IN-FLIGHT turn — the pre-first-byte gap through the
 * settle, INCLUDING a permission prompt. Excludes the two terminals ('idle'/'error') and
 * 'compacting' (a separate lifecycle with no tools/permissions). A mid-turn settle event
 * (a top-level tool result/error, a resolved permission) hands back to 'streaming' ONLY
 * from one of these — otherwise a late event drained AFTER an abort (phase already 'idle')
 * or an error would wrongly RESURRECT 'streaming' and re-pin the busy line on a dead turn.
 */
function isTurnPhase(phase: Phase): boolean {
  return (
    phase === 'preparing' ||
    phase === 'streaming' ||
    phase === 'running-tool' ||
    phase === 'awaiting-permission'
  );
}

/**
 * The SINGLE pure phase-transition table: `(phase, action, ctx) → phase`. Every
 * reducer case that changes the phase routes through here, so the whole
 * turn/compaction lifecycle lives in ONE place instead of being scattered across
 * five out-of-reducer mirrors. Exported for the exhaustive table test.
 *
 * `ctx.liveNull` = `state.live === null`; it is consulted ONLY when leaving an overlay
 * via `phaseForOverlay` (set-overlay / skill-select). A top-level tool `result`/`error`
 * and a `permission-resolved` are mid-turn settle events: while the turn is in flight
 * (`isTurnPhase`) they hand back to 'streaming' rather than dipping to 'idle' — killing
 * the old spurious mid-turn idle blip on raw-API rounds, where an assistant-done(tool_use)
 * nulls `live` BEFORE the tool's `result` arrives (the old `liveNull ? 'idle'` briefly
 * dropped the busy line). They do NOT resurrect a terminated turn, so from a settled phase
 * ('idle' after an abort that drained a parked prompt, or 'error') the phase is preserved.
 * `ctx.isChildTool` = the tool-status target carries a `parentToolUseId` (a background
 * subagent child never moves the parent phase). Phase-inert actions are enumerated so
 * `assertNever` fires the instant a NEW action variant is added without deciding its
 * phase effect.
 */
export function transitionPhase(
  phase: Phase,
  action: Action,
  ctx: { liveNull: boolean; isChildTool: boolean },
): Phase {
  switch (action.t) {
    case 'turn-start':
      // A submitted turn covers the pre-`assistant-start` gap with 'preparing'. Only
      // enter it from a settled phase (idle, or clearing a prior 'error'); a turn-start
      // arriving mid-flight (shouldn't happen — submit self-guards) leaves phase as-is.
      return phase === 'error' ? 'preparing' : phase === 'idle' ? 'preparing' : phase;
    case 'assistant-start':
      return 'streaming';
    case 'tool-status':
      if (ctx.isChildTool) return phase; // background child never moves the parent phase
      if (action.status === 'running') return 'running-tool';
      // A settled top-level tool is mid-turn: while the turn is in flight the turn continues
      // (another round or the terminal assistant-done follows), so hand back to 'streaming'
      // rather than dipping to 'idle' — that killed the raw-API mid-turn idle blip (where
      // assistant-done(tool_use) nulls `live` before the result lands). But a result drained
      // AFTER an abort/error must NOT resurrect the dead turn, so guard on isTurnPhase.
      if (action.status === 'result' || action.status === 'error') return isTurnPhase(phase) ? 'streaming' : phase;
      return phase; // 'pending'
    case 'permission-open':
      return 'awaiting-permission';
    case 'permission-resolved':
      // A permission prompt only ever opens mid-turn, so resolving it hands back to the
      // in-flight 'streaming' phase (never a mid-turn idle blip) — UNLESS the turn already
      // terminated (a parked prompt drained to 'deny' on abort), in which case the settled
      // phase is preserved so a dead turn is never resurrected.
      return isTurnPhase(phase) ? 'streaming' : phase;
    case 'assistant-done':
      return action.stopReason === 'tool_use' || action.continues === true ? 'streaming' : 'idle';
    case 'aborted':
      return 'idle';
    case 'error':
      return 'error';
    case 'set-overlay':
      return phaseForOverlay(phase, ctx.liveNull, action.overlay);
    case 'skill-select':
      return phaseForOverlay(phase, ctx.liveNull, 'none');
    case 'compaction-start':
      return 'compacting';
    case 'compaction-settle':
      // Releases a COMPACTION specifically: settle ONLY from 'compacting'. From any other
      // phase it is a no-op — it must never clobber a live turn's 'streaming'/'preparing'
      // (a turn and a compaction are mutually exclusive, but defensiveness is free here),
      // and it preserves an 'error' terminal.
      return phase === 'compacting' ? 'idle' : phase;
    case 'turn-settle':
      // Safety net for a hung TURN: force 'idle' from any busy phase (the whole point is to
      // recover a turn stuck in 'streaming'/'preparing'), but never clobber an 'error' terminal.
      return phase === 'error' ? 'error' : 'idle';
    case 'compact':
      return 'idle'; // the summary was applied; return to idle
    case 'resume-session':
    case 'clear':
      return 'idle';
    // Phase-inert actions — enumerated (not `default`) so a NEW action forces a decision.
    case 'user-submit':
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-call':
    case 'tool-call-delta':
    case 'usage':
    case 'set-effort':
    case 'cycle-effort':
    case 'set-permission-mode':
    case 'notice':
    case 'retry-attempt':
    case 'retry-clear':
    case 'deltas': // a delta batch never moves the phase (its sub-actions are all inert)
      return phase;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Rebuild the live `tools` map from a loaded transcript's committed `toolSnapshot`s
 * (resume-session). Each assistant/interrupted msg froze its tool calls at commit; a
 * later snapshot for the same id wins (Object.assign order = transcript order). Pure.
 */
function foldToolSnapshots(msgs: Msg[]): Record<string, ToolState> {
  const tools: Record<string, ToolState> = {};
  for (const m of msgs) {
    if (m.toolSnapshot) Object.assign(tools, m.toolSnapshot);
  }
  return tools;
}

/**
 * NEXT `notice-<n>` / `system-error-<n>` sequence to mint for a loaded transcript —
 * one past the highest such id present — so resume-session can seed the `noticeSeq`
 * cursor and a resume→notice round-trip never re-mints a present id (hence never a
 * duplicate React key). 0 when the transcript has none (the cursor is 0-indexed, so a
 * notice-free resume still starts at `…-0`). Pure.
 */
function nextNoticeSeq(msgs: Msg[]): number {
  let next = 0;
  for (const m of msgs) {
    const g = /^(?:notice|system-error)-(\d+)$/.exec(m.id);
    if (g) next = Math.max(next, Number(g[1]) + 1);
  }
  return next;
}
