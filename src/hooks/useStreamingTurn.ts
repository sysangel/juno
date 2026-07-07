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
import type { Action, Block, State } from '../core/reducer';
import { initialState, reducer } from '../core/reducer';
import type {
  ModelClient,
  PermissionPolicy,
  Tool,
  ToolSpec,
  TurnInput,
  TurnMessage,
} from '../core/contracts';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { createToolExecutor } from '../tools/executor';
import { createPermissionRegistry } from '../agent/eventBus';
import type { PermissionRegistry } from '../agent/eventBus';
import { isPersistentPermissionDecision, runTurn } from '../agent/turnRunner';
import { appendBrainMemoryContext } from '../services/brain';
import { chooseKeepCount, runCompaction } from '../agent/compactor';
import { MIN_MESSAGES_TO_COMPACT, shouldCompact } from '../core/selectors';
import type { PermissionRequest } from '../ui/PermissionPrompt';

/** Fallback context window when no `maxContext` is threaded from config. */
const DEFAULT_MAX_CONTEXT = 1_047_576;

type TextDeltaAction = Extract<Action, { t: 'text-delta' }>;
type ReasoningDeltaAction = Extract<Action, { t: 'reasoning-delta' }>;
type ToolCallDeltaAction = Extract<Action, { t: 'tool-call-delta' }>;
type DeltaAction = TextDeltaAction | ReasoningDeltaAction | ToolCallDeltaAction;

export interface StreamingTurnDeps {
  readonly client: ModelClient;
  readonly tools: ReadonlyArray<Tool>;
  readonly policy: PermissionPolicy;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: State['effort'];
  readonly systemPrompt?: string;
  // --- Context-Compression (all optional; safe defaults applied below) ---
  /** Model context window; the compaction pressure estimate is a fraction of this. */
  readonly maxContext?: number;
  /** Pressure fraction (0,1] at which auto-compaction fires. Default 0.5. */
  readonly compactionThreshold?: number;
  /** Estimated-token budget for the verbatim kept tail. Default ~25% of maxContext. */
  readonly compactionKeepBudget?: number;
  // --- Iteration budget (runaway guard; raw-API re-entry loop only) ---
  /** Per-turn tool-call ceiling forwarded to the turnRunner. Absent => unbounded. */
  readonly maxToolCalls?: number;
  /** Per-execution tool timeout (ms) forwarded to the executor. Absent => executor default. */
  readonly toolTimeoutMs?: number;
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
}

