// src/app.tsx
// W6 — the root component. Wires useStreamingTurn + useKeybinds + useTerminalSize,
// owns ALL controlled UI state (value / selectedIndex / selectedId), routes
// overlays via OverlayHost, and renders the transcript / streaming / status /
// input chrome.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ModelClient, PermissionPolicy, Tool, ToolSpec } from './core/contracts';
import type { State, ToolState } from './core/reducer';
import { selectActivity, type ActivityState } from './core/selectors';
import type { Settings, McpServerConfig } from './services/config';
import type { ModelCatalog, ModelEntry } from './services/catalog';
import type { McpManager } from './services/mcpManager';
import type { SessionStore } from './services/sessions';
import type { SubagentRecorder } from './services/subagentRecorder';
import { BUILTIN_TOOL_SPECS } from './tools/registry';
import { Transcript } from './ui/Transcript';
import { StreamingMessage } from './ui/StreamingMessage';
import { MessageSeparator } from './ui/MessageSeparator';
import { providerKindOf } from './ui/providerKind';
import { StatusLine } from './ui/StatusLine';
import { LiveTurn } from './ui/LiveTurn';
import { Banner } from './ui/Banner';
import { InputBox, ComposerRule } from './ui/InputBox';
import { OverlayHost } from './ui/OverlayHost';
import { SubagentPanel } from './ui/SubagentPanel';
import { computeLiveBudget } from './ui/liveBudget';
import { useKeybinds } from './hooks/useKeybinds';
import { useCompletionBell } from './hooks/useCompletionBell';
import { useCtrlCExit } from './hooks/useCtrlCExit';
import { useInputHistory } from './hooks/useInputHistory';
import { useMcpLifecycle } from './hooks/useMcpLifecycle';
import { PERMISSION_MODES, usePickerControls } from './hooks/usePickerControls';
import { generateSessionId, useSessionResume } from './hooks/useSessionResume';
import { useStatusModel } from './hooks/useStatusModel';
import { useStreamingTurn } from './hooks/useStreamingTurn';
import { useSubagentPanel } from './hooks/useSubagentPanel';
import { useSubmitRouting } from './hooks/useSubmitRouting';
import { useToolDetailOverlay } from './hooks/useToolDetailOverlay';
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
  /**
   * Ambient brain recall (Phase 2): raw prompt text in, matched-memory context
   * block out (or `undefined`). Built by cli.ts ONLY when `brain.enabled` AND
   * `brain.ambientRecall` are set; absent ⇒ the feature is off and the turn
   * hook never calls out. Must be fail-soft and internally time-bounded.
   */
  readonly ambientRecall?: (prompt: string) => Promise<string | undefined>;
  /**
   * Optional session persistence store. When present, committed turns are saved
   * (best-effort) and `/resume` lists + hydrates past sessions. OPTIONAL so
   * existing deps-builders (and back-compat callers) that omit it still compile.
   */
  readonly sessionStore?: SessionStore;
  /**
   * Per-subagent transcript recorder factory (Wave 7). Given the active session
   * id, builds a recorder that persists each subagent's tool activity to
   * `<sessionId>.subagents/<toolUseId>.jsonl`. OPTIONAL so back-compat callers /
   * tests that omit it still compile (and never touch the filesystem); cli.ts
   * wires the real fs-backed factory. Rebound whenever the active session changes.
   */
  readonly createSubagentRecorder?: (sessionId: string) => SubagentRecorder;
  /**
   * Reader for the durable per-subagent JSONL (Wave 7, the READ side of
   * `createSubagentRecorder`). Given a session id, reconstructs the settled subagents
   * recorded under `<sessionId>.subagents/` into a live-shaped `tools` map. OPTIONAL so
   * back-compat callers / tests that omit it still compile (and never touch the
   * filesystem); cli.ts wires the real fs-backed reader. App loads it on session
   * load/resume and merges it UNDER the live `tools` so a RESUMED session (whose live
   * map is empty) still surfaces its on-disk subagents in the below-composer agents panel
   * — without it, a resumed session's `▾ agents` strip would be empty.
   */
  readonly readSubagentTranscripts?: (sessionId: string) => Promise<Record<string, ToolState>>;
  /**
   * Product version for the welcome banner (`juno v<version>`). Optional so
   * back-compat callers/tests that omit it still compile; cli.ts threads the real
   * `npm_package_version`. Defaults to `0.0.0` when absent.
   */
  readonly version?: string;
  /**
   * Async MCP fleet wiring (Wave 2 async-mcp). Present only when servers are
   * configured. cli.ts builds the manager but does NOT `start()` it, so first
   * paint is never gated on the connect (~569ms brain spawn, up to 30s for a dead
   * server). App kicks `start()` in a mount effect (after first paint), then
   * late-binds the discovered tools into its tools/specs state — appended AFTER
   * the base tools, whose subagent tool already froze an MCP-free childTools
   * snapshot, so subagents never gain MCP tools. Connection state surfaces in the
   * status strip. The same manager instance is wired to cli.ts's shutdown.
   */
  readonly mcp?: {
    readonly manager: McpManager;
    readonly servers: Record<string, McpServerConfig>;
  };
  /**
   * Ctrl+C exit override for the double-press quit path (useCtrlCExit). Production
   * omits it → the hook uses Ink's graceful useApp().exit() (unmount → MCP
   * shutdown + terminal restore). Injected ONLY by tests to assert the quit path
   * fires WITHOUT a real process teardown.
   */
  readonly onExit?: () => void;
  /**
   * Clock for the Ctrl+C second-press window (useCtrlCExit). Production omits it →
   * Date.now(). Injected by tests to drive the window deterministically without
   * fake timers fighting Ink's effect scheduler.
   */
  readonly clock?: () => number;
}

