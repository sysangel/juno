// src/hooks/useStreamingTurn.ts
// W6 — the React glue around the turnRunner.
//
// Owns: useReducer(reducer), the AbortController, ~16ms token-delta batching,
// the SHARED permission registry, and the permission-risk side-table (the
// reducer's `permission-open` does NOT store risk, so we remember it here to
// build the PermissionRequest the prompt needs).
//
// Exposes { state, dispatch, submit, abort, resolvePermission, permissionRequest }.
//
// Contract notes:
//   B. ONE shared policy instance (deps.policy) is injected into the executor
//      AND is the instance `resolvePermission` calls `.remember(...)` on.
//   C. resolvePermission = remember(if persistent) -> registry.resolve ->
//      dispatch permission-resolved (which flips the overlay off).
//   A. abort()/unmount drainDeny() the registry so no parked await hangs.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Action, Block, Msg, PermissionMode, State } from '../core/reducer';
import { committedForModel, initialState, reducer } from '../core/reducer';
import type {
  ModelClient,
  PermissionPolicy,
  Tool,
  ToolSpec,
  TurnInput,
  TurnMessage,
} from '../core/contracts';
import type { PermissionDecision } from '../core/events';
import { createToolExecutor } from '../tools/executor';
import { createHookDispatcher } from '../tools/hookDispatcher';
import type { HooksSettings } from '../services/config';
import { createPermissionRegistry } from '../agent/eventBus';
import type { PermissionRegistry } from '../agent/eventBus';
import { isPersistentPermissionDecision, runTurn } from '../agent/turnRunner';
import { appendBrainMemoryContext } from '../services/brain';
import {
  chooseKeepCount,
  classifyCompactionFailure,
  runCompactionWithRetry,
  snapKeepPastToolResults,
  type CompactionRetryOptions,
} from '../agent/compactor';
import {
  MIN_MESSAGES_TO_COMPACT,
  selectBusy,
  shouldCompact,
} from '../core/selectors';
import type { PermissionRequest } from '../ui/PermissionPrompt';
import type { SubagentRecorder } from '../services/subagentRecorder';
import type { SessionTraceRecorder } from '../services/sessionTrace';
import { wipeScrollback, type WipeTarget } from '../ui/wipeScrollback';

/** Fallback context window when no `maxContext` is threaded from config. */
const DEFAULT_MAX_CONTEXT = 1_000_000;

type TextDeltaAction = Extract<Action, { t: 'text-delta' }>;
type ReasoningDeltaAction = Extract<Action, { t: 'reasoning-delta' }>;
type ToolCallDeltaAction = Extract<Action, { t: 'tool-call-delta' }>;
type DeltaAction = TextDeltaAction | ReasoningDeltaAction | ToolCallDeltaAction;
type ToolCallAction = Extract<Action, { t: 'tool-call' }>;
type ToolStatusAction = Extract<Action, { t: 'tool-status' }>;
type UsageAction = Extract<Action, { t: 'usage' }>;
type BatchableAction =
  | DeltaAction
  | ToolCallAction
  | ToolStatusAction
  | UsageAction;

