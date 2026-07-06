import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import {
  UnifiedCommandPalette,
  type ModelPickerProps,
  type PermissionModePickerProps,
  type SessionPickerProps,
  type SkillPickerProps,
  type SlashPaletteProps,
} from './UnifiedCommandPalette';
import { PermissionPrompt, type PermissionPromptProps } from './PermissionPrompt';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  skillPicker?: SkillPickerProps;
  sessionPicker?: SessionPickerProps;
  permissionModePicker?: PermissionModePickerProps;
  permission?: PermissionPromptProps;
}

export function OverlayHost(props: OverlayHostProps): ReactElement | null {
  switch (props.overlay) {
    case 'none':
      return null;
    case 'slash':
      return props.slash !== undefined ? <UnifiedCommandPalette mode="slash" {...props.slash} /> : null;
    case 'model-picker':
      return props.modelPicker !== undefined ? <UnifiedCommandPalette mode="model" {...props.modelPicker} /> : null;
    case 'skill-picker':
      return props.skillPicker !== undefined ? <UnifiedCommandPalette mode="skills" {...props.skillPicker} /> : null;
    case 'session-picker':
      return props.sessionPicker !== undefined ? (
        <UnifiedCommandPalette mode="session" {...props.sessionPicker} />
      ) : null;
    case 'permission-mode':
      return props.permissionModePicker !== undefined ? (
        <UnifiedCommandPalette mode="permission-mode" {...props.permissionModePicker} />
      ) : null;
    case 'permission':
      return props.permission !== undefined ? <PermissionPrompt {...props.permission} /> : null;
    case 'help':
      // Static cheatsheet — no props to thread; render unconditionally.
      return <UnifiedCommandPalette mode="help" />;
  }
}
