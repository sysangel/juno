// Capability-driven command hints for the Observatory. The footer is part of the
// interaction contract: if an action cannot do anything in the current state it
// must not be advertised, and urgent lifecycle actions must survive narrow widths
// ahead of secondary navigation hints.
import type { WorkspaceFocus, WorkspaceKeyHint, WorkspacePane } from './types';

export interface WorkspaceActionCapabilities {
  readonly steer?: boolean;
  readonly cancel?: boolean;
  readonly resolvePermission?: boolean;
}

export interface WorkspaceKeyHintsOptions {
  readonly messageMode: boolean;
  readonly wide: boolean;
  readonly narrowPane: WorkspacePane;
  readonly focus: WorkspaceFocus;
  readonly agentCount: number;
  readonly capabilities?: WorkspaceActionCapabilities;
}

/**
 * Return only live bindings, ordered by consequence: escape route, selected-agent
 * lifecycle actions, local navigation, then the secondary focus switch.
 */
export function workspaceKeyHints(options: WorkspaceKeyHintsOptions): WorkspaceKeyHint[] {
  if (options.messageMode) {
    return [
      { key: 'enter', action: 'send' },
      { key: 'esc', action: 'cancel' },
    ];
  }

  const hints: WorkspaceKeyHint[] = [
    {
      key: 'esc',
      action: !options.wide && options.narrowPane === 'stream' ? 'back' : 'chat',
    },
  ];
  if (options.agentCount <= 0) return hints;

  if (options.capabilities?.resolvePermission === true) {
    hints.push({ key: 'g/d', action: 'allow/deny' });
  }
  if (options.capabilities?.steer === true) hints.push({ key: 'm', action: 'steer' });
  if (options.capabilities?.cancel === true) hints.push({ key: 'x', action: 'cancel' });

  hints.push({ key: '↑↓', action: options.focus === 'stream' ? 'scroll' : 'agent' });
  if (options.focus === 'stream') {
    hints.push({ key: 'pgup/dn', action: 'page' });
  } else {
    hints.push({ key: 'enter', action: 'stream' });
  }
  hints.push({ key: 'tab', action: 'focus' });
  return hints;
}
