// src/hooks/useStatusModel.ts
// W9 app-decompose — the StatusLine bundle memo (Wave 2 item C), extracted
// verbatim from app.tsx. One reason to change: what the status strip shows and
// which state fields invalidate it.
//
// The bundle's identity must stay STABLE across commits that change no status
// field: token flushes only mutate `state.live`, which `selectStatusLine` never
// reads — with a stable `status` identity the memoized <StatusLine> (and the
// passed-through StatusLineState) bail out of those commits instead of
// re-running the render fn + Yoga layout. The dep list is enumerated against
// EVERY field selectStatusLine reads (selectors.ts:312-365, incl.
// selectStatusText's errorMessage/phase reads); miss one and the strip silently
// goes stale — a correctness bug, not a perf miss.
//   state reads : tokens (token bar / cost / ctxFraction), effort, overlay,
//                 phase, errorMessage (statusText), committed +
//                 contextWindowTokens (ctx window + pressure), compactions,
//                 permissionMode, pendingPermissionToolCallId.
//   context     : selectedId, cwd, selectedEntry (contextWindow + pricing),
//                 maxContext, maxToolCalls, skills, isCompacting,
//                 toolCallsThisTurn, mcpStatus.
import { useMemo } from 'react';
import type { State } from '../core/reducer';
import { selectStatusLine, type McpConnectionState } from '../core/selectors';
import type { ModelEntry } from '../services/catalog';

export interface StatusModelDeps {
  /** The full reducer state — the memo keys GRANULARLY on its fields, never
   * on its identity (a token flush re-identifies state every ~16ms). */
  readonly state: State;
  readonly selectedId: string;
  readonly cwd: string;
  /** The SELECTED catalog entry (context window denominator + pricing chip). */
  readonly selectedEntry: ModelEntry | undefined;
  /** Configured fallback context budget (when the entry omits a window). */
  readonly maxContext: number | undefined;
  /** Per-turn tool-call ceiling for the guard chip. */
  readonly maxToolCalls: number | undefined;
  readonly skills: ReadonlyArray<{ name: string; description: string }> | undefined;
  readonly isCompacting: boolean;
  readonly toolCallsThisTurn: number;
  readonly mcpStatus: McpConnectionState | undefined;
}

export function useStatusModel(deps: StatusModelDeps): ReturnType<typeof selectStatusLine> {
  const {
    state,
    selectedId,
    cwd,
    selectedEntry,
    maxContext,
    maxToolCalls,
    skills,
    isCompacting,
    toolCallsThisTurn,
    mcpStatus,
  } = deps;

  return useMemo(
    () =>
      selectStatusLine(state, {
        model: selectedId,
        cwd,
        // Denominator for the context-window monitor: the SELECTED model's real window
        // (codex 272–372k vs fable/sonnet 1M), so the `ctx:` %/bar reflect the model
        // actually in use. Falls back to the configured budget when the entry omits a
        // window. Auto-compaction is threaded the SAME per-model window (see the turn
        // deps in app.tsx), so the meter and the compaction trigger share one denominator.
        maxContext: selectedEntry?.contextWindow ?? maxContext,
        skills: skills?.map((skill) => skill.name),
        // Per-token pricing for the cost chip; undefined for the subscription backend => chip hidden.
        pricing: selectedEntry?.pricing,
        permissionMode: state.permissionMode,
        isCompacting,
        // Surface the per-turn tool-call budget so the StatusLine can render the guard chip.
        toolBudget: { used: toolCallsThisTurn, max: maxToolCalls },
        // Async MCP connect state (Wave 2 async-mcp) → the state-carrying mcp chip.
        mcp: mcpStatus,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- granular by design: each
    // field selectStatusLine reads is listed individually so a token flush (which only
    // changes state.live/tools) does NOT recompute the bundle. Listing state
    // wholesale would defeat the memo (new identity every flush). Keep in sync with the
    // enumeration above whenever selectStatusLine's inputs change.
    [
      state.tokens,
      state.effort,
      state.overlay,
      state.phase,
      state.errorMessage,
      state.committed,
      state.contextWindowTokens,
      state.compactions,
      state.permissionMode,
      state.pendingPermissionToolCallId,
      selectedId,
      cwd,
      selectedEntry,
      maxContext,
      maxToolCalls,
      skills,
      isCompacting,
      toolCallsThisTurn,
      mcpStatus,
    ],
  );
}
