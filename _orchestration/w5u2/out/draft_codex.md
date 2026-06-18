### src/ui/UnifiedCommandPalette.tsx
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ModelEntry } from '../services/catalog';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface CommandPaletteEntry {
  readonly name: string;
  readonly description: string;
}

export interface SkillPaletteEntry {
  readonly name: string;
  readonly description: string;
}

export interface SlashPaletteProps {
  commands: Array<CommandPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
}

export interface SkillPickerProps {
  skills: ReadonlyArray<SkillPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export type PermissionModeOption = 'default' | 'acceptEdits';

export interface PermissionModePickerProps {
  selectedMode?: PermissionModeOption;
  depth?: ColorDepth;
}

export const PERMISSION_MODE_OPTIONS = [
  { mode: 'default', description: 'Prompt for edits' },
  { mode: 'acceptEdits', description: 'Accept edit tools' },
] as const satisfies ReadonlyArray<{ mode: PermissionModeOption; description: string }>;

export type UnifiedCommandPaletteProps =
  | ({ mode: 'slash' } & SlashPaletteProps)
  | ({ mode: 'model' } & ModelPickerProps)
  | ({ mode: 'skills' } & SkillPickerProps)
  | ({ mode: 'permission-mode' } & PermissionModePickerProps);

interface PaletteRow {
  readonly key: string;
  readonly primary: string;
  readonly secondary: string;
  readonly selected: boolean;
}

function frame(header: string, rows: ReadonlyArray<PaletteRow>, depth: ColorDepth): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', depth)} paddingLeft={1} paddingRight={1}>
      <Text color={token('textDim', depth)}>{header}</Text>
      {rows.map((row) => {
        const marker = row.selected ? '▸' : ' ';
        return (
          <Box key={row.key} gap={1}>
            <Text color={row.selected ? token('accent', depth) : token('textDim', depth)}>{marker}</Text>
            <Text color={row.selected ? token('accent', depth) : token('text', depth)} bold={row.selected}>
              {row.primary}
            </Text>
            <Text color={token('textDim', depth)}>{row.secondary}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function UnifiedCommandPalette(props: UnifiedCommandPaletteProps): ReactElement {
  const d = props.depth ?? DEPTH;

  switch (props.mode) {
    case 'slash':
      return frame(
        'commands',
        props.commands.map((command, index) => ({
          key: command.name,
          primary: `/${command.name}`,
          secondary: command.description,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
      );

    case 'model':
      return frame(
        'models',
        props.models.map((model) => ({
          key: model.id,
          primary: model.label,
          secondary: model.id,
          selected: model.id === props.selectedId,
        })),
        d,
      );

    case 'skills':
      return frame(
        'skills',
        props.skills.map((skill, index) => ({
          key: skill.name,
          primary: skill.name,
          secondary: skill.description,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
      );

    case 'permission-mode':
      return frame(
        'permission mode',
        PERMISSION_MODE_OPTIONS.map((option) => ({
          key: option.mode,
          primary: option.mode,
          secondary: option.description,
          selected: option.mode === (props.selectedMode ?? 'default'),
        })),
        d,
      );
  }
}
```

### src/ui/OverlayHost.tsx
```tsx
import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import {
  UnifiedCommandPalette,
  type ModelPickerProps,
  type PermissionModePickerProps,
  type SkillPickerProps,
  type SlashPaletteProps,
} from './UnifiedCommandPalette';
import { PermissionPrompt, type PermissionPromptProps } from './PermissionPrompt';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  skillPicker?: SkillPickerProps;
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
    case 'permission-mode':
      return props.permissionModePicker !== undefined ? (
        <UnifiedCommandPalette mode="permission-mode" {...props.permissionModePicker} />
      ) : null;
    case 'permission':
      return props.permission !== undefined ? <PermissionPrompt {...props.permission} /> : null;
  }
}
```

### src/app.tsx
```tsx
// src/app.tsx
// W6 — the root component. Wires useStreamingTurn + useKeybinds + useTerminalSize,
// owns ALL controlled UI state (value / selectedIndex / selectedId), routes
// overlays via OverlayHost, and renders the transcript / streaming / status /
// input chrome.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box } from 'ink';
import type { ModelClient, PermissionPolicy, Tool, ToolSpec } from './core/contracts';
import type { State } from './core/reducer';
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
  /** Discovered skills for the status line and command palette. */
  readonly skills?: ReadonlyArray<{ name: string; description: string }>;
}

export interface AppProps {
  readonly deps: AppDeps;
}

/** The InputBox placeholder. Exported so tests assert on the SOURCE value, not a
 * hardcoded literal (the product name is not finalized — keep them coupled). */
export const INPUT_PLACEHOLDER = 'Message Juno';

/**
 * Parse a slash command name from an input string. Returns the lowercased
 * command word (without the leading `/`) or null when the input does not start
 * with `/` followed by at least one command character. Exported so the parse is
 * unit-testable in isolation.
 *
 *   parseSlashCommand('/clear')      → 'clear'
 *   parseSlashCommand('  /EFFORT')   → 'effort'
 *   parseSlashCommand('/model x')    → 'model'
 *   parseSlashCommand('hi /clear')   → null
 *   parseSlashCommand('/')           → null
 */
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

export const slashCommands: ReadonlyArray<SlashCommand> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
  { name: 'skills', description: 'Choose a skill' },
  { name: 'permissions', description: 'Set permission mode' },
];

const PERMISSION_MODES: ReadonlyArray<State['permissionMode']> = ['default', 'acceptEdits'];

/** Resolve a parsed command name to its registry entry (undefined if unknown). */
function findSlashCommand(name: string | null): SlashCommand | undefined {
  if (name === null) {
    return undefined;
  }
  return slashCommands.find((command) => command.name === name);
}

export function App({ deps }: AppProps): ReactElement {
  const { columns } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const skills = useMemo(() => deps.skills ?? [], [deps.skills]);
  const initialModelId =
    deps.catalog.resolve(deps.settings.defaultModel)?.id ??
    deps.catalog.default()?.id ??
    deps.settings.defaultModel;

  const configuredPermissionMode = deps.settings.permissionMode ?? 'default';
  const seededPermissionModeRef = useRef(false);
  const slashPlainSubmitRef = useRef<string | null>(null);

  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [selectedPermissionMode, setSelectedPermissionMode] =
    useState<State['permissionMode']>(configuredPermissionMode);

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

  useEffect(() => {
    if (seededPermissionModeRef.current) {
      return;
    }
    seededPermissionModeRef.current = true;
    if (turn.state.permissionMode !== configuredPermissionMode) {
      turn.dispatch({ t: 'set-permission-mode', mode: configuredPermissionMode });
    }
  }, [configuredPermissionMode, turn]);

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: turn.state.permissionMode,
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

  const openSkillPicker = useCallback((): void => {
    setSelectedSkillIndex(0);
    turn.dispatch({ t: 'set-overlay', overlay: 'skill-picker' });
  }, [turn]);

  const openPermissionModePicker = useCallback((): void => {
    setSelectedPermissionMode(turn.state.permissionMode);
    turn.dispatch({ t: 'set-overlay', overlay: 'permission-mode' });
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

  const moveSkill = useCallback(
    (delta: number): void => {
      setSelectedSkillIndex((current) => {
        if (skills.length === 0) {
          return current;
        }
        return (current + delta + skills.length) % skills.length;
      });
    },
    [skills.length],
  );

  const movePermissionMode = useCallback((delta: number): void => {
    setSelectedPermissionMode((current) => {
      const currentIndex = Math.max(0, PERMISSION_MODES.indexOf(current));
      const nextIndex = (currentIndex + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length;
      return PERMISSION_MODES[nextIndex]!;
    });
  }, []);

  const submitPlainInputFromSlashOverlay = useCallback(
    (nextValue: string): void => {
      if (slashPlainSubmitRef.current === nextValue) {
        return;
      }

      slashPlainSubmitRef.current = nextValue;
      setTimeout(() => {
        if (slashPlainSubmitRef.current === nextValue) {
          slashPlainSubmitRef.current = null;
        }
      }, 0);

      closeOverlay();
      setValue('');
      void turn.submit(nextValue);
    },
    [closeOverlay, turn],
  );

  // Dispatch a resolved slash command to its already-wired target. Single source
  // of truth for slash dispatch — shared by acceptSlash (Enter while the overlay
  // is open) and submit() (a typed `/command` when the overlay is NOT 'slash').
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
        case 'skills':
          openSkillPicker();
          break;
        case 'permissions':
          openPermissionModePicker();
          break;
        default:
          closeOverlay();
          break;
      }
    },
    [closeOverlay, openModelPicker, openPermissionModePicker, openSkillPicker, turn],
  );

  // Prefer a typed `/command` (parsed from the input value) over the highlighted
  // index, so a typed `/effort` + Enter cycles exactly once. If the slash overlay
  // is still open but the user has replaced the input with a plain non-slash
  // line, send that line once instead of firing the highlighted command.
  const acceptSlash = useCallback((): void => {
    const parsedCommand = parseSlashCommand(value);
    const plainNonSlashInput = value.trim().length > 0 && !value.trimStart().startsWith('/');

    if (plainNonSlashInput && parsedCommand === null) {
      submitPlainInputFromSlashOverlay(value);
      return;
    }

    const typedCommand = findSlashCommand(parsedCommand);
    const command = typedCommand ?? slashCommands[selectedIndex];
    runSlashCommand(command);
  }, [runSlashCommand, selectedIndex, submitPlainInputFromSlashOverlay, value]);

  const acceptModel = useCallback((): void => {
    closeOverlay();
  }, [closeOverlay]);

  const acceptSkill = useCallback((): void => {
    const skill = skills[selectedSkillIndex];
    if (skill === undefined) {
      closeOverlay();
      return;
    }
    turn.dispatch({ t: 'skill-select', name: skill.name });
  }, [closeOverlay, selectedSkillIndex, skills, turn]);

  const acceptPermissionMode = useCallback((): void => {
    turn.dispatch({ t: 'set-permission-mode', mode: selectedPermissionMode });
    closeOverlay();
  }, [closeOverlay, selectedPermissionMode, turn]);

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    slashCommandCount: slashCommands.length,
    modelCount: models.length,
    skillCount: skills.length,
    permissionModeCount: PERMISSION_MODES.length,
    onAbort: turn.abort,
    onCycleEffort: () => turn.dispatch({ t: 'cycle-effort' }),
    onOpenSlash: openSlash,
    onOpenModelPicker: openModelPicker,
    onCloseOverlay: closeOverlay,
    onMoveSlash: moveSlash,
    onAcceptSlash: acceptSlash,
    onMoveModel: moveModel,
    onAcceptModel: acceptModel,
    onMoveSkill: moveSkill,
    onAcceptSkill: acceptSkill,
    onMovePermissionMode: movePermissionMode,
    onAcceptPermissionMode: acceptPermissionMode,
  });

  // The single guard against leaking `/` to the model. A leading-`/` line NEVER
  // reaches turn.submit():
  //   - overlay === 'slash': just clear; acceptSlash (fired on the SAME Enter via
  //     useKeybinds) dispatches the command → exactly one dispatch, no double-fire.
  //   - otherwise: parse + dispatch the typed `/command` ourselves; unknown → drop.
  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) {
        return;
      }

      const trimmed = nextValue.trimStart();
      if (turn.state.overlay === 'slash' && !trimmed.startsWith('/')) {
        submitPlainInputFromSlashOverlay(nextValue);
        return;
      }

      if (slashPlainSubmitRef.current === nextValue) {
        slashPlainSubmitRef.current = null;
        return;
      }

      if (trimmed.startsWith('/')) {
        setValue('');
        if (turn.state.overlay === 'slash') {
          return;
        }
        runSlashCommand(findSlashCommand(parseSlashCommand(nextValue)));
        return;
      }

      setValue('');
      void turn.submit(nextValue);
    },
    [runSlashCommand, submitPlainInputFromSlashOverlay, turn],
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
        skillPicker={
          effectiveOverlay === 'skill-picker'
            ? { skills, selectedIndex: selectedSkillIndex }
            : undefined
        }
        permissionModePicker={
          effectiveOverlay === 'permission-mode'
            ? { selectedMode: selectedPermissionMode }
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
      <StatusLine status={status} width={columns} />
      <InputBox value={value} onChange={setValue} onSubmit={submit} placeholder={INPUT_PLACEHOLDER} />
    </Box>
  );
}

export default App;
```

### src/hooks/useKeybinds.ts
```ts
// src/hooks/useKeybinds.ts
// W6 — scoped key handling via Ink's useInput. Pure-ish: takes callbacks +
// current overlay, registers a single useInput, returns nothing.
//
// IMPORTANT: when the permission overlay is open, this hook stays out of the way
// for everything EXCEPT Esc (abort) — PermissionPrompt owns its own y/a/d/!
// keys via its internal useInput.
import { useInput } from 'ink';
import type { State } from '../core/reducer';

export interface UseKeybindsOptions {
  readonly overlay: State['overlay'];
  readonly value: string;
  readonly slashCommandCount: number;
  readonly modelCount: number;
  readonly skillCount?: number;
  readonly permissionModeCount?: number;
  readonly onAbort: () => void;
  readonly onCycleEffort: () => void;
  readonly onOpenSlash: () => void;
  readonly onOpenModelPicker: () => void;
  readonly onCloseOverlay: () => void;
  readonly onMoveSlash: (delta: number) => void;
  readonly onAcceptSlash: () => void;
  readonly onMoveModel: (delta: number) => void;
  readonly onAcceptModel: () => void;
  readonly onMoveSkill?: (delta: number) => void;
  readonly onAcceptSkill?: () => void;
  readonly onMovePermissionMode?: (delta: number) => void;
  readonly onAcceptPermissionMode?: () => void;
}

export function useKeybinds(options: UseKeybindsOptions): void {
  useInput((input, key) => {
    if (key.escape) {
      // Esc aborts the turn when no dismissable overlay is up (or a permission
      // prompt is up — aborting drains it). Otherwise it closes the overlay.
      if (options.overlay === 'permission' || options.overlay === 'none') {
        options.onAbort();
        return;
      }
      options.onCloseOverlay();
      return;
    }

    // PermissionPrompt owns all other keys while it is open.
    if (options.overlay === 'permission') {
      return;
    }

    if (options.overlay === 'slash') {
      if (key.upArrow && options.slashCommandCount > 0) {
        options.onMoveSlash(-1);
        return;
      }
      if (key.downArrow && options.slashCommandCount > 0) {
        options.onMoveSlash(1);
        return;
      }
      if (key.return) {
        options.onAcceptSlash();
        return;
      }
      return;
    }

    if (options.overlay === 'model-picker') {
      if (key.upArrow && options.modelCount > 0) {
        options.onMoveModel(-1);
        return;
      }
      if (key.downArrow && options.modelCount > 0) {
        options.onMoveModel(1);
        return;
      }
      if (key.return) {
        options.onAcceptModel();
        return;
      }
      return;
    }

    if (options.overlay === 'skill-picker') {
      const skillCount = options.skillCount ?? 0;
      if (key.upArrow && skillCount > 0) {
        options.onMoveSkill?.(-1);
        return;
      }
      if (key.downArrow && skillCount > 0) {
        options.onMoveSkill?.(1);
        return;
      }
      if (key.return) {
        options.onAcceptSkill?.();
        return;
      }
      return;
    }

    if (options.overlay === 'permission-mode') {
      const permissionModeCount = options.permissionModeCount ?? 0;
      if (key.upArrow && permissionModeCount > 0) {
        options.onMovePermissionMode?.(-1);
        return;
      }
      if (key.downArrow && permissionModeCount > 0) {
        options.onMovePermissionMode?.(1);
        return;
      }
      if (key.return) {
        options.onAcceptPermissionMode?.();
        return;
      }
      return;
    }

    // overlay === 'none': global bindings.
    if (key.tab) {
      options.onCycleEffort();
      return;
    }

    if (input === '/' && options.value.length === 0) {
      options.onOpenSlash();
      return;
    }

    if (key.ctrl && input.toLowerCase() === 'm') {
      options.onOpenModelPicker();
    }
  });
}
```

### src/core/reducer.ts
```ts
// src/core/reducer.ts
// W3 — the single PURE reducer. Every other unit builds against State/Action/Msg.
//
// Purity contract: no I/O, no Date.now, no Math.random, never mutates its inputs.
// On a no-op it returns the SAME state reference (consumers may rely on `===`).
import type { PermissionDecision, RiskLevel, StopReason, ToolStatus } from './events';

export type Role = 'user' | 'assistant' | 'tool' | 'system';
export type PermissionMode = 'default' | 'acceptEdits';

/**
 * Append-only message blocks with stable, monotonic block ids derived from the
 * owning message id + append index (`<msgId>:block:<n>`). Never a render index,
 * never Math.random — so React keys stay stable across redraws.
 */
export type Block =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

/** A single tool call's accumulated state in the live `tools` map. */
export interface ToolState {
  status: ToolStatus;
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
  /**
   * Partial tool-arg JSON accumulated from `tool-call-delta` events while the
   * model streams arguments. The final, parsed `args` arrive on `tool-call`.
   */
  argsText?: string;
  /**
   * For a claude-cli subagent's tool call: the parent `Agent` tool_use id this
   * call was spawned under (`parent_tool_use_id` in the CLI stream). Drives
   * nested rendering — the renderer groups child cards beneath the parent whose
   * `toolCallId` equals this value. Absent for top-level (non-subagent) calls.
   */
  parentToolUseId?: string;
}

export interface Msg {
  id: string;
  role: Role;
  blocks: Block[];
  done: boolean;
  /**
   * Accumulated extended-thinking / reasoning text for this message, built from
   * `reasoning-delta` events. Kept off the block list (it renders separately,
   * collapsed by default). Absent until the first reasoning delta arrives.
   */
  reasoning?: string;
  /**
   * Frozen snapshot of every tool call this message references, set ONLY at
   * commit time (`assistant-done`) so the <Static> committed render path never
   * reads the live `tools` map.
   */
  toolSnapshot?: Record<string, ToolState>;
}

export interface State {
  committed: Msg[];                 // -> Ink <Static>, printed once, never redrawn
  live: Msg | null;                 // the current streaming assistant turn
  tools: Record<string, ToolState>;
  phase: 'idle' | 'streaming' | 'awaiting-permission' | 'running-tool' | 'error';
  overlay: 'none' | 'slash' | 'permission' | 'model-picker' | 'skill-picker' | 'permission-mode';
  effort: 'medium' | 'high' | 'xhigh';
  permissionMode: PermissionMode;
  tokens: { in: number; out: number };

  // --- W3-PROPOSED additions to the frozen shape (flagged in NOTES) ---
  /** The tool call the permission overlay is resolving; null when no prompt is open. */
  pendingPermissionToolCallId: string | null;
  /** Surfaced error text for `phase === 'error'`; null otherwise. */
  errorMessage: string | null;
}

/**
 * Action variants map 1:1 to AgentEvent variants, PLUS local UI actions
 * (`user-submit`, `set-effort`, `cycle-effort`, `set-overlay`, `clear`,
 * `skill-select`, `set-permission-mode`).
 */
export type Action =
  | { t: 'user-submit'; id: string; text: string }
  | { t: 'assistant-start'; id: string }
  | { t: 'text-delta'; id: string; delta: string }
  | { t: 'reasoning-delta'; id: string; delta: string }
  | { t: 'tool-call'; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }
  | { t: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | { t: 'tool-status'; toolCallId: string; status: ToolStatus; result?: unknown; error?: string }
  | { t: 'permission-open'; toolCallId: string; name: string; args: unknown; risk: RiskLevel }
  | { t: 'permission-resolved'; toolCallId: string; decision: PermissionDecision }
  | { t: 'assistant-done'; id: string; stopReason: StopReason }
  | { t: 'usage'; tokensIn: number; tokensOut: number }
  | { t: 'aborted'; reason?: string }
  | { t: 'set-effort'; effort: State['effort'] }
  | { t: 'cycle-effort' }
  | { t: 'set-overlay'; overlay: State['overlay'] }
  | { t: 'skill-select'; name: string }
  | { t: 'set-permission-mode'; mode: State['permissionMode'] }
  | { t: 'error'; message: string }
  | { t: 'clear' };

const EFFORT_ORDER: ReadonlyArray<State['effort']> = ['medium', 'high', 'xhigh'];

export function initialState(): State {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

/** PURE reducer. Never mutates inputs; returns a new State (or the same ref for no-ops). */
export function reducer(state: State, action: Action): State {
  switch (action.t) {
    case 'user-submit': {
      const msg: Msg = {
        id: action.id,
        role: 'user',
        blocks: [{ kind: 'text', id: blockId(action.id, 0), text: action.text }],
        done: true,
      };
      // tokens.in is populated by the provider's real `usage` event (W9). The old
      // input estimate here was a pre-W9 placeholder; keeping it double-counted
      // input (estimate + real usage). Removed — `user-submit` no longer touches tokens.
      return {
        ...state,
        committed: [...state.committed, msg],
      };
    }

    case 'assistant-start':
      return {
        ...state,
        live: { id: action.id, role: 'assistant', blocks: [], done: false },
        phase: 'streaming',
      };

    case 'text-delta': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      const blocks = live.blocks.slice();
      const last = blocks.at(-1);
      if (last?.kind === 'text') {
        // Keep the same block id; concatenate into the trailing text block.
        blocks[blocks.length - 1] = { ...last, text: last.text + action.delta };
      } else {
        // A tool block (or nothing) precedes — open a new text block.
        blocks.push({ kind: 'text', id: blockId(live.id, blocks.length), text: action.delta });
      }
      return { ...state, live: { ...live, blocks } };
    }

    case 'reasoning-delta': {
      const live = state.live;
      // No-op if no live msg / id mismatch — reasoning belongs to the live turn.
      if (live === null || live.id !== action.id) return state;
      return { ...state, live: { ...live, reasoning: (live.reasoning ?? '') + action.delta } };
    }

    case 'tool-call': {
      const tools: Record<string, ToolState> = {
        ...state.tools,
        [action.toolCallId]: {
          status: 'pending',
          name: action.name,
          args: action.args,
          ...(action.parentToolUseId !== undefined ? { parentToolUseId: action.parentToolUseId } : {}),
        },
      };
      const live = state.live;
      if (live === null) {
        // Defensive: still register the call so a later tool-status isn't dropped.
        return { ...state, tools };
      }
      const blocks = [
        ...live.blocks,
        { kind: 'tool' as const, id: blockId(live.id, live.blocks.length), toolCallId: action.toolCallId },
      ];
      return { ...state, tools, live: { ...live, blocks } };
    }

    case 'tool-call-delta': {
      const existing = state.tools[action.toolCallId];
      // Accumulate partial arg text onto the pending tool entry. If `tool-call`
      // has not registered the entry yet, open a pending one so deltas survive.
      const base: ToolState =
        existing ?? { status: 'pending', name: '', args: undefined };
      const updated: ToolState = { ...base, argsText: (base.argsText ?? '') + action.argsDelta };
      return { ...state, tools: { ...state.tools, [action.toolCallId]: updated } };
    }

    case 'tool-status': {
      const existing = state.tools[action.toolCallId];
      if (existing === undefined) return state;
      // Race guard: once 'error', a later non-error status must NOT clobber it.
      if (existing.status === 'error' && action.status !== 'error') return state;

      const updated: ToolState = {
        ...existing,
        status: action.status,
        ...(action.result !== undefined ? { result: action.result } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
      const tools = { ...state.tools, [action.toolCallId]: updated };

      let phase = state.phase;
      if (action.status === 'running') phase = 'running-tool';
      else if (action.status === 'result' || action.status === 'error') {
        phase = state.live !== null ? 'streaming' : 'idle';
      }
      return { ...state, tools, phase };
    }

    case 'permission-open': {
      // Defensive: ensure a tools entry exists (tool-call normally precedes).
      const tools: Record<string, ToolState> =
        state.tools[action.toolCallId] !== undefined
          ? state.tools
          : { ...state.tools, [action.toolCallId]: { status: 'pending', name: action.name, args: action.args } };
      return {
        ...state,
        tools,
        overlay: 'permission',
        phase: 'awaiting-permission',
        pendingPermissionToolCallId: action.toolCallId,
      };
    }

    case 'permission-resolved':
      // The decision's effect on tool execution is W7/W8's job; the reducer only
      // restores UI/phase. (Decision/toolCallId are intentionally not stored.)
      return {
        ...state,
        overlay: 'none',
        phase: state.live !== null ? 'streaming' : 'idle',
        pendingPermissionToolCallId: null,
      };

    case 'assistant-done': {
      const live = state.live;
      if (live === null || live.id !== action.id) return state;

      const toolSnapshot = snapshotTools(live, state.tools);
      const doneMsg: Msg = {
        ...live,
        done: true,
        ...(Object.keys(toolSnapshot).length > 0 ? { toolSnapshot } : {}),
      };
      return { ...state, committed: [...state.committed, doneMsg], live: null, phase: 'idle' };
    }

    case 'usage':
      return {
        ...state,
        tokens: { in: state.tokens.in + action.tokensIn, out: state.tokens.out + action.tokensOut },
      };

    case 'aborted':
      // Cancellation: drop the in-flight turn and any open permission prompt,
      // return to idle, but keep committed history and cumulative tokens.
      return {
        ...state,
        live: null,
        phase: 'idle',
        overlay: state.overlay === 'permission' ? 'none' : state.overlay,
        pendingPermissionToolCallId: null,
      };

    case 'set-effort':
      return { ...state, effort: action.effort };

    case 'cycle-effort': {
      const idx = EFFORT_ORDER.indexOf(state.effort);
      const next = EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length]!;
      return { ...state, effort: next };
    }

    case 'set-overlay':
      return { ...state, overlay: action.overlay, phase: phaseForOverlay(state, action.overlay) };

    case 'skill-select':
      return { ...state, overlay: 'none', phase: phaseForOverlay(state, 'none') };

    case 'set-permission-mode':
      return { ...state, permissionMode: action.mode };

    case 'error': {
      // PROPOSED: surface errors both as a committed system Msg (so <Static>
      // renders them for free) and on `errorMessage` (so the status line reads it).
      const id = `system-error-${state.committed.length}`;
      const msg: Msg = {
        id,
        role: 'system',
        blocks: [{ kind: 'text', id: blockId(id, 0), text: action.message }],
        done: true,
      };
      return {
        ...state,
        committed: [...state.committed, msg],
        phase: 'error',
        errorMessage: action.message,
      };
    }

    case 'clear':
      // Reset conversation/turn state; preserve user prefs (effort, permissionMode) and cumulative tokens.
      return { ...initialState(), effort: state.effort, permissionMode: state.permissionMode, tokens: state.tokens };
  }
}

/** Stable, monotonic-per-message block id. `n` is the append index. */
function blockId(msgId: string, blockIndex: number): string {
  return `${msgId}:block:${blockIndex + 1}`;
}

function snapshotTools(msg: Msg, tools: Record<string, ToolState>): Record<string, ToolState> {
  const snapshot: Record<string, ToolState> = {};
  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      const tool = tools[block.toolCallId];
      if (tool !== undefined) snapshot[block.toolCallId] = { ...tool };
    }
  }
  return snapshot;
}

function phaseForOverlay(state: State, overlay: State['overlay']): State['phase'] {
  if (state.phase === 'error') return 'error';
  if (overlay === 'permission') return 'awaiting-permission';
  if (state.phase === 'awaiting-permission') return state.live !== null ? 'streaming' : 'idle';
  return state.phase;
}
```

### tests/components.test.tsx
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../src/core/reducer';
import { selectStatusLine } from '../src/core/selectors';
import { EffortBadge } from '../src/ui/EffortBadge';
import { OverlayHost } from '../src/ui/OverlayHost';
import { PermissionPrompt, type PermissionRequest } from '../src/ui/PermissionPrompt';
import { StatusLine } from '../src/ui/StatusLine';
import { ToolCallCard } from '../src/ui/ToolCallCard';
import { Transcript } from '../src/ui/Transcript';

/**
 * ink-testing-library attaches `useInput`'s stdin listener on the first effect
 * flush (after raw-mode setup), so a key written synchronously right after
 * render() is dropped. Awaiting one macrotask tick lets the handler register.
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const userMsg: Msg = {
  id: 'u1',
  role: 'user',
  blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello juno' }],
  done: true,
};

const asstMsg: Msg = {
  id: 'a1',
  role: 'assistant',
  blocks: [{ kind: 'text', id: 'a1:block:1', text: 'hello human' }],
  done: true,
};

const resultTool: ToolState = {
  status: 'result',
  name: 'read_file',
  args: { path: 'a.ts' },
  result: { ok: true, lines: 3 },
};

const errorTool: ToolState = {
  status: 'error',
  name: 'write_file',
  args: { path: 'a.ts' },
  error: 'permission denied',
};

const runningTool: ToolState = {
  status: 'running',
  name: 'grep',
  args: { pattern: 'x' },
};

const baseState: State = {
  committed: [userMsg],
  live: null,
  tools: {},
  phase: 'idle',
  overlay: 'none',
  effort: 'medium',
  permissionMode: 'default',
  tokens: { in: 100, out: 50 },
  pendingPermissionToolCallId: null,
  errorMessage: null,
};

describe('Transcript', () => {
  it('renders committed messages text', () => {
    const { lastFrame } = render(<Transcript committed={[userMsg, asstMsg]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello juno');
    expect(frame).toContain('hello human');
  });
});

describe('ToolCallCard', () => {
  it('shows a result summary on result status', () => {
    const frame = render(<ToolCallCard tool={resultTool} />).lastFrame() ?? '';
    expect(frame).toContain('read_file');
    expect(frame).toContain('"ok":true');
    expect(frame).toContain('result');
  });

  it('shows the error on error status', () => {
    const frame = render(<ToolCallCard tool={errorTool} />).lastFrame() ?? '';
    expect(frame).toContain('write_file');
    expect(frame).toContain('permission denied');
    expect(frame).toContain('error');
  });

  it('different statuses produce different output', () => {
    const result = render(<ToolCallCard tool={resultTool} />).lastFrame() ?? '';
    const error = render(<ToolCallCard tool={errorTool} />).lastFrame() ?? '';
    const running = render(<ToolCallCard tool={runningTool} />).lastFrame() ?? '';
    expect(result).toContain('result');
    expect(error).toContain('error');
    expect(running).toContain('running');
    expect(result).not.toEqual(error);
    expect(running).not.toEqual(result);
  });
});

describe('EffortBadge', () => {
  it('renders the label for each effort level', () => {
    expect(render(<EffortBadge effort="medium" />).lastFrame() ?? '').toContain('MEDIUM');
    expect(render(<EffortBadge effort="high" />).lastFrame() ?? '').toContain('HIGH');
    expect(render(<EffortBadge effort="xhigh" />).lastFrame() ?? '').toContain('XHIGH');
  });
});

describe('StatusLine', () => {
  it('shows model, cwd, tokens and a context bar', () => {
    const status = selectStatusLine(baseState, { model: 'gpt-x', cwd: '/work', maxContext: 200 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('gpt-x');
    expect(frame).toContain('/work');
    expect(frame).toContain('tok:150');
    expect(frame).toContain('[');
    expect(frame).toContain(']');
  });

  it('keeps a stable line count when width shrinks (resize duplication regression)', () => {
    // Root cause: with no width constraint the gap'd chip row uses Ink's default
    // flex-wrap. When the terminal width shrinks below the chips' combined length,
    // the row wraps to MORE lines than the prior frame; Ink's log-update erases
    // the old (smaller) line count and leaves the extra wrapped lines as residue,
    // so the footer visually duplicates/accumulates. The fix threads `width` and
    // pins the rows to nowrap+truncate so line count is stable across widths.
    const status = selectStatusLine(baseState, {
      model: 'gpt-extremely-long-model-name-that-far-exceeds-any-narrow-width',
      cwd: '/workspaces/juno/a/very/deep/path/that/greatly/exceeds/the/status/width',
      maxContext: 200,
      skills: ['alpha', 'beta'],
      permissionMode: 'acceptEdits',
    });

    const narrow = render(<StatusLine status={status} width={20} />).lastFrame() ?? '';
    const wide = render(<StatusLine status={status} width={80} />).lastFrame() ?? '';

    // Line count must be identical regardless of width. Without nowrap/truncate
    // on the inner rows the width=20 constraint forces the chips to wrap to extra
    // lines, making narrow taller than wide and this assertion fail.
    expect(narrow.split('\n').length).toEqual(wide.split('\n').length);
    // Lock the absolute footer height (border + 2 content rows + border) so a
    // future change cannot make BOTH widths grow equally and still pass above.
    expect(narrow.split('\n').length).toEqual(4);
  });

  it('renders a skills chip with the count when skills are present (Wave 3)', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w', skills: ['alpha', 'beta'] });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('skills:2');
  });

  it('omits the skills chip when there are no skills', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('skills:');
  });
});

describe('PermissionPrompt', () => {
  it('renders the tool name and risk', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'rm -rf' },
      risk: 'dangerous',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('shell_exec');
    expect(frame).toContain('dangerous');
  });

  it('calls onDecision once with allow-once on "y"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'ls' },
      risk: 'risky',
    };
    const { stdin, lastFrame } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    expect(lastFrame() ?? '').toContain('risky');
    await tick();
    stdin.write('y');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  it('calls onDecision once with deny on "d"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't2',
      name: 'write_file',
      args: {},
      risk: 'safe',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await tick();
    stdin.write('d');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('deny');
  });

  it('calls onDecision once with dangerous-bypass on "!"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't4',
      name: 'shell_exec',
      args: { cmd: 'rm -rf /' },
      risk: 'dangerous',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await tick();
    stdin.write('!');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('dangerous-bypass');
  });

  it('calls onDecision once with always-allow-pattern on "a"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't5',
      name: 'write_file',
      args: { path: 'a.ts' },
      risk: 'risky',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await tick();
    stdin.write('a');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('always-allow-pattern');
  });

  it('does not fire onDecision twice', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't3',
      name: 'read_file',
      args: {},
      risk: 'safe',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await tick();
    stdin.write('y');
    stdin.write('d');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });
});

describe('OverlayHost', () => {
  it('returns null (empty frame) for none', () => {
    expect(render(<OverlayHost overlay="none" />).lastFrame() ?? '').toBe('');
  });

  it('renders the permission prompt for the permission overlay', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: {},
      risk: 'risky',
    };
    const frame =
      render(<OverlayHost overlay="permission" permission={{ request, onDecision: vi.fn() }} />).lastFrame() ?? '';
    expect(frame).toContain('shell_exec');
    expect(frame).toContain('risky');
  });

  it('renders the slash palette for the slash overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="slash"
          slash={{ commands: [{ name: 'model', description: 'switch model' }] }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('commands');
    expect(frame).toContain('/model');
    expect(frame).toContain('switch model');
  });

  it('renders the model picker for the model-picker overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="model-picker"
          modelPicker={{
            models: [{ id: 'gpt-x', provider: 'openai', label: 'GPT X', contextWindow: 200 }],
          }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('models');
    expect(frame).toContain('GPT X');
    expect(frame).toContain('gpt-x');
  });

  it('renders the skill picker for the skill-picker overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="skill-picker"
          skillPicker={{ skills: [{ name: 'review', description: 'Review code' }] }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('skills');
    expect(frame).toContain('review');
    expect(frame).toContain('Review code');
  });

  it('renders the permission mode picker for the permission-mode overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="permission-mode"
          permissionModePicker={{ selectedMode: 'acceptEdits' }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('permission mode');
    expect(frame).toContain('default');
    expect(frame).toContain('acceptEdits');
  });
});
```

### tests/reducer.test.ts
```ts
// tests/reducer.test.ts
// W3 — covers every reducer Action variant plus the tricky lifecycle paths.
import { describe, it, expect } from 'vitest';
import { reducer, initialState, type State, type Action } from '../src/core/reducer';
import { eventToAction, type AgentEvent } from '../src/core/events';
import type { TurnMessage } from '../src/core/contracts';

function step(state: State, action: Action): State {
  return reducer(state, action);
}

/** A streaming turn: one committed user msg + an open live assistant msg. */
function streamingState(): State {
  let s = initialState();
  s = step(s, { t: 'user-submit', id: 'u1', text: 'hello world' });
  s = step(s, { t: 'assistant-start', id: 'a1' });
  return s;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe('reducer — initialState', () => {
  it('has sane defaults', () => {
    expect(initialState()).toEqual({
      committed: [],
      live: null,
      tools: {},
      phase: 'idle',
      overlay: 'none',
      effort: 'medium',
      permissionMode: 'default',
      tokens: { in: 0, out: 0 },
      pendingPermissionToolCallId: null,
      errorMessage: null,
    });
  });
});

describe('reducer — user-submit', () => {
  it('commits a user msg with a single text block and does NOT touch tokens.in', () => {
    const s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'hello world' });
    expect(s.committed).toHaveLength(1);
    expect(s.committed[0]).toEqual({
      id: 'u1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello world' }],
      done: true,
    });
    // tokens.in is populated by the provider's real `usage` event, not estimated
    // here. The pre-W9 estimate was removed to stop double-counting input.
    expect(s.tokens.in).toBe(0);
  });

  it('input double-count regression: user-submit then a usage event yields the PROVIDER value, not estimate+value', () => {
    let s = step(initialState(), { t: 'user-submit', id: 'u1', text: 'a much longer prompt that would have estimated several tokens' });
    s = step(s, { t: 'usage', tokensIn: 42, tokensOut: 0 });
    // Exactly the provider value — no leftover estimate added on submit.
    expect(s.tokens.in).toBe(42);
  });
});

describe('reducer — assistant-start', () => {
  it('creates a fresh empty live assistant msg and sets streaming', () => {
    const s = step(initialState(), { t: 'assistant-start', id: 'a1' });
    expect(s.live).toEqual({ id: 'a1', role: 'assistant', blocks: [], done: false });
    expect(s.phase).toBe('streaming');
  });
});

describe('reducer — text-delta', () => {
  it('appends to the trailing text block keeping the same block id', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'foo ' });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'bar' });
    expect(s.live!.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'foo bar' }]);
  });

  it('creates a new text block when a tool block splits text', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'before' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'after' });
    expect(s.live!.blocks).toEqual([
      { kind: 'text', id: 'a1:block:1', text: 'before' },
      { kind: 'tool', id: 'a1:block:2', toolCallId: 'tc1' },
      { kind: 'text', id: 'a1:block:3', text: 'after' },
    ]);
  });

  it('ignores deltas with no live msg', () => {
    const s = initialState();
    expect(step(s, { t: 'text-delta', id: 'a1', delta: 'x' })).toBe(s);
  });

  it('ignores deltas with an id mismatch', () => {
    const s = streamingState();
    expect(step(s, { t: 'text-delta', id: 'other', delta: 'x' })).toBe(s);
  });
});

describe('reducer — tool-call', () => {
  it('creates a pending tools entry and pushes a tool block', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: { dir: '.' } });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'list_files', args: { dir: '.' } });
    expect(s.live!.blocks.at(-1)).toEqual({ kind: 'tool', id: 'a1:block:1', toolCallId: 'tc1' });
  });

  it('records the tool even when there is no live msg (no block pushed)', () => {
    const s = step(initialState(), { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: { path: 'x' } });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'read', args: { path: 'x' } });
    expect(s.live).toBeNull();
  });
});

describe('reducer — tool-status', () => {
  it('transitions pending→running→result and flips phase', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'running' });
    expect(s.tools['tc1'].status).toBe('running');
    expect(s.phase).toBe('running-tool');
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 42 });
    expect(s.tools['tc1']).toEqual({ status: 'result', name: 'n', args: {}, result: 42 });
    expect(s.phase).toBe('streaming');
  });

  it('returns to idle on terminal status when no live turn', () => {
    let s = step(initialState(), { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 });
    expect(s.phase).toBe('idle');
  });

  it('race guard: error is not clobbered by a late result', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'error', error: 'boom' });
    const errored = s;
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 'late' });
    expect(s).toBe(errored); // no-op, same ref
    expect(s.tools['tc1']).toEqual({ status: 'error', name: 'n', args: {}, error: 'boom' });
  });

  it('ignores status for an unknown toolCallId', () => {
    const s = streamingState();
    expect(step(s, { t: 'tool-status', toolCallId: 'nope', status: 'running' })).toBe(s);
  });
});

describe('reducer — permission-open / permission-resolved', () => {
  it('opens the permission overlay and awaits, then resolves back to streaming', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc2', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc2', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.overlay).toBe('permission');
    expect(s.phase).toBe('awaiting-permission');
    expect(s.pendingPermissionToolCallId).toBe('tc2');
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc2', decision: 'allow-once' });
    expect(s.overlay).toBe('none');
    expect(s.phase).toBe('streaming');
    expect(s.pendingPermissionToolCallId).toBeNull();
  });

  it('permission-open is defensive: registers a tools entry if tool-call did not precede', () => {
    let s = initialState();
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: { p: 1 }, risk: 'dangerous' });
    expect(s.tools['tc1']).toEqual({ status: 'pending', name: 'write_file', args: { p: 1 } });
  });

  it('permission-resolved without a live turn goes to idle', () => {
    let s = step(initialState(), { t: 'permission-open', toolCallId: 'tc1', name: 'n', args: {}, risk: 'risky' });
    s = step(s, { t: 'permission-resolved', toolCallId: 'tc1', decision: 'deny' });
    expect(s.phase).toBe('idle');
    expect(s.overlay).toBe('none');
  });
});

describe('reducer — assistant-done', () => {
  it('commits live with a correct toolSnapshot and clears live', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: {} });
    s = step(s, { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: ['a'] });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.live).toBeNull();
    expect(s.phase).toBe('idle');
    const last = s.committed.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.toolSnapshot).toEqual({
      tc1: { status: 'result', name: 'list_files', args: {}, result: ['a'] },
    });
  });

  it('omits toolSnapshot when the turn referenced no tools', () => {
    let s = streamingState();
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
    s = step(s, { t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(s.committed.at(-1)!.toolSnapshot).toBeUndefined();
  });

  it('no-op when no live msg or id mismatch', () => {
    const s = step(initialState(), { t: 'assistant-start', id: 'a1' });
    expect(step(s, { t: 'assistant-done', id: 'other', stopReason: 'end' })).toBe(s);
    const empty = initialState();
    expect(step(empty, { t: 'assistant-done', id: 'a1', stopReason: 'end' })).toBe(empty);
  });
});

describe('reducer — usage', () => {
  it('accumulates tokens', () => {
    let s = step(initialState(), { t: 'usage', tokensIn: 10, tokensOut: 5 });
    s = step(s, { t: 'usage', tokensIn: 3, tokensOut: 7 });
    expect(s.tokens).toEqual({ in: 13, out: 12 });
  });

  it('multi-turn: two sequential turns ACCUMULATE into the session total (not last-wins)', () => {
    // Guards against the fix turning session-cumulative accumulation into replacement.
    let s = initialState();
    // Turn 1
    s = step(s, { t: 'user-submit', id: 'u1', text: 'first prompt' });
    s = step(s, { t: 'usage', tokensIn: 100, tokensOut: 40 });
    // Turn 2
    s = step(s, { t: 'user-submit', id: 'u2', text: 'second prompt' });
    s = step(s, { t: 'usage', tokensIn: 30, tokensOut: 60 });
    expect(s.tokens).toEqual({ in: 130, out: 100 });
  });
});

describe('reducer — set-effort / cycle-effort', () => {
  it('set-effort sets the effort', () => {
    expect(step(initialState(), { t: 'set-effort', effort: 'high' }).effort).toBe('high');
  });

  it('cycle-effort cycles medium→high→xhigh→medium', () => {
    let s = initialState();
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('high');
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('xhigh');
    s = step(s, { t: 'cycle-effort' }); expect(s.effort).toBe('medium');
  });
});

describe('reducer — set-overlay', () => {
  it('sets a neutral overlay without disturbing phase', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    expect(s.overlay).toBe('slash');
    expect(s.phase).toBe('streaming');
  });

  it('opening the permission overlay awaits; clearing it restores phase', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'permission' });
    expect(s.phase).toBe('awaiting-permission');
    s = step(s, { t: 'set-overlay', overlay: 'none' });
    expect(s.phase).toBe('streaming');
  });
});

describe('reducer — local palette actions', () => {
  it('set-permission-mode sets permissionMode and leaves other fields untouched', () => {
    const before = step(streamingState(), { t: 'usage', tokensIn: 10, tokensOut: 5 });
    const after = step(before, { t: 'set-permission-mode', mode: 'acceptEdits' });

    expect(after).not.toBe(before);
    expect(after.permissionMode).toBe('acceptEdits');

    const { permissionMode: _beforeMode, ...beforeRest } = before;
    const { permissionMode: _afterMode, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });

  it('skill-select is handled and only closes the skill overlay', () => {
    let before = streamingState();
    before = step(before, { t: 'set-overlay', overlay: 'skill-picker' });
    const after = step(before, { t: 'skill-select', name: 'review' });

    expect(after).not.toBe(before);
    expect(after.overlay).toBe('none');

    const { overlay: _beforeOverlay, ...beforeRest } = before;
    const { overlay: _afterOverlay, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });
});

describe('reducer — error', () => {
  it('sets phase=error, commits a system msg, stores errorMessage', () => {
    const s = step(initialState(), { t: 'error', message: 'kaboom' });
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('kaboom');
    expect(s.committed.at(-1)).toEqual({
      id: 'system-error-0',
      role: 'system',
      blocks: [{ kind: 'text', id: 'system-error-0:block:1', text: 'kaboom' }],
      done: true,
    });
  });
});

describe('reducer — clear', () => {
  it('resets conversation/turn state but preserves effort and tokens', () => {
    let s = streamingState();
    s = step(s, { t: 'usage', tokensIn: 100, tokensOut: 50 });
    s = step(s, { t: 'set-effort', effort: 'high' });
    s = step(s, { t: 'error', message: 'x' });
    const cleared = step(s, { t: 'clear' });
    expect(cleared).toEqual({ ...initialState(), effort: 'high', tokens: s.tokens });
  });
});

describe('events — eventToAction', () => {
  it('maps every event variant 1:1', () => {
    expect(eventToAction({ type: 'assistant-start', id: 'a1' })).toEqual({ t: 'assistant-start', id: 'a1' });
    expect(eventToAction({ type: 'text-delta', id: 'a1', delta: 'x' })).toEqual({ t: 'text-delta', id: 'a1', delta: 'x' });
    expect(eventToAction({ type: 'reasoning-delta', id: 'a1', delta: 'r' }))
      .toEqual({ t: 'reasoning-delta', id: 'a1', delta: 'r' });
    expect(eventToAction({ type: 'tool-call', id: 'a1', toolCallId: 'tc', name: 'n', args: 1 }))
      .toEqual({ t: 'tool-call', toolCallId: 'tc', name: 'n', args: 1 });
    expect(eventToAction({ type: 'tool-call-delta', toolCallId: 'tc', argsDelta: '{"a"' }))
      .toEqual({ t: 'tool-call-delta', toolCallId: 'tc', argsDelta: '{"a"' });
    expect(eventToAction({ type: 'tool-status', toolCallId: 'tc', status: 'running' }))
      .toEqual({ t: 'tool-status', toolCallId: 'tc', status: 'running', result: undefined, error: undefined });
    expect(eventToAction({ type: 'permission-open', toolCallId: 'tc', name: 'n', args: 1, risk: 'risky' }))
      .toEqual({ t: 'permission-open', toolCallId: 'tc', name: 'n', args: 1, risk: 'risky' });
    expect(eventToAction({ type: 'permission-resolved', toolCallId: 'tc', decision: 'deny' }))
      .toEqual({ t: 'permission-resolved', toolCallId: 'tc', decision: 'deny' });
    expect(eventToAction({ type: 'assistant-done', id: 'a1', stopReason: 'end' }))
      .toEqual({ t: 'assistant-done', id: 'a1', stopReason: 'end' });
    expect(eventToAction({ type: 'usage', tokensIn: 1, tokensOut: 2 }))
      .toEqual({ t: 'usage', tokensIn: 1, tokensOut: 2 });
    expect(eventToAction({ type: 'aborted', reason: 'user' }))
      .toEqual({ t: 'aborted', reason: 'user' });
    expect(eventToAction({ type: 'error', message: 'e' })).toEqual({ t: 'error', message: 'e' });
  });
});

describe('reducer — reasoning-delta', () => {
  it('accumulates reasoning text on the live msg', () => {
    let s = streamingState();
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'Let me ' });
    s = step(s, { t: 'reasoning-delta', id: 'a1', delta: 'think.' });
    expect(s.live!.reasoning).toBe('Let me think.');
    // Reasoning lives off the block list; no blocks created.
    expect(s.live!.blocks).toEqual([]);
  });

  it('ignores reasoning with no live msg or id mismatch (no-op, same ref)', () => {
    const empty = initialState();
    expect(step(empty, { t: 'reasoning-delta', id: 'a1', delta: 'x' })).toBe(empty);
    const s = streamingState();
    expect(step(s, { t: 'reasoning-delta', id: 'other', delta: 'x' })).toBe(s);
  });
});

describe('reducer — tool-call-delta', () => {
  it('accumulates partial arg text onto a pending tool entry', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'list_files', args: undefined });
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '{"dir":' });
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '"."}' });
    expect(s.tools['tc1'].argsText).toBe('{"dir":"."}');
    expect(s.tools['tc1'].name).toBe('list_files');
  });

  it('opens a pending entry if a delta arrives before tool-call', () => {
    let s = streamingState();
    s = step(s, { t: 'tool-call-delta', toolCallId: 'tc9', argsDelta: '{"x"' });
    expect(s.tools['tc9']).toEqual({ status: 'pending', name: '', args: undefined, argsText: '{"x"' });
  });
});

describe('reducer — aborted', () => {
  it('drops live + pending permission, returns to idle, keeps committed + tokens', () => {
    let s = streamingState();
    s = step(s, { t: 'usage', tokensIn: 10, tokensOut: 5 });
    s = step(s, { t: 'text-delta', id: 'a1', delta: 'partial' });
    s = step(s, { t: 'tool-call', toolCallId: 'tc1', name: 'write_file', args: {} });
    s = step(s, { t: 'permission-open', toolCallId: 'tc1', name: 'write_file', args: {}, risk: 'risky' });
    expect(s.pendingPermissionToolCallId).toBe('tc1');

    const committedBefore = s.committed;
    s = step(s, { t: 'aborted', reason: 'user cancelled' });
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
    expect(s.overlay).toBe('none');
    expect(s.pendingPermissionToolCallId).toBeNull();
    expect(s.committed).toBe(committedBefore); // history preserved
    // user-submit no longer estimates input; tokens come only from the usage event.
    expect(s.tokens).toEqual({ in: 10, out: 5 });
  });

  it('accepts an aborted action without a reason', () => {
    const s = step(streamingState(), { t: 'aborted' });
    expect(s.phase).toBe('idle');
    expect(s.live).toBeNull();
  });

  it('leaves a non-permission overlay untouched', () => {
    let s = streamingState();
    s = step(s, { t: 'set-overlay', overlay: 'slash' });
    s = step(s, { t: 'aborted' });
    expect(s.overlay).toBe('slash');
  });
});

describe('reducer — assistant-done stopReason union', () => {
  it('accepts every StopReason variant', () => {
    const reasons = ['end', 'tool_use', 'max_tokens', 'abort', 'error'] as const;
    for (const stopReason of reasons) {
      let s = streamingState();
      s = step(s, { t: 'text-delta', id: 'a1', delta: 'hi' });
      s = step(s, { t: 'assistant-done', id: 'a1', stopReason });
      expect(s.live).toBeNull();
      expect(s.committed.at(-1)!.done).toBe(true);
    }
  });
});

describe('contracts — TurnMessage tool shape (type-level)', () => {
  it('admits system/user, assistant-with-toolCalls, and tool messages', () => {
    // Compile-time coverage: each branch of the TurnMessage union must type-check.
    const messages: TurnMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: 'calling tool',
        toolCalls: [{ toolCallId: 'tc1', name: 'list_files', args: { dir: '.' } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: '["a.txt","b.txt"]' },
    ];
    const toolMsg = messages[3]!;
    expect(toolMsg).toEqual({ role: 'tool', toolCallId: 'tc1', content: '["a.txt","b.txt"]' });
    // The tool result content is a string keyed back to the assistant's toolCall.
    if (toolMsg.role === 'tool') expect(toolMsg.toolCallId).toBe('tc1');
  });
});

describe('events — AgentEvent new variants are total', () => {
  it('reducer handles every new event end-to-end via eventToAction', () => {
    const events: AgentEvent[] = [
      { type: 'assistant-start', id: 'a1' },
      { type: 'reasoning-delta', id: 'a1', delta: 'hm' },
      { type: 'tool-call-delta', toolCallId: 'tc1', argsDelta: '{}' },
      { type: 'aborted', reason: 'stop' },
    ];
    let s = initialState();
    for (const e of events) s = reducer(s, eventToAction(e));
    expect(s.phase).toBe('idle'); // aborted last
  });
});

describe('reducer — purity / immutability', () => {
  it('never mutates the input state across a full lifecycle', () => {
    let s = initialState();
    const actions: Action[] = [
      { t: 'user-submit', id: 'u1', text: 'hi' },
      { t: 'assistant-start', id: 'a1' },
      { t: 'text-delta', id: 'a1', delta: 'x' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'n', args: {} },
      { t: 'tool-status', toolCallId: 'tc1', status: 'running' },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 },
      { t: 'assistant-done', id: 'a1', stopReason: 'end' },
      { t: 'usage', tokensIn: 1, tokensOut: 1 },
      { t: 'cycle-effort' },
      { t: 'set-overlay', overlay: 'skill-picker' },
      { t: 'skill-select', name: 'alpha' },
      { t: 'set-permission-mode', mode: 'acceptEdits' },
      { t: 'clear' },
    ];
    for (const a of actions) {
      const snapshot = JSON.parse(JSON.stringify(s)) as State;
      const next = step(s, a);
      expect(JSON.parse(JSON.stringify(s))).toEqual(snapshot); // input unchanged
      if (JSON.stringify(next) !== JSON.stringify(s)) {
        expect(next).not.toBe(s); // new ref when state changed
      }
      s = next;
    }
  });

  it('works with a deep-frozen input without throwing', () => {
    const frozen = deepFreeze(step(initialState(), { t: 'assistant-start', id: 'a1' }));
    const next = step(frozen, { t: 'text-delta', id: 'a1', delta: 'hello' });
    expect(next).not.toBe(frozen);
    expect(frozen.live!.blocks).toEqual([]);
    expect(next.live!.blocks).toEqual([{ kind: 'text', id: 'a1:block:1', text: 'hello' }]);
  });
});
```

### tests/tools.test.ts
```ts
// tests/tools.test.ts
// W7 — file tools + executor suite. Deterministic: real fs only inside a per-test
// mkdtemp workspace, cleaned in afterEach. No network, no clock, no randomness.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PermissionPolicy,
  Tool,
  ToolCtx,
  ToolResult,
} from '../src/core/contracts';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import { createToolExecutor, type ToolExecutorDeps } from '../src/tools/executor';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';

// --- helpers ------------------------------------------------------------------

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'juno-tools-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A minimal, real Readonly<State> for ToolCtx — no `any`, no unsafe cast. */
function fakeState(): Readonly<State> {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermissionToolCallId: null,
    errorMessage: null,
  };
}

function getTool(name: string): Tool {
  const tool = createDefaultTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function createCtx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    state: fakeState(),
  };
}

function statusEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool-status' }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> => event.type === 'tool-status',
  );
}

function eventTags(events: AgentEvent[]): string[] {
  return events.map((e) => (e.type === 'tool-status' ? `tool-status:${e.status}` : e.type));
}

// --- file tools ---------------------------------------------------------------

describe('file tools', () => {
  it('write_file then read_file round-trips (nested path) and reports bytesWritten', async () => {
    const cwd = await makeWorkspace();
    const content = 'hello\nworld\n';

    const writeResult = await getTool('write_file').run(
      { path: 'notes/a.txt', content },
      createCtx(cwd),
    );
    expect(writeResult).toEqual({
      ok: true,
      data: { path: 'notes/a.txt', bytesWritten: Buffer.byteLength(content, 'utf8') },
    });

    const readResult = await getTool('read_file').run({ path: 'notes/a.txt' }, createCtx(cwd));
    expect(readResult).toEqual({ ok: true, data: { path: 'notes/a.txt', content } });
  });

  it('list_files returns sorted entries (files + dirs)', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'z.txt'), 'z', 'utf8');
    await writeFile(path.join(cwd, 'a.txt'), 'a', 'utf8');
    await writeFile(path.join(cwd, 'm.txt'), 'm', 'utf8');
    await mkdir(path.join(cwd, 'sub'));

    const result = await getTool('list_files').run({}, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { dir: '.', entries: ['a.txt', 'm.txt', 'sub', 'z.txt'] },
    });
  });

  it('grep finds known lines with correct line numbers, sorted by file then line', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'alpha.txt'), 'first\nneedle here\nthird\n', 'utf8');
    await writeFile(path.join(cwd, 'beta.txt'), 'needle\nnone\nneedle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [
          { file: 'alpha.txt', line: 2, text: 'needle here' },
          { file: 'beta.txt', line: 1, text: 'needle' },
          { file: 'beta.txt', line: 3, text: 'needle' },
        ],
      },
    });
  });

  it('grep honours a simple * glob on the filename', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'keep.md'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, 'skip.txt'), 'needle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle', glob: '*.md' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'keep.md', line: 1, text: 'needle' }] },
    });
  });

  it('grep skips node_modules and dot-directories', async () => {
    const cwd = await makeWorkspace();
    await mkdir(path.join(cwd, 'node_modules'));
    await mkdir(path.join(cwd, '.git'));
    await writeFile(path.join(cwd, 'node_modules', 'x.txt'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, '.git', 'y.txt'), 'needle\n', 'utf8');
    await writeFile(path.join(cwd, 'top.txt'), 'needle\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'needle' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'top.txt', line: 1, text: 'needle' }] },
    });
  });

  it('grep default path is literal substring: a pathological regex pattern does not hang', async () => {
    const cwd = await makeWorkspace();
    // A line that triggers catastrophic backtracking if `(a+)+$` were a regex.
    await writeFile(path.join(cwd, 'evil.txt'), `${'a'.repeat(40)}\nliteral (a+)$ here\n`, 'utf8');

    const start = process.hrtime.bigint();
    const result = await getTool('grep').run({ pattern: '(a+)+$' }, createCtx(cwd));
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Treated as a literal substring `(a+)+$` — not present in the file → 0 matches.
    expect(result).toEqual({ ok: true, data: { matches: [] } });
    // The ReDoS proof: completes promptly instead of taking ~70s.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('grep matches a literal regex-looking substring by default (no regex flag)', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'lit.txt'), 'has (a+)+$ inside\nplain\n', 'utf8');

    const result = await getTool('grep').run({ pattern: '(a+)+$' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'lit.txt', line: 1, text: 'has (a+)+$ inside' }] },
    });
  });

  it('grep opt-in regex: pattern is compiled when regex:true', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'rx.txt'), 'aaa\nbbb\na\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'a+', regex: true }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: {
        matches: [
          { file: 'rx.txt', line: 1, text: 'aaa' },
          { file: 'rx.txt', line: 3, text: 'a' },
        ],
      },
    });
  });

  it('grep default treats regex metachars literally: "a.c" matches "a.c" not "abc"', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'dot.txt'), 'a.c\nabc\n', 'utf8');

    const result = await getTool('grep').run({ pattern: 'a.c' }, createCtx(cwd));
    expect(result).toEqual({
      ok: true,
      data: { matches: [{ file: 'dot.txt', line: 1, text: 'a.c' }] },
    });
  });

  it('edit_file replaceAll replaces and reports count', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'red', newString: 'green', replaceAll: true },
      createCtx(cwd),
    );
    expect(result).toEqual({ ok: true, data: { path: 'edit.txt', replacements: 2 } });
    await expect(readFile(path.join(cwd, 'edit.txt'), 'utf8')).resolves.toBe('green blue green');
  });

  it('edit_file replaces only the first occurrence by default', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'foo bar foo', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'foo', newString: 'qux' },
      createCtx(cwd),
    );
    expect(result).toEqual({ ok: true, data: { path: 'edit.txt', replacements: 1 } });
    await expect(readFile(path.join(cwd, 'edit.txt'), 'utf8')).resolves.toBe('qux bar foo');
  });

  it('edit_file fails when oldString is missing', async () => {
    const cwd = await makeWorkspace();
    await writeFile(path.join(cwd, 'edit.txt'), 'red blue red', 'utf8');

    const result = await getTool('edit_file').run(
      { path: 'edit.txt', oldString: 'purple', newString: 'green' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('oldString');
  });

  it('jail: rejects a relative path that escapes the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run({ path: '../outside' }, createCtx(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: rejects an absolute path outside the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run(
      { path: path.join(tmpdir(), 'definitely-outside.txt') },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('jail: write_file cannot escape the workspace', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('write_file').run(
      { path: '../escapee.txt', content: 'nope' },
      createCtx(cwd),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('escape');
  });

  it('returns invalid args on bad input', async () => {
    const cwd = await makeWorkspace();
    const result = await getTool('read_file').run({ notpath: 1 }, createCtx(cwd));
    expect(result).toEqual({ ok: false, error: 'invalid args' });
  });

  it('registry exposes 5 tools and matching specs', () => {
    const tools = createDefaultTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['edit_file', 'grep', 'list_files', 'read_file', 'write_file'],
    );
    expect(BUILTIN_TOOL_SPECS.map((s) => s.name).sort()).toEqual(
      ['edit_file', 'grep', 'list_files', 'read_file', 'write_file'],
    );
    // risk levels pinned by the seam
    expect(getTool('read_file').risk).toBe('safe');
    expect(getTool('list_files').risk).toBe('safe');
    expect(getTool('grep').risk).toBe('safe');
    expect(getTool('write_file').risk).toBe('risky');
    expect(getTool('edit_file').risk).toBe('risky');
  });
});

// --- executor -----------------------------------------------------------------

class FakePolicy implements PermissionPolicy {
  public constructor(private readonly decision: 'auto-allow' | 'auto-deny' | 'prompt') {}
  public evaluate(): 'auto-allow' | 'auto-deny' | 'prompt' {
    return this.decision;
  }
  public remember(): void {
    return undefined;
  }
}

function makeDeps(opts: {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  awaitPermission?: (toolCallId: string) => Promise<PermissionDecision>;
  signal?: AbortSignal;
}): ToolExecutorDeps {
  return {
    tools: opts.tools,
    policy: opts.policy,
    cwd: process.cwd(),
    signal: opts.signal ?? new AbortController().signal,
    getState: () => fakeState(),
    awaitPermission: opts.awaitPermission ?? (async (): Promise<PermissionDecision> => 'allow-once'),
  };
}

describe('tool executor', () => {
  it('auto-allows safe tools: emits running then result, no permission-open', async () => {
    const tool: Tool = {
      name: 'safe_tool',
      risk: 'safe',
      spec: { name: 'safe_tool', description: 'safe', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: { value: 1 } }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-1', 'safe_tool', { x: 1 }, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-1', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-1', status: 'result', result: { value: 1 } },
    ]);
  });

  it('prompts for risky tools and proceeds after allow-once', async () => {
    const tool: Tool = {
      name: 'risky_tool',
      risk: 'risky',
      spec: { name: 'risky_tool', description: 'risky', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data: 'done' }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('prompt'), awaitPermission: async () => 'allow-once' }),
    );

    await executor.execute('call-2', 'risky_tool', { path: 'x' }, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-2', name: 'risky_tool', args: { path: 'x' }, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'running' },
      { type: 'tool-status', toolCallId: 'call-2', status: 'result', result: 'done' },
    ]);
  });

  it('auto-deny: terminal error, run NOT called', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'blocked_tool',
      risk: 'risky',
      spec: { name: 'blocked_tool', description: 'blocked', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-deny') }));

    await executor.execute('call-3', 'blocked_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(statusEvents(events)).toEqual([
      { type: 'tool-status', toolCallId: 'call-3', status: 'error', error: 'denied by policy' },
    ]);
  });

  it('permission deny: terminal error, run NOT called', async () => {
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'prompted_tool',
      risk: 'risky',
      spec: { name: 'prompted_tool', description: 'prompted', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('prompt'), awaitPermission: async () => 'deny' }),
    );

    await executor.execute('call-4', 'prompted_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(eventTags(events)).toEqual(['permission-open', 'tool-status:error']);
    expect(events).toEqual([
      { type: 'permission-open', toolCallId: 'call-4', name: 'prompted_tool', args: {}, risk: 'risky' },
      { type: 'tool-status', toolCallId: 'call-4', status: 'error', error: 'denied' },
    ]);
  });

  it('unknown tool name: terminal error', async () => {
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-5', 'missing_tool', {}, (event) => events.push(event));

    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-5', status: 'error', error: 'unknown tool: missing_tool' },
    ]);
  });

  it('aborted before run: terminal error, run NOT called', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn<(args: unknown, ctx: ToolCtx) => Promise<ToolResult>>();
    const tool: Tool = {
      name: 'safe_tool',
      risk: 'safe',
      spec: { name: 'safe_tool', description: 'safe', inputSchema: {} },
      run,
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), signal: controller.signal }),
    );

    await executor.execute('call-6', 'safe_tool', {}, (event) => events.push(event));

    expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'tool-status', toolCallId: 'call-6', status: 'error', error: 'aborted' },
    ]);
  });

  it('surfaces a throwing tool as a terminal error (does not crash)', async () => {
    const tool: Tool = {
      name: 'throwing_tool',
      risk: 'safe',
      spec: { name: 'throwing_tool', description: 'throws', inputSchema: {} },
      run: async (): Promise<ToolResult> => {
        throw new Error('boom');
      },
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow') }));

    await executor.execute('call-7', 'throwing_tool', {}, (event) => events.push(event));

    expect(eventTags(events)).toEqual(['tool-status:running', 'tool-status:error']);
    const err = statusEvents(events).at(-1);
    expect(err?.error).toContain('boom');
  });
});
```

### tests/unifiedPalette.test.tsx
```tsx
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, slashCommands } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { UnifiedCommandPalette } from '../src/ui/UnifiedCommandPalette';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
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
const DOWN = '\u001B[B';
const ENTER = '\r';

const TEST_SKILLS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'review', description: 'Review code changes' },
  { name: 'docs', description: 'Draft documentation' },
];

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient, settingsOverrides: Partial<Settings> = {}): AppDeps {
  const config = createFakeConfigService(fakeSettings(settingsOverrides));
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
    skills: TEST_SKILLS,
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
      // eslint-disable-next-line @typescript-eslint/no-empty-function
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

function changeCaptured(value: string): void {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  props.onChange(value);
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('UnifiedCommandPalette', () => {
  it('renders the slash surface with commands, descriptions and a selected marker', () => {
    const commands = slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
    }));

    const frame =
      render(<UnifiedCommandPalette mode="slash" commands={[...commands]} selectedIndex={1} depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('commands');
    expect(frame).toContain('▸');
    for (const command of commands) {
      expect(frame).toContain(`/${command.name}`);
      expect(frame).toContain(command.description);
    }
  });

  it('renders the model surface with labels and ids', () => {
    const models = createModelCatalog(BUILTIN_MODELS).list();

    const frame =
      render(<UnifiedCommandPalette mode="model" models={models} selectedId={models[0]?.id} depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('models');
    for (const model of models) {
      expect(frame).toContain(model.label);
      expect(frame).toContain(model.id);
    }
  });

  it('renders the skills surface from deps.skills-shaped entries', () => {
    const { client } = createRecordingClient();
    const skills = fakeDeps(client).skills ?? [];

    const frame =
      render(<UnifiedCommandPalette mode="skills" skills={skills} selectedIndex={0} depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('skills');
    expect(frame).toContain('▸');
    for (const skill of skills) {
      expect(frame).toContain(skill.name);
      expect(frame).toContain(skill.description);
    }
  });

  it('renders the permission-mode surface with both modes and an active marker', () => {
    const frame =
      render(<UnifiedCommandPalette mode="permission-mode" selectedMode="acceptEdits" depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('permission mode');
    expect(frame).toContain('default');
    expect(frame).toContain('acceptEdits');
    expect(frame).toContain('▸');
  });
});

describe('App slash overlay Enter routing', () => {
  it('does not fire the highlighted command when slash overlay input becomes a plain line', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await act(async () => {
      submitCaptured('seed transcript');
      await tick();
    });

    expect(requests).toHaveLength(1);
    expect(lastFrame() ?? '').toContain('seed transcript');

    await tick();

    await act(async () => {
      stdin.write('/');
      await tick();
    });
    expect(lastFrame() ?? '').toContain('commands');

    await act(async () => {
      changeCaptured('hello from slash overlay');
      await tick();
    });

    // Pre-fix this went red: useKeybinds routed Enter to acceptSlash, which
    // accepted highlighted clear(index 0). With the mocked InputBox, the plain
    // line was not sent at all, and the seeded transcript was cleared.
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toBe('hello from slash overlay');

    const frame = lastFrame() ?? '';
    expect(frame).toContain('seed transcript');
    expect(frame).toContain('hello from slash overlay');

    unmount();
  });

  it('still lets Enter choose the highlighted model command when slash input is empty', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await tick();

    await act(async () => {
      stdin.write('/');
      await tick();
    });
    expect(lastFrame() ?? '').toContain('commands');

    await act(async () => {
      stdin.write(DOWN);
      await tick();
    });

    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('models');
    expect(frame).toContain(BUILTIN_MODELS[0]!.label);
    expect(frame).toContain(BUILTIN_MODELS[0]!.id);

    unmount();
  });
});
```

### DELETE: src/ui/SlashPalette.tsx
Folded into `src/ui/UnifiedCommandPalette.tsx`; keeping this file would leave a duplicate command surface.

### DELETE: src/ui/ModelPicker.tsx
Folded into `src/ui/UnifiedCommandPalette.tsx`; keeping this file would leave a duplicate command surface.

Who-touched-what:
- `UnifiedCommandPalette.tsx`: new shared renderer for slash, model, skills, and permission-mode surfaces.
- `OverlayHost.tsx`, `app.tsx`, `useKeybinds.ts`: route all overlays through the unified palette and add keyboard wiring.
- `reducer.ts`: additive overlay/action/state support for skills and runtime permission mode.
- Tests: add palette coverage, reducer coverage, and the slash Enter regression; update existing `State` literals for `permissionMode`.