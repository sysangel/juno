// src/providers/codexSpawnBridge.ts
// Wave 8 (codex-bridge) — the BRIDGE that lets a codex PARENT spawn juno subagents
// and have them render exactly like a claude/raw-API parent's subagents.
//
// The problem: codex's only custom-tool channel is an MCP server, and an MCP
// tool call + result travel over the MCP stdio/HTTP channel, NOT codex's `--json`
// event stream. So a subagent run driven from an MCP handler would, by default,
// return only a summary string to codex (rendered as a flat mcp-tool result) —
// the nested spawn card + child status rows the raw-API orchestrator produces
// (subagentTool.ts, via `parentToolUseId`) would render nothing.
//
// The fix: run the juno-hosted MCP server IN-PROCESS (subagentMcpServer.ts) so its
// spawn handler executes in the SAME process as the active codex turn, and give it
// a live sink into that turn's AgentEvent stream. This bridge owns that seam:
//   - codexCliClient registers the active turn (id + cwd + abort signal + an `emit`
//     that feeds the turn's output stream) via `beginTurn` for the turn's duration;
//   - the MCP server calls `spawn(args)` when the codex parent invokes the tool;
//   - `spawn` synthesizes the OUTER spawn card (a `spawn_subagent` tool-call +
//     running/terminal tool-status — the executor's role on the raw-API path) and
//     runs the EXISTING `spawn_subagent` Tool with a ToolCtx whose `toolCallId` is
//     that card's id. The tool's own orchestrator then re-emits every child tool
//     event namespaced under that id (identical to the raw-API path), so the child
//     status rows nest under the codex parent's card.
//   - the subagent's summary is returned as the MCP tool result for codex to consume.
//
// While a spawn is in flight the codex process is BLOCKED waiting on the MCP result,
// so its stdout is silent; codexCliClient reads `isSpawnActive()` to suspend its
// idle/stale stall timers for exactly that window (a long subagent must not look
// like a wedged codex stream).
//
// SECURITY: the spawn is NOT re-gated by a juno permission prompt (there is no UI
// round-trip a mid-turn codex process could wait on) — codex's own approval_policy
// governs whether it calls the tool. This is safe because the subagent itself is
// bounded exactly as a raw-API subagent: it inherits only the depth-1 childTools
// (file + load_skill; shell/brain/mcp are registered AFTER the subagent snapshot and
// are absent), runs on the SHARED policy, and auto-denies any interactive prompt.

import type { AgentEvent } from '../core/events';
import type { State } from '../core/reducer';
import { initialState } from '../core/reducer';
import type { Tool, ToolCtx } from '../core/contracts';
import type { SpawnBridgeResult } from '../services/subagentMcpServer';

/** The active codex turn's seam the bridge attributes a spawn to. Supplied by
 * codexCliClient for the lifetime of one `streamTurn`. */
export interface CodexTurnContext {
  /** The assistant turn id (`input.id`) — stamped as the spawn card's `id` so the
   * card attaches to the codex parent's live message. */
  readonly turnId: string;
  /** The turn's workspace jail root (`input.cwd`), forwarded to the subagent. */
  readonly cwd: string;
  /** The turn's abort signal — parent-abort cascades into the subagent. */
  readonly signal: AbortSignal;
  /** Push an AgentEvent into the active turn's output stream (codexCliClient drains
   * these alongside codex's own translated stdout events). */
  readonly emit: (event: AgentEvent) => void;
}

export interface CodexSpawnBridge {
  /** Register the active codex turn for the duration of its stream. Returns a
   * disposer codexCliClient MUST call (in a finally) when the turn ends. A second
   * beginTurn without disposing the first replaces it (single-runtime: one turn at
   * a time) so a leaked registration can never mis-attribute a later turn. */
  beginTurn(ctx: CodexTurnContext): () => void;
  /** True while ≥1 spawn is executing — codexCliClient suspends stall timers. */
  isSpawnActive(): boolean;
  /** Run one spawn on behalf of a codex parent's MCP tools/call. Never throws:
   * every failure resolves to an `isError` result. `signal` (the MCP request's
   * AbortSignal) is combined with the active turn's own signal so an MCP-side cancel
   * — a codex tool timeout, `notifications/cancelled`, or a connection drop/crash —
   * cascades into the child abort path instead of leaving the subagent running. */
  spawn(args: Record<string, unknown>, signal?: AbortSignal): Promise<SpawnBridgeResult>;
}

