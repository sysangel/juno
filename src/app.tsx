// src/app.tsx
// W6, decomposed in W9 — the thin composition root. Owns only the genuinely
// top-level state (the composer `value`, the selected model id, the active
// session id) and wires the seam hooks together:
// useMcpLifecycle / useSessionResume / usePickerControls / useToolDetailOverlay /
// useSubagentPanel / useSubmitRouting / useInputHistory /
// useCompletionBell / useStatusModel around useStreamingTurn + useKeybinds +
// useCtrlCExit — then
// routes overlays via OverlayHost and renders the transcript / streaming /
// status / input chrome. Hook CALL ORDER here is load-bearing: it fixes the
// effect order (post-paint MCP kick → persistence save → palette-highlight
// reset → subagent disk load → input registration → bell).
// The pre-`assistant-start` busy line is now a reducer phase ('preparing', set by
// turn-start in useStreamingTurn.submit) surfaced through selectActivity — the old
// out-of-reducer optimisticTurn flag + its takeover-clear effect are gone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ModelClient } from './core/contracts';
import { selectActivity, selectBusy } from './core/selectors';
import type { SubagentEntry } from './core/selectors';
import type { Action } from './core/reducer';
import type { AppDeps } from './app/deps';
import { formatCompletion } from './services/backgroundAgents';
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
import { clipCells } from './ui/clipText';
import { permissionPromptRows } from './ui/PermissionPrompt';
import { toolDetailOverlayRows, type ToolDetailOverlayProps } from './ui/ToolDetailOverlay';
import { subagentViewerViewportRows } from './ui/SubagentViewer';
import { computeLiveBudget } from './ui/liveBudget';
import { useKeybinds } from './hooks/useKeybinds';
import { useCompletionBell } from './hooks/useCompletionBell';
import { useTerminalTitle } from './hooks/useTerminalTitle';
import { useCtrlCExit } from './hooks/useCtrlCExit';
import { useInputHistory } from './hooks/useInputHistory';
import { useMcpLifecycle } from './hooks/useMcpLifecycle';
import { PERMISSION_MODES, usePickerControls } from './hooks/usePickerControls';
import { generateSessionId, useSessionResume } from './hooks/useSessionResume';
import { useStatusModel } from './hooks/useStatusModel';
import { useStableCallback } from './hooks/useStableCallback';
import { useStreamingTurn } from './hooks/useStreamingTurn';
import { useSubagentPanel } from './hooks/useSubagentPanel';
import { useSubmitRouting } from './hooks/useSubmitRouting';
import { useToolDetailOverlay } from './hooks/useToolDetailOverlay';
import { useTerminalSize } from './hooks/useTerminalSize';

// The App dependency contract moved verbatim to src/app/deps.ts (W9
// app-decompose). Re-exported so existing consumers (cli.ts and the test
// suite import it from './app' / '../src/app') keep working unchanged.
export type { AppDeps } from './app/deps';

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
  const truthGuidance = 'Harness truthfulness: describe a review as independent or delegated only after actually using the available subagent tool and recording its completion. Juno verifies delegation only from recorded Agent, Task, or spawn_subagent tool events; prose is not evidence and unsupported claims are visibly marked unverified. On raw-provider re-entry, a <juno-delegation-evidence> fact block reports the authoritative counts. A failed or completed command is terminal; only a managed process explicitly reporting status running may be described as still running.';
  // Delegate CLIs discover skills themselves, but still need the small harness contract.
  if (providerKindOf(provider) !== 'api') return truthGuidance;
  return systemPrompt === undefined ? truthGuidance : `${systemPrompt}\n\n${truthGuidance}`;
}

// Completion bell: the pure shouldRingBell predicate + the BEL effect moved to
// src/hooks/useCompletionBell.ts (W9 app-decompose). Re-exported for existing
// consumers (tests import it from '../src/app').
export { shouldRingBell } from './hooks/useCompletionBell';

