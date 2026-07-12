// src/hooks/useKeybinds.ts
// W6 — scoped key handling via Ink's useInput. Pure-ish: takes callbacks +
// current overlay, registers a single useInput, returns nothing.
//
// IMPORTANT: when the permission overlay is open, this hook stays out of the way
// for everything EXCEPT Esc (abort) — PermissionPrompt owns its own y/a/d/!
// keys via its internal useInput.
import { useInput, useStdin } from 'ink';
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { State } from '../core/reducer';

export interface UseKeybindsOptions {
  readonly overlay: State['overlay'];
  readonly value: string;
  /**
   * In-paste flag mirrored from the Composer's bracketed-paste buffer. When true a
   * bracketed paste is mid-flight (its markers/content span multiple data chunks),
   * so this hook must ignore every keystroke — a bare '\r' chunk between paste
   * chunks is paste CONTENT, not an Enter. Optional (component tests omit it).
   */
  readonly pasteActiveRef?: MutableRefObject<boolean>;
  readonly slashCommandCount: number;
  readonly modelCount: number;
  /** Number of skill rows (skill-picker overlay). Optional — defaults to 0. */
  readonly skillCount?: number;
  /** Number of session rows (session-picker overlay). Optional — defaults to 0. */
  readonly sessionCount?: number;
  /** Number of permission-mode rows. Optional — defaults to 0. */
  readonly permissionModeCount?: number;
  /** Number of tool-call rows (tool-detail overlay). Optional — defaults to 0. */
  readonly toolDetailCount?: number;
  readonly onAbort: () => void;
  readonly onCycleEffort: () => void;
  readonly onOpenSlash: () => void;
  /** Open the help overlay (`?` with empty input). Optional — omitted = no binding. */
  readonly onOpenHelp?: () => void;
  readonly onCloseOverlay: () => void;
  readonly onMoveSlash: (delta: number) => void;
  readonly onAcceptSlash: () => void;
  readonly onMoveModel: (delta: number) => void;
  readonly onAcceptModel: () => void;
  readonly onMoveSkill?: (delta: number) => void;
  readonly onAcceptSkill?: () => void;
  readonly onMoveSession?: (delta: number) => void;
  readonly onAcceptSession?: () => void;
  readonly onMovePermissionMode?: (delta: number) => void;
  readonly onAcceptPermissionMode?: () => void;
  /** Open the tool-detail overlay (ctrl+o with no overlay up). Optional. */
  readonly onOpenToolDetail?: () => void;
  /** Move the highlight (list view) or scroll (detail view) of the tool overlay. */
  readonly onMoveTool?: (delta: number) => void;
  /** Enter in the tool overlay: open the highlighted call's detail view. */
  readonly onAcceptTool?: () => void;
  /** Esc in the tool overlay: detail → back to list, list → close overlay. */
  readonly onToolBack?: () => void;
  /** Number of subagent rows (subagent-browser panel). Optional — defaults to 0. */
  readonly subagentCount?: number;
  /**
   * Move the highlight (list view) or scroll (transcript view) of the subagent panel.
   * The app routes by its sub-view; Up past the top of the list returns focus to the
   * composer.
   */
  readonly onMoveSubagent?: (delta: number) => void;
  /** Enter in the subagent panel: open the highlighted subagent's transcript overlay. */
  readonly onAcceptSubagent?: () => void;
  /** Esc in the subagent panel: transcript → back to list, list → return to composer. */
  readonly onSubagentBack?: () => void;
}

/**
 * Count the arrow-key escape sequences (CSI `ESC[` or SS3 `ESC O`, letter A/B) in a
 * raw stdin chunk. Ink's parseKeypress uses an ANCHORED regex, so a single data
 * chunk carrying a burst (`ESC[A ESC[A ESC[A` from key-repeat) parses to just ONE
 * keypress and DROPS the rest — this recovers the true count so overlay nav can
 * move by N in a single setState instead of losing the repeats. Exported for unit
 * tests.
 */
export function countArrowKeys(chunk: string): { up: number; down: number } {
  const esc = String.fromCharCode(27);
  const up = chunk.split(`${esc}[A`).length - 1 + (chunk.split(`${esc}OA`).length - 1);
  const down = chunk.split(`${esc}[B`).length - 1 + (chunk.split(`${esc}OB`).length - 1);
  return { up, down };
}