export interface StreamingTurnDeps {
  readonly client: ModelClient;
  readonly tools: ReadonlyArray<Tool>;
  readonly policy: PermissionPolicy;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: State['effort'];
  /**
   * Runtime permission mode seeded from config. Threaded into `initialState` at
   * construction so frame 1 already reflects the configured mode (no post-mount seed
   * dispatch that briefly showed 'default'). Absent ⇒ 'default'.
   */
  readonly permissionMode?: PermissionMode;
  readonly systemPrompt?: string;
  // --- Context-Compression (all optional; safe defaults applied below) ---
  /** Model context window; the compaction pressure estimate is a fraction of this. */
  readonly maxContext?: number;
  /** Pressure fraction (0,1] at which auto-compaction fires. Default 0.5. */
  readonly compactionThreshold?: number;
  /** Estimated-token budget for the verbatim kept tail. Default ~25% of maxContext. */
  readonly compactionKeepBudget?: number;
  /**
   * Bounded-retry knobs for the compaction summarization call (empty/degenerate/transient
   * retry). Absent ⇒ production defaults (≤3 attempts, ~200-char min seed, ~250ms abortable
   * backoff). Tests zero the backoff to keep the hook harness fast.
   */
  readonly compactionRetry?: CompactionRetryOptions;
  /**
   * Wave 14 (b8-compaction-resilience): reactive compaction on a main-call
   * context-overflow. Default ON — the turnRunner compacts-and-retries once instead of
   * dead-ending on the overflow. Set `false` to disable. Threaded straight into runTurn;
   * leaving it undefined relies on the turnRunner's `!== false` default.
   */
  readonly reactiveCompaction?: boolean;
  // --- Iteration budget (runaway guard; raw-API re-entry loop only) ---
  /** Per-turn tool-call ceiling forwarded to the turnRunner. Absent => unbounded. */
  readonly maxToolCalls?: number;
  /** Per-execution tool timeout (ms) forwarded to the executor. Absent => executor default. */
  readonly toolTimeoutMs?: number;
  // --- Config-driven tool-call hooks (Wave 12; absent => feature off) ---
  /**
   * PreToolUse/PostToolUse hook config (config.json `hooks` block). When present, a
   * per-submission HookDispatcher is built over the turn's AbortSignal and threaded
   * into the executor: PreToolUse can hard-deny a call; PostToolUse can append a
   * model-facing reminder. Absent (or no groups) => the executor runs hooks-less
   * (zero behavior change).
   */
  readonly hooks?: HooksSettings;
  // --- Ambient brain recall (Phase 2; absent => feature off) ---
  /**
   * Given the RAW user prompt text, return a matched-memory context block to
   * append to this turn's outgoing user message, or `undefined` for none.
   * Called once per submit, before the turn is dispatched; the result is
   * injected into `TurnInput.messages` ONLY (never committed to state), so it
   * reaches every backend adjacent to the prompt but is never rendered,
   * persisted, or fed back into the next turn's recall query. The callback
   * must be fail-soft and internally time-bounded; a rejection is swallowed.
   */
  readonly ambientRecall?: (prompt: string) => Promise<string | undefined>;
  /**
   * Per-subagent transcript recorder (Wave 7). When present, every dispatched
   * action is observed against the post-reduction state and any subagent-child
   * tool event (claude-cli native OR juno-orchestrated) is appended to that
   * subagent's JSONL. Absent ⇒ no recording (the default in tests). Best-effort
   * and fail-soft — never affects the turn.
   */
  readonly subagentRecorder?: SubagentRecorder;
  /** Optional session-wide diagnostic trace observer. Its record method must stay
   * non-blocking; the fs-backed implementation queues serialization/I/O. */
  readonly traceRecorder?: SessionTraceRecorder;
  /**
   * Terminal stream the transcript-replacement scrollback wipe writes to (clear /
   * resume — see `dispatchNow`). Defaults to `process.stdout`; injectable so
   * a test can pass a capturing fake (and force `isTTY`) to assert the wipe. TTY-gated
   * inside `wipeScrollback`, so a non-TTY default never leaks control bytes.
   */
  readonly stdout?: WipeTarget;
}

export interface StreamingTurnControls {
  readonly state: State;
  readonly dispatch: (action: Action) => void;
  readonly submit: (text: string) => Promise<void>;
  /**
   * True while a turn OR a fire-and-forget compaction is in flight — now just
   * `selectBusy(state)` (phase ∉ {idle, error}). A turn covers its whole life with a
   * busy phase: 'preparing' from submit (before `assistant-start`, spanning the
   * ambient-recall await), then streaming/running-tool/awaiting-permission; a compaction
   * runs at 'compacting'. This is EXACTLY the window in which `submit` silently no-ops:
   * `submit` and `runCompactionStep` gate on the SAME `selectBusy(stateRef.current)`
   * predicate, so this probe and the actual acceptance decision can never diverge — in
   * particular there is no post-terminal micro-gap where isBusy reports idle but submit
   * would drop the message. Read SYNCHRONOUSLY off `stateRef` (kept in lockstep by
   * dispatchNow) at call time so the composer decides whether an Enter would be accepted
   * BEFORE it clears the input, and never destroys a message the hook would reject.
   */
  readonly isBusy: () => boolean;
  readonly abort: () => void;
  readonly resolvePermission: (toolCallId: string, decision: PermissionDecision) => void;
  readonly permissionRequest: PermissionRequest | null;
  /** Manual `/compact`: summarize + rebuild now, bypassing the pressure threshold. */
  readonly compactNow: () => void;
  /**
   * Running count of tool calls executed in the CURRENT turn (resets to 0 on each submit).
   * Surfaced so the StatusLine can render a `tools:used/max` budget chip — the runaway guard
   * is VISIBLE, not silent.
   */
  readonly toolCallsThisTurn: number;
  /**
   * Inject mid-turn guidance WITHOUT restarting the turn. On a raw-API backend the text is
   * spliced into the live re-entry loop as the freshest user message; it is ALSO committed
   * (rendered) immediately so it is never lost (and becomes the lead of the next submit if
   * the turn ends before a re-entry, e.g. on claude-cli). Empty/whitespace is a no-op.
   */
  readonly steer: (text: string) => void;
}

/**
 * Attach the current wall clock to the actions that bound the extended-thinking
 * phase (`reasoning-delta` start, `text-delta`/`tool-call` end, `assistant-done`
 * fallback close). Everything else passes through untouched. The clock lives here
 * at the dispatch edge — never in the pure reducer (thinking-collapse).
 */
