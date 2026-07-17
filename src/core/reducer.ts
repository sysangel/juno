// src/core/reducer.ts
// W3 — the single PURE reducer. Every other unit builds against State/Action/Msg.
//
// Purity contract: no I/O, no Date.now, no Math.random, never mutates its inputs.
// On a no-op it returns the SAME state reference (consumers may rely on `===`).
import type { PermissionDecision, RiskLevel, StopReason, ToolStatus } from './events';

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
  | { kind: 'notice'; id: string; text: string };

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
}

export interface State {
  committed: Msg[];                 // -> Ink <Static>, printed once, never redrawn
  live: Msg | null;                 // the current streaming assistant turn
  tools: Record<string, ToolState>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker' | 'skill-picker' | 'permission-mode' | 'session-picker' | 'help' | 'mcp' | 'tool-detail' | 'subagents';
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
  /** The tool call the permission overlay is resolving; null when no prompt is open. */
  pendingPermissionToolCallId: string | null;
  /** Surfaced error text for `phase === 'error'`; null otherwise. */
  errorMessage: string | null;

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
}

/**
 * Action variants map 1:1 to AgentEvent variants, PLUS local UI actions
 * (`user-submit`, `set-effort`, `cycle-effort`, `set-overlay`, `clear`).
 */
export type Action =
  | { t: 'user-submit'; id: string; text: string }
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
  | { t: 'assistant-done'; id: string; stopReason: StopReason; ts?: number }
  | { t: 'usage'; tokensIn: number; tokensOut: number; contextTokens?: number }
  | { t: 'aborted'; reason?: string }
  | { t: 'set-effort'; effort: State['effort'] }
  | { t: 'cycle-effort' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'skill-select'; name: string }
  | { t: 'set-permission-mode'; mode: State['permissionMode'] }
  | { t: 'error'; message: string }
  // System-feedback line (F): append a dim `notice` block as a committed system
  // message. LOCAL action (no wire AgentEvent) — same class as `clear`/`compact`.
  | { t: 'notice'; text: string }
  | { t: 'clear' }
  // Context-Compression (LOCAL action, no wire AgentEvent — same class as `clear`).
  | { t: 'compact'; summaryText: string; keepCount: number }
  // Session Resume (LOCAL action, no wire AgentEvent — same class as `clear`/`compact`).
  // `messages` is the loaded transcript, supplied by the caller (purity preserved).
  | { t: 'resume-session'; messages: Msg[] };

const EFFORT_ORDER: ReadonlyArray<State['effort']> = ['medium', 'high', 'xhigh'];