export interface AppProps {
  readonly deps: AppDeps;
}

/** The InputBox placeholder. Exported so tests assert on the SOURCE value, not a
 * hardcoded literal (the product name is not finalized — keep them coupled). */
export const INPUT_PLACEHOLDER = 'Message Juno';

// The live-turn height budget below the composer chrome is no longer a fixed reserve: a
// fixed number ignored the agents dropdown's EXPANDED height, so a full panel blew past it
// and re-triggered Ink's scrollback-erasing repaint. It is now DERIVED from the real
// rendered chrome (and the panel's expanded rows are clamped to fit) — see
// src/ui/liveBudget.ts:computeLiveBudget, called at render time below.

// Slash-command registry + parsing/filtering: moved verbatim to
// src/app/slashCommands.ts (W9 app-decompose). Re-exported here so existing
// consumers (tests import these from '../src/app') keep working unchanged.
export {
  filterSlashCommands,
  parseSlashCommand,
  parseSteerArg,
  slashCommands,
} from './app/slashCommands';

/**
 * The skills system prompt is for the RAW-API (`api`) backends only. The delegate
 * CLIs (claude-cli, codex-cli) discover their own tools/skills natively AND fold
 * systemPrompt into their single CLI prompt (claudeCliClient/codexCliClient
 * buildPrompt), so applying juno's skills block there double-loads / confuses them.
 * Suppress it for any non-`api` backend. Exported + named so the load-bearing
 * invariant is testable (a regression that inverts the kind check or drops the gate
 * goes red).
 */
export function systemPromptForProvider(
  provider: string | undefined,
  systemPrompt: string | undefined,
): string | undefined {
  return providerKindOf(provider) === 'api' ? systemPrompt : undefined;
}

// Completion bell: the pure shouldRingBell predicate + the BEL effect moved to
// src/hooks/useCompletionBell.ts (W9 app-decompose). Re-exported for existing
// consumers (tests import it from '../src/app').
export { shouldRingBell } from './hooks/useCompletionBell';

/**
 * Optimistic pre-start activity: the SAME 'thinking…' busy line `selectActivity`
 * yields for a streaming turn that has emitted no visible text yet. Rendered from
 * the instant a turn is submitted until the provider's `assistant-start` flips the
 * reducer phase (see `optimisticTurn`). Because the label/abortable/attention here
 * MATCH what `selectActivity` returns for that early phase, the handover from
 * optimistic → real is seamless — `LiveTurn`'s by-value memo bails on the swap, so
 * the spinner never blinks or double-mounts and the elapsed clock keeps ticking.
 */
const OPTIMISTIC_ACTIVITY: ActivityState = {
  label: 'thinking…',
  abortable: true,
  attention: false,
};

