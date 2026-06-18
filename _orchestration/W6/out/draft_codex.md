=== FILE: src/agent/eventBus.ts ===
```ts
import type { PermissionDecision } from '../core/events';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  return { promise, resolve: resolveDeferred };
}

export interface PermissionRegistry {
  await(toolCallId: string): Promise<PermissionDecision>;
  resolve(toolCallId: string, decision: PermissionDecision): void;
  drainDeny(): void;
  pending(): number;
}

export function createPermissionRegistry(): PermissionRegistry {
  const parked = new Map<string, Deferred<PermissionDecision>>();

  return {
    await: (toolCallId: string): Promise<PermissionDecision> => {
      const existing = parked.get(toolCallId);
      if (existing !== undefined) {
        return existing.promise;
      }

      const deferred = createDeferred<PermissionDecision>();
      parked.set(toolCallId, deferred);
      return deferred.promise;
    },

    resolve: (toolCallId: string, decision: PermissionDecision): void => {
      const deferred = parked.get(toolCallId);
      if (deferred === undefined) {
        return;
      }

      parked.delete(toolCallId);
      deferred.resolve(decision);
    },

    drainDeny: (): void => {
      const entries = Array.from(parked.entries());
      parked.clear();

      for (const [, deferred] of entries) {
        deferred.resolve('deny');
      }
    },

    pending: (): number => parked.size,
  };
}
```