export function initialState(): State {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
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
      };
    }

    case 'assistant-start':
      return {
        ...state,
        live: { id: action.id, role: 'assistant', blocks: [], done: false },
        phase: 'streaming',
      };

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
      if (live === null) {
        // Defensive: still register the call so a later tool-status isn't dropped.
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

      let phase = state.phase;
      if (action.status === 'running') phase = 'running-tool';
      else if (action.status === 'result' || action.status === 'error') {
        phase = state.live !== null ? 'streaming' : 'idle';
      }
      return { ...state, tools, phase };
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
        phase: 'awaiting-permission',
        pendingPermissionToolCallId: action.toolCallId,
      };
    }

    case 'permission-resolved':
      // The decision's effect on tool execution is W7/W8's job; the reducer only
      // restores UI/phase. (Decision/toolCallId are intentionally not stored.)
      return {
        ...state,
        overlay: 'none',
        phase: state.live !== null ? 'streaming' : 'idle',
        pendingPermissionToolCallId: null,
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
      // between requests) and rings the completion bell once per tool round. Only a
      // terminal stop ('end'/'max_tokens'/'abort'/'error') returns to 'idle', so the
      // bell rings exactly once when the whole turn ENDS.
      const phase: State['phase'] = action.stopReason === 'tool_use' ? 'streaming' : 'idle';
      return { ...state, committed: [...state.committed, doneMsg], live: null, phase };
    }

    case 'usage': {
      // Capture the live context-window occupancy from THIS request. Prefer the
      // adapter's normalized `contextTokens` (cache-inclusive); else fall back to a
      // positive `tokensIn` (a full-input measurement arrives once per request — at
      // message_start for the Anthropic family — while output-only deltas carry
      // tokensIn=0 and must NOT clobber it). `tokens` stays cumulative as before.
      const measured =
        action.contextTokens ?? (action.tokensIn > 0 ? action.tokensIn : undefined);
      return {
        ...state,
        tokens: { in: state.tokens.in + action.tokensIn, out: state.tokens.out + action.tokensOut },
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
        phase: 'idle',
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermissionToolCallId: null,
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
      return { ...state, overlay: action.overlay, phase: phaseForOverlay(state, action.overlay) };

    case 'skill-select':
      // UI action: the user picked a skill from the palette. The actual skill
      // body load is the model's `load_skill` tool, not a user invocation — so
      // this minimally closes the overlay. Additive: a new variant + case only.
      return { ...state, overlay: 'none', phase: phaseForOverlay(state, 'none') };

    case 'set-permission-mode':
      return { ...state, permissionMode: action.mode };

    case 'error': {
      // PROPOSED: surface errors both as a committed system Msg (so <Static>
      // renders them for free) and on `errorMessage` (so the status line reads it).
      const id = `system-error-${state.committed.length}`;
      const msg: Msg = {
        id,
        role: 'system',
        blocks: [{ kind: 'text', id: blockId(id, 0), text: action.message }],
        done: true,
      };
      return {
        ...state,
        committed: [...state.committed, msg],
        // Clear the in-flight turn the same way `aborted` does. A mid-stream error
        // (dropped connection, 5xx, error frame) leaves `state.live` a partial
        // assistant msg with `done:false`; StreamingMessage renders an animated
        // Spinner whenever `!live.done`, so without this the spinner would spin
        // forever below the committed error until a NEW turn overwrites `live`. Also
        // drop any open permission overlay so an error while it's up can't strand it.
        live: null,
        phase: 'error',
        errorMessage: action.message,
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermissionToolCallId: null,
      };
    }

    case 'resume-session':
      // Session Resume: wholesale-replace the transcript with a loaded session.
      // PURE — `messages` is supplied by the caller (no I/O / clock here). The live
      // `tools` map starts CLEAN: committed assistant msgs carry their own
      // `toolSnapshot`, and `toTurnMessages` reads that snapshot first, so a resumed
      // turn with tool calls reconstructs the model-facing transcript correctly.
      // Token totals are not persisted → reset fresh. effort + permissionMode are
      // user prefs → PRESERVED (same as `clear`). `compactions` intentionally omitted
      // (resets to absent/0).
      return {
        ...state,
        committed: action.messages,
        live: null,
        tools: {},
        phase: 'idle',
        overlay: 'none',
        pendingPermissionToolCallId: null,
        errorMessage: null,
        tokens: { in: 0, out: 0 },
        contextWindowTokens: undefined,
        compactions: undefined,
        // committed was replaced wholesale → remount <Static> so the whole resumed
        // transcript re-renders (else Static's grown index drops the leading msgs).
        transcriptEpoch: (state.transcriptEpoch ?? 0) + 1,
      };

    case 'notice': {
      // Append a dim system-feedback line to the committed transcript (F). Uses the
      // same committed.length-derived id scheme as the `error` case (PURE — no
      // Date.now / Math.random). Never fed to the model (see `isNoticeOnly` filtering
      // in the turn-message builder).
      const id = `notice-${state.committed.length}`;
      const msg: Msg = {
        id,
        role: 'system',
        done: true,
        blocks: [{ kind: 'notice', id: blockId(id, 0), text: action.text }],
      };
      return { ...state, committed: [...state.committed, msg] };
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
        phase: 'idle',
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermissionToolCallId: null,
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
 */
export const INTERRUPTED_NOTICE = 'interrupted';

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

function phaseForOverlay(state: State, overlay: State['overlay']): State['phase'] {
  if (state.phase === 'error') return 'error';
  if (overlay === 'permission') return 'awaiting-permission';
  if (state.phase === 'awaiting-permission') return state.live !== null ? 'streaming' : 'idle';
  return state.phase;
}
