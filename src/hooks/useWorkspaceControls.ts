import { useInput } from 'ink';
import type { WorkspaceFocus, WorkspacePane } from '../ui/workspace';

export interface WorkspaceControlsOptions {
  readonly active: boolean;
  readonly messageMode: boolean;
  readonly wide: boolean;
  readonly focus: WorkspaceFocus;
  readonly narrowPane: WorkspacePane;
  readonly agentCount: number;
  readonly onMoveAgent: (delta: number) => void;
  readonly onScrollStream: (deltaRows: number) => void;
  readonly onSetFocus: (focus: WorkspaceFocus) => void;
  readonly onSetNarrowPane: (pane: WorkspacePane) => void;
  readonly onClose: () => void;
  readonly onCancelMessage: () => void;
  readonly onMessage: () => void;
  readonly onCancelAgent: () => void;
  readonly onResolvePermission: (decision: 'allow-once' | 'deny') => void;
}

/** Keyboard ownership for the alternate-screen Observatory surface. */
export function useWorkspaceControls(options: WorkspaceControlsOptions): void {
  useInput((input, key) => {
    if (options.messageMode) {
      if (key.escape) options.onCancelMessage();
      return;
    }
    if (key.escape) {
      if (!options.wide && options.narrowPane === 'stream') {
        options.onSetNarrowPane('orbit');
        options.onSetFocus('orbit');
      } else {
        options.onClose();
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (options.focus === 'stream') {
        options.onScrollStream(key.upArrow ? 1 : -1);
      } else if (options.agentCount > 0) {
        options.onMoveAgent(key.upArrow ? -1 : 1);
      }
      return;
    }
    if (key.pageUp || key.pageDown) {
      if (options.agentCount > 0) {
        options.onSetFocus('stream');
        if (!options.wide) options.onSetNarrowPane('stream');
        options.onScrollStream(key.pageUp ? 5 : -5);
      }
      return;
    }
    if (key.tab) {
      if (options.agentCount <= 0) return;
      const next = options.focus === 'orbit' ? 'stream' : 'orbit';
      options.onSetFocus(next);
      if (!options.wide) options.onSetNarrowPane(next);
      return;
    }
    if (key.leftArrow) {
      if (options.agentCount <= 0) return;
      options.onSetFocus('orbit');
      if (!options.wide) options.onSetNarrowPane('orbit');
      return;
    }
    if (key.rightArrow || key.return) {
      if (options.agentCount > 0) {
        options.onSetFocus('stream');
        if (!options.wide) options.onSetNarrowPane('stream');
      }
      return;
    }
    if (options.agentCount <= 0) return;
    if (input === 'm') options.onMessage();
    else if (input === 'x') options.onCancelAgent();
    else if (input === 'g') options.onResolvePermission('allow-once');
    else if (input === 'd') options.onResolvePermission('deny');
  }, { isActive: options.active });
}