export interface StreamingTurnControls {
  readonly state: State;
  readonly dispatch: (action: Action) => void;
  readonly submit: (text: string) => Promise<void>;
  /**
   * True the instant a turn — OR a fire-and-forget compaction / ambient-recall pass —
   * owns `controllerRef`. This is EXACTLY the window in which `submit` silently no-ops
   * (see the `controllerRef.current !== null` guard in `submit`), and it can read while
   * the reducer phase is still `idle` (there is no `compacting` phase; the pre-turn
   * ambient-recall await also runs at `idle`). Read SYNCHRONOUSLY at call time — off the
   * ref, not render state — so the composer can decide whether an Enter would be accepted
   * BEFORE it clears the input, and never destroy a message the hook would reject.
   */
  readonly isBusy: () => boolean;
  readonly abort: () => void;
  readonly resolvePermission: (toolCallId: string, decision: PermissionDecision) => void;
  readonly permissionRequest: PermissionRequest | null;
  /** Manual `/compact`: summarize + rebuild now, bypassing the pressure threshold. */
  readonly compactNow: () => void;
  /**
   * True while a compaction LLM call is in flight (the window during which `submit`
   * silently no-ops because `controllerRef` is reused). Surfaced so the StatusLine can
   * make that window VISIBLE instead of dropping the user's message without a trace.
   */
  readonly isCompacting: boolean;
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

function isDeltaAction(action: Action): action is DeltaAction {
  return (
    action.t === 'text-delta' ||
    action.t === 'reasoning-delta' ||
    action.t === 'tool-call-delta'
  );
}

function textFromBlocks(blocks: ReadonlyArray<Block>): string {
  return blocks
    .filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('');
}

/** Rebuild the model-facing transcript from committed reducer state. */
function toTurnMessages(state: State): TurnMessage[] {
  const messages: TurnMessage[] = [];

  for (const message of state.committed) {
    const content = textFromBlocks(message.blocks);

    if (message.role === 'system' || message.role === 'user') {
      messages.push({ role: message.role, content });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls: Array<{ toolCallId: string; name: string; args: unknown }> = [];

      for (const block of message.blocks) {
        if (block.kind !== 'tool') {
          continue;
        }
        const tool = message.toolSnapshot?.[block.toolCallId] ?? state.tools[block.toolCallId];
        if (tool !== undefined) {
          toolCalls.push({ toolCallId: block.toolCallId, name: tool.name, args: tool.args });
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

// Coalesce only ADJACENT same-key deltas. The identity key differs by variant:
// text/reasoning carry `id`+`delta`; tool-call-delta carries `toolCallId`+`argsDelta`
// (NO `id`/`delta`). Branching by `action.t` so we NEVER read `.id`/`.delta` on a
// tool-call-delta (which would collapse different tool calls together) nor
// `.toolCallId`/`.argsDelta` on a text/reasoning delta. Adjacent-only merge preserves
// stream order: an interleaved different tool call (or a text-delta between two
// tool-call-deltas) starts a fresh entry. The mutated `last` is always a `{ ...action }`
// copy already in `coalesced`, never the caller's object.
function coalesceDeltas(queue: ReadonlyArray<DeltaAction>): DeltaAction[] {
  const coalesced: DeltaAction[] = [];

  for (const action of queue) {
    const last = coalesced.at(-1);

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
  const [state, reactDispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef<State>(state);
  const registryRef = useRef<PermissionRegistry>(createPermissionRegistry());
  const controllerRef = useRef<AbortController | null>(null);
  const compactingRef = useRef(false);
  // Render-mirror of `compactingRef`: refs don't re-render, so this drives the
  // StatusLine's visible `compacting…` indicator for the fire-and-forget window.
  const [isCompacting, setIsCompacting] = useState(false);
  // Render-mirror of the turnRunner's per-turn tool-call count (refs don't re-render). Reset
  // to 0 at the top of each `submit`; updated via the runTurn `onIteration` callback.
  const [toolCallsThisTurn, setToolCallsThisTurn] = useState(0);
  // Queue of pending /steer guidance for the LIVE re-entry loop. The turnRunner drains this
  // (via `drainSteer`) at each re-entry boundary; `steer()` also commits the text so it is
  // rendered and carried into the next submit even if the loop never re-enters.
  const steerQueueRef = useRef<string[]>([]);
  const deltaQueueRef = useRef<DeltaAction[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permissionRisksRef = useRef<Map<string, RiskLevel>>(new Map());

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Synchronous dispatch: keep stateRef.current in lockstep so the executor's
  // getState() and the permissionRequest selector always see the latest state,
  // even before React re-renders.
  const dispatchNow = useCallback(
    (action: Action): void => {
      if (action.t === 'permission-open') {
        permissionRisksRef.current.set(action.toolCallId, action.risk);
      }
      if (action.t === 'permission-resolved') {
        permissionRisksRef.current.delete(action.toolCallId);
      }
      // Prune leaked risk entries: `permission-resolved` is the normal cleanup,
      // but an abort emits `aborted` (clearing the overlay) and a tool's terminal
      // status arrives as `tool-status error`, never `permission-resolved`. Drop
      // the side-table entry on both so a parked risk can't leak past the turn.
      if (action.t === 'aborted') {
        permissionRisksRef.current.clear();
      }
      if (
        action.t === 'tool-status' &&
        (action.status === 'result' || action.status === 'error')
      ) {
        permissionRisksRef.current.delete(action.toolCallId);
      }

      stateRef.current = reducer(stateRef.current, action);
      reactDispatch(action);
    },
    [reactDispatch],
  );

  const flushDeltas = useCallback((): void => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const queued = deltaQueueRef.current;
    if (queued.length === 0) {
      return;
    }

    deltaQueueRef.current = [];
    for (const action of coalesceDeltas(queued)) {
      dispatchNow(action);
    }
  }, [dispatchNow]);

  const dispatch = useCallback(
    (action: Action): void => {
      if (isDeltaAction(action)) {
        deltaQueueRef.current.push(action);
        if (flushTimerRef.current === null) {
          flushTimerRef.current = setTimeout(() => {
            flushDeltas();
          }, 16);
        }
        return;
      }

      // Non-delta actions flush the queue first to preserve ordering.
      flushDeltas();
      dispatchNow(action);
    },
    [dispatchNow, flushDeltas],
  );

  // Synchronous "would submit no-op?" probe for the composer. Reads the ref at call
  // time so it reflects a controller taken AFTER the last render (compaction / ambient
  // recall) — a render-mirrored value could be stale for that exact window.
  const isBusy = useCallback((): boolean => controllerRef.current !== null, []);

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
      if (compactingRef.current || controllerRef.current !== null) {
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
      if (s.committed.length <= MIN_MESSAGES_TO_COMPACT) {
        return;
      }

      compactingRef.current = true;
      setIsCompacting(true);
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const budget = deps.compactionKeepBudget ?? Math.floor(maxContext * 0.25);
        const keepCount = chooseKeepCount(s.committed, budget);
        // Summarize ONLY the elided prefix (everything before the kept tail).
        const elided = toTurnMessages({
          ...s,
          committed: s.committed.slice(0, s.committed.length - keepCount),
        });
        const summaryText = await runCompaction(elided, deps.client, controller.signal);
        if (summaryText.trim().length > 0 && !controller.signal.aborted) {
          dispatchNow({ t: 'compact', summaryText, keepCount });
        }
      } catch {
        // Compaction is best-effort; never crash the session.
      } finally {
        compactingRef.current = false;
        setIsCompacting(false);
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    },
    [
      deps.client,
      deps.compactionKeepBudget,
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
      if (trimmed.length === 0 || controllerRef.current !== null) {
        return;
      }

      flushDeltas();

      const userId = `user-${createTurnId()}`;
      dispatchNow({ t: 'user-submit', id: userId, text });
      // Reset the per-turn tool-call budget mirror for this fresh submission, and clear any
      // steer guidance that was queued but never drained (a stale steer from a prior turn
      // already rode that turn's committed lead via toTurnMessages, so re-injecting it here
      // would double it).
      setToolCallsThisTurn(0);
      steerQueueRef.current = [];

      const controller = new AbortController();
      controllerRef.current = controller;

      const executor = createToolExecutor({
        tools: deps.tools,
        policy: deps.policy,
        cwd: deps.cwd,
        signal: controller.signal,
        getState: () => stateRef.current,
        awaitPermission: registryRef.current.await,
        timeoutMs: deps.toolTimeoutMs,
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
          onIteration: (count) => setToolCallsThisTurn(count),
          drainSteer: () => steerQueueRef.current.splice(0),
        });
      } finally {
        flushDeltas();
        registryRef.current.drainDeny();
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }

      // After the turn fully settles (controllerRef cleared, phase idle), kick off an
      // auto-compaction pass — never inside the turn. Fire-and-forget: a no-op unless
      // the estimated transcript pressure has crossed the threshold.
      void maybeCompact();
    },
    [
      deps.ambientRecall,
      deps.client,
      deps.cwd,
      deps.effort,
      deps.maxToolCalls,
      deps.model,
      deps.policy,
      deps.specs,
      deps.systemPrompt,
      deps.tools,
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

      registryRef.current.drainDeny();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permissionRequest = useMemo<PermissionRequest | null>(() => {
    const toolCallId = state.pendingPermissionToolCallId;
    if (toolCallId === null) {
      return null;
    }

    const tool = state.tools[toolCallId];
    if (tool === undefined) {
      return null;
    }

    return {
      toolCallId,
      name: tool.name,
      args: tool.args,
      risk: permissionRisksRef.current.get(toolCallId) ?? 'risky',
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
    isCompacting,
    toolCallsThisTurn,
    steer,
  };
}
