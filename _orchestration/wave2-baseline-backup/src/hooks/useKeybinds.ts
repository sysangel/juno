// src/hooks/useKeybinds.ts
// W6 — scoped key handling via Ink's useInput. Pure-ish: takes callbacks +
// current overlay, registers a single useInput, returns nothing.
//
// IMPORTANT: when the permission overlay is open, this hook stays out of the way
// for everything EXCEPT Esc (abort) — PermissionPrompt owns its own y/a/d/!
// keys via its internal useInput.
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

    // overlay === 'none': global bindings.
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
