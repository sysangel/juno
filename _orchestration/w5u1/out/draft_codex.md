Implemented slash parsing and local dispatch in `src/app.tsx`.
`submit()` now clears and blocks all leading-`/` input from `turn.submit()`.
Added deterministic slash interception tests with a mocked `InputBox`.

`src/app.tsx`
```tsx
// src/app.tsx
// W6 — the root component. Wires useStreamingTurn + useKeybinds + useTerminalSize,
// owns ALL controlled UI state (value / selectedIndex / selectedId), routes
// overlays via OverlayHost, and renders the transcript / streaming / status /
// input chrome.
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Box } from 'ink';
import type { ModelClient, PermissionPolicy, Tool, ToolSpec } from './core/contracts';
import { selectStatusLine } from './core/selectors';
import type { Settings } from './services/config';
import type { ModelCatalog, ModelEntry } from './services/catalog';
import { BUILTIN_TOOL_SPECS } from './tools/registry';
import { Transcript } from './ui/Transcript';
import { StreamingMessage } from './ui/StreamingMessage';
import { StatusLine } from './ui/StatusLine';
import { InputBox } from './ui/InputBox';
import { OverlayHost } from './ui/OverlayHost';
import { useKeybinds } from './hooks/useKeybinds';
import { useStreamingTurn } from './hooks/useStreamingTurn';
import { useTerminalSize } from './hooks/useTerminalSize';

export interface AppDeps {
  /**
   * Build a ModelClient for the SELECTED catalog entry. Replaces the old
   * build-once-at-startup `client`: each entry can belong to a different
   * provider, so the client must be (re)built from the chosen entry's provider
   * — otherwise a foreign slug would be sent to the startup provider's endpoint
   * (cross-provider 404/401/400). cli.ts closes over provider config / env /
   * fetch; App only hands it the entry.
   */
  readonly createClient: (entry: ModelEntry) => ModelClient;
  readonly tools: ReadonlyArray<Tool>;
  readonly policy: PermissionPolicy;
  readonly catalog: ModelCatalog;
  readonly settings: Settings;
  readonly specs?: ReadonlyArray<ToolSpec>;
  /**
   * Skills system prompt (names + descriptions, progressive disclosure). Applied
   * to raw-API backends only — the claude-cli backend auto-discovers skills
   * NATIVELY, so App suppresses this for it to avoid a double-load.
   */
  readonly systemPrompt?: string;
  /** Discovered skills (render-only indicator in the status line). */
  readonly skills?: ReadonlyArray<{ name: string; description: string }>;
}

export interface AppProps {
  readonly deps: AppDeps;
}

/** The InputBox placeholder. Exported so tests assert on the SOURCE value, not a
 * hardcoded literal (the product name is not finalized — keep them coupled). */
export const INPUT_PLACEHOLDER = 'Message Juno';

export function parseSlashCommand(value: string): string | null {
  const match = /^\/([A-Za-z0-9_-]+)/.exec(value.trimStart());
  const command = match?.[1];
  return command === undefined ? null : command.toLowerCase();
}

/**
 * The skills system prompt is for the RAW-API backends only. The claude-cli
 * backend auto-discovers skills natively AND folds systemPrompt into its prompt
 * (claudeCliClient.buildPrompt), so applying it there double-loads. Suppress it
 * for that provider. Exported + named so the load-bearing invariant is testable
 * (a regression that inverts the provider check or drops the gate goes red).
 */
export function systemPromptForProvider(
  provider: string | undefined,
  systemPrompt: string | undefined,
): string | undefined {
  return provider === 'claude-cli' ? undefined : systemPrompt;
}

interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

const slashCommands: ReadonlyArray<SlashCommand> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
];

function findSlashCommand(name: string | null): SlashCommand | undefined {
  if (name === null) {
    return undefined;
  }
  return slashCommands.find((command) => command.name === name);
}

export function App({ deps }: AppProps): ReactElement {
  const { columns } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const initialModelId =
    deps.catalog.resolve(deps.settings.defaultModel)?.id ??
    deps.catalog.default()?.id ??
    deps.settings.defaultModel;

  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);

  // Resolve the selected entry once: drives both client construction and the
  // backend-aware systemPrompt gate below.
  const selectedEntry = useMemo(
    () => deps.catalog.resolve(selectedId) ?? deps.catalog.default(),
    [deps.catalog, selectedId],
  );

  // Build the client from the SELECTED entry's provider. Rebuilds whenever the
  // picker changes selectedId, so the next turn dispatches against the correct
  // provider endpoint (fixes the build-once cross-provider bug).
  const client = useMemo<ModelClient>(() => {
    if (selectedEntry === undefined) {
      throw new Error(`no catalog entry for "${selectedId}"`);
    }
    return deps.createClient(selectedEntry);
  }, [deps, selectedEntry, selectedId]);

  // The claude-cli (subscription) backend auto-discovers skills natively, so do
  // NOT also inject juno's skills system prompt there (it folds systemPrompt into
  // the CLI prompt → double-load). Apply it only on the raw-API secondaries.
  const systemPromptForTurn = systemPromptForProvider(selectedEntry?.provider, deps.systemPrompt);

  const turn = useStreamingTurn({
    client,
    tools: deps.tools,
    policy: deps.policy,
    specs: deps.specs ?? BUILTIN_TOOL_SPECS,
    cwd: deps.settings.cwd,
    model: selectedId,
    systemPrompt: systemPromptForTurn,
  });

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: deps.settings.permissionMode,
  });

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
      if (slashCommands.length === 0) {
        return current;
      }
      return (current + delta + slashCommands.length) % slashCommands.length;
    });
  }, []);

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
        const nextIndex = (currentIndex + delta + models.length) % models.length;
        return models[nextIndex]!.id;
      });
    },
    [models],
  );

  const runSlashCommand = useCallback(
    (command: SlashCommand | undefined): void => {
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
    },
    [closeOverlay, openModelPicker, turn],
  );

  const acceptSlash = useCallback((): void => {
    const typedCommand = findSlashCommand(parseSlashCommand(value));
    const command = typedCommand ?? slashCommands[selectedIndex];
    runSlashCommand(command);
  }, [runSlashCommand, selectedIndex, value]);

  const acceptModel = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

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
      if (nextValue.trim().length === 0) {
        return;
      }

      const trimmed = nextValue.trimStart();
      if (trimmed.startsWith('/')) {
        setValue('');
        if (turn.state.overlay === 'slash') {
          return;
        }

        const command = findSlashCommand(parseSlashCommand(nextValue));
        if (command !== undefined) {
          runSlashCommand(command);
        }
        return;
      }

      setValue('');
      void turn.submit(nextValue);
    },
    [runSlashCommand, turn],
  );

  const permissionRequest = turn.permissionRequest;
  // Guard: if the reducer says overlay is 'permission' but we have no request to
  // render (race), fall back to 'none' so OverlayHost doesn't get an undefined prop.
  const effectiveOverlay =
    turn.state.overlay === 'permission' && permissionRequest === null
      ? 'none'
      : turn.state.overlay;

  return (
    <Box flexDirection="column" width={columns}>
      <Transcript committed={turn.state.committed} />
      <StreamingMessage live={turn.state.live} />
      <OverlayHost
        overlay={effectiveOverlay}
        slash={
          effectiveOverlay === 'slash'
            ? { commands: [...slashCommands], selectedIndex }
            : undefined
        }
        modelPicker={
          effectiveOverlay === 'model-picker'
            ? { models, selectedId }
            : undefined
        }
        permission={
          effectiveOverlay === 'permission' && permissionRequest !== null
            ? {
                request: permissionRequest,
                onDecision: (decision) => {
                  turn.resolvePermission(permissionRequest.toolCallId, decision);
                },
              }
            : undefined
        }
      />
      <StatusLine status={status} />
      <InputBox value={value} onChange={setValue} onSubmit={submit} placeholder={INPUT_PLACEHOLDER} />
    </Box>
  );
}

export default App;
```

