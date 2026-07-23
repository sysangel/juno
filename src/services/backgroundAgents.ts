// src/services/backgroundAgents.ts
// Wave 13 (lane 1) — the background-agent RUNNER. Makes `spawn_subagent`
// NON-BLOCKING: instead of awaiting the child's whole turn inside the parent
// tool call (which pins the TUI spinner on "responding…"), the runner registers
// a task, kicks the child's `runTurn` on a DETACHED async loop, and returns a
// handle SYNCHRONOUSLY. The parent tool call settles immediately, so the parent
// turn goes idle right after spawning while the child keeps working.
//
// Two seams keep the rest of the app working while the child runs detached:
//
//   1. SURFACING via the INJECTED app dispatch (never `ctx.emit`). The child's
//      tool-call / -delta / -status actions are forwarded to `turn.dispatch`
//      (attached by App via `attach()`), namespaced under the spawn card id
//      (`<spawnCardId>::<childId>`) with `parentToolUseId = spawnCardId`. Routing
//      through `turn.dispatch` means the subagentRecorder + selectSubagents
//      nesting keep working for free. `ctx.emit` CANNOT be used: it is dead the
//      instant the spawning tool.run() returns (executor.ts `settled` guard), and
//      that now happens immediately. Child text/thinking stay OUT of the parent
//      transcript (they feed the returned summary only), same as the blocking path.
//
//   2. COMPLETION as OBSERVABLE STATE. When a child finishes the runner pushes a
//      `BackgroundCompletion` onto a queue and bumps a version counter, notifying
//      subscribers. It NEVER calls React dispatch/steer from its async loop — App
//      drains the queue in an effect and re-injects the result through the
//      interjection seam (`turn.steer`) plus a dim scrollback notice.
//
// {provider, model} PINNING (hard constraint): the runner captures the RESOLVED
// catalog entry (id + provider) at spawn() and uses it for the child's client +
// model. It NEVER re-resolves from the catalog/default later — the task's model
// and provider are set once and immutable.
import type { ModelClient, PermissionPolicy, Tool } from '../core/contracts';
import type { Action } from '../core/reducer';
import { initialState } from '../core/reducer';
import { createPermissionRegistry } from '../agent/eventBus';
import { runTurn } from '../agent/turnRunner';
import { createToolExecutor } from '../tools/executor';
import { createHookDispatcher } from '../tools/hookDispatcher';
import type { ModelEntry } from './catalog';
import type { AgentDefinition } from './agents';
import type { HooksSettings } from './config';
import {
  classifyRecords,
  type BackgroundOutputLine,
  type BackgroundPermissionCheckpoint,
  type BackgroundTaskRecord,
  type BackgroundTaskStore,
} from './backgroundTaskStore';

export type BackgroundTaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'aborted';
type InternalBackgroundTaskStatus = BackgroundTaskStatus | 'needs-user';

/** One registered background task. `model`/`provider` are the PINNED spawn-time
 * values (immutable). `controller` governs THIS task's lifetime alone — the
 * parent turn's abort never cascades here (detachment is the point). */
export interface BackgroundTask {
  /** The spawn card id (`ctx.toolCallId` of the spawning call). Keys everything. */
  readonly id: string;
  /** PINNED child model id (resolved catalog entry, spawn-time; immutable). */
  readonly model: string;
  /** PINNED child backend (resolved catalog entry provider, spawn-time; immutable). */
  readonly provider: string;
  status: InternalBackgroundTaskStatus;
  /** The spawn `task` text (the record's human label). */
  readonly description: string;
  /** This task's own AbortController — the ONLY thing that stops it. */
  readonly controller: AbortController;
  readonly mailbox: string[];
  /** Ordered, runner-owned event stream used by the orchestration workspace. */
  readonly timeline: BackgroundOutputLine[];
  readonly profile?: string;
  checkpoint?: BackgroundPermissionCheckpoint;
  /** The child's final summary (done only). */
  summary?: string;
  /** The child's failure reason (error only). */
  error?: string;
  readonly startedAt: number;
  /** Newest child activity (tool/prose/reasoning/usage), for panel timing. */
  lastActivityAt?: number;
  /** The session this task belongs to (durability key). Absent when no session id
   * was bound (e.g. a spawn before App called setSessionId, or a storeless runner). */
  sessionId?: string;
}

/** Read-only projection of a live runner task for presentation surfaces. */
export interface BackgroundAgentSnapshot {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly status: BackgroundTaskStatus;
  readonly description: string;
  readonly profile?: string;
  readonly checkpoint?: BackgroundPermissionCheckpoint;
  readonly summary?: string;
  readonly error?: string;
  readonly startedAt: number;
  readonly sessionId?: string;
  readonly timeline: readonly BackgroundOutputLine[];
  readonly capabilities: {
    readonly steer: boolean;
    readonly cancel: boolean;
    readonly resolvePermission: boolean;
  };
}