=== FILE: src/agent/turnRunner.ts ===
```ts
import type { Action } from '../core/reducer';
import type { AgentEvent, PermissionDecision, StopReason, ToolStatus } from '../core/events';
import { eventToAction } from '../core/events';
import type { ModelClient, ToolExecutor, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { PermissionRegistry } from './eventBus';

interface ToolCallRecord {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
}

interface ToolResultRecord {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface TurnRunnerDeps {
  readonly client: ModelClient;
  readonly executor: ToolExecutor;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly dispatch: (action: Action) => void;
  readonly signal: AbortSignal;
  readonly registry: PermissionRegistry;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown turn runner error';
}

function resultFromStatus(status: ToolStatus, result: unknown, error: string | undefined): ToolResultRecord | null {
  if (status === 'result') {
    return { ok: true, data: result };
  }

  if (status === 'error') {
    return { ok: false, error: error ?? 'Tool failed' };
  }

  return null;
}

function serializeToolResult(result: ToolResultRecord): string {
  return JSON.stringify(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
}

function isPersistentPermissionDecision(decision: PermissionDecision): boolean {
  return decision === 'always-allow-pattern' || decision === 'dangerous-bypass';
}

export { isPersistentPermissionDecision };

export async function runTurn(input: TurnInput, deps: TurnRunnerDeps): Promise<void> {
  let currentInput = input;
  let abortedDispatched = false;

  const dispatchEvent = (event: AgentEvent): void => {
    deps.dispatch(eventToAction(event));
  };

  const dispatchAborted = (reason?: string): void => {
    deps.registry.drainDeny();

    if (!abortedDispatched) {
      abortedDispatched = true;
      dispatchEvent({ type: 'aborted', reason });
    }
  };

  const abortListener = (): void => {
    dispatchAborted('aborted');
  };

  if (deps.signal.aborted) {
    dispatchAborted('aborted');
    return;
  }

  deps.signal.addEventListener('abort', abortListener, { once: true });

  try {
    while (!deps.signal.aborted) {
      const toolCalls: ToolCallRecord[] = [];
      const assistantText: string[] = [];
      const toolResults = new Map<string, ToolResultRecord>();

      let stopReason: StopReason | null = null;
      let deferredToolUseDone: Extract<AgentEvent, { type: 'assistant-done' }> | null = null;

      for await (const event of deps.client.streamTurn(currentInput, [...deps.specs], deps.signal)) {
        if (deps.signal.aborted) {
          dispatchAborted('aborted');
          break;
        }

        if (event.type === 'aborted') {
          dispatchAborted(event.reason);
          stopReason = 'abort';
          break;
        }

        if (event.type === 'assistant-done' && event.stopReason === 'tool_use') {
          deferredToolUseDone = event;
          stopReason = event.stopReason;
          break;
        }

        dispatchEvent(event);

        switch (event.type) {
          case 'assistant-start':
          case 'reasoning-delta':
          case 'tool-call-delta':
          case 'permission-open':
          case 'permission-resolved':
          case 'usage':
            break;

          case 'text-delta':
            assistantText.push(event.delta);
            break;

          case 'tool-call':
            toolCalls.push({
              toolCallId: event.toolCallId,
              name: event.name,
              args: event.args,
            });
            break;

          case 'tool-status': {
            const terminal = resultFromStatus(event.status, event.result, event.error);
            if (terminal !== null) {
              toolResults.set(event.toolCallId, terminal);
            }
            break;
          }

          case 'assistant-done':
            stopReason = event.stopReason;
            break;

          case 'error':
            stopReason = 'error';
            break;

          case 'aborted':
            stopReason = 'abort';
            break;

          default: {
            const exhaustive: never = event;
            throw new Error(`Unhandled agent event: ${JSON.stringify(exhaustive)}`);
          }
        }

        if (stopReason !== null) {
          break;
        }
      }

      if (deps.signal.aborted) {
        dispatchAborted('aborted');
        break;
      }

      if (stopReason === null) {
        break;
      }

      if (stopReason !== 'tool_use') {
        break;
      }

      if (toolCalls.length === 0) {
        if (deferredToolUseDone !== null) {
          dispatchEvent(deferredToolUseDone);
        }
        dispatchEvent({
          type: 'error',
          message: 'Model requested tool use but did not provide a tool call.',
        });
        break;
      }

      for (const call of toolCalls) {
        const emit = (event: AgentEvent): void => {
          if (event.type === 'tool-status') {
            const terminal = resultFromStatus(event.status, event.result, event.error);
            if (terminal !== null) {
              toolResults.set(event.toolCallId, terminal);
            }
          }

          dispatchEvent(event);
        };

        await deps.executor.execute(call.toolCallId, call.name, call.args, emit);

        if (deps.signal.aborted) {
          dispatchAborted('aborted');
          break;
        }

        if (!toolResults.has(call.toolCallId)) {
          toolResults.set(call.toolCallId, {
            ok: false,
            error: 'Tool did not complete.',
          });
        }
      }

      if (deps.signal.aborted) {
        dispatchAborted('aborted');
        break;
      }

      if (deferredToolUseDone !== null) {
        dispatchEvent(deferredToolUseDone);
      }

      const assistantMessage: TurnMessage = {
        role: 'assistant',
        content: assistantText.join(''),
        toolCalls: toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          name: call.name,
          args: call.args,
        })),
      };

      const toolMessages: TurnMessage[] = toolCalls.map((call) => ({
        role: 'tool',
        toolCallId: call.toolCallId,
        content: serializeToolResult(
          toolResults.get(call.toolCallId) ?? {
            ok: false,
            error: 'Tool did not complete.',
          },
        ),
      }));

      currentInput = {
        ...currentInput,
        messages: [...currentInput.messages, assistantMessage, ...toolMessages],
      };
    }
  } catch (error) {
    if (deps.signal.aborted) {
      dispatchAborted('aborted');
      return;
    }

    dispatchEvent({
      type: 'error',
      message: toErrorMessage(error),
    });
  } finally {
    deps.signal.removeEventListener('abort', abortListener);
    deps.registry.drainDeny();
  }
}
```

=== FILE: src/hooks/useTerminalSize.ts ===
```ts
import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();

  const readSize = (): TerminalSize => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  const [size, setSize] = useState<TerminalSize>(() => readSize());

  useEffect(() => {
    const onResize = (): void => {
      setSize(readSize());
    };

    stdout.on('resize', onResize);
    onResize();

    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
```