function stampThinkingClock(action: Action): Action {
  switch (action.t) {
    case 'reasoning-delta':
    case 'text-delta':
    case 'tool-call':
    case 'assistant-done':
      return { ...action, ts: Date.now() };
    default:
      return action;
  }
}

function isBatchableAction(action: Action): action is BatchableAction {
  return (
    action.t === 'text-delta' ||
    action.t === 'reasoning-delta' ||
    action.t === 'tool-call-delta' ||
    action.t === 'tool-call' ||
    action.t === 'tool-status' ||
    action.t === 'usage'
  );
}

function textFromBlocks(blocks: ReadonlyArray<Block>): string {
  return blocks
    .filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('');
}

/** Rebuild the model-facing transcript from committed reducer state. */
export function toTurnMessages(state: State): TurnMessage[] {
  const messages: TurnMessage[] = [];
  const committed = committedForModel(state);

  for (let index = 0; index < committed.length; index += 1) {
    const message = committed[index]!;
    // Notice-only messages (F: `session cleared`, compaction feedback) are UI
    // feedback — never re-sent to the model. Skip so an empty system frame is not
    // emitted for them.
    if (message.blocks.length > 0 && message.blocks.every((block) => block.kind === 'notice')) {
      continue;
    }

    const content = textFromBlocks(message.blocks);

    if (message.role === 'system' || message.role === 'user') {
      messages.push({ role: message.role, content });
      continue;
    }

    if (message.role === 'assistant') {
      // Incremental Static fragments are a rendering/storage detail. Consecutive
      // fragments from one user turn must re-form ONE assistant wire message.
      const run: Msg[] = [message];
      if (message.turnId !== undefined) {
        while (
          index + 1 < committed.length &&
          committed[index + 1]?.role === 'assistant' &&
          committed[index + 1]?.turnId === message.turnId
        ) {
          run.push(committed[index + 1]!);
          index += 1;
        }
      }
      const toolCalls: Array<{ toolCallId: string; name: string; args: unknown }> = [];
      let content = '';

      for (const fragment of run) {
        content += textFromBlocks(fragment.blocks);
        for (const block of fragment.blocks) {
          if (block.kind !== 'tool') {
            continue;
          }
          const tool = fragment.toolSnapshot?.[block.toolCallId] ?? state.tools[block.toolCallId];
          if (tool !== undefined) {
            toolCalls.push({ toolCallId: block.toolCallId, name: tool.name, args: tool.args });
          }
        }
      }

      messages.push(
        toolCalls.length > 0
          ? { role: 'assistant', content, toolCalls }
          : { role: 'assistant', content },
      );
      continue;
    }

    // role === 'tool'
    const toolBlock = message.blocks.find(
      (block): block is Extract<Block, { kind: 'tool' }> => block.kind === 'tool',
    );
    if (toolBlock !== undefined) {
      messages.push({ role: 'tool', toolCallId: toolBlock.toolCallId, content });
    }
  }

  return messages;
}

/**
 * Ambient brain recall (Phase 2): append the matched-memory block to the LAST
 * user message of the outgoing transcript (the prompt just submitted), via the
 * same `<brain-memory-context>` framing as the Phase 0 system-prompt append.
 * Pure on `messages` (returns a copy); no user message ⇒ returned unchanged.
 */
function withAmbientContext(messages: TurnMessage[], context: string): TurnMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === 'user') {
      const content = appendBrainMemoryContext(message.content, context);
      if (content === undefined) {
        return messages;
      }
      const next = messages.slice();
      next[i] = { ...message, content };
      return next;
    }
  }
  return messages;
}

function createTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Coalesce only ADJACENT same-key deltas. Non-delta batch members (tool lifecycle
// and usage) remain distinct and ordered. The identity key differs by delta variant:
// text/reasoning carry `id`+`delta`; tool-call-delta carries `toolCallId`+`argsDelta`
// (NO `id`/`delta`). Branching by `action.t` so we NEVER read `.id`/`.delta` on a
// tool-call-delta (which would collapse different tool calls together) nor
// `.toolCallId`/`.argsDelta` on a text/reasoning delta. Adjacent-only merge preserves
// stream order: an interleaved different tool call (or a text-delta between two
// tool-call-deltas) starts a fresh entry. The mutated `last` is always a `{ ...action }`
// copy already in `coalesced`, never the caller's object.
function coalesceBatchableActions(queue: ReadonlyArray<BatchableAction>): BatchableAction[] {
  const coalesced: BatchableAction[] = [];

  for (const action of queue) {
    const last = coalesced.at(-1);

    if (
      action.t === 'tool-call' ||
      action.t === 'tool-status' ||
      action.t === 'usage'
    ) {
      coalesced.push({ ...action });
      continue;
    }

    if (action.t === 'tool-call-delta') {
      if (last?.t === 'tool-call-delta' && last.toolCallId === action.toolCallId) {
        last.argsDelta += action.argsDelta;
      } else {
        coalesced.push({ ...action });
      }
      continue;
    }

    // text-delta / reasoning-delta: merge by `id`.
    if (last?.t === action.t && last.id === action.id) {
      last.delta += action.delta;
    } else {
      coalesced.push({ ...action });
    }
  }

  return coalesced;
}

export function useStreamingTurn(deps: StreamingTurnDeps): StreamingTurnControls {
  // Seed the runtime permission mode from config at CONSTRUCTION (frame 1 is honest —
  // no post-mount seed dispatch that flashed 'default'). The `clear` case re-applies
  // `state.permissionMode`, so a later config change need not re-seed here.
  const [state, reactDispatch] = useReducer(reducer, deps.permissionMode, (m) =>
    initialState(m !== undefined ? { permissionMode: m } : undefined),
  );
  const stateRef = useRef<State>(state);
  const registryRef = useRef<PermissionRegistry>(createPermissionRegistry());
  // The AbortController + async-ownership token. It is NO LONGER a busy MIRROR (the
  // reducer phase owns "in flight" now); it survives ONLY to hold the AbortController
  // and to gate submit/compaction re-entry so an in-flight turn's finally can't clobber
  // a freshly-started next turn (the `controllerRef.current === controller` checks).
  const controllerRef = useRef<AbortController | null>(null);
  // Render-mirror of the turnRunner's per-turn tool-call count (refs don't re-render). Reset
  // to 0 at the top of each `submit`; updated via the runTurn `onIteration` callback.
  const [toolCallsThisTurn, setToolCallsThisTurn] = useState(0);
  // Queue of pending /steer guidance for the LIVE re-entry loop. The turnRunner drains this
  // (via `drainSteer`) at each re-entry boundary; `steer()` also commits the text so it is
  // rendered and carried into the next submit even if the loop never re-enters.
  const steerQueueRef = useRef<string[]>([]);
  const batchQueueRef = useRef<BatchableAction[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read the recorder off a ref so dispatchNow (which runs on the hot dispatch
  // path) need not list it as a dependency and re-form every time it changes.
  const recorderRef = useRef<SubagentRecorder | undefined>(deps.subagentRecorder);
  recorderRef.current = deps.subagentRecorder;
  const traceRecorderRef = useRef<SessionTraceRecorder | undefined>(deps.traceRecorder);
  traceRecorderRef.current = deps.traceRecorder;
  // Read the wipe target off a ref for the same reason as the recorder: dispatchNow
  // stays on `[reactDispatch]` and never re-forms when stdout identity changes.
  const stdoutRef = useRef<WipeTarget>(deps.stdout ?? process.stdout);
  stdoutRef.current = deps.stdout ?? process.stdout;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Synchronous dispatch: keep stateRef.current in lockstep so the executor's
  // getState() and the permissionRequest selector always see the latest state,
  // even before React re-renders.
  const dispatchNow = useCallback(
    (action: Action): void => {
      // The permission risk now rides `permission-open` INTO reducer state
      // (`state.pendingPermission.risk`) and is cleared by every terminal that closes
      // the prompt — so the old permissionRisksRef side-table (and its leak-prone manual
      // pruning across permission-resolved/aborted/tool-status, which MISSED the 'error'
      // case) is gone entirely.
      //
      // Stamp the dispatch-edge wall clock onto the actions that bound the thinking
      // phase, so the reducer can freeze a `✻ thought for <n>s` duration WITHOUT
      // reading a clock itself (purity preserved). Other actions pass through as-is.
      //
      // A `deltas` batch stamps EACH sub-action (the wrapper carries no ts); every other
      // action stamps itself. (stampThinkingClock is a no-op on tool-call-delta — not in
      // its switch — so arg-deltas pass through, exactly as today.)
      const stamped: Action =
        action.t === 'deltas'
          ? { t: 'deltas', actions: action.actions.map(stampThinkingClock) }
          : stampThinkingClock(action);
      stateRef.current = reducer(stateRef.current, stamped);
      // Session-wide trace observes the exact stamped Action accepted by the reducer.
      // It only enqueues here; redaction serialization and NDJSON I/O happen later.
      try {
        traceRecorderRef.current?.record(stamped);
      } catch {
        // An observer must never affect state dispatch, including an injected one.
      }
      // Record subagent-child tool events AFTER the reducer applies them, so a
      // tool-status/-delta can resolve its parent via the freshly-updated
      // state.tools. Fail-soft: the recorder itself swallows its I/O errors.
      //
      // FAN a `deltas` batch out to its sub-actions. A bare 'deltas' resolves to no
      // parentToolUseId (subagentRecorder.parentIdFor returns undefined for it), so
      // recording the wrapper would DROP subagent tool-call-delta lines. Recording each
      // sub-action against the final folded state is byte-identical to today: a delta never
      // sets/changes parentToolUseId, and flushDeltas already coalesced before dispatch, so
      // the recorder sees the same coalesced sub-actions it sees now.
      if (stamped.t === 'deltas') {
        for (const sub of stamped.actions) recorderRef.current?.record(sub, stateRef.current);
      } else {
        recorderRef.current?.record(stamped, stateRef.current);
      }
      // Transcript-replacement wipe. `clear` / `resume-session` are the two
      // actions that swap `committed` wholesale and bump `transcriptEpoch`,
      // remounting <Static> to REPRINT the entire new transcript. Erase native
      // scrollback FIRST (the one sanctioned `\x1b[3J`) or the remount stacks a SECOND
      // copy above the stale one — the resume duplication bug. This shared funnel keeps
      // every true replacement path uniform; it runs BEFORE reactDispatch,
      // i.e. before the remount, so the wipe precedes the reprint.
      if (
        stamped.t === 'clear' ||
        stamped.t === 'resume-session'
      ) {
        wipeScrollback(stdoutRef.current);
      }
      reactDispatch(stamped);
    },
    [reactDispatch],
  );

  const flushDeltas = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const queued = batchQueueRef.current;
    if (queued.length === 0) {
      return;
    }

    batchQueueRef.current = [];
    // ONE dispatch applies the whole coalesced set: dispatchNow folds it in a single
    // reducer application (stateRef in lockstep) and fires ONE reactDispatch → one render.
    dispatchNow({ t: 'deltas', actions: coalesceBatchableActions(queued) });
  }, [dispatchNow]);

  const dispatch = useCallback(
    (action: Action): void => {
      if (isBatchableAction(action)) {
        batchQueueRef.current.push(action);
        if (flushTimerRef.current === null) {
          flushTimerRef.current = setTimeout(() => {
            flushDeltas();
          }, 16);
        }
        return;
      }

      // Synchronous lifecycle/permission/local actions flush the queue first to
      // preserve ordering and make stateRef immediately observable to their handlers.
      flushDeltas();
      dispatchNow(action);
    },
    [dispatchNow, flushDeltas],
  );

  // Synchronous "would submit no-op?" probe for the composer. Reads `selectBusy` off
  // `stateRef` (kept in lockstep by dispatchNow) at call time, so it reflects a turn-start
  // (phase 'preparing') or compaction-start (phase 'compacting') dispatched AFTER the last
  // render — those are set synchronously with the controller, with no await between, so
  // this reducer-derived signal agrees with the controller at every observable point.
  const isBusy = useCallback((): boolean => selectBusy(stateRef.current), []);

  const abort = useCallback((): void => {
    // Single owner for the `aborted` action: controller.abort() fires
    // turnRunner's abort listener, which is the ONE source of the `aborted`
    // dispatch. We only unstick parked awaits here so the executor doesn't hang;
    // we do NOT dispatch `aborted` ourselves (that would double-fire it).
    const controller = controllerRef.current;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort();
    }

    registryRef.current.drainDeny();
    flushDeltas();
  }, [flushDeltas]);

  const resolvePermission = useCallback(
    (toolCallId: string, decision: PermissionDecision): void => {
      flushDeltas();

      // B + C: remember on the SHARED policy FIRST (persistent decisions only),
      // then unstick the parked executor await, then dismiss the overlay.
      if (isPersistentPermissionDecision(decision)) {
        const tool = stateRef.current.tools[toolCallId];
        if (tool !== undefined) {
          deps.policy.remember(tool.name, decision);
        }
      }

      registryRef.current.resolve(toolCallId, decision);
      dispatchNow({ t: 'permission-resolved', toolCallId, decision });
    },
    [deps.policy, dispatchNow, flushDeltas],
  );

  // Context-Compression step. Runs ONLY at idle (never mid-turn): summarizes the
  // elided committed prefix through the SAME client (tools-less) and dispatches the
  // pure `compact` action. Best-effort — any failure/empty summary leaves committed
  // untouched. `force` bypasses the pressure threshold (manual `/compact`) but still
  // honors the re-entrancy + min-length guards. Reuses controllerRef so abort()/unmount
  // cancels an in-flight compaction exactly like a turn.
  const runCompactionStep = useCallback(
    async (force: boolean): Promise<void> => {
      // Re-entrancy gate on the reducer-derived busy signal (same authority as isBusy /
      // submit): a live turn is busy in any of its phases, a second compaction is busy at
      // 'compacting'. Using selectBusy rather than a raw controllerRef check also blocks a
      // compaction during the pre-first-byte 'preparing' window, before the turn's
      // controller is taken. The min-length / shouldCompact early-returns below run BEFORE
      // compaction-start, so nothing can interleave between this gate and taking the phase.
      if (selectBusy(stateRef.current)) {
        return;
      }
      // Commit any queued deltas so the estimate sees the true committed transcript.
      flushDeltas();
      const s = stateRef.current;
      const maxContext = deps.maxContext ?? DEFAULT_MAX_CONTEXT;
      if (!force && !shouldCompact(s, maxContext, deps.compactionThreshold)) {
        return;
      }
      // Min-length guard applies to the manual path too: nothing to shrink below this.
      const modelCommitted = committedForModel(s);
      if (modelCommitted.length <= MIN_MESSAGES_TO_COMPACT) {
        // Manual `/compact` gets HONEST feedback instead of the old silent no-op (F).
        if (force) {
          dispatchNow({ t: 'notice', text: 'nothing to compact yet' });
        }
        return;
      }

      // Enter the 'compacting' phase synchronously, then take the controller with NO await
      // between — mirroring submit's turn-start ordering — so isBusy (selectBusy) and the
      // controller flip together and the `compacting…` busy line is visible for the whole
      // fire-and-forget window.
      dispatchNow({ t: 'compaction-start' });
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const budget = deps.compactionKeepBudget ?? Math.floor(maxContext * 0.25);
        // Snap the chosen boundary FORWARD past any leading tool-result Msgs so the kept
        // tail never opens on an orphan `tool` message (whose `tool_use` was elided into
        // the summary — an Anthropic 400 on the next turn). One snap here keeps the elided
        // slice (below) and the dispatched `compact` keepCount consistent.
        const selectedKeepCount = snapKeepPastToolResults(
          modelCommitted,
          chooseKeepCount(modelCommitted, budget),
        );
        // The boundary is persisted against append-only UI fragments. If a
        // repeated compaction's selected model tail starts with the synthetic
        // prior summary, fold that summary forward again and begin the verbatim
        // tail at the first real committed fragment.
        let keepStart = modelCommitted.length - selectedKeepCount;
        while (
          keepStart < modelCommitted.length &&
          !s.committed.includes(modelCommitted[keepStart]!)
        ) {
          keepStart += 1;
        }
        const firstKept = modelCommitted[keepStart];
        const rawKeepCount = firstKept === undefined
          ? 0
          : s.committed.length - s.committed.indexOf(firstKept);
        // Summarize ONLY the elided prefix (everything before the kept tail).
        const elided = toTurnMessages({
          ...s,
          committed: modelCommitted.slice(0, keepStart),
          compactionBoundary: undefined,
        });
        const summaryText = await runCompactionWithRetry(
          elided,
          deps.client,
          controller.signal,
          deps.compactionRetry,
        );
        if (summaryText.trim().length > 0 && !controller.signal.aborted) {
          dispatchNow({
            t: 'compact',
            summaryText,
            keepCount: rawKeepCount,
            compactedCount: keepStart,
          });
        } else if (force && !controller.signal.aborted) {
          // Force path produced no usable summary (empty model reply, no throw): say so
          // rather than leave the user staring at an unchanged transcript.
          dispatchNow({ t: 'notice', text: 'nothing to compact yet' });
        }
      } catch (error) {
        // Compaction is best-effort; never crash the session. On the MANUAL (/compact
        // force) path, surface a summarizer failure as an honest error notice instead
        // of a silent no-op (E). Auto-compaction stays quiet (it fires opportunistically
        // at idle — a failure there is not the user's action to hear about).
        if (force && !controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          // Surface the distinct cause when the model rejected the summarization input
          // for being too large (the retry wrapper rethrows context-length failures
          // immediately) so the user sees why /compact could not shrink the transcript.
          const detail =
            classifyCompactionFailure(message) === 'context_length'
              ? `context window exceeded: ${message}`
              : message;
          dispatchNow({ t: 'notice', text: `compaction failed: ${detail}` });
        }
      } finally {
        // Release the controller + return to 'idle' (compaction-settle keeps 'error' if an
        // error landed). Gated on still OWNING the controller so a compaction's settle can
        // never clobber a turn that started after this one — same discipline as submit's
        // turn-settle.
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          dispatchNow({ t: 'compaction-settle' });
        }
        // Compaction drains the SAME `onRetry`-wired client as a live turn, but through
        // `runCompaction` — which consumes the summarization call's
        // assistant-start/error/aborted INTERNALLY. So a transient 503/429 during
        // summarization fires onRetry ⇒ dispatches `retry-attempt`, yet NO reducer path
        // ever clears `state.retry` (the compact/notice actions don't touch it). Clear
        // it here, in the finally, so no phantom `retrying n/m · esc to abort` line
        // survives at idle after compaction settles — success, silent skip, failure, or
        // abort all funnel through here. A no-op when nothing was retried.
        dispatchNow({ t: 'retry-clear' });
      }
    },
    [
      deps.client,
      deps.compactionKeepBudget,
      deps.compactionRetry,
      deps.compactionThreshold,
      deps.maxContext,
      dispatchNow,
      flushDeltas,
    ],
  );

  const maybeCompact = useCallback((): Promise<void> => runCompactionStep(false), [runCompactionStep]);
  const compactNow = useCallback((): void => {
    void runCompactionStep(true);
  }, [runCompactionStep]);

  // /steer mid-turn inject. Two effects, both load-bearing:
  //   1. push to steerQueueRef -> the turnRunner drains it at the next re-entry boundary and
  //      appends it as the freshest user message of the live loop (raw-API only).
  //   2. dispatch a `user-submit` -> the steer RENDERS in the transcript AND lands in
  //      `committed`, so `toTurnMessages` carries it into the NEXT submit even if the turn
  //      ends before re-entering (e.g. claude-cli, or a steer arriving on the final
  //      iteration). No double-exposure within one turn: the live loop builds currentInput
  //      from the queue, not from committed; committed is only re-read on the next submit.
  const steer = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      steerQueueRef.current.push(trimmed);
      dispatchNow({ t: 'user-submit', id: `steer-${createTurnId()}`, text: trimmed });
    },
    [dispatchNow],
  );

  const submit = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      // Guard on the SAME reducer-derived busy signal the composer probes via isBusy
      // (selectBusy off stateRef), NOT on controllerRef — otherwise the two diverge in the
      // post-terminal micro-gap (phase 'idle' but the settling turn's finally hasn't yet
      // released controllerRef): isBusy would report not-busy, the composer would clear the
      // input and call submit, and a controllerRef guard would silently drop the message.
      // selectBusy also closes the pre-first-byte 'preparing' window (busy before the
      // controller is even taken), which the null-controller check missed.
      if (trimmed.length === 0 || selectBusy(stateRef.current)) {
        return;
      }

      flushDeltas();

      const userId = `user-${createTurnId()}`;
      dispatchNow({ t: 'user-submit', id: userId, text });
      // Enter the 'preparing' phase SYNCHRONOUSLY, before the ambient-recall await below, so
      // the busy line (selectActivity 'thinking…') and isBusy (selectBusy) cover the whole
      // pre-`assistant-start` window — recall wait + pre-first-byte gap + initial-call retry
      // backoff. This REPLACES the old optimisticTurn flag; the controller is taken just
      // below with no await between, so the two flip together.
      dispatchNow({ t: 'turn-start' });
      // Reset the per-turn tool-call budget mirror for this fresh submission, and clear any
      // steer guidance that was queued but never drained (a stale steer from a prior turn
      // already rode that turn's committed lead via toTurnMessages, so re-injecting it here
      // would double it).
      setToolCallsThisTurn(0);
      steerQueueRef.current = [];

      const controller = new AbortController();
      controllerRef.current = controller;

      // Config-driven hook gate, built PER-SUBMISSION over this turn's signal so a
      // PreToolUse hook is killed on abort. Undefined when no hooks are configured,
      // so the executor path is byte-identical to a hooks-less build.
      const hookDispatcher =
        deps.hooks !== undefined
          ? createHookDispatcher(deps.hooks, { signal: controller.signal })
          : undefined;

      const executor = createToolExecutor({
        tools: deps.tools,
        policy: deps.policy,
        cwd: deps.cwd,
        signal: controller.signal,
        getState: () => stateRef.current,
        awaitPermission: registryRef.current.await,
        timeoutMs: deps.toolTimeoutMs,
        hooks: hookDispatcher,
      });

      // Ambient brain recall (Phase 2): query the brain with the RAW prompt
      // text only (never previously injected context — no recall recursion)
      // and append any matched-memory block to the OUTGOING copy of this
      // prompt. This is awaited before dispatch, so it adds a bounded pre-turn
      // delay (≤2.5s hard timeout, ~50-70ms typical) — not a free background
      // fetch. The callback is time-bounded and fail-soft by contract, and any
      // rejection is swallowed here too: empty/timeout/error all mean "inject
      // nothing and proceed" (fails open).
      let messages = toTurnMessages(stateRef.current);
      if (deps.ambientRecall !== undefined) {
        let ambient: string | undefined;
        try {
          ambient = await deps.ambientRecall(trimmed);
        } catch {
          ambient = undefined;
        }
        if (ambient !== undefined && ambient.trim().length > 0) {
          messages = withAmbientContext(messages, ambient);
        }
      }

      const input: TurnInput = {
        id: createTurnId(),
        messages,
        model: deps.model,
        cwd: deps.cwd,
        effort: deps.effort ?? stateRef.current.effort,
        permissionMode: stateRef.current.permissionMode,
        systemPrompt: deps.systemPrompt,
        // Continuation key for CLI `--resume`: model-only compaction advances this
        // generation without remounting the append-only Static transcript.
        conversationEpoch: stateRef.current.conversationEpoch ?? 0,
      };

      try {
        await runTurn(input, {
          client: deps.client,
          executor,
          specs: deps.specs,
          dispatch,
          signal: controller.signal,
          registry: registryRef.current,
          maxToolCalls: deps.maxToolCalls,
          // Mid-turn (preflight) compaction: same knobs the idle runCompactionStep reads, so
          // the two paths shrink the transcript on one consistent scale. maxContext undefined
          // ⇒ mid-turn compaction is OFF (feature-off / backward-compat); the keep-budget and
          // threshold defaults (~25% / 0.5) are applied inside maybeCompactTurnMessages to match
          // the idle path (Math.floor(maxContext*0.25) / DEFAULT_COMPACTION_THRESHOLD).
          maxContext: deps.maxContext,
          compactionThreshold: deps.compactionThreshold,
          compactionKeepBudget: deps.compactionKeepBudget,
          // Wave 14 (b8): reactive compact-and-retry on a context-overflow (default ON).
          reactiveCompaction: deps.reactiveCompaction,
          onIteration: (count) => setToolCallsThisTurn(count),
          drainSteer: () => steerQueueRef.current.splice(0),
        });
      } finally {
        flushDeltas();
        registryRef.current.drainDeny();
        // Settle to 'idle' (turn-settle keeps 'error' if the turn errored) — but ONLY when
        // we still own the controller. If a new turn started in the post-terminal micro-gap
        // (assistant-done already flipped phase to 'idle', then a fresh submit took the
        // controller), this stale finally must NOT dispatch turn-settle and clobber the new
        // turn's 'preparing'. The ownership check is what makes that safe.
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          dispatchNow({ t: 'turn-settle' });
        }
      }

      // After the turn fully settles (controllerRef cleared, phase idle), kick off an
      // auto-compaction pass — never inside the turn. Fire-and-forget: a no-op unless
      // the estimated transcript pressure has crossed the threshold.
      void maybeCompact();
    },
    // Granular by design (same rationale as useStatusModel): `deps` is a FRESH
    // object literal every render (see app.tsx:204), so depending on `deps`
    // wholesale — what the rule suggests — would rebuild `submit` on every render
    // (incl. each ~16ms token flush) and defeat this useCallback. Instead every
    // field submit reads is listed individually. Keep this list COMPLETE:
    // toolTimeoutMs was the one gap (a real stale-closure, now added above and
    // guarded by a test).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above
    [
      deps.ambientRecall,
      deps.client,
      // Mid-turn compaction knobs read inside the runTurn call above — listed individually
      // (like every other deps.* field submit reads) so a config change rebuilds submit
      // instead of leaving a stale closure with the old context window / threshold / budget.
      deps.compactionKeepBudget,
      deps.compactionThreshold,
      deps.cwd,
      deps.effort,
      // hooks feeds createHookDispatcher(deps.hooks, …) in this callback's body;
      // omitting it here would stale the tool-call hook gate whenever the config's
      // hooks block changed between renders (same stale-closure trap as toolTimeoutMs).
      deps.hooks,
      deps.maxContext,
      deps.maxToolCalls,
      // reactiveCompaction feeds runTurn above; list it so a config flip rebuilds submit
      // instead of leaving a stale closure with the old reactive-compaction setting.
      deps.reactiveCompaction,
      deps.model,
      deps.policy,
      deps.specs,
      deps.systemPrompt,
      deps.tools,
      // toolTimeoutMs feeds createToolExecutor({ timeoutMs }) in this callback's
      // body; omitting it here staled the tool-execution timeout whenever the
      // value changed between renders (submit kept its first-render closure).
      deps.toolTimeoutMs,
      dispatch,
      dispatchNow,
      flushDeltas,
      maybeCompact,
    ],
  );

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }

      const controller = controllerRef.current;
      if (controller !== null && !controller.signal.aborted) {
        controller.abort();
      }

      // registryRef holds a STABLE service object (created once via useRef, never
      // reassigned), so draining the CURRENT registry at unmount is intentional and
      // correct — not the "ref may point at a changed React-rendered node" hazard
      // the rule warns about. The [] deps are right: the cleanup touches only refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      registryRef.current.drainDeny();
    };
  }, []);

  useEffect(() => {
    const recorder = deps.traceRecorder;
    return () => {
      // Flush the session-bound recorder when App changes the active session or the
      // hook unmounts. Separate from turn cleanup: swapping trace ownership must not
      // abort an unrelated live controller.
      void recorder?.close().catch(() => {});
    };
  }, [deps.traceRecorder]);

  const permissionRequest = useMemo<PermissionRequest | null>(() => {
    const pending = state.pendingPermission;
    if (pending === null) {
      return null;
    }

    const tool = state.tools[pending.toolCallId];
    if (tool === undefined) {
      return null;
    }

    // Risk rides `state.pendingPermission` now (from the `permission-open` action), so
    // there is no side-table lookup and no `?? 'risky'` fallback to drift.
    return {
      toolCallId: pending.toolCallId,
      name: tool.name,
      args: tool.args,
      risk: pending.risk,
    };
  }, [state]);

  return {
    state,
    dispatch,
    submit,
    isBusy,
    abort,
    resolvePermission,
    permissionRequest,
    compactNow,
    toolCallsThisTurn,
    steer,
  };
}
