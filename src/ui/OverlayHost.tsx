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
import { McpPanel, type McpPanelProps } from './McpPanel';
import { ToolDetailOverlay, type ToolDetailOverlayProps } from './ToolDetailOverlay';
import {
  SubagentTranscriptOverlay,
  type SubagentTranscriptOverlayProps,
} from './SubagentTranscriptOverlay';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  skillPicker?: SkillPickerProps;
  sessionPicker?: SessionPickerProps;
  permissionModePicker?: PermissionModePickerProps;
  permission?: PermissionPromptProps;
  mcp?: McpPanelProps;
  toolDetail?: ToolDetailOverlayProps;
  /**
   * Full-height subagent-transcript overlay. Present ONLY in the 'subagents' overlay's
   * transcript sub-view; in the list sub-view the browse UI is the below-composer
   * `SubagentPanel`, so this host renders nothing (undefined ⇒ null).
   */
  subagentTranscript?: SubagentTranscriptOverlayProps;
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
    case 'mcp':
      // Read-only MCP status panel — its own component, NOT a palette mode.
      return props.mcp !== undefined ? <McpPanel {...props.mcp} /> : null;
    case 'tool-detail':
      // ctrl+o tool-call browser — its own component (list + detail views).
      return props.toolDetail !== undefined ? <ToolDetailOverlay {...props.toolDetail} /> : null;
    case 'subagents':
      // Subagent browser: the LIST view lives in the below-composer SubagentPanel, so
      // this host only paints the full-height TRANSCRIPT view (undefined in list view).
      return props.subagentTranscript !== undefined ? (
        <SubagentTranscriptOverlay {...props.subagentTranscript} />
      ) : null;
  }
}