=== FILE: src/hooks/useKeybinds.ts ===
```ts
import { useInput } from 'ink';
import type { State } from '../core/reducer';

export interface UseKeybindsOptions {
  readonly overlay: State['overlay'];
  readonly value: string;
  readonly slashCommandCount: number;
  readonly modelCount: number;
  readonly onAbort: () => void;
  readonly onCycleMode: () => void;
  readonly onOpenSlash: () => void;
  readonly onOpenModelPicker: () => void;
  readonly onCloseOverlay: () => void;
  readonly onMoveSlash: (delta: number) => void;
  readonly onAcceptSlash: () => void;
  readonly onMoveModel: (delta: number) => void;
  readonly onAcceptModel: () => void;
}

export function useKeybinds(options: UseKeybindsOptions): void {
  useInput((input, key) => {
    if (key.escape) {
      if (options.overlay === 'permission' || options.overlay === 'none') {
        options.onAbort();
        return;
      }

      options.onCloseOverlay();
      return;
    }

    if (options.overlay === 'permission') {
      return;
    }

    if (options.overlay === 'slash') {
      if (key.upArrow && options.slashCommandCount > 0) {
        options.onMoveSlash(-1);
        return;
      }

      if (key.downArrow && options.slashCommandCount > 0) {
        options.onMoveSlash(1);
        return;
      }

      if (key.return) {
        options.onAcceptSlash();
        return;
      }

      return;
    }

    if (options.overlay === 'model-picker') {
      if (key.upArrow && options.modelCount > 0) {
        options.onMoveModel(-1);
        return;
      }

      if (key.downArrow && options.modelCount > 0) {
        options.onMoveModel(1);
        return;
      }

      if (key.return) {
        options.onAcceptModel();
        return;
      }

      return;
    }

    if (key.tab) {
      options.onCycleMode();
      return;
    }

    if (input === '/' && options.value.length === 0) {
      options.onOpenSlash();
      return;
    }

    if (key.ctrl && input.toLowerCase() === 'm') {
      options.onOpenModelPicker();
    }
  });
}
```

=== FILE: src/hooks/useStreamingTurn.ts ===
```ts
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
import type { PermissionRequest } from '../ui';

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

function toTurnMessages(state: State): TurnMessage[] {
  const messages: TurnMessage[] = [];

  for (const message of state.committed) {
    const content = textFromBlocks(message.blocks);

    if (message.role === 'system' || message.role === 'user') {
      messages.push({ role: message.role, content });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = [];

      for (const block of message.blocks) {
        if (block.kind !== 'tool') {
          continue;
        }

        const tool = message.toolSnapshot?.[block.toolCallId] ?? state.tools[block.toolCallId];
        if (tool !== undefined) {
          toolCalls.push({
            toolCallId: block.toolCallId,
            name: tool.name,
            args: tool.args,
          });
        }
      }

      messages.push(
        toolCalls.length > 0
          ? { role: 'assistant', content, toolCalls }
          : { role: 'assistant', content },
      );
      continue;
    }

    const toolBlock = message.blocks.find(
      (block): block is Extract<Block, { kind: 'tool' }> => block.kind === 'tool',
    );

    if (toolBlock !== undefined) {
      messages.push({
        role: 'tool',
        toolCallId: toolBlock.toolCallId,
        content,
      });
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

  const dispatchNow = useCallback(
    (action: Action): void => {
      if (action.t === 'permission-open') {
        permissionRisksRef.current.set(action.toolCallId, action.risk);
      }

      if (action.t === 'permission-resolved') {
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

      flushDeltas();
      dispatchNow(action);
    },
    [dispatchNow, flushDeltas],
  );

  const abort = useCallback((): void => {
    const controller = controllerRef.current;
    if (controller !== null && !controller.signal.aborted) {
      controller.abort();
    }

    registryRef.current.drainDeny();
    flushDeltas();
    dispatchNow({ t: 'aborted', reason: 'aborted' });
  }, [dispatchNow, flushDeltas]);

  const resolvePermission = useCallback(
    (toolCallId: string, decision: PermissionDecision): void => {
      flushDeltas();

      const tool = stateRef.current.tools[toolCallId];
      if (tool !== undefined && isPersistentPermissionDecision(decision)) {
        deps.policy.remember(tool.name, decision);
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
```

