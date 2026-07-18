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

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/events';
import type { State } from '../core/reducer';
import { initialState } from '../core/reducer';
import type { Tool, ToolCtx } from '../core/contracts';
import type { SpawnBridgeResult } from '../services/subagentMcpServer';
import { SUBAGENT_ABORTED } from '../core/abort';

/**
 * Unique-per-process prefix for the DEFAULT outer-card id, so a `codex exec` restart
 * (new process → the `codex-spawn-<n>` counter restarts at 1) cannot reuse the previous
 * session's `codex-spawn-1` and corrupt the durable subagent JSONL the recorder keys by
 * that id (a resumed session rebinds the recorder to the original session dir, so a
 * collision would fold two distinct subagents' runs into one record). Provider-issued ids
 * (claude-cli / raw-API tool-use ids) are already globally unique; only the codex bridge
 * minted a per-process counter. Tests inject `nextToolCallId` and keep their deterministic
 * ids, so this only changes production. */
const PROCESS_SPAWN_PREFIX = `codex-spawn-${randomUUID()}`;

/**
 * Grace window (ms) that keeps `isSpawnActive()` true for a short beat after the LAST
 * in-flight spawn's finally. `spawn` decrements `activeSpawns` BEFORE the MCP response is
 * even written back to codex, so a stall guard firing in the gap between activeSpawns→0
 * and codex's next stdout chunk (HTTP-response transit + codex processing) would otherwise
 * see suppression off and reap a child whose subagent JUST succeeded. A few seconds
 * comfortably covers that transit while staying far below the 60s/90s guard periods. */
const SPAWN_GRACE_MS = 5_000;

/**
 * `AbortSignal.any([...])` with a graceful fallback for Node < 20.3. package.json now
 * requires `>=20.3`, but a 20.0–20.2 point release lacks `AbortSignal.any`, and — because
 * runSignal below always combines signals — the missing global would throw
 * `AbortSignal.any is not a function` on EVERY bridge spawn, breaking the whole
 * codex-parent flow with an opaque backstop error. The fallback wires the first source
 * abort through to a fresh controller (losing nothing but the native impl). Exported for a
 * unit test that exercises the fallback branch.
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return AbortSignal.any([...signals]);
  }
  const controller = new AbortController();
  const already = signals.find((s) => s.aborted);
  if (already !== undefined) {
    controller.abort(already.reason);
    return controller.signal;
  }
  const onAbort = (event: Event): void => {
    for (const s of signals) s.removeEventListener('abort', onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

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
  /** True while ≥1 spawn is executing (plus a brief SPAWN_GRACE_MS tail after the last
   * one ends) — codexCliClient suspends its idle/stale stall timers for that window. */
  isSpawnActive(): boolean;
  /** Run one spawn on behalf of a codex parent's MCP tools/call. Never throws: every
   * failure resolves to an `isError` result. The child's abort path is driven by
   * `anySignal([turn.signal, <per-turn end>, signal])`, so it cascades from the turn's own
   * abort, from the turn ENDING (the disposer fires when codex dies/finishes — covering a
   * crash/OOM/timeout the SDK's per-request signal does NOT: in the installed SDK
   * `extra.signal` fires only on `notifications/cancelled` or a full transport close, NOT
   * on a per-request HTTP socket drop), OR from an explicit MCP-side cancel (`signal` — a
   * codex tool timeout / `notifications/cancelled`). */
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
  /** Injectable clock (ms) for the post-spawn stall-suppression grace window
   * (SPAWN_GRACE_MS). Default `Date.now`; tests inject a virtual clock. */
  readonly now?: () => number;
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
      return `${PROCESS_SPAWN_PREFIX}-${counter}`;
    });
  const getState = deps.getState ?? ((): Readonly<State> => initialState());
  const now = deps.now ?? Date.now;

  /** The active turn plus a controller that fires when THIS turn's disposer runs. */
  interface ActiveTurn {
    readonly ctx: CodexTurnContext;
    readonly ended: AbortController;
  }
  let active: ActiveTurn | undefined;
  let activeSpawns = 0;
  let lastSpawnEndedAt = Number.NEGATIVE_INFINITY;

  return {
    beginTurn(ctx: CodexTurnContext): () => void {
      const entry: ActiveTurn = { ctx, ended: new AbortController() };
      active = entry;
      return (): void => {
        // The turn is ending — codexCliClient's streamTurn `finally` runs this exactly
        // when the turn is over (codex dead / crashed / timed out / finished). Abort any
        // spawn still in flight for it: without this, a codex parent that OOMs or exits
        // non-zero mid-spawn leaves the subagent running unattended (silent token spend),
        // its spawn card frozen 'running' forever, and activeSpawns stuck >0 — which,
        // because the bridge instance is shared, globally suppresses stall detection on
        // the user's NEXT codex turn. Aborting HERE can never cancel a legitimately live
        // spawn precisely because the disposer only runs once the turn is done.
        entry.ended.abort();
        // Only clear if still ours — a later turn may have already replaced it.
        if (active === entry) {
          active = undefined;
        }
      };
    },

    isSpawnActive(): boolean {
      if (activeSpawns > 0) return true;
      // Grace window after the last spawn's finally — see SPAWN_GRACE_MS.
      return now() - lastSpawnEndedAt < SPAWN_GRACE_MS;
    },

    async spawn(args: Record<string, unknown>, signal?: AbortSignal): Promise<SpawnBridgeResult> {
      const entry = active;
      if (entry === undefined) {
        // Codex only calls the MCP tool mid-turn, so this is a defensive guard.
        return { text: 'spawn_subagent: no active codex turn', isError: true };
      }
      const turn = entry.ctx;

      // Cascade into the child's abort path (subagentTool aborts its childController off
      // ctx.signal) from ANY of: the turn's own abort; the per-turn `ended` abort (the
      // turn is over — codex dead or finished, so aborting a still-running spawn reclaims
      // the orphan); or the MCP-side cancel `signal` (codex tool timeout /
      // notifications/cancelled). anySignal degrades gracefully on Node < 20.3.
      const runSignal = anySignal(
        signal !== undefined
          ? [turn.signal, entry.ended.signal, signal]
          : [turn.signal, entry.ended.signal],
      );

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
          // Emit the SHARED abort marker (not a bare 'aborted') so isAbortReason
          // classifies this parent-abort cascade as a neutral `aborted` card on both
          // render surfaces — a bare 'aborted' would read as a red ✗ FAIL, and would
          // also race the turn-level normalization (a settled-error card passes through
          // untouched), so the same Esc could read neutral or red depending on write order.
          turn.emit({ type: 'tool-status', toolCallId, status: 'error', error: SUBAGENT_ABORTED });
          return { text: SUBAGENT_ABORTED, isError: true };
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
        // Start the grace window from the moment the LAST spawn settles (see
        // SPAWN_GRACE_MS): activeSpawns is decremented here, BEFORE the MCP response
        // reaches codex, so isSpawnActive() must stay true a beat longer.
        if (activeSpawns === 0) lastSpawnEndedAt = now();
      }
    },
  };
}
