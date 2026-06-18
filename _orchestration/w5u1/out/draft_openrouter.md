Summary: Rewrote `submit()` to block `/`-prefixed input from reaching `turn.submit()`, dispatching known commands locally or deferring to `acceptSlash` when the slash overlay is open. Updated `acceptSlash()` to prefer the typed command (parsed from `value`) over the highlighted index, ensuring single dispatch on Enter. Added `parseSlashCommand` helper in `src/utils/slash.ts` and a new test asserting the no-leak invariant.

`src/utils/slash.ts`
```ts
/**
 * Parse a slash command name from an input string.
 * Returns the lowercased command word (without the leading `/`) or null
 * if the input does not start with `/` followed by at least one letter.
 *
 *   parseSlashCommand("/clear")       → "clear"
 *   parseSlashCommand("  /MODEL")     → "model"
 *   parseSlashCommand("/clear args")  → "clear"
 *   parseSlashCommand("hello")        → null
 *   parseSlashCommand("/")            → null
 */
export function parseSlashCommand(value: string): string | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  const match = /^[a-zA-Z]+/.exec(rest);
  return match ? match[0].toLowerCase() : null;
}
```

`src/app.tsx`
```tsx
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from './hooks/useTerminalSize';
import { useKeybinds } from './hooks/useKeybinds';
import { InputBox } from './components/InputBox';
import { useTurn } from './hooks/useTurn';
import { parseSlashCommand } from './utils/slash';
import type { AppProps } from './types';

const slashCommands: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
];

export function App({ deps }: AppProps): ReactElement {
  const { columns } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const initialModelId = useMemo(() => models[0]?.id ?? '', [models]);

  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);

  const turn = useTurn(deps);

  const closeOverlay = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'none' });
  }, [turn]);

  const openSlash = useCallback((): void => {
    setSelectedIndex(0);
    turn.dispatch({ t: 'set-overlay', overlay: 'slash' });
  }, [turn]);

  const openModelPicker = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'model-picker' });
  }, [turn]);

  const moveSlash = useCallback((delta: number): void => {
    setSelectedIndex((current) => {
      if (slashCommands.length === 0) return current;
      return (current + delta + slashCommands.length) % slashCommands.length;
    });
  }, []);

  const acceptSlash = useCallback((): void => {
    const typedName = parseSlashCommand(value);
    const command =
      (typedName !== null
        ? slashCommands.find((c) => c.name === typedName)
        : undefined) ?? slashCommands[selectedIndex];
    if (command === undefined) {
      closeOverlay();
      return;
    }
    switch (command.name) {
      case 'clear':
        turn.dispatch({ t: 'clear' });
        closeOverlay();
        break;
      case 'model':
        openModelPicker();
        break;
      case 'effort':
        turn.dispatch({ t: 'cycle-effort' });
        closeOverlay();
        break;
      default:
        closeOverlay();
        break;
    }
  }, [closeOverlay, openModelPicker, selectedIndex, turn, value]);

  const moveModel = useCallback(
    (delta: number): void => {
      setSelectedIndex((current) => {
        if (models.length === 0) return current;
        return (current + delta + models.length) % models.length;
      });
    },
    [models.length],
  );

  const acceptModel = useCallback((): void => {
    const model = models[selectedIndex];
    if (model === undefined) {
      closeOverlay();
      return;
    }
    setSelectedId(model.id);
    closeOverlay();
  }, [closeOverlay, models, selectedIndex]);

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    slashCommandCount: slashCommands.length,
    modelCount: models.length,
    onAbort: turn.abort,
    onCycleEffort: () => turn.dispatch({ t: 'cycle-effort' }),
    onOpenSlash: openSlash,
    onOpenModelPicker: openModelPicker,
    onCloseOverlay: closeOverlay,
    onMoveSlash: moveSlash,
    onAcceptSlash: acceptSlash,
    onMoveModel: moveModel,
    onAcceptModel: acceptModel,
  });

  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) return;
      const trimmed = nextValue.trimStart();
      if (trimmed.startsWith('/')) {
        setValue('');
        // When the slash overlay is open, acceptSlash (via useKeybinds) handles
        // dispatch.  We only clear the input here to avoid double-dispatch.
        if (turn.state.overlay === 'slash') {
          return;
        }
        // Overlay is not 'slash' — parse and dispatch the command ourselves.
        const name = parseSlashCommand(trimmed);
        switch (name) {
          case 'clear':
            turn.dispatch({ t: 'clear' });
            closeOverlay();
            break;
          case 'model':
            openModelPicker();
            break;
          case 'effort':
            turn.dispatch({ t: 'cycle-effort' });
            closeOverlay();
            break;
          default:
            // Unknown command — just clear the input, never send to model.
            closeOverlay();
            break;
        }
        return;
      }
      setValue('');
      void turn.submit(nextValue);
    },
    [closeOverlay, openModelPicker, turn],
  );

  return (
    <Box flexDirection="column" width={columns}>
      {turn.state.overlay === 'slash' && (
        <Box flexDirection="column" marginTop={1}>
          {slashCommands.map((cmd, i) => (
            <Text key={cmd.name} inverse={i === selectedIndex}>
              /{cmd.name} — {cmd.description}
            </Text>
          ))}
        </Box>
      )}
      <InputBox value={value} onChange={setValue} onSubmit={submit} />
    </Box>
  );
}
```

`tests/slashIntercept.test.tsx`
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import * as React from 'react';
import { parseSlashCommand } from '../src/utils/slash';
import { App } from '../src/app';

async function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('parseSlashCommand', () => {
  it('extracts the lowercased command word', () => {
    expect(parseSlashCommand('/clear')).toBe('clear');
    expect(parseSlashCommand('/MODEL')).toBe('model');
    expect(parseSlashCommand('/Effort')).toBe('effort');
    expect(parseSlashCommand('  /clear')).toBe('clear');
    expect(parseSlashCommand('/clear extra args')).toBe('clear');
  });

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('  ')).toBeNull();
  });

  it('returns null for bare slash or non-letter commands', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/ ')).toBeNull();
    expect(parseSlashCommand('/123')).toBeNull();
  });
});

describe('slash submit interception', () => {
  it('never calls the model client for /-prefixed input', async () => {
    const turnSpy = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'response' }],
    });

    const deps = {
      catalog: {
        list: () => [{ id: 'm1', name: 'Model 1' }],
      },
      client: {
        turn: turnSpy,
      },
      config: {
        get: vi.fn((k: string) => {
          if (k === 'model') return 'm1';
          if (k === 'effort') return 'medium';
          return undefined;
        }),
        set: vi.fn(),
      },
    };

    const { stdin } = render(<App deps={deps} />);
    await tick();

    // Normal input reaches the model client.
    stdin.write('hello\r');
    await tick();
    const baseline = turnSpy.mock.calls.length;
    expect(baseline).toBeGreaterThan(0);

    // Slash-prefixed input must NOT reach the model client.
    stdin.write('/clear\r');
    await tick();
    expect(turnSpy.mock.calls.length).toBe(baseline);

    // Unknown slash command also must not leak.
    stdin.write('/unknown\r');
    await tick();
    expect(turnSpy.mock.calls.length).toBe(baseline);

    // Normal input still works after slash commands.
    stdin.write('world\r');
    await tick();
    expect(turnSpy.mock.calls.length).toBe(baseline + 1);
  });
});
```