=== FILE: src/app.tsx ===
```tsx
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Box } from 'ink';
import type { ModelClient, PermissionPolicy, Tool, ToolSpec } from './core/contracts';
import { selectStatusLine } from './core/selectors';
import type { Settings } from './services/config';
import type { ModelCatalog } from './services/catalog';
import { BUILTIN_TOOL_SPECS } from './tools/registry';
import {
  InputBox,
  OverlayHost,
  StatusLine,
  StreamingMessage,
  Transcript,
} from './ui';
import { useKeybinds } from './hooks/useKeybinds';
import { useStreamingTurn } from './hooks/useStreamingTurn';
import { useTerminalSize } from './hooks/useTerminalSize';

export interface AppDeps {
  readonly client: ModelClient;
  readonly tools: ReadonlyArray<Tool>;
  readonly policy: PermissionPolicy;
  readonly catalog: ModelCatalog;
  readonly settings: Settings;
  readonly specs?: ReadonlyArray<ToolSpec>;
}

export interface AppProps {
  readonly deps: AppDeps;
}

const slashCommands = [
  { name: '/clear', description: 'Clear the transcript' },
  { name: '/model', description: 'Choose a model' },
  { name: '/mode', description: 'Cycle execution mode' },
];

export function App({ deps }: AppProps): ReactElement {
  const { columns } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const initialModelId =
    deps.catalog.resolve(deps.settings.defaultModel)?.id ??
    deps.catalog.default()?.id ??
    deps.settings.defaultModel;

  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);

  const turn = useStreamingTurn({
    client: deps.client,
    tools: deps.tools,
    policy: deps.policy,
    specs: deps.specs ?? BUILTIN_TOOL_SPECS,
    cwd: deps.settings.cwd,
    model: selectedId,
  });

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
  });

  const closeOverlay = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'none' });
  }, [turn]);

  const openSlash = useCallback((): void => {
    setSelectedIndex(0);
    turn.dispatch({ t: 'set-overlay', overlay: 'slash' });
  }, [turn]);

  const openModelPicker = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'model-picker' });
  }, [turn]);

  const moveSlash = useCallback((delta: number): void => {
    setSelectedIndex((current) => {
      if (slashCommands.length === 0) {
        return current;
      }

      return (current + delta + slashCommands.length) % slashCommands.length;
    });
  }, []);

  const moveModel = useCallback(
    (delta: number): void => {
      if (models.length === 0) {
        return;
      }

      setSelectedId((current) => {
        const currentIndex = Math.max(
          0,
          models.findIndex((model) => model.id === current),
        );
        const nextIndex = (currentIndex + delta + models.length) % models.length;
        return models[nextIndex].id;
      });
    },
    [models],
  );

  const acceptSlash = useCallback((): void => {
    const command = slashCommands[selectedIndex];
    if (command === undefined) {
      closeOverlay();
      return;
    }

    switch (command.name) {
      case '/clear':
        turn.dispatch({ t: 'clear' });
        closeOverlay();
        break;

      case '/model':
        openModelPicker();
        break;

      case '/mode':
        turn.dispatch({ t: 'cycle-mode' });
        closeOverlay();
        break;

      default:
        closeOverlay();
        break;
    }
  }, [closeOverlay, openModelPicker, selectedIndex, turn]);

  const acceptModel = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    slashCommandCount: slashCommands.length,
    modelCount: models.length,
    onAbort: turn.abort,
    onCycleMode: () => turn.dispatch({ t: 'cycle-mode' }),
    onOpenSlash: openSlash,
    onOpenModelPicker: openModelPicker,
    onCloseOverlay: closeOverlay,
    onMoveSlash: moveSlash,
    onAcceptSlash: acceptSlash,
    onMoveModel: moveModel,
    onAcceptModel: acceptModel,
  });

  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) {
        return;
      }

      setValue('');
      void turn.submit(nextValue);
    },
    [turn],
  );

  const effectiveOverlay =
    turn.state.overlay === 'permission' && turn.permissionRequest === null
      ? 'none'
      : turn.state.overlay;

  return (
    <Box flexDirection="column" width={columns}>
      <Transcript committed={turn.state.committed} />
      <StreamingMessage live={turn.state.live} />
      <OverlayHost
        overlay={effectiveOverlay}
        slash={
          effectiveOverlay === 'slash'
            ? { commands: slashCommands, selectedIndex }
            : undefined
        }
        modelPicker={
          effectiveOverlay === 'model-picker'
            ? { models, selectedId }
            : undefined
        }
        permission={
          effectiveOverlay === 'permission' && turn.permissionRequest !== null
            ? {
                request: turn.permissionRequest,
                onDecision: (decision) => {
                  turn.resolvePermission(turn.permissionRequest.toolCallId, decision);
                },
              }
            : undefined
        }
      />
      <StatusLine status={status} />
      <InputBox
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder="Message Juno"
      />
    </Box>
  );
}

export default App;
```