/** A settled child, queued for App to re-inject through the interjection seam. */
export interface BackgroundCompletion {
  readonly taskId: string;
  readonly status: 'done' | 'error' | 'aborted';
  readonly model: string;
  readonly provider: string;
  readonly summary?: string;
  readonly error?: string;
  /** The session this completion belongs to (lets the drain path mark it delivered
   * without threading activeSessionId). Absent for a storeless / session-less run. */
  readonly sessionId?: string;
}

/** Everything spawn() needs. `entry` is the RESOLVED catalog entry captured by the
 * spawning tool — the spawn-time {provider, model} pin. `childTools` is the
 * depth-1 child toolset (already stripped of spawn_subagent). */
export interface BackgroundSpawnOptions {
  readonly spawnCardId: string;
  readonly task: string;
  readonly entry: ModelEntry;
  readonly agentDef?: AgentDefinition;
  readonly childTools: ReadonlyArray<Tool>;
  readonly profile?: string;
  readonly systemPrompt?: string;
}

export interface BackgroundAgentRunnerDeps {
  /** Build a ModelClient for a catalog entry (the CHILD factory — never the codex bridge). */
  readonly createClient: (entry: ModelEntry) => ModelClient;
  /** SHARED permission policy (remembered patterns persist into background children). */
  readonly policy: PermissionPolicy;
  /** Working directory the child turn runs against (session-stable). */
  readonly cwd: string;
  /**
   * Config-driven tool-call hooks (PreToolUse only, for gate parity). A hook that
   * denies a tool for the parent denies it for a background child too. PostToolUse
   * is deliberately not applied (a child returns only a summary). Absent => hooks-less.
   */
  readonly hooks?: HooksSettings;
  /**
   * The crash-durability store (wave 14 b7). OPTIONAL: when undefined EVERY
   * durability path is a no-op — spawn/complete write nothing, reconcile/markDelivered
   * return empty — so every back-compat caller that omits it never touches disk and
   * behaves exactly as before.
   */
  readonly store?: BackgroundTaskStore;
  /** Maximum children executing concurrently. Absent keeps the historical unbounded mode. */
  readonly maxConcurrent?: number;
  /**
   * Wall-clock limit for one executing child. A timeout aborts its provider signal,
   * settles the visible task as an error, and frees the queue slot. Absent disables it.
   */
  readonly timeoutMs?: number;
  /** Injectable wall clock for deterministic queue/timing tests. */
  readonly now?: () => number;
  /** Injectable timer for deterministic timeout tests. */
  readonly setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface BackgroundAgentRunner {
  /**
   * Register the task, kick the child's runTurn on a DETACHED async IIFE, and
   * return the handle SYNCHRONOUSLY. Never awaits the child.
   */
  spawn(opts: BackgroundSpawnOptions): { taskId: string };
  sendMessage?(taskId: string, text: string): boolean;
  cancel?(taskId: string): boolean;
  pendingPermission?(taskId: string): BackgroundPermissionCheckpoint | undefined;
  resolvePermission?(taskId: string, decision: 'allow-once' | 'deny'): boolean;
  /**
   * Late-bind the app dispatch sink (turn.dispatch). Called by App once `turn`
   * exists; the detached loop surfaces child tool events through it.
   */
  attach(deps: { dispatch: (action: Action) => void }): void;
  /** Subscribe to task/completion changes (version bumps). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic change counter — a stable snapshot for external-store subscription. */
  getVersion(): number;
  /** Return + CLEAR the pending completion queue (App drains it in an effect). */
  drainCompletions(): BackgroundCompletion[];
  /** Live task-status snapshot keyed by spawn card id (the panel override source). */
  taskStatuses(): Record<string, BackgroundTaskStatus>;
  /** Spawn and last-activity instants for the legacy dock's timing grammar. */
  taskTimings?(): Record<string, { startedAt: number; lastActivityAt?: number }>;
  /** Ordered live-task projections for the dedicated orchestration workspace. */
  taskSnapshots?(): readonly BackgroundAgentSnapshot[];
  /** Enable token-level presentation notifications only while that surface is visible. */
  setTimelineVisible?(visible: boolean): void;
  /** Abort every still-running task (App unmount / teardown). */
  abortAll(): void;
  /**
   * Bind the active session id (wave 14 b7). App calls this after first paint (before
   * any user turn) so the first spawn's durable record carries the session. No-op
   * when no store is wired.
   */
  setSessionId(sessionId: string): void;
  /**
   * Crash-recovery reconcile for `sessionId` (wave 14 b7). Reads the durable records,
   * flips still-'running' tasks that are NOT live in THIS process to 'interrupted'
   * (persisting the flip), and returns them alongside the done/error completions that
   * were never delivered — for App to re-surface. No store ⇒ empty. Fail-soft.
   */
  reconcile(
    sessionId: string,
  ): Promise<{ interrupted: BackgroundTaskRecord[]; needsUser: BackgroundTaskRecord[]; undeliveredCompletions: BackgroundCompletion[] }>;
  /** Flip a durable record's `delivered` flag true (wave 14 b7) so a later resume does
   * NOT re-queue it. Fire-and-forget; no-op when no store is wired. */
  markDelivered(sessionId: string, taskId: string): void;
  /** Read a task's durable partial output (wave 14 b7) for inspection on resume.
   * No store ⇒ empty result. Fail-soft. */
  readOutput(
    sessionId: string,
    taskId: string,
  ): Promise<{ text: string; reasoning: string; lifecycle: BackgroundOutputLine[] }>;
}

// Deterministic nested-turn ids (no Date-based id — keeps tests reproducible; the
// turn id is not asserted, but a stable counter avoids nondeterministic churn).
let bgTurnCounter = 0;
function bgTurnId(): string {
  bgTurnCounter += 1;
  return `bg-subagent-turn-${bgTurnCounter}`;
}

/** Presentation memory bounds; the durable NDJSON remains the full audit trail. */
export const BACKGROUND_TIMELINE_MAX_ENTRIES = 256;
export const BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS = 2_048;
export const BACKGROUND_SUMMARY_MAX_CHARS = 200_000;
const BACKGROUND_TRUNCATION_MARKER = '\n… [agent output truncated by Juno]';

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key/i;
function sanitizeCheckpointValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeCheckpointValue(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeCheckpointValue(item, depth + 1);
  }
  return out;
}

