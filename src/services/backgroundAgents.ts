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

export type BackgroundTaskStatus = 'running' | 'done' | 'error';

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
  status: BackgroundTaskStatus;
  /** The spawn `task` text (the record's human label). */
  readonly description: string;
  /** This task's own AbortController — the ONLY thing that stops it. */
  readonly controller: AbortController;
  /** The child's final summary (done only). */
  summary?: string;
  /** The child's failure reason (error only). */
  error?: string;
  readonly startedAt: number;
}

/** A settled child, queued for App to re-inject through the interjection seam. */
export interface BackgroundCompletion {
  readonly taskId: string;
  readonly status: 'done' | 'error';
  readonly model: string;
  readonly provider: string;
  readonly summary?: string;
  readonly error?: string;
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
}

export interface BackgroundAgentRunner {
  /**
   * Register the task, kick the child's runTurn on a DETACHED async IIFE, and
   * return the handle SYNCHRONOUSLY. Never awaits the child.
   */
  spawn(opts: BackgroundSpawnOptions): { taskId: string };
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
  /** Abort every still-running task (App unmount / teardown). */
  abortAll(): void;
}

// Deterministic nested-turn ids (no Date-based id — keeps tests reproducible; the
// turn id is not asserted, but a stable counter avoids nondeterministic churn).
let bgTurnCounter = 0;
function bgTurnId(): string {
  bgTurnCounter += 1;
  return `bg-subagent-turn-${bgTurnCounter}`;
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

  const emitChange = (): void => {
    version += 1;
    for (const listener of listeners) {
      listener();
    }
  };

  const complete = (
    record: BackgroundTask,
    status: 'done' | 'error',
    summary: string | undefined,
    error: string | undefined,
  ): void => {
    record.status = status;
    if (summary !== undefined) record.summary = summary;
    if (error !== undefined) record.error = error;
    completions.push({
      taskId: record.id,
      status,
      model: record.model,
      provider: record.provider,
      ...(summary !== undefined ? { summary } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    emitChange();
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
          });
          break;
        default:
          break;
      }
    };

    // Summary accumulator (per assistant turn; last completed wins). Child prose is
    // NOT surfaced into the parent transcript — it only feeds the summary.
    let currentText = '';
    let finalText = '';
    let errorMessage: string | null = null;
    const childDispatch = (action: Action): void => {
      surfaceChildEvent(action);
      switch (action.t) {
        case 'assistant-start':
          currentText = '';
          break;
        case 'text-delta':
          currentText += action.delta;
          break;
        case 'assistant-done':
          finalText = currentText;
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
      // No UI for nested prompts → deny. The shared policy still auto-allows safe
      // tools and any remembered always-allow patterns before we get here.
      awaitPermission: async () => 'deny',
      ...(childHooks !== undefined ? { hooks: childHooks } : {}),
    });

    try {
      await runTurn(
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
        },
      );
    } catch (error) {
      complete(record, 'error', undefined, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      childRegistry.drainDeny();
    }

    if (controller.signal.aborted) {
      complete(record, 'error', undefined, 'sub-agent aborted');
      return;
    }
    if (errorMessage !== null) {
      complete(record, 'error', undefined, `sub-agent error: ${errorMessage}`);
      return;
    }
    const summary = (finalText.length > 0 ? finalText : currentText).trim();
    complete(record, 'done', summary, undefined);
  };

  return {
    spawn(opts: BackgroundSpawnOptions): { taskId: string } {
      const controller = new AbortController();
      const record: BackgroundTask = {
        id: opts.spawnCardId,
        model: opts.entry.id,
        provider: opts.entry.provider,
        status: 'running',
        description: opts.task,
        controller,
        startedAt: Date.now(),
      };
      tasks.set(opts.spawnCardId, record);
      emitChange();
      // Detached IIFE: kick the child loop and return WITHOUT awaiting it. runChild
      // never throws (it records an error completion on any failure).
      void runChild(record, opts);
      return { taskId: opts.spawnCardId };
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
        out[id] = record.status;
      }
      return out;
    },
    abortAll(): void {
      for (const record of tasks.values()) {
        if (!record.controller.signal.aborted) {
          record.controller.abort();
        }
      }
    },
  };
}