=== FILE: src/cli.ts ===
```ts
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app';
import type { AppDeps } from './app';
import { createPermissionPolicy } from './permissions/policy';
import { createModelClient } from './providers';
import { createConfigService } from './services/config';
import { BUILTIN_MODELS, createModelCatalog } from './services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from './tools/registry';

const HELP = `Usage: juno [--help] [--version]

Options:
  --help      Show this help message
  --version   Show the installed version
`;

function versionFromEnv(env: NodeJS.ProcessEnv): string {
  return env.npm_package_version ?? '0.0.0';
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(versionFromEnv(env));
    return;
  }

  const config = createConfigService({ env });
  const settings = config.get();
  const catalog = createModelCatalog(BUILTIN_MODELS);
  const model = catalog.resolve(settings.defaultModel) ?? catalog.default();

  if (model === undefined) {
    console.error('No model is configured.');
    process.exitCode = 1;
    return;
  }

  const deps: AppDeps = {
    client: createModelClient(model, {
      provider: settings.providers?.[model.provider],
      env,
      fetchImpl: fetch,
    }),
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog,
    settings,
    specs: BUILTIN_TOOL_SPECS,
  };

  render(createElement(App, { deps }));
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath !== undefined && /(?:^|\/)(?:cli|juno)\.js$/.test(invokedPath)) {
  void main();
}
```

=== FILE: tests/coordinator.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import type { Action, State } from '../src/core/reducer';
import { initialState, reducer } from '../src/core/reducer';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { ModelClient, Tool, ToolSpec, TurnInput } from '../src/core/contracts';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createToolExecutor } from '../src/tools/executor';
import { createPermissionRegistry } from '../src/agent/eventBus';
import { runTurn } from '../src/agent/turnRunner';

interface Harness {
  readonly actions: Action[];
  readonly dispatch: (action: Action) => void;
  readonly getState: () => State;
}

interface ScriptedClient {
  readonly client: ModelClient;
  readonly inputs: TurnInput[];
  readonly calls: () => number;
}

function createHarness(): Harness {
  let state = initialState();
  const actions: Action[] = [];

  return {
    actions,
    dispatch: (action: Action): void => {
      actions.push(action);
      state = reducer(state, action);
    },
    getState: (): State => state,
  };
}

function createScriptedClient(turns: ReadonlyArray<ReadonlyArray<AgentEvent>>): ScriptedClient {
  let callCount = 0;
  const inputs: TurnInput[] = [];

  const client: ModelClient = {
    streamTurn: async function* (input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      inputs.push(input);
      const events = turns[callCount] ?? [
        { type: 'assistant-start', id: `assistant-${callCount}` },
        { type: 'assistant-done', id: `assistant-${callCount}`, stopReason: 'end' },
      ];
      callCount += 1;

      for (const event of events) {
        if (signal.aborted) {
          yield { type: 'aborted', reason: 'aborted' };
          return;
        }

        yield event;
        await Promise.resolve();
      }
    },
  };

  return {
    client,
    inputs,
    calls: () => callCount,
  };
}

