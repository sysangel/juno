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
// The panel is EXPAND/COLLAPSE only — its expanded/collapsed state is the
// reducer overlay (`overlay === 'subagents'`), so no local view/selection/
// scroll state is needed here (transcript browsing was removed; the per-
// subagent record is still written to disk, the UI just no longer opens it).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Action, ToolState } from '../core/reducer';
import { selectSubagents, type SubagentEntry } from '../core/selectors';

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
}

export interface SubagentPanelState {
  /** The session's subagents, newest-last (selectSubagents order). */
  readonly subagents: SubagentEntry[];
  /** Down-arrow handoff from the composer: expand ONLY when subagents exist. */
  readonly focusFromComposer: () => void;
  /** up/down while expanded: Up collapses; Down is a no-op. */
  readonly move: (delta: number) => void;
  /** Esc: collapse the panel, returning focus to the composer. */
  readonly back: () => void;
}

export function useSubagentPanel(deps: SubagentPanelDeps): SubagentPanelState {
  const { read, activeSessionId, liveTools, dispatch, closeOverlay } = deps;

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
  const subagents = useMemo(
    () => selectSubagents({ tools: effectiveSubagentTools }),
    [effectiveSubagentTools],
  );

  // Down-arrow handoff from the composer: EXPAND the panel ONLY when the session actually
  // has subagents (else the Down stays a no-op, exactly as before).
  const focusFromComposer = useCallback((): void => {
    if (subagents.length === 0) return;
    dispatch({ t: 'set-overlay', overlay: 'subagents' });
  }, [subagents, dispatch]);

  // up/down while the panel is expanded (expand/collapse only): Up collapses back to the
  // composer; Down is a no-op (the whole list is already shown — there is nothing to
  // scroll into now that transcript browsing is gone).
  const move = useCallback(
    (delta: number): void => {
      if (delta < 0) closeOverlay();
    },
    [closeOverlay],
  );

  // Esc (routed here by useKeybinds): collapse the panel, returning focus to the composer.
  const back = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

  return { subagents, focusFromComposer, move, back };
}
