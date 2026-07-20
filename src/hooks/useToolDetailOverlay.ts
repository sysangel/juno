// src/hooks/useToolDetailOverlay.ts
// W9 app-decompose — the ctrl+o tool-detail overlay's controller state, extracted
// verbatim from app.tsx. One reason to change: how the tool-call browser
// highlights, pins, scrolls and navigates.
//
// `view` toggles list ↔ detail; `scroll` is the detail body's offset in wrapped
// lines. All of it is overlay-local — the reducer only tracks that the overlay is
// open (`overlay === 'tool-detail'`).
//
// The highlighted (list) and opened (detail) calls are pinned by tool-call ID, NOT
// by list index: `entries` is rebuilt most-recent-first every time `tools` grows,
// so a tool-call that lands while the overlay is up would shift every index and
// silently swap which call the list highlights / the detail body shows (with the
// stale scroll offset applied). Tracking by ID keeps both glued to the SAME call
// across insertions; positions are re-derived from the id each render.
import { useCallback, useMemo, useState } from 'react';
import type { Action, ToolState } from '../core/reducer';
import {
  buildToolDetailLines,
  toolDetailViewportRows,
  type ToolDetailEntry,
} from '../ui/ToolDetailOverlay';

export interface ToolDetailOverlayDeps {
  /** The session's tool-call map (turn.state.tools), chronological insertion order. */
  readonly tools: Record<string, ToolState>;
  /** turn.dispatch — opens the overlay via set-overlay. */
  readonly dispatch: (action: Action) => void;
  /** Close the active overlay (app.tsx preserves the composer draft). */
  readonly closeOverlay: () => void;
  /** Terminal size, for the detail body's wrap/viewport scroll clamp. */
  readonly columns: number;
  readonly rows: number;
}

export interface ToolDetailOverlay {
  readonly view: 'list' | 'detail';
  /** This session's tool calls, MOST-RECENT-FIRST. */
  readonly entries: ToolDetailEntry[];
  /** Id-resolved list highlight position (0 fallback; -1 on an empty list). */
  readonly highlightIndex: number;
  /** Id-resolved pinned (opened) position; -1 when the call no longer exists. */
  readonly pinnedIndex: number;
  readonly scroll: number;
  readonly open: () => void;
  readonly move: (delta: number) => void;
  readonly accept: () => void;
  readonly back: () => void;
}

export function useToolDetailOverlay(deps: ToolDetailOverlayDeps): ToolDetailOverlay {
  const { tools, dispatch, closeOverlay, columns, rows } = deps;

  const [view, setView] = useState<'list' | 'detail'>('list');
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);

  // This session's tool calls, MOST-RECENT-FIRST. `tools` accumulates every
  // call in insertion (chronological) order and is only wiped on clear/resume, so
  // reversing its entries yields the newest-first browse order the overlay wants.
  const entries = useMemo<ToolDetailEntry[]>(
    () => Object.entries(tools).map(([id, tool]) => ({ id, tool })).reverse(),
    [tools],
  );

  // Re-derive positions in the CURRENT (possibly just-grown) ordering from the pinned
  // ids. The highlight falls back to the newest row (index 0) when its id is gone or
  // unset; the pinned index is -1 when the opened call no longer exists (e.g. cleared),
  // which the overlay renders as "(no selection)" rather than swapping to another call.
  const highlightIndex = useMemo(() => {
    if (entries.length === 0) return -1;
    const i = entries.findIndex((e) => e.id === highlightId);
    return i >= 0 ? i : 0;
  }, [entries, highlightId]);
  const pinnedIndex = useMemo(
    () => entries.findIndex((e) => e.id === pinnedId),
    [entries, pinnedId],
  );

  const open = useCallback((): void => {
    setView('list');
    setHighlightId(entries[0]?.id ?? null);
    setPinnedId(null);
    setScroll(0);
    dispatch({ t: 'set-overlay', overlay: 'tool-detail' });
  }, [dispatch, entries]);

  // up/down in the overlay: SCROLL the detail body when a call is open, else MOVE the
  // list highlight. Both clamp (a browser, not a wrap-around ring) — the detail scroll
  // against the wrapped-line count for the SAME viewport the panel renders.
  const move = useCallback(
    (delta: number): void => {
      if (view === 'detail') {
        // Scroll the PINNED call's body — look it up by id, never by list index, so a
        // mid-turn insertion can't retarget the scroll math onto a different call.
        const entry = entries.find((e) => e.id === pinnedId);
        if (entry === undefined) return;
        const maxScroll = Math.max(
          0,
          buildToolDetailLines(entry.tool, columns).length - toolDetailViewportRows(rows),
        );
        setScroll((s) => Math.max(0, Math.min(s + delta, maxScroll)));
        return;
      }
      const n = entries.length;
      if (n === 0) return;
      // Move the highlight relative to its CURRENT id-resolved position, then re-pin to
      // the id at the new slot so the highlight stays on that call across insertions.
      const cur = highlightIndex >= 0 ? highlightIndex : 0;
      const next = Math.max(0, Math.min(cur + delta, n - 1));
      setHighlightId(entries[next]?.id ?? null);
    },
    [view, entries, pinnedId, highlightIndex, columns, rows],
  );

  // Enter: open the highlighted call's full detail view (no-op on an empty list). Pin
  // by the highlighted call's ID (not its current index) so a tool-call that lands
  // between this frame and the keypress can't open a DIFFERENT call than the one shown.
  const accept = useCallback((): void => {
    if (entries.length === 0) return;
    const entry = entries[highlightIndex >= 0 ? highlightIndex : 0];
    if (entry === undefined) return;
    setPinnedId(entry.id);
    setScroll(0);
    setView('detail');
  }, [entries, highlightIndex]);

  // Esc (routed here by useKeybinds): detail view → back to the list; list → close.
  const back = useCallback((): void => {
    if (view === 'detail') {
      setView('list');
      setScroll(0);
      return;
    }
    closeOverlay();
  }, [view, closeOverlay]);

  return { view, entries, highlightIndex, pinnedIndex, scroll, open, move, accept, back };
}