function createRiskyWriteTool(runCalls: unknown[]): Tool {
  return {
    name: 'write_file',
    risk: 'risky',
    spec: {
      name: 'write_file',
      description: 'test write tool',
      inputSchema: { type: 'object' },
    },
    run: async (args: unknown) => {
      runCalls.push(args);
      return { ok: true, data: { written: false } };
    },
  };
}

function baseInput(): TurnInput {
  return {
    id: 'turn-test',
    messages: [{ role: 'user', content: 'run the tool' }],
    model: 'test-model',
    cwd: '.',
    mode: 'normal',
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error(`Timed out waiting for ${label}`);
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function actionCount(actions: ReadonlyArray<Action>, predicate: (action: Action) => boolean): number {
  return actions.filter(predicate).length;
}

async function runScriptedToolTurn(
  turns: ReadonlyArray<ReadonlyArray<AgentEvent>>,
): Promise<{
  readonly harness: Harness;
  readonly registry: ReturnType<typeof createPermissionRegistry>;
  readonly controller: AbortController;
  readonly runCalls: unknown[];
  readonly runPromise: Promise<void>;
  readonly policy: ReturnType<typeof createPermissionPolicy>;
  readonly scripted: ScriptedClient;
}> {
  const harness = createHarness();
  const registry = createPermissionRegistry();
  const controller = new AbortController();
  const policy = createPermissionPolicy();
  const runCalls: unknown[] = [];
  const tool = createRiskyWriteTool(runCalls);
  const scripted = createScriptedClient(turns);
  const executor = createToolExecutor({
    tools: [tool],
    policy,
    cwd: '.',
    signal: controller.signal,
    getState: harness.getState,
    awaitPermission: registry.await,
  });

  const runPromise = runTurn(baseInput(), {
    client: scripted.client,
    executor,
    specs: [tool.spec],
    dispatch: harness.dispatch,
    signal: controller.signal,
    registry,
  });

  return {
    harness,
    registry,
    controller,
    runCalls,
    runPromise,
    policy,
    scripted,
  };
}

function resolveLikeUi(
  harness: Harness,
  registry: ReturnType<typeof createPermissionRegistry>,
  toolCallId: string,
  decision: PermissionDecision,
): void {
  registry.resolve(toolCallId, decision);
  harness.dispatch({ t: 'permission-resolved', toolCallId, decision });
}

describe('coordinator turn runner', () => {
  it('parks a risky tool permission and runs after allow-once', async () => {
    const setup = await runScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'text-delta', id: 'assistant-2', delta: 'done' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    expect(setup.harness.getState().phase).toBe('awaiting-permission');
    expect(setup.harness.getState().overlay).toBe('permission');
    expect(setup.harness.getState().pendingPermissionToolCallId).toBe('tc1');

    resolveLikeUi(setup.harness, setup.registry, 'tc1', 'allow-once');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(1);
    expect(setup.harness.getState().overlay).toBe('none');
    expect(setup.registry.pending()).toBe(0);
    expect(setup.scripted.calls()).toBe(2);
    expect(
      setup.harness.actions.some(
        (action) => action.t === 'tool-status' && action.toolCallId === 'tc1' && action.status === 'running',
      ),
    ).toBe(true);
    expect(
      setup.harness.actions.some(
        (action) => action.t === 'tool-status' && action.toolCallId === 'tc1' && action.status === 'result',
      ),
    ).toBe(true);
  });

  it('resolves deny without running the risky tool', async () => {
    const setup = await runScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    resolveLikeUi(setup.harness, setup.registry, 'tc1', 'deny');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(0);
    expect(setup.harness.getState().overlay).toBe('none');
    expect(
      setup.harness.actions.some(
        (action) => action.t === 'tool-status' && action.toolCallId === 'tc1' && action.status === 'running',
      ),
    ).toBe(false);
    expect(
      setup.harness.actions.some(
        (action) => action.t === 'tool-status' && action.toolCallId === 'tc1' && action.status === 'error',
      ),
    ).toBe(true);
  });

  it('drains parked permissions on abort so the turn cannot hang', async () => {
    const setup = await runScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'safe.txt', content: 'hello' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'permission park');

    const parked = setup.registry.await('tc1');
    setup.controller.abort();
    setup.registry.drainDeny();

    await expect(parked).resolves.toBe('deny');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(0);
    expect(setup.registry.pending()).toBe(0);
    expect(setup.harness.getState().phase).toBe('idle');
    expect(setup.harness.actions.some((action) => action.t === 'aborted')).toBe(true);
  });

  it('remembers always-allow on the shared policy and avoids a second prompt', async () => {
    const setup = await runScriptedToolTurn([
      [
        { type: 'assistant-start', id: 'assistant-1' },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc1',
          name: 'write_file',
          args: { path: 'same.txt', content: 'one' },
        },
        {
          type: 'tool-call',
          id: 'assistant-1',
          toolCallId: 'tc2',
          name: 'write_file',
          args: { path: 'same.txt', content: 'two' },
        },
        { type: 'assistant-done', id: 'assistant-1', stopReason: 'tool_use' },
      ],
      [
        { type: 'assistant-start', id: 'assistant-2' },
        { type: 'assistant-done', id: 'assistant-2', stopReason: 'end' },
      ],
    ]);

    await waitFor(() => setup.registry.pending() === 1, 'first permission park');

    setup.policy.remember('write_file', 'always-allow-pattern');
    resolveLikeUi(setup.harness, setup.registry, 'tc1', 'always-allow-pattern');
    await setup.runPromise;

    expect(setup.runCalls).toHaveLength(2);
    expect(
      actionCount(
        setup.harness.actions,
        (action) => action.t === 'permission-open' && action.toolCallId === 'tc1',
      ),
    ).toBe(1);
    expect(
      actionCount(
        setup.harness.actions,
        (action) => action.t === 'permission-open' && action.toolCallId === 'tc2',
      ),
    ).toBe(0);
    expect(
      setup.harness.actions.some(
        (action) => action.t === 'tool-status' && action.toolCallId === 'tc2' && action.status === 'running',
      ),
    ).toBe(true);
  });

  it('smokes the fake client stream and accumulates usage', async () => {
    const harness = createHarness();
    const registry = createPermissionRegistry();
    const controller = new AbortController();
    const policy = createPermissionPolicy();
    const runCalls: unknown[] = [];
    const tool = createRiskyWriteTool(runCalls);
    const executor = createToolExecutor({
      tools: [tool],
      policy,
      cwd: '.',
      signal: controller.signal,
      getState: harness.getState,
      awaitPermission: registry.await,
    });

    await runTurn(baseInput(), {
      client: createFakeModelClient({ tickMs: 0 }),
      executor,
      specs: [tool.spec],
      dispatch: harness.dispatch,
      signal: controller.signal,
      registry,
    });

    const assistantText = harness
      .getState()
      .committed.filter((message) => message.role === 'assistant')
      .flatMap((message) => message.blocks)
      .filter((block): block is Extract<(typeof harness.getState())['committed'][number]['blocks'][number], { kind: 'text' }> => block.kind === 'text')
      .map((block) => block.text)
      .join('');

    expect(assistantText).toContain('Hello from Juno.');
    expect(harness.getState().tokens.in).toBe(120);
    expect(harness.getState().tokens.out).toBe(48);
  });
});
```

=== NOTES ===
## Open wiring needs
none

The runner defers actual executor calls until `assistant-done(stopReason:'tool_use')`. That avoids double-running fake/model streams that already include tool lifecycle events, while still making scripted `tool_use` turns exercise the real executor, permission registry, policy, abort drain, and re-entry path.