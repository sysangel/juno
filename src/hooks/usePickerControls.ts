// src/hooks/usePickerControls.ts
// W9 app-decompose — the palette/picker controllers, extracted verbatim from
// app.tsx: the slash palette's live query + filtered rows + highlight, the
// model/skill/permission-mode picker selections, and their open/move/accept
// handlers. One reason to change: picker navigation + selection UX.
//
// The MODEL selection itself (selectedId) stays app-level state — it drives
// client construction and the status line — so moveModel receives its setter.
// The session picker and tool-detail/subagent overlays have their own hooks
// (useSessionResume / useToolDetailOverlay / useSubagentPanel).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Action, State } from '../core/reducer';
import type { ModelEntry } from '../services/catalog';
import {
  filterSlashCommands,
  parseSlashCommand,
  slashCommands,
  type SlashCommand,
} from '../app/slashCommands';

export const PERMISSION_MODES: ReadonlyArray<State['permissionMode']> = ['default', 'acceptEdits'];

export interface PickerControlsDeps {
  /** turn.dispatch — every opener routes through set-overlay. */
  readonly dispatch: (action: Action) => void;
  /** turn.state.permissionMode — seeds the permission-mode picker on open. */
  readonly permissionMode: State['permissionMode'];
  /** Configured startup mode — the picker highlight's initial value. */
  readonly initialPermissionMode: State['permissionMode'];
  /** The live composer text (the slash palette's type-to-filter query). */
  readonly value: string;
  readonly setValue: (value: string) => void;
  readonly closeOverlay: () => void;
  readonly models: ReadonlyArray<ModelEntry>;
  /** Setter for the app-owned model selection (moveModel cycles it in place). */
  readonly setSelectedId: Dispatch<SetStateAction<string>>;
  readonly skills: ReadonlyArray<{ name: string; description: string }>;
}

export interface PickerControls {
  /** The command word typed after `/` (null when not a slash query). */
  readonly slashQuery: string | null;
  readonly filteredSlashCommands: ReadonlyArray<SlashCommand>;
  readonly selectedIndex: number;
  readonly selectedSkillIndex: number;
  readonly selectedPermissionMode: State['permissionMode'];
  readonly openSlash: () => void;
  readonly openModelPicker: () => void;
  readonly openHelp: () => void;
  readonly openMcp: () => void;
  readonly openSkillPicker: () => void;
  readonly openPermissionModePicker: () => void;
  readonly moveSlash: (delta: number) => void;
  readonly moveModel: (delta: number) => void;
  readonly moveSkill: (delta: number) => void;
  readonly movePermissionMode: (delta: number) => void;
  readonly acceptModel: () => void;
  readonly acceptSkill: () => void;
  readonly acceptPermissionMode: () => void;
}

export function usePickerControls(deps: PickerControlsDeps): PickerControls {
  const {
    dispatch,
    permissionMode,
    initialPermissionMode,
    value,
    setValue,
    closeOverlay,
    models,
    setSelectedId,
    skills,
  } = deps;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [selectedPermissionMode, setSelectedPermissionMode] =
    useState<State['permissionMode']>(initialPermissionMode);

  // Query the slash palette filters on: the command word typed after `/`. While the
  // slash overlay is open the composer stays focused (see the InputBox focus gate),
  // so `value` holds the live query text ('/st', '/steer make it shorter'). Empty /
  // null query shows every command.
  const slashQuery = parseSlashCommand(value);
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashQuery),
    [slashQuery],
  );

  // Reset the highlight to the top whenever the query narrows/widens the list, so a
  // stale index can never point past the filtered end or select the wrong row.
  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const openSlash = useCallback((): void => {
    setSelectedIndex(0);
    // Seed the '/' into the composer so it survives the palette open (the seed strip
    // in handleInputChange only fires while the overlay is 'none'). value now holds
    // the live query as the user types.
    setValue('/');
    dispatch({ t: 'set-overlay', overlay: 'slash' });
  }, [dispatch, setValue]);

  const openModelPicker = useCallback((): void => {
    dispatch({ t: 'set-overlay', overlay: 'model-picker' });
  }, [dispatch]);

  const openHelp = useCallback((): void => {
    dispatch({ t: 'set-overlay', overlay: 'help' });
  }, [dispatch]);

  const openMcp = useCallback((): void => {
    dispatch({ t: 'set-overlay', overlay: 'mcp' });
  }, [dispatch]);

  const openSkillPicker = useCallback((): void => {
    setSelectedSkillIndex(0);
    dispatch({ t: 'set-overlay', overlay: 'skill-picker' });
  }, [dispatch]);

  const openPermissionModePicker = useCallback((): void => {
    setSelectedPermissionMode(permissionMode);
    dispatch({ t: 'set-overlay', overlay: 'permission-mode' });
  }, [dispatch, permissionMode]);

  // All picker lists clamp at their ends. Coalesced arrow deltas may be larger
  // than the list, so every mover clamps the computed index in one step.
  const moveSlash = useCallback((delta: number): void => {
    setSelectedIndex((current) => {
      const count = filteredSlashCommands.length;
      if (count === 0) {
        return current;
      }
      return Math.max(0, Math.min(current + delta, count - 1));
    });
  }, [filteredSlashCommands.length]);

  const moveModel = useCallback(
    (delta: number): void => {
      if (models.length === 0) {
        return;
      }
      setSelectedId((current) => {
        const currentIndex = Math.max(
          0,
          models.findIndex((model) => model.id === current),
        );
        const nextIndex = Math.max(0, Math.min(currentIndex + delta, models.length - 1));
        return models[nextIndex]!.id;
      });
    },
    [models, setSelectedId],
  );

  const moveSkill = useCallback(
    (delta: number): void => {
      setSelectedSkillIndex((current) => {
        if (skills.length === 0) {
          return current;
        }
        return Math.max(0, Math.min(current + delta, skills.length - 1));
      });
    },
    [skills.length],
  );

  const movePermissionMode = useCallback((delta: number): void => {
    setSelectedPermissionMode((current) => {
      const currentIndex = Math.max(0, PERMISSION_MODES.indexOf(current));
      const nextIndex = Math.max(0, Math.min(currentIndex + delta, PERMISSION_MODES.length - 1));
      return PERMISSION_MODES[nextIndex]!;
    });
  }, []);

  const acceptModel = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

  const acceptSkill = useCallback((): void => {
    const skill = skills[selectedSkillIndex];
    if (skill === undefined) {
      closeOverlay();
      return;
    }
    dispatch({ t: 'skill-select', name: skill.name });
  }, [closeOverlay, selectedSkillIndex, skills, dispatch]);

  const acceptPermissionMode = useCallback((): void => {
    dispatch({ t: 'set-permission-mode', mode: selectedPermissionMode });
    closeOverlay();
  }, [closeOverlay, selectedPermissionMode, dispatch]);

  return {
    slashQuery,
    filteredSlashCommands,
    selectedIndex,
    selectedSkillIndex,
    selectedPermissionMode,
    openSlash,
    openModelPicker,
    openHelp,
    openMcp,
    openSkillPicker,
    openPermissionModePicker,
    moveSlash,
    moveModel,
    moveSkill,
    movePermissionMode,
    acceptModel,
    acceptSkill,
    acceptPermissionMode,
  };
}