`tests/slashIntercept.test.tsx`
```tsx
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, parseSlashCommand } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
  readonly depth?: unknown;
}

const inputBoxMock = vi.hoisted(() => ({
  latestProps: null as CapturedInputBoxProps | null,
}));

vi.mock('../src/ui/InputBox', () => ({
  InputBox: (props: CapturedInputBoxProps) => {
    inputBoxMock.latestProps = props;
    return <Text>mock-input</Text>;
  },
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
}

function createRecordingClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn(
      input: TurnInput,
      _tools: ToolSpec[],
      _signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      requests.push(input);
      return (async function* emptyStream(): AsyncGenerator<AgentEvent, void, unknown> {})();
    },
  };
  return { client, requests };
}

function submitCaptured(value: string): void {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  props.onSubmit(value);
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('parseSlashCommand', () => {
  it('returns a lowercased command name from leading slash input', () => {
    expect(parseSlashCommand('/clear')).toBe('clear');
    expect(parseSlashCommand('/EFFORT')).toBe('effort');
    expect(parseSlashCommand('  /model extra')).toBe('model');
  });

  it('returns null when there is no leading slash command word', () => {
    expect(parseSlashCommand('hello /clear')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('App slash interception', () => {
  it('never sends leading slash input to the model client, but still sends normal input', async () => {
    const { client, requests } = createRecordingClient();
    const { unmount } = render(<App deps={fakeDeps(client)} />);

    await act(async () => {
      submitCaptured('/clear');
      await tick();
    });

    expect(requests).toHaveLength(0);

    await act(async () => {
      submitCaptured('hello');
      await tick();
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)?.content).toBe('hello');

    unmount();
  });
});
```