export function App({ deps }: AppProps): ReactElement {
  const { columns, rows } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const skills = useMemo(() => deps.skills ?? [], [deps.skills]);
  const initialModelId =
    deps.catalog.resolve(deps.settings.defaultModel)?.id ??
    deps.catalog.default()?.id ??
    deps.settings.defaultModel;

  const configuredPermissionMode = deps.settings.permissionMode ?? 'default';
  const seededPermissionModeRef = useRef(false);
  // Shared in-paste flag (G). Composer owns the bracketed-paste buffer, but its
  // sibling useInput handlers (useKeybinds) cannot see it — so a bare '\r' chunk
  // arriving BETWEEN paste chunks parses as Enter and fires the palette's accept
  // handler mid-paste. The Composer mirrors its paste-open state here so useKeybinds
  // can ignore keystrokes while a paste is in flight, extending Composer's own
  // paste-first ordering to the app-level bindings.
  const pasteActiveRef = useRef(false);

  const [value, setValue] = useState('');
  // Input history ring (G — in-memory only this wave): the ring + cursor + draft
  // stash and the push/prev/next navigation live in useInputHistory (W9
  // app-decompose). Refs + callbacks only — no state, no effects.
  const inputHistory = useInputHistory({ value, setValue });
  // Transient Ctrl+C exit hint ("press ctrl+c again to exit"). A dedicated dim
  // <Text> line driven by its OWN state so it bypasses the memoized StatusLine /
  // InputBox surfaces entirely — flipping it never perturbs their prop stability.
  const [ctrlcHint, setCtrlcHint] = useState<string | null>(null);
  // Optimistic-turn flag (resumed-turn spinner). True from the instant a turn is
  // submitted until it EITHER produces a real activity (the provider's first phase
  // change — normal handover) OR settles without one (a failed start). It only fills
  // the pre-`assistant-start` gap so a --resume turn — whose start event is DEFERRED
  // to its first content, ~1.7-2.2s — still shows the busy line as promptly as a fresh
  // turn. See `runSubmit` (set + settle-clear) and the takeover effect (real-activity clear).
  const [optimisticTurn, setOptimisticTurn] = useState(false);
  const [selectedId, setSelectedId] = useState(initialModelId);

  // Tool-detail overlay (ctrl+o) view/highlight/pin/scroll state lives in
  // useToolDetailOverlay (W9 app-decompose), called further down once
  // closeOverlay exists.

  // Subagent panel (LANE B) is EXPAND/COLLAPSE only — its expanded/collapsed state is the
  // reducer overlay (`overlay === 'subagents'`), so no app-local view/selection/scroll
  // state is needed. Transcript browsing was removed (the per-subagent record is still
  // written to disk, the UI just no longer opens it).

  // The active session id, seeded ONCE from a generated id at mount (the
  // clock/randomness live in generateSessionId, NOT in the pure reducer). It stays
  // app-level plumbing — the subagent recorder + on-disk subagent reader key on it
  // — while the picker rows / persistence / accept path live in useSessionResume
  // (called further down, after the turn hook it consumes).
  const [activeSessionId, setActiveSessionId] = useState(generateSessionId);

  // Async MCP (Wave 2 async-mcp): the late-bindable tools/specs + connection chip
  // state and the once-only background start live in useMcpLifecycle (W9
  // app-decompose). Tools/specs initialize to the non-MCP set built by cli.ts and
  // re-form the useStreamingTurn submit closure when the connect resolves; the
  // chip seeds to `connecting` so the very first paint already shows the state —
  // proof the render is not gated on the connect.
  const mcpLifecycle = useMcpLifecycle({
    mcp: deps.mcp,
    baseTools: deps.tools,
    baseSpecs: deps.specs ?? BUILTIN_TOOL_SPECS,
  });
  const mcpStatus = mcpLifecycle.status;

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

  // Per-subagent recorder, rebound to the active session (a resume swaps the id).
  // Absent factory (tests) ⇒ undefined ⇒ the turn hook records nothing.
  const subagentRecorder = useMemo(
    () => deps.createSubagentRecorder?.(activeSessionId),
    [deps, activeSessionId],
  );

  const turn = useStreamingTurn({
    client,
    tools: mcpLifecycle.tools,
    policy: deps.policy,
    specs: mcpLifecycle.specs,
    cwd: deps.settings.cwd,
    model: selectedId,
    systemPrompt: systemPromptForTurn,
    subagentRecorder,
    // Context-Compression: thread the SELECTED model's real context window (same
    // resolution as the status ctx meter below) + tuning, so auto-compaction fires on
    // estimated transcript pressure against the window of the model actually in use
    // (and `/compact` honors the same budget). Falls back to the configured budget
    // when the entry omits a window.
    maxContext: selectedEntry?.contextWindow ?? deps.settings.maxContext,
    compactionThreshold: deps.settings.compactionThreshold,
    compactionKeepBudget: deps.settings.compactionKeepBudget,
    // Iteration budget: per-turn tool-call ceiling (runaway guard) for the raw-API loop.
    maxToolCalls: deps.settings.maxToolCalls,
    // Per-execution tool timeout (wedged-tool guard) forwarded to the executor.
    toolTimeoutMs: deps.settings.toolTimeoutMs,
    // Ambient brain recall (Phase 2): per-prompt matched-memory injection.
    // Applied on EVERY backend — the block rides TurnInput.messages, which all
    // three clients receive (unlike systemPromptForTurn's claude-cli gate).
    ambientRecall: deps.ambientRecall,
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

  // Submit wrapper that raises the optimistic-turn flag the instant a turn is
  // dispatched, then lowers it when the turn fully settles. The settle-clear is the
  // load-bearing half of the FAILED-START requirement: a spawn error / immediate
  // provider error produces no real activity, so the flag would otherwise linger — but
  // `turn.submit` still resolves once `runTurn` surfaces the error and returns, clearing
  // it. The happy path clears earlier via the takeover effect below; this `.finally` is
  // then a harmless no-op.
  //
  // The `isBusy()` early-return makes runSubmit OWN the flag it raises. When a turn
  // already holds the controller, `turn.submit` silently no-ops (useStreamingTurn's
  // `controllerRef.current !== null` guard) — but its `.finally` would still fire and
  // lower the flag, killing the IN-FLIGHT turn's optimistic indicator mid-window (the
  // pre-`assistant-start` gap this track exists to eliminate). Returning early here
  // preserves that no-op submit semantics WITHOUT touching the flag, so a second submit
  // interleaved during the optimistic window (e.g. the slash-overlay path — plain text
  // typed over the seeded '/' then Enter — which has no busy gate of its own) cannot
  // resurrect the spinner gap. The plain-input submit paths already gate on isBusy()
  // before calling; this makes the guard total and covers any future caller.
  const runSubmit = useCallback(
    (text: string): void => {
      if (turn.isBusy()) {
        return;
      }
      setOptimisticTurn(true);
      void turn.submit(text).finally(() => setOptimisticTurn(false));
    },
    [turn],
  );

  // Async MCP connect (Wave 2 async-mcp). cli.ts builds the manager but does NOT
  // start it — kicking `start()` HERE, in an effect that runs AFTER first paint,
  // is what keeps the render off the connect's critical path. The once-guard,
  // status mapping, tool late-bind and warning formatting live in useMcpLifecycle
  // (the effect refires as `turn` re-identifies each render; start() no-ops after
  // the first call). Warnings route to ONE dim transcript notice — post-render
  // stderr writes corrupt the ink TUI, so they can no longer go there.
  const mcp = deps.mcp;
  useEffect(() => {
    mcpLifecycle.start((text) => turn.dispatch({ t: 'notice', text }));
  }, [mcpLifecycle, turn]);

  const closeOverlay = useCallback((): void => {
    // Clear the composer on EVERY close path. The slash overlay seeds/keeps a live
    // `/query` in `value` (composer focused); without this a bailed-out palette
    // ('/mod' + Esc) would leave that text prefixing the next message into a bogus
    // `/command` that submit silently drops. Non-slash overlays keep value empty, so
    // clearing is a harmless no-op for them.
    setValue('');
    turn.dispatch({ t: 'set-overlay', overlay: 'none' });
  }, [turn]);

  // Session persistence + the /resume picker (useSessionResume, W9 app-decompose):
  // best-effort create-once-then-save on each committed-transcript change, the
  // picker's lazily-loaded rows, and the hydrate/abort/resume-dispatch accept path.
  // Called HERE so its save-on-commit effect keeps its exact pre-extraction slot
  // (after the MCP kick, before the slash-highlight reset).
  const committed = turn.state.committed;
  const sessionResume = useSessionResume({
    store: deps.sessionStore,
    cwd: deps.settings.cwd,
    model: selectedId,
    activeSessionId,
    setActiveSessionId,
    committed,
    abort: turn.abort,
    dispatch: turn.dispatch,
    closeOverlay,
  });

  // StatusLine bundle (useStatusModel, W9 app-decompose): identity-stable across
  // token flushes (which only mutate state.live) so the memoized <StatusLine>
  // bails out of those commits; the granular field-level dep list lives with the
  // memo in the hook.
  const status = useStatusModel({
    state: turn.state,
    selectedId,
    cwd: deps.settings.cwd,
    selectedEntry,
    maxContext: deps.settings.maxContext,
    maxToolCalls: deps.settings.maxToolCalls,
    skills: deps.skills,
    isCompacting: turn.isCompacting,
    toolCallsThisTurn: turn.toolCallsThisTurn,
    mcpStatus,
  });

  // Palette/picker controllers (usePickerControls, W9 app-decompose): the slash
  // palette's live query/filtered rows/highlight, the model/skill/permission-mode
  // selections, and their open/move/accept handlers. Called HERE so its
  // highlight-reset effect keeps its exact pre-extraction slot (after the
  // persistence save, before the subagent disk load). selectedId stays app state
  // (it drives client construction + the status line); moveModel cycles it via
  // the setter.
  const pickers = usePickerControls({
    dispatch: turn.dispatch,
    permissionMode: turn.state.permissionMode,
    initialPermissionMode: configuredPermissionMode,
    value,
    setValue,
    closeOverlay,
    models,
    setSelectedId,
    skills,
  });

  // Tool-detail overlay (ctrl+o): the id-pinned highlight/pin/scroll controller
  // (useToolDetailOverlay, W9 app-decompose). Entries derive newest-first from
  // `turn.state.tools`; open dispatches the overlay; Esc routes back/close.
  const toolDetail = useToolDetailOverlay({
    tools: turn.state.tools,
    dispatch: turn.dispatch,
    closeOverlay,
    columns,
    rows,
  });

  // --- Subagent browser (LANE B) ------------------------------------------------
  // The agents panel's disk rehydrate + live-wins merge + expand/collapse
  // controllers (useSubagentPanel, W9 app-decompose). Called HERE so its
  // load-on-session effect keeps its exact pre-extraction slot.
  const subagentPanel = useSubagentPanel({
    read: deps.readSubagentTranscripts,
    activeSessionId,
    liveTools: turn.state.tools,
    dispatch: turn.dispatch,
    closeOverlay,
  });
  const subagents = subagentPanel.subagents;

  // Input dispatch (useSubmitRouting, W9 app-decompose): the single guard against
  // leaking `/` to the model — Enter routes a line to a slash command, a mid-turn
  // steer, or the model, with the same-Enter dedup between acceptSlash and the
  // InputBox submit path living inside the hook.
  const submitRouting = useSubmitRouting({
    turn,
    overlay: turn.state.overlay,
    value,
    setValue,
    closeOverlay,
    runSubmit,
    pushHistory: inputHistory.push,
    filteredSlashCommands: pickers.filteredSlashCommands,
    selectedIndex: pickers.selectedIndex,
    openModelPicker: pickers.openModelPicker,
    openSkillPicker: pickers.openSkillPicker,
    openPermissionModePicker: pickers.openPermissionModePicker,
    openSessionPicker: sessionResume.openSessionPicker,
    openMcp: pickers.openMcp,
    openHelp: pickers.openHelp,
  });

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    pasteActiveRef,
    slashCommandCount: pickers.filteredSlashCommands.length,
    modelCount: models.length,
    skillCount: skills.length,
    sessionCount: sessionResume.sessions.length,
    permissionModeCount: PERMISSION_MODES.length,
    onAbort: turn.abort,
    onCycleEffort: () => turn.dispatch({ t: 'cycle-effort' }),
    onOpenSlash: pickers.openSlash,
    onOpenHelp: pickers.openHelp,
    onCloseOverlay: closeOverlay,
    onMoveSlash: pickers.moveSlash,
    onAcceptSlash: submitRouting.acceptSlash,
    onMoveModel: pickers.moveModel,
    onAcceptModel: pickers.acceptModel,
    onMoveSkill: pickers.moveSkill,
    onAcceptSkill: pickers.acceptSkill,
    onMoveSession: sessionResume.moveSession,
    onAcceptSession: sessionResume.acceptSession,
    onMovePermissionMode: pickers.movePermissionMode,
    onAcceptPermissionMode: pickers.acceptPermissionMode,
    toolDetailCount: toolDetail.entries.length,
    onOpenToolDetail: toolDetail.open,
    onMoveTool: toolDetail.move,
    onAcceptTool: toolDetail.accept,
    onToolBack: toolDetail.back,
    onMoveSubagent: subagentPanel.move,
    onSubagentBack: subagentPanel.back,
  });

  // Double-press Ctrl+C: first press aborts an in-flight turn (or clears the
  // composer when idle) and arms the exit hint; a second press within the window
  // exits via Ink's graceful useApp().exit() (→ cli.ts waitUntilExit → MCP
  // shutdown + terminal restore). A dedicated ungated useInput owns \x03; Ink's
  // own exitOnCtrlC is disabled in cli.ts so it does not race this.
  useCtrlCExit({
    isBusy: turn.isBusy,
    hasValue: () => value.length > 0,
    clearValue: () => setValue(''),
    abort: turn.abort,
    setHint: setCtrlcHint,
    exit: deps.onExit,
    now: deps.clock,
  });

  // Completion bell (config-gated, default off) — useCompletionBell rings the
  // terminal BEL once when a turn finishes. Called HERE so the effect keeps its
  // exact pre-extraction slot (after the key handlers, before the takeover clear).
  useCompletionBell({ phase: turn.state.phase, enabled: deps.settings.completionBell });

  const permissionRequest = turn.permissionRequest;
  // Guard: if the reducer says overlay is 'permission' but we have no request to
  // render (race), fall back to 'none' so OverlayHost doesn't get an undefined prop.
  const effectiveOverlay =
    turn.state.overlay === 'permission' && permissionRequest === null
      ? 'none'
      : turn.state.overlay;

  // Composer change handler with the overlay-open SEED keystroke stripped. The `?`
  // (opens help) and `/` (opens the slash palette) are delivered to the Composer in
  // the SAME frame they reach useKeybinds — the seed frame — so without this they
  // would land in the composer alongside the overlay open. openSlash seeds the '/'
  // itself; this strip stops the Composer's duplicate seed change from being re-applied.
  // The strip condition — empty composer gaining exactly '?' or '/' at overlay 'none'
  // — is precisely the keybinds' own empty-input gate, so a '?' / '/' typed into a
  // non-empty input still inserts normally. Once the slash overlay is OPEN the strip
  // is lifted so type-to-filter builds the live `/query` (backspacing to '' then
  // retyping '/' must reach `value`). A typed multi-char `/command` (via paste)
  // arrives as one non-single-char change and is left intact for submit() to parse.
  const overlayForInput = turn.state.overlay;
  const handleInputChange = useCallback(
    (nextValue: string): void => {
      // Typing or pasting exits history navigation: the edited text becomes the new
      // live draft, so the next Up re-stashes it and starts from the newest entry.
      inputHistory.resetNavigation();
      if (
        (nextValue === '?' || nextValue === '/') &&
        value.length === 0 &&
        overlayForInput !== 'slash'
      ) {
        return;
      }
      setValue(nextValue);
    },
    [inputHistory, value, overlayForInput],
  );

  // Welcome banner: shown only on a fresh start (empty transcript, no live turn),
  // so the screen is never blank-then-box. The live-turn activity indicator drives
  // the single busy line between the transcript and the composer.
  const isFresh = turn.state.committed.length === 0 && turn.state.live === null;
  // Live-turn activity, with the optimistic pre-start fallback: the real
  // phase-derived activity ALWAYS wins; only when it is null AND a turn is in its
  // optimistic window do we stand in the 'thinking…' line. So `assistant-start`
  // arriving is a silent takeover (real replaces the value-equal optimistic; the
  // memoized LiveTurn doesn't even re-render), and a terminal phase (idle/error)
  // drops the line the moment the real activity clears — no lingering spinner.
  const realActivity = selectActivity(turn.state);
  const activity = realActivity ?? (optimisticTurn ? OPTIMISTIC_ACTIVITY : null);
  // Hand the optimistic flag off to real state the instant a real activity exists,
  // so the LiveTurn's elapsed clock / label are driven by the reducer for the rest
  // of the turn and no stale 'thinking…' frame can survive into a terminal phase.
  // (A failed start yields no real activity; `runSubmit`'s settle-clear covers it.)
  const hasRealActivity = realActivity !== null;
  useEffect(() => {
    if (hasRealActivity && optimisticTurn) {
      setOptimisticTurn(false);
    }
  }, [hasRealActivity, optimisticTurn]);
  // The delegate CLIs (claude-cli/codex-cli) run tools under THEIR OWN config (juno
  // replays them), so tool lines are tagged `· via claude cli` / `· via codex cli`;
  // juno-executor (`api`) backends stay unmarked.
  const providerKind = providerKindOf(selectedEntry?.provider);

  // LANE D + scrollback (autoscroll): bound the LIVE turn's rendered height so Ink's
  // dynamic redraw region stays shorter than the viewport and keeps terminal-following
  // (see src/ui/liveWindow.ts). The reserve is DERIVED from the real chrome height —
  // including the agents dropdown in its current collapsed/expanded shape — and the
  // panel's expandable rows are clamped so the total dynamic region is ALWAYS < rows,
  // through resize and panel expansion (see src/ui/liveBudget.ts). `subagentMaxRows` is
  // fed back into <SubagentPanel> so the panel renders exactly the height reserved.
  const { liveMaxLines, subagentMaxRows } = computeLiveBudget({
    rows,
    columns,
    composerValue: value,
    subagentEntryCount: subagents.length,
    subagentFocused: turn.state.overlay === 'subagents',
  });

  return (
    <Box flexDirection="column" width={columns}>
      {isFresh ? (
        <Banner version={deps.version ?? '0.0.0'} model={selectedId} cwd={deps.settings.cwd} />
      ) : null}
      <Transcript
        committed={turn.state.committed}
        epoch={turn.state.transcriptEpoch}
        providerKind={providerKind}
      />
      {/* Turn separator for the pre-stream window (optimistic `thinking…`, or an
          `assistant-start` whose live msg has no content yet): while `live` is null
          StreamingMessage renders nothing, so ITS leading MessageSeparator is absent and
          the spinner butts directly against the transcript — then hops down one row the
          instant `live` goes non-null and that separator materializes, even before any
          text ("like the text presses enter"). Render the SAME one-line separator here so
          the spinner holds its row from the first thinking frame through streaming and
          commit. Gated exactly complementary to StreamingMessage's own separator
          (`live === null` here vs `live !== null` there) so the blank line is never
          doubled, and only when there is committed history to separate from — matching
          `separated={committed.length > 0}` below. liveBudget's BASE_CHROME_RESERVE already
          reserves this row unconditionally, so drawing it never overflows the live region. */}
      {activity !== null && turn.state.live === null && turn.state.committed.length > 0 ? (
        <MessageSeparator />
      ) : null}
      <StreamingMessage
        live={turn.state.live}
        tools={turn.state.tools}
        separated={turn.state.committed.length > 0}
        pendingPermissionToolCallId={turn.state.pendingPermissionToolCallId}
        providerKind={providerKind}
        maxLines={liveMaxLines}
        columns={columns}
      />
      <LiveTurn activity={activity} width={columns} />
      <OverlayHost
        overlay={effectiveOverlay}
        slash={
          effectiveOverlay === 'slash'
            ? {
                commands: [...pickers.filteredSlashCommands],
                selectedIndex: pickers.selectedIndex,
                rows,
                query: pickers.slashQuery ?? undefined,
              }
            : undefined
        }
        modelPicker={
          effectiveOverlay === 'model-picker'
            ? { models, selectedId, rows }
            : undefined
        }
        skillPicker={
          effectiveOverlay === 'skill-picker'
            ? { skills, selectedIndex: pickers.selectedSkillIndex, rows }
            : undefined
        }
        sessionPicker={
          effectiveOverlay === 'session-picker'
            ? { sessions: sessionResume.sessions, selectedIndex: sessionResume.selectedSessionIndex, rows }
            : undefined
        }
        permissionModePicker={
          effectiveOverlay === 'permission-mode'
            ? { selectedMode: pickers.selectedPermissionMode, rows }
            : undefined
        }
        permission={
          effectiveOverlay === 'permission' && permissionRequest !== null
            ? {
                request: permissionRequest,
                onDecision: (decision) => {
                  turn.resolvePermission(permissionRequest.toolCallId, decision);
                },
                width: columns,
                rows,
              }
            : undefined
        }
        mcp={
          effectiveOverlay === 'mcp'
            ? {
                // `mcpStatus` is undefined when no MCP servers are configured → 'none'
                // (empty-state panel). When connecting, the per-server rows are not yet
                // meaningful; the panel shows a connecting line instead. status() is a
                // cheap pure read — safe to call each frame while the panel is open.
                connectionState: mcpStatus?.state ?? 'none',
                servers: mcp?.manager.status() ?? [],
              }
            : undefined
        }
        toolDetail={
          effectiveOverlay === 'tool-detail'
            ? {
                view: toolDetail.view,
                entries: toolDetail.entries,
                // Detail view renders the id-PINNED call; list view the id-resolved
                // highlight. Both indices are re-derived from ids every render, so an
                // insertion that reorders the list can't swap what's shown.
                selectedIndex:
                  toolDetail.view === 'detail'
                    ? toolDetail.pinnedIndex
                    : toolDetail.highlightIndex,
                scroll: toolDetail.scroll,
                rows,
                width: columns,
              }
            : undefined
        }
      />
      {/* Composer anchors the layout, sitting directly above the single dim status
          line. Focus-gate it while an overlay is open — EXCEPT the slash palette,
          which is type-to-filter: the composer stays focused there so typed chars
          build the `/query` (and inline `/steer <text>` args). useKeybinds swallows
          keybind ACTIONS, but Ink still delivers every keypress to each active
          useInput, so every OTHER overlay stays gated or an ungated composer types
          behind pickers/help/permission. */}
      {/* Composer framing (Wave 3): two dim hairline rules bracket the input row —
          NOT a full border box (heavier, eats columns). The TOP rule right-anchors the
          current mode tag; the BOTTOM rule sits between the composer and the status
          strip. Both are separate memoized siblings, so the InputBox/StatusLine memo
          bail-outs are untouched (their props are unchanged).
          Vertical rhythm: exactly ONE blank line separates the content above from the
          composer. On a fresh start the Banner already owns that gap (its marginBottom),
          so the top rule adds its own margin ONLY when the Banner is absent — otherwise
          the two would stack into a doubled blank. */}
      <ComposerRule width={columns} mode={turn.state.permissionMode} spaceAbove={!isFresh} />
      <InputBox
        value={value}
        onChange={handleInputChange}
        onSubmit={submitRouting.submit}
        placeholder={INPUT_PLACEHOLDER}
        pasteActiveRef={pasteActiveRef}
        focus={effectiveOverlay === 'none' || effectiveOverlay === 'slash'}
        onHistoryPrev={effectiveOverlay === 'none' ? inputHistory.prev : undefined}
        onHistoryNext={effectiveOverlay === 'none' ? inputHistory.next : undefined}
        onArrowDownAtBottom={effectiveOverlay === 'none' ? subagentPanel.focusFromComposer : undefined}
      />
      <ComposerRule width={columns} />
      {/* Subagent panel (LANE B): the always-available strip sits BELOW the composer,
          beside the status line. Collapsed to one dim line when unfocused (nothing when
          the session has no subagents); expands into the per-agent status list when the
          'subagents' overlay is open (expand/collapse only — no transcript browsing). A
          NEW sibling that touches no StatusLine/InputBox prop — their memo bail-outs are
          unaffected. */}
      <SubagentPanel
        entries={subagents}
        focused={turn.state.overlay === 'subagents'}
        width={columns}
        maxRows={subagentMaxRows}
      />
      {ctrlcHint !== null ? <Text dimColor>{ctrlcHint}</Text> : null}
      <StatusLine status={status} width={columns} />
    </Box>
  );
}

export default App;
