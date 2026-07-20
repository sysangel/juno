/**
 * Canonical user-facing keybinding catalogue. Runtime handlers stay in their owning
 * components/hooks, while every surface that advertises a binding derives from this
 * list. `tests/keybindingConsistency.test.tsx` executes the global bindings and guards
 * owner coverage for the component-owned bindings.
 */
export const KEYBINDINGS = [
  { id: 'escape', key: 'Esc', description: 'Abort turn (including permission) / close overlay', owner: 'useKeybinds' },
  { id: 'exit', key: 'Ctrl+C', description: 'Abort turn / press twice to exit', owner: 'useCtrlCExit' },
  { id: 'effort', key: 'Tab', description: 'Cycle effort level', owner: 'useKeybinds' },
  { id: 'commands', key: '/', description: 'Open the command palette (empty input)', owner: 'useKeybinds' },
  { id: 'help', key: '?', description: 'Show this help (empty input)', owner: 'useKeybinds' },
  { id: 'agents', key: '↓', description: 'Focus agents when history is at newest', owner: 'Composer' },
  { id: 'tools', key: 'Ctrl+O', description: 'Open the tool-call detail overlay', owner: 'useKeybinds' },
  { id: 'picker', key: '↑ ↓ Enter', description: 'Navigate / accept in pickers', owner: 'useKeybinds' },
  { id: 'permission', key: 'y a d !', description: 'Permission prompt: once / always / deny / bypass', owner: 'PermissionPrompt' },
  { id: 'line-edge', key: 'Ctrl+A / Ctrl+E', description: 'Move to line start / end', owner: 'Composer' },
  { id: 'delete', key: 'Ctrl+W / Ctrl+U / Ctrl+K', description: 'Delete word / line before / line after', owner: 'Composer' },
  { id: 'word', key: 'Alt+B / Alt+F', description: 'Move one word left / right', owner: 'Composer' },
] as const satisfies ReadonlyArray<{
  id: string;
  key: string;
  description: string;
  owner: 'useKeybinds' | 'useCtrlCExit' | 'PermissionPrompt' | 'Composer';
}>;

export type KeybindingId = (typeof KEYBINDINGS)[number]['id'];