export function useKeybinds(options: UseKeybindsOptions): void {
  // Record the RAW data chunk for each input event so an arrow burst can be
  // coalesced (Ink blanks `input` for arrow keys, so the repeat count is only
  // visible in the raw chunk). This subscribes to Ink's OWN re-emit of chunks it
  // has already read in paused mode — NOT a raw stdin 'data' listener, so it does
  // not flip the stream to flowing mode. Declared BEFORE useInput so this listener
  // registers first and therefore fires before the keypress handler reads it.
  const { internal_eventEmitter } = useStdin();
  const lastChunkRef = useRef<string>('');
  useEffect(() => {
    const record = (chunk: unknown): void => {
      lastChunkRef.current = typeof chunk === 'string' ? chunk : String(chunk);
    };
    internal_eventEmitter.on('input', record);
    return () => {
      internal_eventEmitter.off('input', record);
    };
  }, [internal_eventEmitter]);

  // Resolve an arrow keypress into a single signed step count. Direction comes from
  // Ink's parsed key (reliable — it always reports at least the first arrow); the
  // MAGNITUDE is recovered from the raw chunk, clamped to ≥1 so a lone press still
  // moves one row even when the count cannot be recounted from the chunk.
  const arrowDelta = (isUp: boolean): number => {
    const { up, down } = countArrowKeys(lastChunkRef.current);
    return isUp ? -Math.max(1, up) : Math.max(1, down);
  };

  useInput((input, key) => {
    // Paste-first ordering (mirrors Composer.tsx): while a bracketed paste is still
    // assembling, EVERY key event belongs to the paste. The Composer buffers the
    // chunk (its useInput runs before this one — child effect subscribes first), so
    // a bare '\r' between paste chunks must not reach the palette's accept handler
    // and mis-fire /clear (default highlight) mid-paste. Bail before any binding.
    if (options.pasteActiveRef?.current === true) {
      return;
    }

    if (key.escape) {
      // The tool-detail overlay owns a two-level Esc: from the detail view it backs
      // out to the list; from the list it closes the overlay. Both are decided by
      // the app (it holds the sub-view state), so route Esc there FIRST — before the
      // generic abort/close split below — so Esc never aborts the turn behind it.
      if (options.overlay === 'tool-detail') {
        options.onToolBack?.();
        return;
      }
      // The subagent browser owns a two-level Esc too: transcript view → back to the
      // list (focus stays in the panel); list view → return focus to the composer. The
      // app decides which by its sub-view, so route Esc there FIRST so it never aborts
      // the turn behind the panel.
      if (options.overlay === 'subagents') {
        options.onSubagentBack?.();
        return;
      }
      // Esc aborts the turn when no dismissable overlay is up (or a permission
      // prompt is up — aborting drains it). Otherwise it closes the overlay.
      if (options.overlay === 'permission' || options.overlay === 'none') {
        options.onAbort();
        return;
      }
      options.onCloseOverlay();
      return;
    }

    // PermissionPrompt owns all other keys while it is open.
    if (options.overlay === 'permission') {
      return;
    }

    if (options.overlay === 'slash') {
      if ((key.upArrow || key.downArrow) && options.slashCommandCount > 0) {
        options.onMoveSlash(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptSlash();
        return;
      }
      return;
    }

    if (options.overlay === 'model-picker') {
      if ((key.upArrow || key.downArrow) && options.modelCount > 0) {
        options.onMoveModel(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptModel();
        return;
      }
      return;
    }

    if (options.overlay === 'skill-picker') {
      const skillCount = options.skillCount ?? 0;
      if ((key.upArrow || key.downArrow) && skillCount > 0) {
        options.onMoveSkill?.(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptSkill?.();
        return;
      }
      return;
    }

    if (options.overlay === 'session-picker') {
      const sessionCount = options.sessionCount ?? 0;
      if ((key.upArrow || key.downArrow) && sessionCount > 0) {
        options.onMoveSession?.(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptSession?.();
        return;
      }
      return;
    }

    if (options.overlay === 'permission-mode') {
      const permissionModeCount = options.permissionModeCount ?? 0;
      if ((key.upArrow || key.downArrow) && permissionModeCount > 0) {
        options.onMovePermissionMode?.(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptPermissionMode?.();
        return;
      }
      return;
    }

    // Tool-detail overlay: up/down move the list highlight (list view) or scroll the
    // detail body (detail view) — the app routes by its sub-view; Enter opens the
    // highlighted call. Esc is handled above (two-level back). Everything else is
    // swallowed so Tab / `/` can't fire behind it.
    if (options.overlay === 'tool-detail') {
      if (key.upArrow || key.downArrow) {
        options.onMoveTool?.(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptTool?.();
        return;
      }
      return;
    }

    // Subagent browser: up/down move the panel's row highlight (list view) or scroll the
    // transcript body (transcript view) — the app routes by its sub-view; Enter opens the
    // highlighted subagent's transcript. Esc is handled above (two-level back). Everything
    // else is swallowed so Tab / `/` can't fire behind it.
    if (options.overlay === 'subagents') {
      if (key.upArrow || key.downArrow) {
        options.onMoveSubagent?.(arrowDelta(key.upArrow));
        return;
      }
      if (key.return) {
        options.onAcceptSubagent?.();
        return;
      }
      return;
    }

    // Help + MCP overlays: static read-only panels — Esc (handled above) closes;
    // every other key is swallowed so Tab / `/` can't fire behind them.
    if (options.overlay === 'help' || options.overlay === 'mcp') {
      return;
    }

    // overlay === 'none': global bindings.
    if (key.tab) {
      options.onCycleEffort();
      return;
    }

    // Ctrl+O opens the tool-detail overlay (a navigable list of this session's tool
    // calls → full args/result). Ink maps Ctrl+O to input 'o' with key.ctrl; the raw
    // DLE byte (\x0f) is accepted too for terminals that pass it through unmapped.
    // Not empty-input-gated (it is a chord, not a printable), so it works mid-draft.
    if (key.ctrl && (input === 'o' || input === '\x0f')) {
      options.onOpenToolDetail?.();
      return;
    }

    if (input === '/' && options.value.length === 0) {
      options.onOpenSlash();
      return;
    }

    // Keybind discoverability: `?` on an empty input opens the help cheatsheet
    // (same empty-input gate as `/` so typing "what?" never triggers it).
    if (input === '?' && options.value.length === 0) {
      options.onOpenHelp?.();
      return;
    }

    // NOTE (G): the former Ctrl+M → onOpenModelPicker binding was removed. Ctrl+M
    // transmits '\r', which parseKeypress classifies as `return` (handled by the
    // composer's submit), so `key.ctrl && 'm'` was never reachable. The model picker
    // is reached via `/model`.
  });
}