export function App({ deps }: AppProps): ReactElement {
  const { columns, rows } = useTerminalSize();
  const [subagentViewerScroll, setSubagentViewerScroll] = useState(0);
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  const skills = useMemo(() => deps.skills ?? [], [deps.skills]);
  const initialModelId =
    deps.catalog.resolve(deps.settings.defaultModel)?.id ??
    deps.catalog.default()?.id ??
    deps.settings.defaultModel;

  const configuredPermissionMode = deps.settings.permissionMode ?? 'default';
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

  // Wave 13 (retry-ui): bridge `retryFetch`'s pre-first-byte backoff callback into a
  // `retry-attempt` reducer action WITHOUT a client↔dispatch construction cycle. The
  // client memo (below) needs `onRetry`, but `turn.dispatch` only exists AFTER the
  // client is built — so `onRetry` is a STABLE callback reading a ref that App assigns
  // `turn.dispatch` to each render (post-`turn`). The callback fires synchronously
  // inside `retryFetch` immediately before its backoff sleep, so the dispatch lands and
  // React re-renders `retrying n/m` DURING the wait. Stable ⇒ never churns the memo.
  const retryDispatchRef = useRef<((action: Action) => void) | null>(null);
  const onRetry = useCallback((attempt: number, max: number, delayMs: number): void => {
    retryDispatchRef.current?.({ t: 'retry-attempt', attempt, max, delayMs });
  }, []);

  // Build the client from the SELECTED entry's provider. Rebuilds whenever the
  // picker changes selectedId, so the next turn dispatches against the correct
  // provider endpoint (fixes the build-once cross-provider bug).
  const client = useMemo<ModelClient>(() => {
    if (selectedEntry === undefined) {
      throw new Error(`no catalog entry for "${selectedId}"`);
    }
    return deps.createClient(selectedEntry, onRetry);
  }, [deps, selectedEntry, selectedId, onRetry]);

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
  const traceRecorder = useMemo(
    () => deps.createSessionTraceRecorder?.(activeSessionId),
    [deps, activeSessionId],
  );

  const turn = useStreamingTurn({
    client,
    tools: mcpLifecycle.tools,
    policy: deps.policy,
    specs: mcpLifecycle.specs,
    cwd: deps.settings.cwd,
    model: selectedId,
    // Seed the runtime permission mode at reducer construction so frame 1 is honest
    // (no post-mount seed dispatch). initialState applies it; `clear` re-applies it.
    permissionMode: configuredPermissionMode,
    systemPrompt: systemPromptForTurn,
    subagentRecorder,
    traceRecorder,
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
    // Config-driven PreToolUse/PostToolUse tool-call hooks (undefined => feature off).
    hooks: deps.settings.hooks,
    // Ambient brain recall (Phase 2): per-prompt matched-memory injection.
    // Applied on EVERY backend — the block rides TurnInput.messages, which all
    // three clients receive (unlike systemPromptForTurn's claude-cli gate).
    ambientRecall: deps.ambientRecall,
  });

  // Wave 13 (retry-ui): point the retry-dispatch ref at this render's `turn.dispatch`
  // (a stable useCallback) so the stable `onRetry` observer built above the client memo
  // can dispatch `retry-attempt` without a construction cycle. Assigned inline each
  // render — cheap, and always current before any onRetry can fire (a retry happens
  // only DURING an in-flight turn, well after mount). `retry-attempt` is a non-delta
  // action ⇒ dispatch flushes deltas (a no-op pre-first-byte) then dispatches now.
  retryDispatchRef.current = turn.dispatch;

  // Mirror reducer state into the live permission policy so runtime mode flips (the
  // palette selector's `acceptPermissionMode` dispatch) actually reach enforcement. The
  // configured mode is now seeded into reducer state at construction, so on mount this
  // effect is a harmless no-op (state and policy already agree); it still propagates
  // later runtime flips. State stays the single source of truth; this effect is the ONLY
  // writer to the policy mode. `deps.policy` is the shared instance also handed to the
  // subagent tool, so a flip here propagates to subagents automatically.
  useEffect(() => {
    deps.policy.setMode(turn.state.permissionMode);
  }, [turn.state.permissionMode, deps.policy]);

  // --- Background agents (Wave 13, lane 1) --------------------------------------
  // The non-blocking runner spawn_subagent hands children to. App is the ONLY place
  // that owns turn.dispatch + turn.steer, so it: (a) mirrors the runner's monotonic
  // version into state to re-render on any task change; (b) late-binds turn.dispatch
  // so the detached child loop can surface its tool cards; (c) drains settled children
  // into the interjection seam; (d) feeds the live task-status snapshot to the panel;
  // (e) aborts every live task on unmount. All no-ops when no runner is wired.
  const backgroundAgents = deps.backgroundAgents;
  // Manual external-store subscription (simpler than useSyncExternalStore here). Sync
  // once on subscribe in case a change landed before the listener attached.
  const [bgVersion, setBgVersion] = useState(0);
  // Wave 14 (b7): reconcile-derived interrupted statuses, keyed by spawn card id. A
  // task that was 'running' when a prior process died is presented as `aborted`
  // (neutral ⊘) — never a fake `done` — on the next resume. Merged into the panel
  // override below; a live 'running' task never has an entry (reconcile skips live
  // ids), so the merge can't mislabel a working task.
  const [interruptedStatuses, setInterruptedStatuses] = useState<
    Record<string, SubagentEntry['status']>
  >({});
  useEffect(() => {
    if (backgroundAgents === undefined) {
      return;
    }
    const sync = (): void => setBgVersion(backgroundAgents.getVersion());
    const unsubscribe = backgroundAgents.subscribe(sync);
    sync();
    return unsubscribe;
  }, [backgroundAgents]);

  // Late-bind turn.dispatch (a stable callback ⇒ attaches once) so the detached child
  // loop surfaces its tool-call/-delta/-status into the parent stream, namespaced
  // under the spawn card. Text/thinking stay out (they feed the child's summary).
  useEffect(() => {
    backgroundAgents?.attach({ dispatch: turn.dispatch });
  }, [backgroundAgents, turn.dispatch]);

  // Drain settled children into the interjection seam: a dim scrollback notice plus
  // turn.steer, which re-injects the result to the model whether or not a turn is
  // live (it re-enters an in-flight turn AND rides toTurnMessages into the next
  // submit). Runs only when the version bumps; `turn` is read off a ref so this is
  // not a per-render no-op. drainCompletions is empty on the settle-triggered
  // re-render, so steer/notice can't loop.
  const turnRef = useRef(turn);
  turnRef.current = turn;
  useEffect(() => {
    if (backgroundAgents === undefined) {
      return;
    }
    const completions = backgroundAgents.drainCompletions();
    if (completions.length === 0) {
      return;
    }
    const t = turnRef.current;
    for (const completion of completions) {
      const { steerText, noticeText } = formatCompletion(completion);
      // The spawn tool's `{status:'spawned'}` handle proves start, not completion.
      // Promote the durable reducer ledger only from this real runner terminal so a
      // later final answer can verify (or reject) a completion claim after resume.
      t.dispatch({
        t: 'delegation-status',
        toolCallId: completion.taskId,
        status:
          completion.status === 'done'
            ? 'completed'
            : completion.status === 'aborted'
              ? 'aborted'
              : 'failed',
        ...(completion.summary !== undefined ? { summary: completion.summary } : {}),
        ...(completion.error !== undefined ? { error: completion.error } : {}),
      });
      t.dispatch({ t: 'notice', text: noticeText });
      t.steer(steerText);
      // Wave 14 (b7): the live session surfaced this completion, so flip its durable
      // record delivered:true — a later resume's reconcile then finds delivered:true
      // and does NOT re-queue it (no double delivery). complete() wrote it delivered:false
      // precisely so a crash BEFORE this drain re-queues it on the next resume.
      if (completion.sessionId !== undefined) {
        backgroundAgents.markDelivered(completion.sessionId, completion.taskId);
      }
    }
  }, [backgroundAgents, bgVersion]);

  // Abort every still-running background task when App tears down (a detached
  // in-process loop cannot outlive the TUI; on-disk JSONL rehydrates last-known
  // state on resume).
  useEffect(() => {
    return () => {
      backgroundAgents?.abortAll();
    };
  }, [backgroundAgents]);

  // Wave 14 (b7): feed the active session id into the runner AFTER first paint, before
  // any user turn — so the very first spawn's durable record already carries the
  // session (and a /resume re-binds it). No-op when no runner / store is wired.
  useEffect(() => {
    backgroundAgents?.setSessionId(activeSessionId);
  }, [backgroundAgents, activeSessionId]);

  // Wave 14 (b7): crash-recovery reconcile for the active session. Reads the durable
  // records and (a) re-queues a done/error completion that finished but was never
  // drained to the user (a crash before the drain effect ran) through the SAME
  // wave-12 interjection seam, marking each delivered so a later resume won't double
  // it; (b) presents a task that was still 'running' when a prior process died as
  // honestly `aborted` (never a fake `done`) plus a guaranteed dim notice — the
  // PRIMARY visible surface, even for an interrupted task that made no tool call and
  // thus has no panel card. Interrupted tasks are NOT steered to the model (a
  // non-result should not re-enter a turn on resume); the reconcile return keeps them
  // separate so that decision is a one-line change here. Fail-soft throughout.
  useEffect(() => {
    if (!backgroundAgents) return;
    let cancelled = false;
    void (async () => {
      let res: Awaited<ReturnType<typeof backgroundAgents.reconcile>>;
      try {
        res = await backgroundAgents.reconcile(activeSessionId);
      } catch {
        return;
      }
      if (cancelled) return;
      const t = turnRef.current;
      for (const c of res.undeliveredCompletions) {
        const { steerText, noticeText } = formatCompletion(c);
        t.dispatch({ t: 'notice', text: noticeText });
        t.steer(steerText);
        if (c.sessionId !== undefined) backgroundAgents.markDelivered(c.sessionId, c.taskId);
      }
      if (res.interrupted.length > 0) {
        setInterruptedStatuses((prev) => {
          const next = { ...prev };
          for (const r of res.interrupted) next[r.taskId] = 'aborted';
          return next;
        });
        for (const r of res.interrupted) {
          // Item 3 consumer: append a truncated, single-line preview of the child's
          // durable partial output (text, falling back to reasoning) so an interrupted
          // task's work is surfaced for inspection, not silently dropped.
          let preview = '';
          try {
            const out = await backgroundAgents.readOutput(activeSessionId, r.taskId);
            if (cancelled) return;
            const body = out.text.length > 0 ? out.text : out.reasoning;
            const flat = body.replace(/\s+/g, ' ').trim().slice(0, 200);
            if (flat.length > 0) preview = ` — partial: "${flat}"`;
          } catch {
            // fail-soft: no preview.
          }
          t.dispatch({
            t: 'notice',
            text: `⚠ agent ${r.taskId} interrupted (ended before finishing)${preview}`,
          });
        }
      }
      if (res.needsUser.length > 0) {
        setInterruptedStatuses((prev) => {
          const next = { ...prev };
          for (const r of res.needsUser) next[r.taskId] = 'waiting';
          return next;
        });
        for (const r of res.needsUser) {
          t.dispatch({ t: 'notice', text: `⚠ agent ${r.taskId} needs approval; restart recovery is fail-closed (deny or rerun the task)` });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turnRef is a stable ref; re-run only on runner/session change.
  }, [backgroundAgents, activeSessionId]);

  // The runner's live task-status snapshot, recomputed when the version bumps. Fed
  // into useSubagentPanel to OVERRIDE a settled spawn card's rolled-up status so a
  // detached background agent reads 'running' until it actually finishes.
  const backgroundTaskStatus = useMemo(
    () =>
      backgroundAgents
        ? // Wave 14 (b7): merge reconcile-derived interrupted statuses OVER the live
          // snapshot. A live 'running' task never has an interrupted entry (reconcile
          // skips live ids), so the spread never mislabels a working task; an
          // interrupted task with no live entry gets its honest `aborted` glyph.
          { ...backgroundAgents.taskStatuses(), ...interruptedStatuses }
        : undefined,
    // `bgVersion` is the intentional external-store recompute key: `taskStatuses()`
    // reads the runner's internal task Map, which the rule can't see, so it flags the
    // dep as unnecessary. It IS the trigger that pulls a fresh snapshot when the runner
    // bumps its version — keep it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above
    [backgroundAgents, bgVersion, interruptedStatuses],
  );

  // The composer's submit entry point. `turn.submit` self-guards on `selectBusy` (so the
  // slash-overlay path, which has no busy gate of its own, can call it safely) and now
  // owns the whole busy lifecycle in the reducer: it dispatches turn-start ('preparing')
  // the instant it is invoked, which is what the pre-`assistant-start` busy line reads.
  // The extra `isBusy()` pre-check is belt-and-suspenders (the old useOptimisticTurn
  // wrapper had it) — it reads the same predicate submit guards on, so the two agree. No
  // optimistic flag / takeover effect is needed any more.
  const runSubmit = useCallback(
    (text: string) => {
      if (turn.isBusy()) return;
      void turn.submit(text);
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
    // Only the slash overlay owns composer text: it seeds/keeps a live
    // `/query` in `value` (composer focused); without this a bailed-out palette
    // ('/mod' + Esc) would leave that text prefixing the next message into a bogus
    // `/command` that submit silently drops. Non-slash overlays keep value empty, so
    // Other overlays may be opened over an in-progress draft, which must survive
    // dismissal (Ctrl+O and the agents panel are the important cases).
    if (turn.state.overlay === 'slash') setValue('');
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
    // A permission-gated spawn rolls up as `waiting` (never a spinning `running`) so the
    // agents panel and the transcript row agree it is blocked on the user, not working.
    // Sourced from the reducer-owned `pendingPermission` object (a2 replaced the flat
    // `state.pendingPermissionToolCallId` field with `{ toolCallId, risk }`).
    pendingPermissionToolCallId: turn.state.pendingPermission?.toolCallId ?? null,
    // Wave 13: override a settled spawn card's rolled-up status with the runner's
    // live task status so a detached background agent reads 'running' until done.
    ...(backgroundTaskStatus !== undefined ? { taskStatusOverride: backgroundTaskStatus } : {}),
  });
  const subagents = subagentPanel.subagents;
  const openAgentMessage = useCallback(() => {
    if (subagentPanel.selectedId === undefined) return;
    setValue('');
    turn.dispatch({ t: 'set-overlay', overlay: 'message-agent' });
  }, [subagentPanel.selectedId, turn]);
  const cancelSelectedAgent = useCallback(() => {
    const id = subagentPanel.selectedId;
    if (id === undefined) return;
    const cancelled = backgroundAgents?.cancel?.(id) ?? false;
    turn.dispatch({ t: 'notice', text: cancelled ? `⊘ cancelling agent ${id}` : `agent ${id} is already finished` });
  }, [backgroundAgents, subagentPanel.selectedId, turn]);
  const resolveSelectedAgentPermission = useCallback((decision: 'allow-once' | 'deny') => {
    const id = subagentPanel.selectedId;
    const resolved = id !== undefined && (backgroundAgents?.resolvePermission?.(id, decision) ?? false);
    if (resolved && decision === 'deny' && id !== undefined) {
      setInterruptedStatuses((prev) => ({ ...prev, [id]: 'error' }));
    }
    turn.dispatch({
      t: 'notice',
      text: resolved
        ? decision === 'allow-once' ? `permission granted once for agent ${id}` : `permission denied for agent ${id}`
        : `agent ${id ?? ''} has no live permission checkpoint`,
    });
  }, [backgroundAgents, subagentPanel.selectedId, turn]);

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
    onOpenSubagent: () => {
      setSubagentViewerScroll(0);
      subagentPanel.open();
    },
    onMessageSubagent: openAgentMessage,
    onCancelSubagent: cancelSelectedAgent,
    onResolveSubagentPermission: resolveSelectedAgentPermission,
    onMoveSubagentViewer: (delta) => setSubagentViewerScroll((n) => Math.max(0, n + delta)),
    onSubagentViewerBack: () => turn.dispatch({ t: 'set-overlay', overlay: 'subagents' }),
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
  // terminal BEL once when a turn GENUINELY completes. Keyed off the reducer's
  // completedTurns counter (not a phase edge) so an Esc-abort — which also lands at
  // idle — never rings. Called HERE so the effect keeps its exact pre-extraction slot.
  useCompletionBell({ completed: turn.state.completedTurns ?? 0, enabled: deps.settings.completionBell });

  // Terminal title (OSC 2) — reflect the turn's in-flight signal + phase in the
  // tab/window title so a backgrounded juno shows running / needs-input / idle at a
  // glance. `inFlight` (selectBusy) makes retry / preparing / compacting all read
  // 'running' too. TTY-gated and title-stack save/restore live inside the hook.
  useTerminalTitle({ inFlight: selectBusy(turn.state), phase: turn.state.phase, cwd: deps.settings.cwd });

  const permissionRequest = turn.permissionRequest;
  // Guard: if the reducer says overlay is 'permission' but we have no request to
  // render (race), fall back to 'none' so OverlayHost doesn't get an undefined prop.
  const effectiveOverlay =
    turn.state.overlay === 'permission' && permissionRequest === null
      ? 'none'
      : turn.state.overlay;

  // The tool-detail overlay's render props, built once so BOTH OverlayHost (below) and the
  // live-budget overlay-height reservation (computeLiveBudget) measure the SAME overlay — the
  // estimate can never drift from what actually paints.
  const toolDetailProps: ToolDetailOverlayProps = {
    view: toolDetail.view,
    // Detail view renders the id-PINNED call; list view the id-resolved highlight. Both
    // indices are re-derived from ids every render, so an insertion that reorders the list
    // can't swap what's shown.
    selectedIndex: toolDetail.view === 'detail' ? toolDetail.pinnedIndex : toolDetail.highlightIndex,
    entries: toolDetail.entries,
    scroll: toolDetail.scroll,
    rows,
    width: columns,
  };
  // Rows the currently-open OverlayHost overlay occupies in the dynamic region, reserved in the
  // live budget so a permission prompt / Ctrl+O overlay opened mid-turn can't push the region
  // past the viewport (Ink's scrollback-erasing repaint). Each overlay reports its OWN height so
  // estimator == renderer. Scoped to the two overlays that realistically open OVER a live turn
  // (permission, tool-detail); every other overlay is a composer-focused state opened with no /
  // short live turn, so it reserves 0 (documented in liveBudget.ts LiveBudgetInputs.overlayRows).
  const overlayRows =
    effectiveOverlay === 'permission' && permissionRequest !== null
      ? permissionPromptRows(permissionRequest, columns, rows)
      : effectiveOverlay === 'tool-detail'
        ? toolDetailOverlayRows(toolDetailProps, rows)
        : effectiveOverlay === 'subagent-viewer'
          ? subagentViewerViewportRows(rows) + 4
          : effectiveOverlay === 'message-agent'
            ? 1
        : 0;

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
        overlayForInput !== 'slash' &&
        overlayForInput !== 'message-agent'
      ) {
        return;
      }
      setValue(nextValue);
    },
    [inputHistory, value, overlayForInput],
  );

  // Stabilize the two InputBox callback props (render-efficiency, W6 item 1 phase-couple).
  // `handleInputChange` depends on the fresh-every-render `inputHistory` object, and
  // `submitRouting.submit` depends on `turn` (whose `.state` churns on every token flush) —
  // so both re-identify each render and would cascade a fresh onChange/onSubmit into the
  // memoized InputBox, falsifying its documented shallow-compare bail-out. The trampoline
  // keeps a stable identity while always calling the LATEST closure, so behavior is
  // identical and the composer's memo genuinely bails across a mid-turn flush.
  const onInputChange = useStableCallback(handleInputChange);
  const handleInputSubmit = useCallback((text: string): void => {
    if (turn.state.overlay !== 'message-agent') {
      submitRouting.submit(text);
      return;
    }
    const id = subagentPanel.selectedId;
    const sent = id !== undefined && (backgroundAgents?.sendMessage?.(id, text) ?? false);
    turn.dispatch({ t: 'notice', text: sent ? `→ message queued for agent ${id}` : `agent ${id ?? ''} is already finished` });
    setValue('');
    turn.dispatch({ t: 'set-overlay', overlay: 'subagent-viewer' });
  }, [backgroundAgents, subagentPanel.selectedId, submitRouting, turn]);
  const onInputSubmit = useStableCallback(handleInputSubmit);

  // Welcome banner: shown only on a fresh start (empty transcript, no live turn),
  // so the screen is never blank-then-box. The live-turn activity indicator drives
  // the single busy line between the transcript and the composer.
  const isFresh = turn.state.committed.length === 0 && turn.state.live === null;
  // Live-turn activity — now purely reducer-phase-derived. `submit` dispatches
  // turn-start ('preparing') synchronously, and selectActivity('preparing') yields the
  // same 'thinking…' line the old optimistic flag stood in for, so the pre-`assistant-
  // start` window is covered without any out-of-reducer state; a terminal phase
  // (idle/error) drops the line with no lingering spinner.
  const activity = selectActivity(turn.state);
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
    overlayRows,
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
        columns={columns}
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
        pendingPermissionToolCallId={turn.state.pendingPermission?.toolCallId ?? null}
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
                columns,
                query: pickers.slashQuery ?? undefined,
              }
            : undefined
        }
        modelPicker={
          effectiveOverlay === 'model-picker'
            ? { models, selectedId, rows, columns }
            : undefined
        }
        skillPicker={
          effectiveOverlay === 'skill-picker'
            ? { skills, selectedIndex: pickers.selectedSkillIndex, rows, columns }
            : undefined
        }
        sessionPicker={
          effectiveOverlay === 'session-picker'
            ? { sessions: sessionResume.sessions, selectedIndex: sessionResume.selectedSessionIndex, rows, columns }
            : undefined
        }
        permissionModePicker={
          effectiveOverlay === 'permission-mode'
            ? { selectedMode: pickers.selectedPermissionMode, rows, columns }
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
                rows,
                columns,
              }
            : undefined
        }
        toolDetail={effectiveOverlay === 'tool-detail' ? toolDetailProps : undefined}
        help={effectiveOverlay === 'help' ? { rows, columns } : undefined}
        subagentViewer={effectiveOverlay === 'subagent-viewer' ? {
          entry: subagents.find((entry) => entry.id === subagentPanel.selectedId),
          tools: subagentPanel.tools,
          rows,
          width: columns,
          scroll: subagentViewerScroll,
          ...(subagentPanel.selectedId !== undefined
            ? { checkpoint: backgroundAgents?.pendingPermission?.(subagentPanel.selectedId) }
            : {}),
        } : undefined}
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
        onChange={onInputChange}
        onSubmit={onInputSubmit}
        placeholder={INPUT_PLACEHOLDER}
        pasteActiveRef={pasteActiveRef}
        focus={effectiveOverlay === 'none' || effectiveOverlay === 'slash' || effectiveOverlay === 'message-agent'}
        onHistoryPrev={effectiveOverlay === 'none' ? inputHistory.prev : undefined}
        onHistoryNext={effectiveOverlay === 'none' ? inputHistory.next : undefined}
        onArrowDownAtBottom={effectiveOverlay === 'none' ? subagentPanel.focusFromComposer : undefined}
      />
      {effectiveOverlay === 'message-agent' ? <Text dimColor>{clipCells(`message agent ${subagentPanel.selectedId ?? ''} · enter send · esc cancel`, Math.max(1, columns - 1))}</Text> : null}
      <ComposerRule width={columns} />
      {/* Subagent panel (LANE B): the always-available strip sits BELOW the composer,
          beside the status line. Collapsed to one dim line when unfocused (nothing when
          the session has no subagents); expands into the per-agent status list when the
          'subagents' overlay is open (roster navigation plus recorder-backed viewing). A
          NEW sibling that touches no StatusLine/InputBox prop — their memo bail-outs are
          unaffected. */}
      <SubagentPanel
        entries={subagents}
        focused={turn.state.overlay === 'subagents'}
        width={columns}
        maxRows={subagentMaxRows}
        selectedIndex={subagentPanel.selectedIndex}
      />
      {ctrlcHint !== null ? <Text dimColor>{ctrlcHint}</Text> : null}
      <StatusLine status={status} width={columns} />
    </Box>
  );
}

export default App;
