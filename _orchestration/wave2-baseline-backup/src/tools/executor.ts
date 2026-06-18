// src/tools/executor.ts
// W7 — the ToolExecutor: drives ONE tool call's lifecycle, INCLUDING the
// permission round-trip. The executor (NOT the tool) owns policy.evaluate and the
// permission-open / awaitPermission round-trip (frozen ToolCtx contract). It adds
// no clock and no randomness. It emits ONLY permission-open + the tool-status
// lifecycle; it never emits the top-level `aborted` event (that's W9/W6).
import type { PermissionPolicy, Tool, ToolCtx, ToolExecutor, ToolResult } from '../core/contracts';
import type { AgentEvent, PermissionDecision } from '../core/events';
import type { State } from '../core/reducer';

/** Runtime deps the coordinator (W6) supplies; closed over by the factory. */
export interface ToolExecutorDeps {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  cwd: string;
  signal: AbortSignal;
  getState: () => Readonly<State>;
  awaitPermission: (toolCallId: string) => Promise<PermissionDecision>;
}

/** Build a `tool-status` event with the correct optional fields per status. */
function toolStatus(
  toolCallId: string,
  status: 'running' | 'result' | 'error',
  payload?: { result?: unknown; error?: string },
): AgentEvent {
  switch (status) {
    case 'running':
      return { type: 'tool-status', toolCallId, status };
    case 'result':
      return { type: 'tool-status', toolCallId, status, result: payload?.result };
    case 'error':
      return { type: 'tool-status', toolCallId, status, error: payload?.error };
  }
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  return {
    async execute(
      toolCallId: string,
      name: string,
      args: unknown,
      emit: (e: AgentEvent) => void,
    ): Promise<void> {
      const emitAborted = (): void => {
        emit(toolStatus(toolCallId, 'error', { error: 'aborted' }));
      };

      if (deps.signal.aborted) {
        emitAborted();
        return;
      }

      // 1. resolve the tool
      const tool = deps.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        emit(toolStatus(toolCallId, 'error', { error: `unknown tool: ${name}` }));
        return;
      }

      // 2. policy decision (executor owns this — tools never call evaluate)
      const decision = deps.policy.evaluate(name, args, tool.risk);

      switch (decision) {
        case 'auto-deny':
          // 3. auto-deny → terminal error, do NOT run
          emit(toolStatus(toolCallId, 'error', { error: 'denied by policy' }));
          return;

        case 'prompt': {
          // 4. prompt → open the overlay, await the user's decision
          emit({ type: 'permission-open', toolCallId, name, args, risk: tool.risk });
          const userDecision = await deps.awaitPermission(toolCallId);
          if (deps.signal.aborted) {
            emitAborted();
            return;
          }
          if (userDecision === 'deny') {
            emit(toolStatus(toolCallId, 'error', { error: 'denied' }));
            return;
          }
          // allow-once / always-allow-pattern / dangerous-bypass → proceed
          break;
        }

        case 'auto-allow':
          break;

        default: {
          // Exhaustive: guard against PermissionPolicy contract drift.
          const exhaustive: never = decision;
          emit(toolStatus(toolCallId, 'error', { error: `unknown policy decision: ${String(exhaustive)}` }));
          return;
        }
      }

      // 5. run
      emit(toolStatus(toolCallId, 'running'));

      const ctx: ToolCtx = {
        cwd: deps.cwd,
        signal: deps.signal,
        emit,
        awaitPermission: deps.awaitPermission,
        state: deps.getState(),
      };

      let result: ToolResult;
      try {
        result = await tool.run(args, ctx);
      } catch (error) {
        // Tools should never throw, but a misbehaving tool must not crash the turn.
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      if (deps.signal.aborted) {
        emitAborted();
        return;
      }

      // 6. terminal
      if (result.ok) {
        emit(toolStatus(toolCallId, 'result', { result: result.data }));
        return;
      }
      emit(toolStatus(toolCallId, 'error', { error: result.error ?? 'tool failed' }));
    },
  };
}
