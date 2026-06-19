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
 * Extract the inline argument text of a `/steer <text>` line. Unlike the other
 * single-word slash commands, `/steer` carries free-form guidance after the command
 * word. Returns the trimmed remainder, or null when there is no text (a bare `/steer`
 * is a no-op — nothing to inject). Exported so the extraction is unit-testable.
 *
 *   parseSteerArg('/steer go faster') → 'go faster'
 *   parseSteerArg('  /STEER  hi ')    → 'hi'
 *   parseSteerArg('/steer')           → null
 *   parseSteerArg('/steering wheel')  → null  (word-boundary: not the steer command)
 */
export function parseSteerArg(value: string): string | null {
  const m = /^\s*\/steer\b\s*(.*)$/i.exec(value);
  const rest = m?.[1]?.trim();
  return rest !== undefined && rest.length > 0 ? rest : null;
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
  { name: 'compact', description: 'Summarize & compact the session' },
  { name: 'steer', description: 'Inject mid-turn guidance (no restart)' },
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
    // Context-Compression: thread the configured window + tuning so auto-compaction
    // fires on estimated transcript pressure (and `/compact` honors the same budget).
    maxContext: deps.settings.maxContext,
    compactionThreshold: deps.settings.compactionThreshold,
    compactionKeepBudget: deps.settings.compactionKeepBudget,
    // Iteration budget: per-turn tool-call ceiling (runaway guard) for the raw-API loop.
    maxToolCalls: deps.settings.maxToolCalls,
  });

  // Seed the runtime permission mode from config ONCE so the status chip and the
  // palette selector reflect the configured value (reducer initialState hardcodes
  // 'default'). Additive: dispatches the additive set-permission-mode action.
  useEffect(() => {
    if (seededPermissionModeRef.current) {
      return;
    }
    seededPermissionModeRef.current = true;
    if (turn.state.permissionMode !== configuredPermissionMode) {
      turn.dispatch({ t: 'set-permission-mode', mode: configuredPermissionMode });
    }
  }, [configuredPermissionMode, turn]);

  // Mirror reducer state into the live permission policy so runtime mode flips
  // (the config-seed dispatch above AND the palette selector's
  // `acceptPermissionMode` dispatch) actually reach enforcement. State stays the
  // single source of truth; this effect is the ONLY writer to the policy mode.
  // `deps.policy` is the shared instance also handed to the subagent tool, so a
  // flip here propagates to subagents automatically.
  useEffect(() => {
    deps.policy.setMode(turn.state.permissionMode);
  }, [turn.state.permissionMode, deps.policy]);

  const status = selectStatusLine(turn.state, {
    model: selectedId,
    cwd: deps.settings.cwd,
    maxContext: deps.settings.maxContext,
    skills: deps.skills?.map((skill) => skill.name),
    permissionMode: turn.state.permissionMode,
    isCompacting: turn.isCompacting,
    // Surface the per-turn tool-call budget so the StatusLine can render the guard chip.
    toolBudget: { used: turn.toolCallsThisTurn, max: deps.settings.maxToolCalls },
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

  // When the slash overlay is open but the user has replaced the input with a
  // plain (non-slash) line, Enter must send THAT line exactly once — not fire the
  // highlighted command. `slashPlainSubmitRef` dedups against the InputBox's own
  // Enter→onSubmit so the SAME Enter does not double-fire (acceptSlash here + the
  // InputBox submit path) — see submit() below.
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
        case 'compact':
          void turn.compactNow();
          closeOverlay();
          break;
        case 'steer':
          // Palette selection carries no typed argument, so there is nothing to inject
          // here — this branch is for discoverability only. The real injection path is the
          // typed `/steer <text>` line, intercepted in `submit` below.
          closeOverlay();
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
  // line, send that line once instead of firing the highlighted command (the
  // Unit-5.1 follow-up edge case — no phantom default-highlighted command).
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
  //   - slash overlay open + plain non-slash line: send it once via the shared
  //     helper (deduped against acceptSlash's same-Enter dispatch).
  //   - overlay === 'slash' + `/`-line: just clear; acceptSlash (fired on the SAME
  //     Enter via useKeybinds) dispatches the command → one dispatch, no double-fire.
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

      // Dedup: acceptSlash already submitted this exact value on the same Enter.
      if (slashPlainSubmitRef.current === nextValue) {
        slashPlainSubmitRef.current = null;
        return;
      }

      // `/steer <text>` is the one slash command that carries an inline argument, so it
      // routes through `turn.steer` (mid-turn inject) instead of the generic command
      // dispatch — and is intercepted HERE so it NEVER leaks to `turn.submit`. A bare
      // `/steer` (no text) is a no-op. This runs even while the slash overlay is open
      // (acceptSlash only closes the overlay for `steer`; the injection happens here once).
      if (parseSlashCommand(nextValue) === 'steer') {
        setValue('');
        const arg = parseSteerArg(nextValue);
        if (arg !== null) {
          turn.steer(arg);
        }
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
