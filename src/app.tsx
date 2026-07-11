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
import {
  selectActivity,
  selectStatusLine,
  type ActivityState,
  type McpConnectionState,
} from './core/selectors';
import type { Settings, McpServerConfig } from './services/config';
import type { ModelCatalog, ModelEntry } from './services/catalog';
import type { McpManager } from './services/mcpManager';
import type { SessionStore } from './services/sessions';
import { sessionMetaFor, toPaletteEntries } from './services/sessionPersistence';
import type { SessionPaletteEntry } from './ui/UnifiedCommandPalette';
import { BUILTIN_TOOL_SPECS } from './tools/registry';
import { createMcpTools } from './tools/mcpTools';
import { Transcript } from './ui/Transcript';
import { StreamingMessage } from './ui/StreamingMessage';
import { providerKindOf } from './ui/providerKind';
import { StatusLine } from './ui/StatusLine';
import { LiveTurn } from './ui/LiveTurn';
import { Banner } from './ui/Banner';
import { InputBox, ComposerRule } from './ui/InputBox';
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

/**
 * Generate a unique-enough session id for THIS run. Lives in app.tsx (not the
 * reducer) because it reads the clock + randomness — the reducer stays pure.
 * Used to seed `activeSessionId` lazily via useState initializer (called once).
 */
function generateSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SlashCommand {
  readonly name: string;
  readonly description: string;
  /**
   * The command carries a free-form inline argument after the command word (only
   * `/steer` today). When such a command is chosen from the palette WITHOUT an arg
   * already typed, `runSlashCommand` prefills `/name ` and keeps the composer open
   * so the user types the arg inline (instead of the closing-is-a-no-op behavior).
   */
  readonly takesArgs?: boolean;
}

export const slashCommands: ReadonlyArray<SlashCommand> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
  { name: 'skills', description: 'Choose a skill' },
  { name: 'permissions', description: 'Set permission mode' },
  { name: 'compact', description: 'Summarize & compact the session' },
  { name: 'steer', description: 'Inject mid-turn guidance (no restart)', takesArgs: true },
  { name: 'resume', description: 'Resume a past session' },
  { name: 'mcp', description: 'Show MCP server status' },
  { name: 'help', description: 'Show keyboard shortcuts' },
];

/**
 * Filter the slash-command registry to those whose name starts with `query` (the
 * command word the user has typed after `/`). A null/empty query returns every
 * command. Case-insensitive to match parseSlashCommand's lowercasing. Exported as
 * a pure helper so the type-to-filter behavior is unit-testable in isolation.
 *
 *   filterSlashCommands(cmds, null)   → all commands
 *   filterSlashCommands(cmds, 'c')    → [clear, compact]
 *   filterSlashCommands(cmds, 'zzz')  → []
 */
export function filterSlashCommands(
  commands: ReadonlyArray<SlashCommand>,
  query: string | null,
): ReadonlyArray<SlashCommand> {
  const q = (query ?? '').toLowerCase();
  return commands.filter((command) => command.name.startsWith(q));
}

/**
 * Whether a `/command …` line carries argument text after the command word — a
 * non-space char following the command word and at least one space. Used to decide
 * whether a `takesArgs` command chosen from the palette should PREFILL `/name ` (no
 * arg yet) or run/close (arg already present).
 *
 *   slashCommandHasArg('/steer go')  → true
 *   slashCommandHasArg('/steer ')    → false
 *   slashCommandHasArg('/steer')     → false
 *   slashCommandHasArg('/')          → false
 */
function slashCommandHasArg(value: string): boolean {
  return /^\s*\/[A-Za-z0-9_-]+\s+\S/.test(value);
}

/**
 * Completion bell predicate: ring exactly when a turn ENDS — the phase leaves an
 * in-flight state ('streaming' | 'running-tool') for 'idle'. PURE + exported so
 * the transition table is unit-testable without rendering App. Overlay-driven
 * phase flips (e.g. 'awaiting-permission') and error terminals never ring.
 */
