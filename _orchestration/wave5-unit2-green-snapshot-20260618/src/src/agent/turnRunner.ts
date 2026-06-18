// src/agent/turnRunner.ts
// W6 — drives ONE user submission to completion (looping on `tool_use`).
//
// Consumes `client.streamTurn(...)`, maps each AgentEvent -> Action via
// `eventToAction`, runs tool calls through the executor (which owns the
// permission round-trip), and re-enters tool results into the next turn.
//
// Wiring contract (load-bearing):
//   A. awaitPermission ALWAYS settles. On abort/teardown we drainDeny() the
//      registry so the executor's parked `await` unsticks and emits a terminal
//      error instead of hanging.
//   D. Branch on `assistant-done.stopReason`; `aborted` is itself terminal; a
//      `tool_use` stop with no matching `tool-call` -> emit `error` (no executor
//      call with a phantom call).
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

/** Capture a terminal tool-status as a re-entry result; null for non-terminal status. */
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

/** Decisions the UI must persist on the SHARED policy (allow-once is a no-op by design). */
function isPersistentPermissionDecision(decision: PermissionDecision): boolean {
  return decision === 'always-allow-pattern' || decision === 'dangerous-bypass';
}

export { isPersistentPermissionDecision };

export async function runTurn(input: TurnInput, deps: TurnRunnerDeps): Promise<void> {
  let currentInput = input;
  let abortedDispatched = false;

  // Track permission overlays we opened but haven't seen resolved. Normally the
  // executor opens (permission-open) and the UI resolves (permission-resolved)
  // within the tool_use branch, leaving this empty. A malformed/fake stream can
  // emit permission-open then terminate non-tool_use, stranding the overlay; we
  // mop those up at the terminal so the prompt can't get stuck (defensive).
  const openPermissionIds = new Set<string>();

  const dispatchEvent = (event: AgentEvent): void => {
    if (event.type === 'permission-open') {
      openPermissionIds.add(event.toolCallId);
    } else if (event.type === 'permission-resolved') {
      openPermissionIds.delete(event.toolCallId);
    }
    deps.dispatch(eventToAction(event));
  };

  // Resolve/clear any still-open permission overlay at a non-tool_use terminal.
  // Drain the parked await to 'deny' so the executor (if any) unsticks, then
  // dispatch permission-resolved so the reducer drops the overlay. No-op when
  // nothing is open (the normal allow/deny/abort paths already cleared it).
  const clearStrandedPermissions = (): void => {
    if (openPermissionIds.size === 0) {
      return;
    }
    deps.registry.drainDeny();
    for (const toolCallId of openPermissionIds) {
      dispatchEvent({ type: 'permission-resolved', toolCallId, decision: 'deny' });
    }
    openPermissionIds.clear();
  };

  // Drain parked permissions to 'deny' and dispatch the terminal `aborted` action
  // exactly once. drainDeny() is idempotent; the flag guards the reducer action.
  const handleAbort = (reason?: string): void => {
    deps.registry.drainDeny();
    if (!abortedDispatched) {
      abortedDispatched = true;
      dispatchEvent({ type: 'aborted', reason });
    }
  };

  const abortListener = (): void => {
    handleAbort('aborted');
  };

  if (deps.signal.aborted) {
    handleAbort('aborted');
    return;
  }

  deps.signal.addEventListener('abort', abortListener);

  try {
    while (!deps.signal.aborted) {
      const toolCalls: ToolCallRecord[] = [];
      const assistantText: string[] = [];
      const toolResults = new Map<string, ToolResultRecord>();

      let stopReason: StopReason | null = null;
      let deferredToolUseDone: Extract<AgentEvent, { type: 'assistant-done' }> | null = null;

      for await (const event of deps.client.streamTurn(currentInput, [...deps.specs], deps.signal)) {
        if (deps.signal.aborted) {
          handleAbort('aborted');
          break;
        }

        if (event.type === 'aborted') {
          handleAbort(event.reason);
          stopReason = 'abort';
          break;
        }

        // Defer the tool_use terminal: we want the tools to run (and their
        // tool-status to land) BEFORE we commit the assistant message, so the
        // <Static> snapshot at commit time includes the tool results.
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
            toolCalls.push({ toolCallId: event.toolCallId, name: event.name, args: event.args });
            break;

          case 'tool-status': {
            // Some streams (e.g. the fake) pretend-run tools and emit their own
            // tool-status; capture terminal status for re-entry correlation.
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
        handleAbort('aborted');
        break;
      }

      // Stream ended without a terminal stopReason (e.g. empty stream): stop.
      if (stopReason === null) {
        clearStrandedPermissions();
        break;
      }

      // Only `tool_use` re-enters. end/max_tokens/error/abort are terminal here.
      if (stopReason !== 'tool_use') {
        clearStrandedPermissions();
        break;
      }

      // Malformed-args guard: a tool_use stop with NO tool-call we actually saw.
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

      // Run each tool call through the executor. The executor emits
      // permission-open (-> overlay) and the tool-status lifecycle; the runner
      // does NOT separately emit those for executor-driven calls.
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
          handleAbort('aborted');
          break;
        }

        if (!toolResults.has(call.toolCallId)) {
          toolResults.set(call.toolCallId, { ok: false, error: 'Tool did not complete.' });
        }
      }

      if (deps.signal.aborted) {
        handleAbort('aborted');
        break;
      }

      // Now commit the assistant turn (with its tool blocks snapshotted).
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
          toolResults.get(call.toolCallId) ?? { ok: false, error: 'Tool did not complete.' },
        ),
      }));

      currentInput = {
        ...currentInput,
        messages: [...currentInput.messages, assistantMessage, ...toolMessages],
      };
    }
  } catch (error) {
    if (deps.signal.aborted) {
      handleAbort('aborted');
      return;
    }
    dispatchEvent({ type: 'error', message: toErrorMessage(error) });
  } finally {
    deps.signal.removeEventListener('abort', abortListener);
    // Teardown drain: any permission still parked (e.g. an early return path)
    // resolves to 'deny' so no awaitPermission caller can hang past this turn.
    deps.registry.drainDeny();
  }
}
