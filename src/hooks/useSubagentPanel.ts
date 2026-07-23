// src/hooks/useSubagentPanel.ts
// W9 app-decompose — the below-composer agents panel's data + controllers
// (LANE B), extracted verbatim from app.tsx. One reason to change: how the
// session's subagents are rehydrated, merged and expanded/collapsed.
//
// Durable per-subagent records are rehydrated from disk for the ACTIVE session.
// The live `tools` map is authoritative during a session (the recorder just
// mirrors it), but a RESUMED session starts with `tools = {}` — so without this
// the agents panel would be empty even though the `<id>.subagents/*.jsonl`
// records still hold every child step. Loaded once per session id (mount +
// resume); fail-soft to {} when there's no reader or no records.
//
// The reducer overlay owns expanded/collapsed state; this hook owns the selected
// roster row and exposes the live-wins recorder map to the focused viewer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Action, ToolState } from '../core/reducer';
import { selectSubagents, type SubagentEntry } from '../core/selectors';

/**
 * Override a rolled-up subagent entry's status by matching id against the runner's
 * live task snapshot (Wave 13, lane 1). The executor forces a spawn card to
 * 'result' the instant the non-blocking tool returns, so `selectSubagents` would
 * roll a still-running background agent up as 'done'. The runner's task status is
 * authoritative while it runs; overriding here keeps the panel honest WITHOUT
 * re-dispatching a 'running' tool-status (which would trip the reducer race-guard
 * and re-pin the spinner). PURE + returns the SAME array ref when nothing changed,
 * so the SubagentPanel memo bail-out is preserved. Timing metadata is folded in
 * through the same immutable projection.
 */
export function overrideSubagentStatus(
  entries: SubagentEntry[],
  statuses: Record<string, SubagentEntry['status']> | undefined,
  timings?: Record<string, { startedAt: number; lastActivityAt?: number }>,
): SubagentEntry[] {
  if (statuses === undefined && timings === undefined) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const override = statuses?.[entry.id];
    const timing = timings?.[entry.id];
    const timingUnchanged =
      timing === undefined ||
      (timing.startedAt === entry.startedAt &&
        timing.lastActivityAt === entry.lastActivityAt);
    if (
      (override === undefined || override === entry.status) &&
      timingUnchanged
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      ...(override !== undefined ? { status: override } : {}),
      ...(timing !== undefined
        ? {
            startedAt: timing.startedAt,
            ...(timing.lastActivityAt !== undefined
              ? { lastActivityAt: timing.lastActivityAt }
              : {}),
          }
        : {}),
    };
  });
  return changed ? next : entries;
}

export interface SubagentPanelDeps {
  /** Reader for the durable per-subagent JSONL (AppDeps.readSubagentTranscripts). */
  readonly read: ((sessionId: string) => Promise<Record<string, ToolState>>) | undefined;
  readonly activeSessionId: string;
  /** The live tool-call map (turn.state.tools) — wins on id conflicts. */
  readonly liveTools: Record<string, ToolState>;
  /** turn.dispatch — expands the panel via set-overlay. */
  readonly dispatch: (action: Action) => void;
  /** Collapse the panel back to the composer (app.tsx's closeOverlay). */
  readonly closeOverlay: () => void;
  /**
   * The background runner's live task-status snapshot (Wave 13), keyed by spawn card
   * id. When present it OVERRIDES a matching subagent entry's rolled-up status so a
   * detached background agent reads 'running' until it actually finishes. Absent ⇒
   * no override (the pure selectSubagents rollup stands).
   */
  readonly taskStatusOverride?: Record<string, SubagentEntry['status']>;
  readonly taskTimingOverride?: Record<string, { startedAt: number; lastActivityAt?: number }>;
  /**
   * The tool call whose permission prompt is open (`state.pendingPermissionToolCallId`).
   * Threaded into `selectSubagents` so a permission-gated spawn rolls up as `waiting`
   * (never a spinning `running`) until the prompt resolves. Absent/null ⇒ no gated spawn.
   */
  readonly pendingPermissionToolCallId?: string | null;
}

export interface SubagentPanelState {
  /** The session's subagents, newest-last (selectSubagents order). */
  readonly subagents: SubagentEntry[];
  /** Live-wins union of recorder-backed and in-memory child tool events. */
  readonly tools: Record<string, ToolState>;
  readonly selectedIndex: number;
  readonly selectedId: string | undefined;
  /** Down-arrow handoff from the composer: expand ONLY when subagents exist. */
  readonly focusFromComposer: () => void;
  /** Up/down while expanded moves the visible selection. */
  readonly move: (delta: number) => void;
  /** Esc: collapse the panel, returning focus to the composer. */
  readonly back: () => void;
  /** Open the selected agent's durable detail/transcript view. */
  readonly open: () => void;
}