export function shouldRingBell(prev: State['phase'], next: State['phase']): boolean {
  return (prev === 'streaming' || prev === 'running-tool') && next === 'idle';
}

const PERMISSION_MODES: ReadonlyArray<State['permissionMode']> = ['default', 'acceptEdits'];

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

/** Resolve a parsed command name to its registry entry (undefined if unknown). */
function findSlashCommand(name: string | null): SlashCommand | undefined {
  if (name === null) {
    return undefined;
  }
  return slashCommands.find((command) => command.name === name);
}

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
  const slashPlainSubmitRef = useRef<string | null>(null);
  // Shared in-paste flag (G). Composer owns the bracketed-paste buffer, but its
  // sibling useInput handlers (useKeybinds) cannot see it — so a bare '\r' chunk
  // arriving BETWEEN paste chunks parses as Enter and fires the palette's accept
  // handler mid-paste. The Composer mirrors its paste-open state here so useKeybinds
  // can ignore keystrokes while a paste is in flight, extending Composer's own
  // paste-first ordering to the app-level bindings.
  const pasteActiveRef = useRef(false);

  // Input history ring (G — in-memory only this wave). `historyRef` holds submitted
  // lines oldest→newest; `historyCursorRef` is null when the composer shows the
  // live draft (not navigating), else an index into the ring; `historyDraftRef`
  // stashes the in-progress text so Down past the newest entry restores it.
  const historyRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef<string>('');

  const [value, setValue] = useState('');
  // Optimistic-turn flag (resumed-turn spinner). True from the instant a turn is
  // submitted until it EITHER produces a real activity (the provider's first phase
  // change — normal handover) OR settles without one (a failed start). It only fills
  // the pre-`assistant-start` gap so a --resume turn — whose start event is DEFERRED
  // to its first content, ~1.7-2.2s — still shows the busy line as promptly as a fresh
  // turn. See `runSubmit` (set + settle-clear) and the takeover effect (real-activity clear).
  const [optimisticTurn, setOptimisticTurn] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [selectedPermissionMode, setSelectedPermissionMode] =
    useState<State['permissionMode']>(configuredPermissionMode);

  // Session Resume state. `activeSessionId` is seeded ONCE from a generated id at
  // mount (the clock/randomness live here, NOT in the pure reducer). `sessions` is
  // the picker's row data (loaded lazily from the store on open); `createdRef`
  // tracks whether the active session's file has been `create()`d yet so the
  // persistence effect creates once then only `save()`s.
  const [activeSessionId, setActiveSessionId] = useState(generateSessionId);
  const [sessions, setSessions] = useState<SessionPaletteEntry[]>([]);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const createdRef = useRef(false);

  // Async MCP (Wave 2 async-mcp). Tools/specs are App state so the fleet can
  // LATE-BIND after its background connect resolves: initialized to the non-MCP
  // set built by cli.ts, then (on `start()` resolution) the discovered MCP tools
  // are appended and the useStreamingTurn submit closure re-forms with the full
  // set for the NEXT turn. `mcpStatus` seeds to `connecting` when servers are
  // configured so the very first paint already shows the state chip — proof the
  // render is not gated on the connect.
  const [activeTools, setActiveTools] = useState<ReadonlyArray<Tool>>(deps.tools);
  const [activeSpecs, setActiveSpecs] = useState<ReadonlyArray<ToolSpec>>(
    deps.specs ?? BUILTIN_TOOL_SPECS,
  );
  const [mcpStatus, setMcpStatus] = useState<McpConnectionState | undefined>(() =>
    deps.mcp !== undefined
      ? { state: 'connecting', connected: 0, total: Object.keys(deps.mcp.servers).length }
      : undefined,
  );
  const mcpStartedRef = useRef(false);

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
    tools: activeTools,
    policy: deps.policy,
    specs: activeSpecs,
    cwd: deps.settings.cwd,
    model: selectedId,
    systemPrompt: systemPromptForTurn,
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
  // is what keeps the render off the connect's critical path. Guarded by a ref so
  // it fires exactly once even though `turn` re-identifies each render. start() is
  // idempotent and never throws across its boundary; callTool fails soft when a
  // server is not yet live, so a first turn fired mid-connect degrades gracefully
  // rather than blocking. On resolution: map {connected, total} to the chip state,
  // append the discovered MCP tools (createMcpTools) to the base set so the submit
  // closure re-forms with them for the next turn, and surface any skipped-server /
  // dropped-tool warnings as ONE dim transcript notice — post-render stderr writes
  // corrupt the ink TUI, so warnings can no longer go there.
  const mcp = deps.mcp;
  useEffect(() => {
    if (mcpStartedRef.current || mcp === undefined) {
      return;
    }
    mcpStartedRef.current = true;
    const total = Object.keys(mcp.servers).length;
    void (async (): Promise<void> => {
      const result = await mcp.manager.start();
      const connected = result.connected.length;
      const state: McpConnectionState['state'] =
        connected === 0 ? 'failed' : connected < total ? 'partial' : 'ready';
      setMcpStatus({ state, connected, total });
      const mcpTools = createMcpTools({ manager: mcp.manager, servers: mcp.servers });
      if (mcpTools.length > 0) {
        setActiveTools((current) => [...current, ...mcpTools]);
        setActiveSpecs((current) => [...current, ...mcpTools.map((tool) => tool.spec)]);
      }
      if (result.warnings.length > 0) {
        turn.dispatch({ t: 'notice', text: `mcp: ${result.warnings.join('; ')}` });
      }
    })();
  }, [mcp, turn]);

  // Session persistence (best-effort, fire-and-forget). On each committed-transcript
  // change, lazily `create()` the session file ONCE (so a title can be derived from
  // the first user message) then `save()` the full committed transcript. Guarded by
  // a present `sessionStore` and a non-empty transcript. Errors are swallowed —
  // persistence must NEVER crash the session (mirrors compaction's best-effort ethos).
  const committed = turn.state.committed;
  useEffect(() => {
    const store = deps.sessionStore;
    // Persist only real conversation. A transcript of nothing but system-feedback
    // notices (F: the post-`/clear` `session cleared` line) must NOT overwrite the
    // active session file — that would clobber a resumable history with a stub.
    const hasConversation = committed.some(
      (message) => message.role === 'user' || message.role === 'assistant',
    );
    if (store === undefined || !hasConversation) {
      return;
    }
    void (async (): Promise<void> => {
      try {
        if (!createdRef.current) {
          createdRef.current = true;
          await store.create(
            sessionMetaFor({
              id: activeSessionId,
              createdAt: new Date().toISOString(),
              model: selectedId,
              cwd: deps.settings.cwd,
              messages: committed,
            }),
          );
        }
        await store.save(activeSessionId, committed);
      } catch {
        // best-effort: never propagate a persistence failure into render.
      }
    })();
  }, [committed, deps.sessionStore, deps.settings.cwd, activeSessionId, selectedId]);

  // statusline-memo (Wave 2 item C): memoize the StatusLine bundle so its identity is
  // STABLE across commits that change no status field. Token flushes only mutate
  // `turn.state.live`, which `selectStatusLine` never reads — with a stable `status`
  // identity the memoized <StatusLine> (and the passed-through StatusLineState) bail
  // out of those commits instead of re-running the render fn + Yoga layout. The dep
  // list is enumerated against EVERY field selectStatusLine reads (selectors.ts:312-365,
  // incl. selectStatusText's errorMessage/phase reads);
  // miss one and the strip silently goes stale — a correctness bug, not a perf miss.
  //   state reads : tokens (token bar / cost / ctxFraction), effort, overlay, phase,
  //                 errorMessage (statusText), committed + contextWindowTokens (ctx
  //                 window + pressure), compactions, permissionMode,
  //                 pendingPermissionToolCallId.
  //   context     : selectedId, cwd, selectedEntry (contextWindow + pricing),
  //                 maxContext, maxToolCalls, skills, isCompacting, toolCallsThisTurn,
  //                 mcpStatus.
  const status = useMemo(
    () =>
      selectStatusLine(turn.state, {
        model: selectedId,
        cwd: deps.settings.cwd,
        // Denominator for the context-window monitor: the SELECTED model's real window
        // (codex 272–372k vs fable/sonnet 1M), so the `ctx:` %/bar reflect the model
        // actually in use. Falls back to the configured budget when the entry omits a
        // window. Auto-compaction is threaded the SAME per-model window (see the turn
        // deps above), so the meter and the compaction trigger share one denominator.
        maxContext: selectedEntry?.contextWindow ?? deps.settings.maxContext,
        skills: deps.skills?.map((skill) => skill.name),
        // Per-token pricing for the cost chip; undefined for the subscription backend => chip hidden.
        pricing: selectedEntry?.pricing,
        permissionMode: turn.state.permissionMode,
        isCompacting: turn.isCompacting,
        // Surface the per-turn tool-call budget so the StatusLine can render the guard chip.
        toolBudget: { used: turn.toolCallsThisTurn, max: deps.settings.maxToolCalls },
        // Async MCP connect state (Wave 2 async-mcp) → the state-carrying mcp chip.
        mcp: mcpStatus,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- granular by design: each
    // field selectStatusLine reads is listed individually so a token flush (which only
    // changes turn.state.live/tools) does NOT recompute the bundle. Listing turn.state
    // wholesale would defeat the memo (new identity every flush). Keep in sync with the
    // enumeration above whenever selectStatusLine's inputs change.
    [
      turn.state.tokens,
      turn.state.effort,
      turn.state.overlay,
      turn.state.phase,
      turn.state.errorMessage,
      turn.state.committed,
      turn.state.contextWindowTokens,
      turn.state.compactions,
      turn.state.permissionMode,
      turn.state.pendingPermissionToolCallId,
      selectedId,
      deps.settings.cwd,
      selectedEntry,
      deps.settings.maxContext,
      deps.settings.maxToolCalls,
      deps.skills,
      turn.isCompacting,
      turn.toolCallsThisTurn,
      mcpStatus,
    ],
  );

  // Query the slash palette filters on: the command word typed after `/`. While the
  // slash overlay is open the composer stays focused (see the InputBox focus gate),
  // so `value` holds the live query text ('/st', '/steer make it shorter'). Empty /
  // null query shows every command.
  const slashQuery = parseSlashCommand(value);
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashQuery),
    [slashQuery],
  );

  // Reset the highlight to the top whenever the query narrows/widens the list, so a
  // stale index can never point past the filtered end or select the wrong row.
  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const closeOverlay = useCallback((): void => {
    // Clear the composer on EVERY close path. The slash overlay seeds/keeps a live
    // `/query` in `value` (composer focused); without this a bailed-out palette
    // ('/mod' + Esc) would leave that text prefixing the next message into a bogus
    // `/command` that submit silently drops. Non-slash overlays keep value empty, so
    // clearing is a harmless no-op for them.
    setValue('');
    turn.dispatch({ t: 'set-overlay', overlay: 'none' });
  }, [turn]);

  const openSlash = useCallback((): void => {
    setSelectedIndex(0);
    // Seed the '/' into the composer so it survives the palette open (the seed strip
    // in handleInputChange only fires while the overlay is 'none'). value now holds
    // the live query as the user types.
    setValue('/');
    turn.dispatch({ t: 'set-overlay', overlay: 'slash' });
  }, [turn]);

  const openModelPicker = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'model-picker' });
  }, [turn]);

  const openHelp = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'help' });
  }, [turn]);

  const openMcp = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'mcp' });
  }, [turn]);

  const openSkillPicker = useCallback((): void => {
    setSelectedSkillIndex(0);
    turn.dispatch({ t: 'set-overlay', overlay: 'skill-picker' });
  }, [turn]);

  const openPermissionModePicker = useCallback((): void => {
    setSelectedPermissionMode(turn.state.permissionMode);
    turn.dispatch({ t: 'set-overlay', overlay: 'permission-mode' });
  }, [turn]);

  // Open the session picker: load the store's session list into palette rows,
  // reset the highlight, then open the overlay. Best-effort — if the store throws
  // or is absent, open with an empty list (the picker renders just its header).
  const openSessionPicker = useCallback((): void => {
    const store = deps.sessionStore;
    setSelectedSessionIndex(0);
    void (async (): Promise<void> => {
      let entries: SessionPaletteEntry[] = [];
      if (store !== undefined) {
        try {
          entries = toPaletteEntries(await store.list());
        } catch {
          entries = [];
        }
      }
      setSessions(entries);
      turn.dispatch({ t: 'set-overlay', overlay: 'session-picker' });
    })();
  }, [deps.sessionStore, turn]);

  // Sign-safe modulo `((i + d) % n + n) % n`: the coalesced arrow delta (useKeybinds'
  // arrowDelta) can be a burst of magnitude N — larger than the list — so the old
  // `(i + d + n) % n` idiom (which only tolerates |d| ≤ n) can leave a NEGATIVE index.
  // JS `%` keeps the sign, so that yields models[-1] (a TypeError crash in moveModel)
  // or an undefined selection in the others. Reducing `(i + d) % n` first bounds the
  // pre-offset into (-n, n), so the final `+ n) % n` always lands in [0, n).
  const moveSession = useCallback((delta: number): void => {
    setSelectedSessionIndex((current) => {
      if (sessions.length === 0) {
        return current;
      }
      return ((current + delta) % sessions.length + sessions.length) % sessions.length;
    });
  }, [sessions.length]);

  const moveSlash = useCallback((delta: number): void => {
    setSelectedIndex((current) => {
      const count = filteredSlashCommands.length;
      if (count === 0) {
        return current;
      }
      return ((current + delta) % count + count) % count;
    });
  }, [filteredSlashCommands.length]);

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
        const nextIndex = ((currentIndex + delta) % models.length + models.length) % models.length;
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
        return ((current + delta) % skills.length + skills.length) % skills.length;
      });
    },
    [skills.length],
  );

  const movePermissionMode = useCallback((delta: number): void => {
    setSelectedPermissionMode((current) => {
      const currentIndex = Math.max(0, PERMISSION_MODES.indexOf(current));
      const nextIndex =
        ((currentIndex + delta) % PERMISSION_MODES.length + PERMISSION_MODES.length) %
        PERMISSION_MODES.length;
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
      // Match the plain-input submit paths' busy guard (see submit() below): while a turn
      // owns the controller, `turn.submit` no-ops, so closing the overlay + clearing the
      // composer here would silently DROP the typed line. Return before mutating any state
      // so the line survives for resend once the controller frees — and, together with
      // runSubmit's own guard, the in-flight turn's optimistic indicator is never lowered.
      if (turn.isBusy()) {
        return;
      }
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
      runSubmit(nextValue);
    },
    [closeOverlay, runSubmit, turn],
  );

  // Dispatch a resolved slash command to its already-wired target. Single source
  // of truth for slash dispatch — shared by acceptSlash (Enter while the overlay
  // is open) and submit() (a typed `/command` when the overlay is NOT 'slash').
  const runSlashCommand = useCallback(
    (command: SlashCommand | undefined): void => {
      if (command === undefined) {
        // Unknown / zero-match selection: just close (closeOverlay clears the composer).
        // A safe no-op — no command fires, nothing leaks to the model.
        closeOverlay();
        return;
      }

      // A takesArgs command (only `/steer`) chosen from the palette with NO arg text
      // yet: prefill `/name ` and KEEP the overlay open + composer focused so the user
      // types the argument inline. The next Enter routes the full `/steer <text>`
      // through submit() → turn.steer. Do NOT close here.
      if (command.takesArgs === true && !slashCommandHasArg(value)) {
        setValue(`/${command.name} `);
        return;
      }

      // Every other resolved command clears the composer as it dispatches/opens a
      // sub-picker (the slash overlay's Enter path defers value ownership to here, so
      // submit no longer clears — see submit()). closeOverlay-based branches clear
      // again harmlessly; the sub-picker openers (model/skills/...) rely on this.
      setValue('');

      switch (command.name) {
        case 'clear':
          // Cancel any in-flight turn FIRST. `clear` alone resets the reducer to an
          // idle transcript but does NOT abort the running turn, so the controller stays
          // held (swallowing the next submit) and a parked permission await orphans into
          // a permanent input freeze. abort() releases the controller and drainDeny()s
          // the registry; it is a safe no-op when nothing is running.
          turn.abort();
          // Wipe the terminal scrollback (F): the epoch remount alone resets <Static>'s
          // index but leaves the OLD already-printed lines in the terminal history, so
          // the prior conversation stays visible above. The ANSI erase-scrollback +
          // clear-screen + home sequence removes it. TTY-gated so unit runners (whose
          // stdout is not a TTY) never emit control bytes into the vitest output.
          if (process.stdout.isTTY === true) {
            process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
          }
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
        case 'resume':
          openSessionPicker();
          break;
        case 'compact':
          void turn.compactNow();
          closeOverlay();
          break;
        case 'mcp':
          openMcp();
          break;
        case 'help':
          openHelp();
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
    [closeOverlay, openHelp, openMcp, openModelPicker, openPermissionModePicker, openSessionPicker, openSkillPicker, turn, value],
  );

  // Prefer a typed `/command` (parsed from the input value) over the highlighted
  // index, so a typed `/effort` + Enter cycles exactly once. If the slash overlay
  // is still open but the user has replaced the input with a plain non-slash
  // line, send that line once instead of firing the highlighted command (the
  // Unit-5.1 follow-up edge case — no phantom default-highlighted command).
  const acceptSlash = useCallback((): void => {
    // A MULTILINE value (bracketed paste, G) is ALWAYS one plain message, never a
    // command — even when it leads with '/'. Mirror submit()'s newline guard
    // (app.tsx: `nextValue.includes('\n')`) so the SAME physical Enter that submit()
    // already routes to submitPlainInputFromSlashOverlay does not ALSO parse the
    // first word (`/clear\nfoo` → 'clear') and fire a command that aborts + wipes the
    // just-submitted turn. The pair is deduped by slashPlainSubmitRef → exactly one send.
    if (value.includes('\n')) {
      submitPlainInputFromSlashOverlay(value);
      return;
    }

    const parsedCommand = parseSlashCommand(value);
    const plainNonSlashInput = value.trim().length > 0 && !value.trimStart().startsWith('/');

    if (plainNonSlashInput && parsedCommand === null) {
      submitPlainInputFromSlashOverlay(value);
      return;
    }

    const typedCommand = findSlashCommand(parsedCommand);
    const command = typedCommand ?? filteredSlashCommands[selectedIndex];
    runSlashCommand(command);
  }, [filteredSlashCommands, runSlashCommand, selectedIndex, submitPlainInputFromSlashOverlay, value]);

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

  // Hydrate the highlighted session: load it from the store and dispatch the
  // resume. On a miss (or no store / empty list) just close the overlay. Setting
  // `activeSessionId` to the loaded id makes continued turns append to the SAME
  // session; `createdRef = true` skips a redundant create() on the next commit.
  const acceptSession = useCallback((): void => {
    const store = deps.sessionStore;
    const entry = sessions[selectedSessionIndex];
    if (store === undefined || entry === undefined) {
      closeOverlay();
      return;
    }
    void (async (): Promise<void> => {
      try {
        const loaded = await store.load(entry.id);
        if (loaded !== undefined) {
          // Cancel any in-flight turn BEFORE swapping the transcript. resume-session
          // resets the reducer to idle but does NOT abort the running turn, so without
          // this the controller stays held (the next submit is silently dropped) and a
          // parked permission await orphans into a permanent input freeze. abort()
          // releases the controller and drainDeny()s the registry; a no-op when idle.
          turn.abort();
          setActiveSessionId(entry.id);
          createdRef.current = true;
          turn.dispatch({ t: 'resume-session', messages: loaded.messages });
        }
      } catch {
        // best-effort: a failed load must never crash the session.
      }
      closeOverlay();
    })();
  }, [closeOverlay, deps.sessionStore, selectedSessionIndex, sessions, turn]);

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    pasteActiveRef,
    slashCommandCount: filteredSlashCommands.length,
    modelCount: models.length,
    skillCount: skills.length,
    sessionCount: sessions.length,
    permissionModeCount: PERMISSION_MODES.length,
    onAbort: turn.abort,
    onCycleEffort: () => turn.dispatch({ t: 'cycle-effort' }),
    onOpenSlash: openSlash,
    onOpenHelp: openHelp,
    onCloseOverlay: closeOverlay,
    onMoveSlash: moveSlash,
    onAcceptSlash: acceptSlash,
    onMoveModel: moveModel,
    onAcceptModel: acceptModel,
    onMoveSkill: moveSkill,
    onAcceptSkill: acceptSkill,
    onMoveSession: moveSession,
    onAcceptSession: acceptSession,
    onMovePermissionMode: movePermissionMode,
    onAcceptPermissionMode: acceptPermissionMode,
  });

  // Record a submitted line at the end of the history ring and reset navigation to
  // the live draft. Called from submit() BEFORE the composer is cleared.
  const pushHistory = useCallback((line: string): void => {
    historyRef.current.push(line);
    historyCursorRef.current = null;
  }, []);

  // Up on the composer's first line: recall an OLDER history entry. First press
  // stashes the in-progress draft, then walks toward the oldest entry (clamped).
  const historyPrev = useCallback((): void => {
    const history = historyRef.current;
    if (history.length === 0) {
      return;
    }
    if (historyCursorRef.current === null) {
      historyDraftRef.current = value;
      historyCursorRef.current = history.length - 1;
    } else if (historyCursorRef.current > 0) {
      historyCursorRef.current -= 1;
    } else {
      return; // already at the oldest entry
    }
    setValue(history[historyCursorRef.current]!);
  }, [value]);

  // Down on the composer's last line: recall a NEWER entry, and past the newest
  // restore the stashed draft (returning to the not-navigating state).
  const historyNext = useCallback((): void => {
    const history = historyRef.current;
    if (historyCursorRef.current === null) {
      return; // already showing the live draft
    }
    if (historyCursorRef.current < history.length - 1) {
      historyCursorRef.current += 1;
      setValue(history[historyCursorRef.current]!);
    } else {
      historyCursorRef.current = null;
      setValue(historyDraftRef.current);
    }
  }, []);

  // The single guard against leaking `/` to the model. A leading-`/` line NEVER
  // reaches turn.submit():
  //   - slash overlay open + plain non-slash line: send it once via the shared
  //     helper (deduped against acceptSlash's same-Enter dispatch).
  //   - overlay === 'slash' + `/`-line: DEFER value ownership to acceptSlash (the
  //     SAME Enter via useKeybinds): it runs the command + clears, or PREFILLS
  //     `/name ` for a takesArgs command. submit must NOT clear here or it would
  //     clobber that prefill. `/steer <arg>` still injects here exactly once.
  //   - otherwise: parse + dispatch the typed `/command` ourselves; unknown → drop.
  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) {
        return;
      }

      // A pasted MULTILINE value (bracketed paste, G) is ALWAYS one plain message —
      // never a slash command, even when its first char is '/'. Route it straight to
      // the model without the leading-`/` guard so a paste like `/etc/hosts\n…` is not
      // mis-parsed as a command. (A single-line `/command` is unaffected.)
      if (nextValue.includes('\n')) {
        if (turn.state.overlay === 'slash') {
          submitPlainInputFromSlashOverlay(nextValue);
          return;
        }
        if (turn.isBusy()) {
          return;
        }
        pushHistory(nextValue);
        setValue('');
        runSubmit(nextValue);
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
      // `/steer` (no text) is a no-op. The injection happens here exactly once.
      if (parseSlashCommand(nextValue) === 'steer') {
        const arg = parseSteerArg(nextValue);
        if (turn.state.overlay === 'slash') {
          // Palette open: acceptSlash (same Enter) owns the composer value — it prefills
          // `/steer ` when there's no arg yet, or clears on close after we inject here.
          // Do NOT clear here (would clobber the prefill).
          if (arg !== null) {
            turn.steer(arg);
          }
          return;
        }
        // Typed/pasted with the palette closed: inject (if any) then clear the composer.
        setValue('');
        if (arg !== null) {
          turn.steer(arg);
        }
        return;
      }

      if (trimmed.startsWith('/')) {
        if (turn.state.overlay === 'slash') {
          // Defer to acceptSlash (same Enter): it runs the command and owns the
          // composer value (clears on close, or prefills a takesArgs command).
          return;
        }
        setValue('');
        runSlashCommand(findSlashCommand(parseSlashCommand(nextValue)));
        return;
      }

      // Do NOT clear the composer unless the hook can actually accept the submission.
      // `turn.submit` silently no-ops while a turn — or a fire-and-forget compaction /
      // ambient-recall pass — still owns the controller (even though the phase can read
      // 'idle'), so clearing first would wipe the typed text AND drop the message: pure
      // silent data loss. When busy, preserve the composer so the user can resend once
      // the controller frees.
      if (turn.isBusy()) {
        return;
      }

      pushHistory(nextValue);
      setValue('');
      runSubmit(nextValue);
    },
    [pushHistory, runSlashCommand, runSubmit, submitPlainInputFromSlashOverlay, turn],
  );

  // Completion bell (config-gated, default off): ring the terminal BEL once when
  // a turn finishes (phase leaves streaming/running-tool for idle) so a user in
  // another window gets a cue. Process-edge I/O lives HERE, not in the reducer;
  // `shouldRingBell` keeps the transition logic pure/testable.
  const phase = turn.state.phase;
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (deps.settings.completionBell === true && shouldRingBell(prev, phase)) {
      process.stdout.write('\u0007');
    }
  }, [phase, deps.settings.completionBell]);

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
      historyCursorRef.current = null;
      if (
        (nextValue === '?' || nextValue === '/') &&
        value.length === 0 &&
        overlayForInput !== 'slash'
      ) {
        return;
      }
      setValue(nextValue);
    },
    [value, overlayForInput],
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
      <StreamingMessage
        live={turn.state.live}
        tools={turn.state.tools}
        separated={turn.state.committed.length > 0}
        pendingPermissionToolCallId={turn.state.pendingPermissionToolCallId}
        providerKind={providerKind}
      />
      <LiveTurn activity={activity} />
      <OverlayHost
        overlay={effectiveOverlay}
        slash={
          effectiveOverlay === 'slash'
            ? {
                commands: [...filteredSlashCommands],
                selectedIndex,
                rows,
                query: slashQuery ?? undefined,
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
            ? { skills, selectedIndex: selectedSkillIndex, rows }
            : undefined
        }
        sessionPicker={
          effectiveOverlay === 'session-picker'
            ? { sessions, selectedIndex: selectedSessionIndex, rows }
            : undefined
        }
        permissionModePicker={
          effectiveOverlay === 'permission-mode'
            ? { selectedMode: selectedPermissionMode, rows }
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
        onSubmit={submit}
        placeholder={INPUT_PLACEHOLDER}
        pasteActiveRef={pasteActiveRef}
        focus={effectiveOverlay === 'none' || effectiveOverlay === 'slash'}
        onHistoryPrev={effectiveOverlay === 'none' ? historyPrev : undefined}
        onHistoryNext={effectiveOverlay === 'none' ? historyNext : undefined}
      />
      <ComposerRule width={columns} />
      <StatusLine status={status} width={columns} />
    </Box>
  );
}

export default App;
