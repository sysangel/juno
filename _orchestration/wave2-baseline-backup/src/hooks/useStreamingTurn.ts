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
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
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
import type { PermissionRequest } from '../ui/PermissionPrompt';

type TextDeltaAction = Extract<Action, { t: 'text-delta' }>;
type ReasoningDeltaAction = Extract<Action, { t: 'reasoning-delta' }>;
type DeltaAction = TextDeltaAction | ReasoningDeltaAction;

export interface StreamingTurnDeps {
  readonly client: ModelClient;
  readonly tools: ReadonlyArray<Tool>;
  readonly policy: PermissionPolicy;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly cwd: string;
  readonly model?: string;
  readonly mode?: State['mode'];
  readonly systemPrompt?: string;
}

export interface StreamingTurnControls {
  readonly state: State;
  readonly dispatch: (action: Action) => void;
  readonly submit: (text: string) => Promise<void>;
  readonly abort: () => void;
  readonly resolvePermission: (toolCallId: string, decision: PermissionDecision) => void;
  readonly permissionRequest: PermissionRequest | null;
}

function isDeltaAction(action: Action): action is DeltaAction {
  return action.t === 'text-delta' || action.t === 'reasoning-delta';
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

function createTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function coalesceDeltas(queue: ReadonlyArray<DeltaAction>): DeltaAction[] {
  const coalesced: DeltaAction[] = [];

  for (const action of queue) {
    const last = coalesced.at(-1);
    if (last !== undefined && last.t === action.t && last.id === action.id) {
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

  const submit = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || controllerRef.current !== null) {
        return;
      }

      flushDeltas();

      const userId = `user-${createTurnId()}`;
      dispatchNow({ t: 'user-submit', id: userId, text });

      const controller = new AbortController();
      controllerRef.current = controller;

      const executor = createToolExecutor({
        tools: deps.tools,
        policy: deps.policy,
        cwd: deps.cwd,
        signal: controller.signal,
        getState: () => stateRef.current,
        awaitPermission: registryRef.current.await,
      });

      const input: TurnInput = {
        id: createTurnId(),
        messages: toTurnMessages(stateRef.current),
        model: deps.model,
        cwd: deps.cwd,
        mode: deps.mode ?? stateRef.current.mode,
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
        });
      } finally {
        flushDeltas();
        registryRef.current.drainDeny();
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      }
    },
    [
      deps.client,
      deps.cwd,
      deps.mode,
      deps.model,
      deps.policy,
      deps.specs,
      deps.systemPrompt,
      deps.tools,
      dispatch,
      dispatchNow,
      flushDeltas,
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
    abort,
    resolvePermission,
    permissionRequest,
  };
}