export function useSubagentPanel(deps: SubagentPanelDeps): SubagentPanelState {
  const {
    read,
    activeSessionId,
    liveTools,
    dispatch,
    closeOverlay,
    taskStatusOverride,
    taskTimingOverride,
    pendingPermissionToolCallId,
  } = deps;

  const [diskSubagentTools, setDiskSubagentTools] = useState<Record<string, ToolState>>({});
  useEffect(() => {
    if (read === undefined) {
      setDiskSubagentTools({});
      return;
    }
    let cancelled = false;
    void read(activeSessionId).then(
      (tools) => {
        if (!cancelled) setDiskSubagentTools(tools);
      },
      () => {
        if (!cancelled) setDiskSubagentTools({});
      },
    );
    return () => {
      cancelled = true;
    };
  }, [read, activeSessionId]);

  // The tools map the panel derives from: the durable on-disk records UNION the live
  // `tools`, with LIVE WINNING on id conflicts. In-session the live map already holds
  // every subagent, so the merge is identity (diskSubagentTools is either equal or a
  // subset) and the ref stays the live map — preserving the SubagentPanel memo
  // bail-out. Only a resume (empty live map) surfaces the disk-only records. The merge is
  // memoized on both refs, both stable across a token flush, so a mid-stream re-render
  // reuses the same map ref.
  const effectiveSubagentTools = useMemo<Record<string, ToolState>>(() => {
    if (Object.keys(diskSubagentTools).length === 0) return liveTools;
    return { ...diskSubagentTools, ...liveTools };
  }, [liveTools, diskSubagentTools]);

  // The session's subagents, rolled up from `effectiveSubagentTools` (the same tool
  // events the recorder persists to `<id>.jsonl`). Keyed on that map, whose ref is stable
  // across a token flush (a text delta returns a new state but the SAME tools map), so a
  // mid-stream re-render reuses this array and the memoized SubagentPanel bails out.
  const rolledUp = useMemo(
    () => selectSubagents({ tools: effectiveSubagentTools }, pendingPermissionToolCallId),
    [effectiveSubagentTools, pendingPermissionToolCallId],
  );

  // Apply the runner's live task-status override (Wave 13). Returns the SAME ref
  // when nothing changed, so a mid-stream re-render still reuses the array and the
  // SubagentPanel memo bails out; keyed on both so a task transition (running→done)
  // re-rolls the list for free.
  const subagents = useMemo(
    () => overrideSubagentStatus(rolledUp, taskStatusOverride, taskTimingOverride),
    [rolledUp, taskStatusOverride, taskTimingOverride],
  );

  const [rawSelectedIndex, setRawSelectedIndex] = useState(0);
  const selectedIndex = subagents.length === 0
    ? -1
    : Math.min(Math.max(rawSelectedIndex, 0), subagents.length - 1);
  const selectedId = selectedIndex < 0 ? undefined : subagents[selectedIndex]?.id;

  // Down-arrow handoff from the composer: EXPAND the panel ONLY when the session actually
  // has subagents (else the Down stays a no-op, exactly as before).
  const focusFromComposer = useCallback((): void => {
    if (subagents.length === 0) return;
    setRawSelectedIndex(subagents.length - 1);
    dispatch({ t: 'set-overlay', overlay: 'subagents' });
  }, [subagents, dispatch]);

  // Up/down moves the selection; Esc alone collapses, avoiding a navigation gesture
  // doubling as a focus-changing action.
  const move = useCallback(
    (delta: number): void => {
      setRawSelectedIndex((current) => {
        if (subagents.length === 0) return 0;
        const base = Math.min(Math.max(current, 0), subagents.length - 1);
        return Math.min(Math.max(base + delta, 0), subagents.length - 1);
      });
    },
    [subagents.length],
  );

  // Esc (routed here by useKeybinds): collapse the panel, returning focus to the composer.
  const back = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

  const open = useCallback((): void => {
    if (selectedId !== undefined) dispatch({ t: 'set-overlay', overlay: 'subagent-viewer' });
  }, [dispatch, selectedId]);

  return { subagents, tools: effectiveSubagentTools, selectedIndex, selectedId, focusFromComposer, move, back, open };
}