export interface CodexSpawnBridgeDeps {
  /** The `spawn_subagent` Tool (createSubagentTool(...)) whose run() drives the
   * nested turn AND re-emits child tool events under `ctx.toolCallId`. Reusing it
   * keeps codex-parent nesting byte-identical to the raw-API path. */
  readonly spawnTool: Tool;
  /** Deterministic id source for the outer spawn card (no Date.now/Math.random —
   * keeps tests reproducible). Default: a monotonic `codex-spawn-<n>` counter. */
  readonly nextToolCallId?: () => string;
  /** Reducer state for the synthetic ToolCtx. The subagent only forwards this to
   * its (depth-1) child tools' ctx.state — it reads nothing from it directly and no
   * grandchild spawns — so `initialState` is an honest inert default. An app that
   * wants the live state may inject a real reader. */
  readonly getState?: () => Readonly<State>;
}

function toSummaryText(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'summary' in data) {
    const summary = (data as { summary?: unknown }).summary;
    if (typeof summary === 'string') {
      return summary;
    }
  }
  return typeof data === 'string' ? data : '';
}

/** Build the codex spawn bridge over its deps. One instance is shared across the
 * app; only one codex turn is active at a time. */
export function createCodexSpawnBridge(deps: CodexSpawnBridgeDeps): CodexSpawnBridge {
  let counter = 0;
  const nextToolCallId =
    deps.nextToolCallId ??
    ((): string => {
      counter += 1;
      return `codex-spawn-${counter}`;
    });
  const getState = deps.getState ?? ((): Readonly<State> => initialState());

  let active: CodexTurnContext | undefined;
  let activeSpawns = 0;

  return {
    beginTurn(ctx: CodexTurnContext): () => void {
      active = ctx;
      return (): void => {
        // Only clear if still ours — a later turn may have already replaced it.
        if (active === ctx) {
          active = undefined;
        }
      };
    },

    isSpawnActive(): boolean {
      return activeSpawns > 0;
    },

    async spawn(args: Record<string, unknown>, signal?: AbortSignal): Promise<SpawnBridgeResult> {
      const turn = active;
      if (turn === undefined) {
        // Codex only calls the MCP tool mid-turn, so this is a defensive guard.
        return { text: 'spawn_subagent: no active codex turn', isError: true };
      }

      // Combine the turn's own abort with the MCP-side cancel signal (codex tool
      // timeout / notifications/cancelled / connection drop) so EITHER cascades into
      // the child's abort path (subagentTool aborts its childController off ctx.signal).
      // Without this, a cancelled/crashed codex parent leaves the subagent running to
      // completion — wasted tokens, a frozen spawn card, and activeSpawns stuck >0
      // (which globally suppresses stall detection, since bridge state is shared).
      const runSignal =
        signal !== undefined ? AbortSignal.any([turn.signal, signal]) : turn.signal;

      const toolCallId = nextToolCallId();
      activeSpawns += 1;
      try {
        // OUTER spawn card lifecycle — the executor's role on the raw-API path:
        // register the card, mark it running, then finalize after the subagent.
        turn.emit({
          type: 'tool-call',
          id: turn.turnId,
          toolCallId,
          name: 'spawn_subagent',
          args,
        });
        turn.emit({ type: 'tool-status', toolCallId, status: 'running' });

        const ctx: ToolCtx = {
          cwd: turn.cwd,
          signal: runSignal,
          // The subagent orchestrator stamps this as `parentToolUseId` on every
          // child tool event, nesting the child cards under THIS card.
          toolCallId,
          emit: turn.emit,
          // No UI for a nested prompt mid-codex-turn → deny (the shared policy still
          // auto-allows safe tools + remembered patterns before this is reached).
          awaitPermission: async () => 'deny',
          state: getState(),
        };

        const result = await deps.spawnTool.run(args, ctx);

        if (runSignal.aborted) {
          turn.emit({ type: 'tool-status', toolCallId, status: 'error', error: 'aborted' });
          return { text: 'sub-agent aborted', isError: true };
        }
        if (result.ok) {
          turn.emit({ type: 'tool-status', toolCallId, status: 'result', result: result.data });
          return { text: toSummaryText(result.data), isError: false };
        }
        const error = result.error ?? 'sub-agent failed';
        turn.emit({ type: 'tool-status', toolCallId, status: 'error', error });
        return { text: error, isError: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        turn.emit({ type: 'tool-status', toolCallId, status: 'error', error });
        return { text: `spawn_subagent failed: ${error}`, isError: true };
      } finally {
        activeSpawns -= 1;
      }
    },
  };
}
