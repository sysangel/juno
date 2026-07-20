import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { useKeybinds, type UseKeybindsOptions } from '../src/hooks/useKeybinds';
import { KEYBINDINGS } from '../src/ui/keybindingMetadata';
import { HELP_KEYBINDS } from '../src/ui/UnifiedCommandPalette';
import { PermissionPrompt } from '../src/ui/PermissionPrompt';
import { flushInk, press } from './helpers/ink';

function callbacks(): UseKeybindsOptions {
  return {
    overlay: 'none', value: '', slashCommandCount: 2, modelCount: 0,
    onAbort: vi.fn(), onCycleEffort: vi.fn(), onOpenSlash: vi.fn(), onOpenHelp: vi.fn(),
    onCloseOverlay: vi.fn(), onMoveSlash: vi.fn(), onAcceptSlash: vi.fn(),
    onMoveModel: vi.fn(), onAcceptModel: vi.fn(), onOpenToolDetail: vi.fn(),
  };
}

function Harness({ options }: { options: UseKeybindsOptions }): null {
  useKeybinds(options);
  return null;
}

describe('canonical keybinding metadata', () => {
  it('is the help overlay source of truth with unique ids and keys', () => {
    expect(HELP_KEYBINDS).toBe(KEYBINDINGS);
    expect(new Set(KEYBINDINGS.map((binding) => binding.id)).size).toBe(KEYBINDINGS.length);
    expect(new Set(KEYBINDINGS.map((binding) => binding.key)).size).toBe(KEYBINDINGS.length);
    expect(KEYBINDINGS.map((binding) => String(binding.key))).not.toContain('Ctrl+M');
  });

  it.each([
    ['escape', '\u001b', 'onAbort'],
    ['effort', '\t', 'onCycleEffort'],
    ['commands', '/', 'onOpenSlash'],
    ['help', '?', 'onOpenHelp'],
    ['tools', '\u000f', 'onOpenToolDetail'],
  ] as const)('executes advertised global binding %s', async (_id, input, callback) => {
    const options = callbacks();
    const view = render(<Harness options={options} />);
    await flushInk();
    await press(view.stdin, input);
    expect(options[callback]).toHaveBeenCalledTimes(1);
  });

  it('executes advertised picker navigation and acceptance', async () => {
    const options = { ...callbacks(), overlay: 'slash' as const };
    const view = render(<Harness options={options} />);
    await flushInk();
    await press(view.stdin, '\u001b[B');
    await press(view.stdin, '\r');
    expect(options.onMoveSlash).toHaveBeenCalledWith(1);
    expect(options.onAcceptSlash).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['y', 'allow-once'], ['a', 'always-allow-pattern'], ['d', 'deny'], ['!', 'dangerous-bypass'],
  ] as const)('executes advertised permission binding %s', async (key, decision) => {
    const onDecision = vi.fn();
    const view = render(<PermissionPrompt request={{ toolCallId: 't', name: 'write_file', args: { path: 'x' }, risk: 'risky' }} onDecision={onDecision} />);
    await flushInk();
    await press(view.stdin, key);
    expect(onDecision).toHaveBeenCalledWith(decision);
  });
});
