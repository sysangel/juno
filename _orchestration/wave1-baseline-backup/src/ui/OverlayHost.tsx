import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import { SlashPalette, type SlashPaletteProps } from './SlashPalette';
import { ModelPicker, type ModelPickerProps } from './ModelPicker';
import { PermissionPrompt, type PermissionPromptProps } from './PermissionPrompt';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  permission?: PermissionPromptProps;
}

export function OverlayHost(props: OverlayHostProps): ReactElement | null {
  switch (props.overlay) {
    case 'none':
      return null;
    case 'slash':
      return props.slash !== undefined ? <SlashPalette {...props.slash} /> : null;
    case 'model-picker':
      return props.modelPicker !== undefined ? <ModelPicker {...props.modelPicker} /> : null;
    case 'permission':
      return props.permission !== undefined ? <PermissionPrompt {...props.permission} /> : null;
  }
}