/**
 * Map a settled completion to the two strings App emits: the model-facing steer
 * text (re-injected through the interjection seam) and the dim scrollback notice.
 * Pure + exported so the delivery wording is unit-testable without rendering App.
 */
export function formatCompletion(completion: BackgroundCompletion): {
  steerText: string;
  noticeText: string;
} {
  if (completion.status === 'done') {
    const body =
      completion.summary !== undefined && completion.summary.length > 0
        ? completion.summary
        : '(no output)';
    return {
      steerText: `Background agent ${completion.taskId} (${completion.model}) finished. Result:\n\n${body}`,
      noticeText: `✓ agent ${completion.taskId} done`,
    };
  }
  if (completion.status === 'aborted') {
    return {
      steerText: `Background agent ${completion.taskId} (${completion.model}) was cancelled.`,
      noticeText: `⊘ agent ${completion.taskId} cancelled`,
    };
  }
  const reason =
    completion.error !== undefined && completion.error.length > 0 ? completion.error : 'failed';
  return {
    steerText: `Background agent ${completion.taskId} (${completion.model}) failed: ${reason}`,
    noticeText: `✗ agent ${completion.taskId} ${reason.split('\n')[0] ?? 'failed'}`,
  };
}

export function createBackgroundAgentRunner(
  deps: BackgroundAgentRunnerDeps,
): BackgroundAgentRunner {
  const tasks = new Map<string, BackgroundTask>();
  const listeners = new Set<() => void>();
  let dispatch: ((action: Action) => void) | undefined;
  let completions: BackgroundCompletion[] = [];
  let version = 0;
  const cancelledIds = new Set<string>();
  const timedOutIds = new Set<string>();
  const pendingPermissions = new Map<string, { checkpoint: BackgroundPermissionCheckpoint; resolve: (decision: 'allow-once' | 'deny') => void }>();
  const recoveredCheckpoints = new Map<string, BackgroundPermissionCheckpoint>();
  const recoveredRecords = new Map<string, BackgroundTaskRecord>();
  const recoveredStatuses = new Map<string, BackgroundTaskStatus>();
  // The store + the App-bound active session id: the durability seam (wave 14 b7).
  // Both undefined ⇒ every durability path below is a no-op.
  const store = deps.store;
  let currentSessionId: string | undefined;
  let timelineChangeQueued = false;
  let timelineVisible = false;
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  const maxConcurrent =
    deps.maxConcurrent !== undefined &&
    Number.isSafeInteger(deps.maxConcurrent) &&
    deps.maxConcurrent > 0
      ? deps.maxConcurrent
      : undefined;
  const timeoutMs =
    deps.timeoutMs !== undefined &&
    Number.isSafeInteger(deps.timeoutMs) &&
    deps.timeoutMs > 0
      ? deps.timeoutMs
      : undefined;
  const queue: Array<{ record: BackgroundTask; opts: BackgroundSpawnOptions }> = [];
  let runningCount = 0;

  const emitChange = (): void => {
    version += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  // Token streams can emit many deltas in one turn of the event loop. Preserve
  // exact event ordering while coalescing adjacent prose and batching subscriber
  // notification to one microtask, so opening the workspace does not turn every
  // token into a full React render.
  const emitTimelineChange = (): void => {
    if (!timelineVisible) return;
    if (timelineChangeQueued) return;
    timelineChangeQueued = true;
    const scheduledAtVersion = version;
    queueMicrotask(() => {
      timelineChangeQueued = false;
      // A synchronous lifecycle/status notification may already have covered
      // these deltas (for example a tiny child that finishes in one tick).
      if (version === scheduledAtVersion) emitChange();
    });
  };

  const appendTimeline = (
    record: BackgroundTask,
    line: BackgroundOutputLine,
    notify = true,
  ): void => {
    record.lastActivityAt = line.ts;
    if (line.kind === 'text' || line.kind === 'reasoning') {
      // Coalesce only into bounded chunks. The former unbounded `previous.delta +=
      // token` copied the entire accumulated answer on every token (quadratic
      // allocation); a long multi-agent stream could exhaust V8 despite a tiny
      // final session file.
      let offset = 0;
      while (offset < line.delta.length) {
        const previous = record.timeline.at(-1);
        if (previous?.kind === line.kind && previous.delta.length < BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS) {
          const take = Math.min(
            BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS - previous.delta.length,
            line.delta.length - offset,
          );
          previous.delta += line.delta.slice(offset, offset + take);
          previous.ts = line.ts;
          offset += take;
        } else {
          const delta = line.delta.slice(offset, offset + BACKGROUND_TIMELINE_TEXT_CHUNK_CHARS);
          record.timeline.push({ kind: line.kind, delta, ts: line.ts });
          offset += delta.length;
        }
      }
    } else {
      record.timeline.push(line);
    }
    // Keep the initial launch marker where possible and discard the oldest body
    // entries in coarse (chunk-sized) increments. Full output is still on disk.
    while (record.timeline.length > BACKGROUND_TIMELINE_MAX_ENTRIES) {
      const firstIsSpawn = record.timeline[0]?.kind === 'lifecycle' && record.timeline[0].event === 'spawn';
      record.timeline.splice(firstIsSpawn ? 1 : 0, 1);
    }
    if (store !== undefined && record.sessionId !== undefined) {
      void store.appendOutput(record.sessionId, record.id, line);
    }
    if (notify) emitTimelineChange();
  };

  const complete = (
    record: BackgroundTask,
    status: 'done' | 'error' | 'aborted',
    summary: string | undefined,
    error: string | undefined,
  ): void => {
    pendingPermissions.delete(record.id);
    record.status = status;
    if (summary !== undefined) record.summary = summary;
    if (error !== undefined) record.error = error;
    const terminalTs = now();
    appendTimeline(
      record,
      {
        kind: 'lifecycle',
        event: status === 'aborted' ? 'error' : status,
        ts: terminalTs,
        ...(summary !== undefined ? { summary } : {}),
        ...(error !== undefined ? { error } : {}),
      },
      false,
    );
    completions.push({
      taskId: record.id,
      status,
      model: record.model,
      provider: record.provider,
      ...(summary !== undefined ? { summary } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    });
    // Persist the terminal record + lifecycle line (wave 14 b7). DELIVERED RULE: an
    // abortAll (normal TUI quit) settles live tasks as an 'aborted' error — those must
    // NOT re-surface as noise on the next resume, so persist them ALREADY delivered. A
    // genuine done/error is delivered:false so a crash-before-drain re-queues it.
    if (store !== undefined && record.sessionId !== undefined) {
      const sessionId = record.sessionId;
      const wasAborted = record.controller.signal.aborted;
      const ts = terminalTs;
      void store.writeRecord({
        schemaVersion: 1,
        taskId: record.id,
        sessionId,
        model: record.model,
        provider: record.provider,
        description: record.description,
        status: status === 'aborted' ? 'error' : status,
        startedAt: record.startedAt,
        updatedAt: ts,
        endedAt: ts,
        delivered: wasAborted && !timedOutIds.has(record.id),
        ...(summary !== undefined ? { summary } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    }
    emitChange();
  };

  const promoteQueued = (): void => {
    while (
      queue.length > 0 &&
      (maxConcurrent === undefined || runningCount < maxConcurrent)
    ) {
      const next = queue.shift();
      if (next === undefined) break;
      startRunning(next.record, next.opts);
    }
  };

  const settleRunning = (
    record: BackgroundTask,
    status: 'done' | 'error' | 'aborted',
    summary: string | undefined,
    error: string | undefined,
  ): void => {
    complete(record, status, summary, error);
    runningCount = Math.max(0, runningCount - 1);
    promoteQueued();
  };

  // The detached child loop — the body of the old blocking subagentTool.run(),
  // relocated near-verbatim. Differences from the blocking path:
  //   - surfaceChildEvent forwards to the INJECTED app dispatch (namespaced), not
  //     ctx.emit (which is dead once the spawning tool.run returns);
  //   - NO parent-abort cascade (the task's own controller governs it);
  //   - on settle it records a BackgroundCompletion instead of returning a summary.
  const runChild = async (record: BackgroundTask, opts: BackgroundSpawnOptions): Promise<void> => {
    const { spawnCardId, task, entry, childTools, systemPrompt } = opts;
    const controller = record.controller;
    const childRegistry = createPermissionRegistry();

    // Namespace child tool-call ids under the spawn card so two agents' children
    // never collide in the parent's single `state.tools` map, and hang each child
    // off the spawn card (or preserve its own nesting for a grandchild).
    const ns = (childId: string): string => `${spawnCardId}::${childId}`;
    const surfaceChildEvent = (action: Action): void => {
      const ts = now();
      if (action.t === 'tool-call') {
        appendTimeline(record, {
          kind: 'tool',
          event: 'call',
          toolCallId: ns(action.toolCallId),
          name: action.name,
          ts,
        });
      } else if (action.t === 'tool-status') {
        appendTimeline(record, {
          kind: 'tool',
          event: 'status',
          toolCallId: ns(action.toolCallId),
          status: action.status,
          ts,
        });
      }
      // Dead until App attaches the sink; a spawn before attach degrades to
      // summary-only surfacing (harmless — the completion still delivers).
      if (dispatch === undefined) return;
      switch (action.t) {
        case 'tool-call':
          dispatch({
            t: 'tool-call',
            toolCallId: ns(action.toolCallId),
            name: action.name,
            args: action.args,
            parentToolUseId:
              action.parentToolUseId !== undefined ? ns(action.parentToolUseId) : spawnCardId,
          });
          break;
        case 'tool-call-delta':
          dispatch({
            t: 'tool-call-delta',
            toolCallId: ns(action.toolCallId),
            argsDelta: action.argsDelta,
          });
          break;
        case 'tool-status':
          dispatch({
            t: 'tool-status',
            toolCallId: ns(action.toolCallId),
            status: action.status,
            ...(action.result !== undefined ? { result: action.result } : {}),
            ...(action.error !== undefined ? { error: action.error } : {}),
            ...(action.termination !== undefined ? { termination: action.termination } : {}),
          });
          break;
        case 'usage':
          // Bubble the child's token spend to the PARENT accounting (this is the
          // PRODUCTION default path). `spawnCardId` — NOT `ns()` — is the parent
          // spawn-card id; the reducer folds the tokens into the cost meter ONLY (the
          // parentToolUseId marker keeps them out of the parent's context-window
          // occupancy — the child ran in an isolated context). Child contextTokens are
          // not forwarded (meaningless for the parent window).
          dispatch({
            t: 'usage',
            tokensIn: action.tokensIn,
            tokensOut: action.tokensOut,
            parentToolUseId: spawnCardId,
          });
          break;
        default:
          break;
      }
    };

    // Summary accumulator (per assistant turn; last completed wins). Child prose is
    // NOT surfaced into the parent transcript — it only feeds the summary.
    let currentTextChunks: string[] = [];
    let currentTextChars = 0;
    let currentTextTruncated = false;
    let finalText = '';
    let errorMessage: string | null = null;
    const childDispatch = (action: Action): void => {
      if (
        record.status === 'done' ||
        record.status === 'error' ||
        record.status === 'aborted'
      ) {
        return;
      }
      surfaceChildEvent(action);
      switch (action.t) {
        case 'permission-open': {
          const checkpoint: BackgroundPermissionCheckpoint = {
            toolCallId: action.toolCallId,
            toolName: action.name,
            risk: action.risk,
            sanitizedArgs: sanitizeCheckpointValue(action.args),
            requestedAt: now(),
          };
          record.checkpoint = checkpoint;
          record.status = 'needs-user';
          appendTimeline(record, {
            kind: 'checkpoint',
            event: 'requested',
            toolCallId: checkpoint.toolCallId,
            toolName: checkpoint.toolName,
            risk: checkpoint.risk,
            ts: checkpoint.requestedAt,
          });
          if (store !== undefined && record.sessionId !== undefined) {
            void store.writeRecord({
              schemaVersion: 1, taskId: record.id, sessionId: record.sessionId,
              model: record.model, provider: record.provider, description: record.description,
              ...(record.profile !== undefined ? { profile: record.profile } : {}), status: 'needs-user', startedAt: record.startedAt,
              updatedAt: checkpoint.requestedAt, delivered: false, checkpoint,
            });
          }
          emitChange();
          break;
        }
        case 'assistant-start':
          currentTextChunks = [];
          currentTextChars = 0;
          currentTextTruncated = false;
          break;
        case 'text-delta':
          if (currentTextChars < BACKGROUND_SUMMARY_MAX_CHARS) {
            const kept = action.delta.slice(0, BACKGROUND_SUMMARY_MAX_CHARS - currentTextChars);
            if (kept.length > 0) currentTextChunks.push(kept);
            currentTextChars += kept.length;
            if (kept.length < action.delta.length) currentTextTruncated = true;
          } else if (action.delta.length > 0) {
            currentTextTruncated = true;
          }
          // Write-through (wave 14 b7): flush each text delta to the durable output
          // log as it arrives, so a crash preserves everything already appended (a
          // torn final line is dropped by the reader). The store swallows its own I/O
          // errors — never let it throw into the detached loop.
          appendTimeline(record, { kind: 'text', delta: action.delta, ts: now() });
          break;
        case 'reasoning-delta':
          // Reasoning is not accumulated into the parent summary (same as before), but
          // IS written through for durable inspection on resume.
          appendTimeline(record, { kind: 'reasoning', delta: action.delta, ts: now() });
          break;
        case 'assistant-done':
          finalText = currentTextChunks.join('') + (currentTextTruncated ? BACKGROUND_TRUNCATION_MARKER : '');
          break;
        case 'error':
          errorMessage = action.message;
          break;
        default:
          break;
      }
    };

    // Gate parity: PreToolUse-only dispatcher over the CHILD signal (a hook that
    // blocks a tool for the parent blocks it for a background child too).
    const childHooks =
      deps.hooks?.PreToolUse !== undefined && deps.hooks.PreToolUse.length > 0
        ? createHookDispatcher(
            { PreToolUse: deps.hooks.PreToolUse },
            { signal: controller.signal },
          )
        : undefined;

    // No child tool reads ctx.state, so a frozen empty state is behaviourally
    // identical to threading the (now unavailable) parent snapshot.
    const frozenState = initialState();
    const executor = createToolExecutor({
      tools: childTools,
      policy: deps.policy,
      cwd: deps.cwd,
      signal: controller.signal,
      getState: () => frozenState,
      awaitPermission: async (toolCallId) => {
        const checkpoint = record.checkpoint;
        if (checkpoint === undefined || checkpoint.toolCallId !== toolCallId) return 'deny';
        return await new Promise((resolve) => {
          pendingPermissions.set(record.id, { checkpoint, resolve });
          emitChange();
        });
      },
      ...(childHooks !== undefined ? { hooks: childHooks } : {}),
    });

    let timeout:
      | { promise: Promise<never>; clear: () => void }
      | undefined;
    if (timeoutMs !== undefined) {
      let rejectTimeout!: (error: Error) => void;
      const promise = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timer = setTimer(() => {
        timedOutIds.add(record.id);
        pendingPermissions.get(record.id)?.resolve('deny');
        pendingPermissions.delete(record.id);
        controller.abort();
        rejectTimeout(new Error(`background agent timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout = { promise, clear: timer.clear };
    }

    try {
      const turn = runTurn(
        {
          id: bgTurnId(),
          messages: [{ role: 'user', content: task }],
          model: entry.id,
          cwd: deps.cwd,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        },
        {
          client: deps.createClient(entry),
          executor,
          specs: childTools.map((tool) => tool.spec),
          dispatch: childDispatch,
          signal: controller.signal,
          registry: childRegistry,
          drainSteer: () => record.mailbox.splice(0),
        },
      );
      // Keep a late provider rejection observed if a timeout wins the race.
      void turn.catch(() => {});
      await (timeout === undefined ? turn : Promise.race([turn, timeout.promise]));
    } catch (error) {
      if (cancelledIds.has(record.id)) {
        settleRunning(record, 'aborted', undefined, 'cancelled by user');
        return;
      }
      const reason = timedOutIds.has(record.id)
        ? `background agent timed out after ${timeoutMs}ms`
        : error instanceof Error ? error.message : String(error);
      settleRunning(record, 'error', undefined, reason);
      return;
    } finally {
      timeout?.clear();
      childRegistry.drainDeny();
    }

    if (controller.signal.aborted) {
      const cancelled = cancelledIds.has(record.id);
      settleRunning(record, cancelled ? 'aborted' : 'error', undefined,
        cancelled ? 'cancelled by user' : 'sub-agent aborted');
      return;
    }
    if (errorMessage !== null) {
      settleRunning(record, 'error', undefined, `sub-agent error: ${errorMessage}`);
      return;
    }
    const currentText = currentTextChunks.join('') + (currentTextTruncated ? BACKGROUND_TRUNCATION_MARKER : '');
    const summary = (finalText.length > 0 ? finalText : currentText).trim();
    settleRunning(record, 'done', summary, undefined);
  };

  const startRunning = (record: BackgroundTask, opts: BackgroundSpawnOptions): void => {
    record.status = 'running';
    record.lastActivityAt = now();
    runningCount += 1;
    if (store !== undefined && record.sessionId !== undefined) {
      void store.writeRecord({
        schemaVersion: 1,
        taskId: record.id,
        sessionId: record.sessionId,
        model: record.model,
        provider: record.provider,
        description: record.description,
        ...(record.profile !== undefined ? { profile: record.profile } : {}),
        status: 'running',
        startedAt: record.startedAt,
        updatedAt: record.lastActivityAt,
        delivered: false,
      });
    }
    emitChange();
    void runChild(record, opts);
  };

  return {
    spawn(opts: BackgroundSpawnOptions): { taskId: string } {
      const controller = new AbortController();
      const startedAt = now();
      const atCap =
        maxConcurrent !== undefined && runningCount >= maxConcurrent;
      const record: BackgroundTask = {
        id: opts.spawnCardId,
        model: opts.entry.id,
        provider: opts.entry.provider,
        status: atCap ? 'queued' : 'running',
        description: opts.task,
        controller,
        mailbox: [],
        timeline: [{ kind: 'lifecycle', event: 'spawn', ts: startedAt }],
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        startedAt,
        ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
      };
      tasks.set(opts.spawnCardId, record);
      // Durable initial record + spawn lifecycle line (wave 14 b7). Fire-and-forget:
      // the task runs regardless of whether the write lands.
      if (store !== undefined && currentSessionId !== undefined) {
        const sessionId = currentSessionId;
        void store.writeRecord({
          schemaVersion: 1,
          taskId: opts.spawnCardId,
          sessionId,
          model: opts.entry.id,
          provider: opts.entry.provider,
          description: opts.task,
          status: atCap ? 'queued' : 'running',
          startedAt: record.startedAt,
          updatedAt: record.startedAt,
          delivered: false,
          ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        });
        void store.appendOutput(sessionId, opts.spawnCardId, {
          kind: 'lifecycle',
          event: 'spawn',
          ts: record.startedAt,
        });
      }
      if (atCap) {
        queue.push({ record, opts });
        emitChange();
      } else {
        startRunning(record, opts);
      }
      return { taskId: opts.spawnCardId };
    },
    sendMessage(taskId: string, text: string): boolean {
      const record = tasks.get(taskId);
      const message = text.trim();
      if (record?.status !== 'running' || message.length === 0) return false;
      record.mailbox.push(message);
      appendTimeline(record, { kind: 'steer', text: message, ts: now() });
      emitChange();
      return true;
    },
    cancel(taskId: string): boolean {
      const record = tasks.get(taskId);
      if (record === undefined) return false;
      if (record.status === 'queued') {
        const index = queue.findIndex((entry) => entry.record.id === taskId);
        if (index >= 0) queue.splice(index, 1);
        cancelledIds.add(taskId);
        record.controller.abort();
        complete(record, 'aborted', undefined, 'cancelled while queued');
        return true;
      }
      if (record.status !== 'running' && record.status !== 'needs-user') return false;
      cancelledIds.add(taskId);
      pendingPermissions.get(taskId)?.resolve('deny');
      pendingPermissions.delete(taskId);
      record.controller.abort();
      return true;
    },
    pendingPermission(taskId: string): BackgroundPermissionCheckpoint | undefined {
      return pendingPermissions.get(taskId)?.checkpoint ?? recoveredCheckpoints.get(taskId);
    },
    resolvePermission(taskId: string, decision: 'allow-once' | 'deny'): boolean {
      const pending = pendingPermissions.get(taskId);
      const record = tasks.get(taskId);
      if (pending === undefined || record?.status !== 'needs-user') {
        const recovered = recoveredRecords.get(taskId);
        if (decision !== 'deny' || recovered === undefined || store === undefined) return false;
        recoveredRecords.delete(taskId);
        recoveredCheckpoints.delete(taskId);
        recoveredStatuses.set(taskId, 'error');
        const ts = now();
        const { checkpoint: _checkpoint, ...withoutCheckpoint } = recovered;
        void store.writeRecord({
          ...withoutCheckpoint, status: 'error',
          updatedAt: ts, endedAt: ts, error: 'permission denied after recovery', delivered: true,
        });
        void store.appendOutput(recovered.sessionId, taskId, {
          kind: 'lifecycle', event: 'error', ts, error: 'permission denied after recovery',
        });
        emitChange();
        return true;
      }
      pendingPermissions.delete(taskId);
      const checkpoint = record.checkpoint;
      if (checkpoint !== undefined) {
        appendTimeline(record, {
          kind: 'checkpoint',
          event: 'resolved',
          toolCallId: checkpoint.toolCallId,
          toolName: checkpoint.toolName,
          decision,
          ts: now(),
        });
      }
      record.checkpoint = undefined;
      record.status = 'running';
      if (store !== undefined && record.sessionId !== undefined) {
        void store.writeRecord({
          schemaVersion: 1, taskId: record.id, sessionId: record.sessionId,
          model: record.model, provider: record.provider, description: record.description,
          ...(record.profile !== undefined ? { profile: record.profile } : {}), status: 'running', startedAt: record.startedAt,
          updatedAt: now(), delivered: false,
        });
      }
      emitChange();
      pending.resolve(decision);
      return true;
    },
    attach(attachDeps: { dispatch: (action: Action) => void }): void {
      dispatch = attachDeps.dispatch;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    getVersion(): number {
      return version;
    },
    drainCompletions(): BackgroundCompletion[] {
      const drained = completions;
      completions = [];
      return drained;
    },
    taskStatuses(): Record<string, BackgroundTaskStatus> {
      const out: Record<string, BackgroundTaskStatus> = {};
      for (const [id, record] of tasks) {
        out[id] = record.status === 'needs-user' ? 'waiting' : record.status;
      }
      for (const id of recoveredCheckpoints.keys()) out[id] = 'waiting';
      for (const [id, status] of recoveredStatuses) out[id] = status;
      return out;
    },
    taskTimings(): Record<string, { startedAt: number; lastActivityAt?: number }> {
      const out: Record<string, { startedAt: number; lastActivityAt?: number }> = {};
      for (const [id, record] of tasks) {
        out[id] = {
          startedAt: record.startedAt,
          ...(record.lastActivityAt !== undefined
            ? { lastActivityAt: record.lastActivityAt }
            : {}),
        };
      }
      return out;
    },
    taskSnapshots(): readonly BackgroundAgentSnapshot[] {
      const snapshots = [...tasks.values()].map((record): BackgroundAgentSnapshot => {
        const status: BackgroundTaskStatus =
          record.status === 'needs-user' ? 'waiting' : record.status;
        return {
          id: record.id,
          model: record.model,
          provider: record.provider,
          status,
          description: record.description,
          ...(record.profile !== undefined ? { profile: record.profile } : {}),
          ...(record.checkpoint !== undefined ? { checkpoint: record.checkpoint } : {}),
          ...(record.summary !== undefined ? { summary: record.summary } : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
          startedAt: record.startedAt,
          ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
          timeline: record.timeline.map((line) => ({ ...line })),
          capabilities: {
            steer: status === 'running',
            cancel: status === 'running' || status === 'waiting',
            resolvePermission: status === 'waiting' && record.checkpoint !== undefined,
          },
        };
      });
      // A restart-recovered permission has no live child loop, but it is still a
      // real actionable checkpoint: fail-closed denial remains available from the
      // workspace. Its durable prose can be inspected through readOutput; do not
      // invent it in this synchronous projection.
      for (const record of recoveredRecords.values()) {
        if (tasks.has(record.taskId)) continue;
        const checkpoint = recoveredCheckpoints.get(record.taskId);
        const timeline: BackgroundOutputLine[] = [
          { kind: 'lifecycle', event: 'spawn', ts: record.startedAt },
        ];
        if (checkpoint !== undefined) {
          timeline.push({
            kind: 'checkpoint',
            event: 'requested',
            toolCallId: checkpoint.toolCallId,
            toolName: checkpoint.toolName,
            risk: checkpoint.risk,
            ts: checkpoint.requestedAt,
          });
        }
        snapshots.push({
          id: record.taskId,
          model: record.model,
          provider: record.provider,
          status: 'waiting',
          description: record.description,
          ...(record.profile !== undefined ? { profile: record.profile } : {}),
          ...(checkpoint !== undefined ? { checkpoint } : {}),
          startedAt: record.startedAt,
          sessionId: record.sessionId,
          timeline,
          capabilities: {
            steer: false,
            cancel: false,
            resolvePermission: checkpoint !== undefined,
          },
        });
      }
      return snapshots;
    },
    setTimelineVisible(visible: boolean): void {
      const changed = timelineVisible !== visible;
      timelineVisible = visible;
      // Opening must immediately project everything accumulated while chat was
      // visible; closing needs no presentation-only invalidation.
      if (changed && visible) emitChange();
    },
    abortAll(): void {
      for (const entry of queue.splice(0)) {
        entry.record.controller.abort();
        complete(entry.record, 'aborted', undefined, 'sub-agent aborted before start');
      }
      for (const record of tasks.values()) {
        pendingPermissions.get(record.id)?.resolve('deny');
        pendingPermissions.delete(record.id);
        if (!record.controller.signal.aborted) {
          record.controller.abort();
        }
      }
    },
    setSessionId(sessionId: string): void {
      currentSessionId = sessionId;
    },
    async reconcile(
      sessionId: string,
    ): Promise<{
      interrupted: BackgroundTaskRecord[];
      needsUser: BackgroundTaskRecord[];
      undeliveredCompletions: BackgroundCompletion[];
    }> {
      const empty = { interrupted: [] as BackgroundTaskRecord[], needsUser: [] as BackgroundTaskRecord[], undeliveredCompletions: [] as BackgroundCompletion[] };
      if (store === undefined) return empty;
      try {
        const records = await store.readRecords(sessionId);
        // Skip still-alive detached tasks (the same-process resume guard): a task still
        // running its loop in THIS process is in `tasks`, so its disk 'running' is NOT
        // interrupted.
        const liveIds = new Set<string>([...tasks.keys()]);
        const { interrupted, undelivered, needsUser } = classifyRecords(records, liveIds);
        for (const rec of needsUser) {
          if (rec.checkpoint !== undefined) {
            recoveredCheckpoints.set(rec.taskId, rec.checkpoint);
            recoveredRecords.set(rec.taskId, rec);
          }
        }
        for (const rec of interrupted) {
          // rec already carries status:'interrupted' + endedAt (classifyRecords rewrote
          // it). The guard lets running→interrupted through and blocks any later flip.
          void store.writeRecord(rec);
          void store.appendOutput(sessionId, rec.taskId, {
            kind: 'lifecycle',
            event: 'interrupted',
            ts: rec.endedAt ?? now(),
          });
        }
        const undeliveredCompletions: BackgroundCompletion[] = undelivered.map((rec) => ({
          taskId: rec.taskId,
          status: rec.status as 'done' | 'error',
          model: rec.model,
          provider: rec.provider,
          sessionId: rec.sessionId,
          ...(rec.summary !== undefined ? { summary: rec.summary } : {}),
          ...(rec.error !== undefined ? { error: rec.error } : {}),
        }));
        if (needsUser.length > 0) emitChange();
        return { interrupted, needsUser, undeliveredCompletions };
      } catch {
        // Fail-soft: the store already routes its own I/O errors to its onError sink;
        // a reconcile that still throws yields an empty (no-op) reconcile.
        return empty;
      }
    },
    markDelivered(sessionId: string, taskId: string): void {
      if (store === undefined) return;
      void store.markDelivered(sessionId, taskId).catch(() => {});
    },
    async readOutput(
      sessionId: string,
      taskId: string,
    ): Promise<{ text: string; reasoning: string; lifecycle: BackgroundOutputLine[] }> {
      const empty = { text: '', reasoning: '', lifecycle: [] as BackgroundOutputLine[] };
      if (store === undefined) return empty;
      try {
        return await store.readOutput(sessionId, taskId);
      } catch {
        return empty;
      }
    },
  };
}
