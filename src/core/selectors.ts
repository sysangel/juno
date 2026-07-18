// src/core/selectors.ts
// W3-PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No React/Ink imports; pure functions over State. Flagged as proposed in NOTES.
import type { Msg, State, ToolState } from './reducer';
import type { TurnMessage } from './contracts';
import { isAbortReason } from './abort';

// Re-exported so the transcript renderer (Message.tsx, which already imports from this
// module) classifies an abort with the SAME predicate the panel selector uses — one
// source of truth, no drift on the abort literals.
export { isAbortReason };

export interface TokenBar {
  in: number;
  out: number;
  total: number;
}

export interface CostState {
  /** USD cost of the session so far: cumulative input cost + output cost. */
  usd: number;
}

/**
 * Async MCP connect state (Wave 2 async-mcp), surfaced in the status strip while
 * the fleet connects in the background. `connecting` before `start()` resolves;
 * `ready` when every configured server came up; `partial` when some but not all
 * did; `failed` when none did. State-carrying (drives the amber/red mcp chip) —
 * exempt from the uniform-dim rule; App owns it (not the reducer).
 */
export interface McpConnectionState {
  state: 'connecting' | 'ready' | 'partial' | 'failed';
  /** Servers that connected AND listed their tools. */
  connected: number;
  /** Total configured servers (the denominator for the `partial` chip). */
  total: number;
}

/**
 * Live context-window occupancy for the monitor chip — "how full is the window
 * RIGHT NOW," the number the user watches to decide when to `/clear` or `/compact`.
 */
export interface ContextWindowState {
  /** Tokens currently occupying the window (the last request's full input, or the estimate). */
  used: number;
  /** The active model's context window size (denominator). */
  max: number;
  /** `used / max`, clamped to [0, 1]. */
  fraction: number;
  /**
   * True when `used` is the char/4 ESTIMATE rather than a real provider measurement
   * (before the first turn, or right after clear/compact/resume). Lets the UI flag it.
   */
  estimated: boolean;
}

export interface StatusLineState {
  model: string;
  cwd: string;
  tokens: TokenBar;
  /** Fraction of the context window used, clamped to [0, 1]. */
  contextFraction: number;
  effort: State['effort'];
  overlay: State['overlay'];
  phase: State['phase'];
  statusText: string;
  pendingPermissionToolCallId: string | null;
  /** Names of the skills available this session (render-only indicator). */
  skills?: ReadonlyArray<string>;
  /** Active permission mode (only non-default values render a chip). */
  permissionMode?: 'default' | 'acceptEdits';
  /**
   * Estimate-based context pressure in [0,1] over the CURRENT committed transcript
   * (what gets RE-SENT next turn) — distinct from `contextFraction`, which is keyed
   * to lifetime cumulative `tokens`. Drives the compaction-aware bar tint.
   */
  contextPressure?: number;
  /** Number of compactions performed this session (renders a `cmp:<n>` chip when > 0). */
  compactions?: number;
  /**
   * Live context-window occupancy (real measurement when available, estimate otherwise).
   * Drives the `ctx:<used>/<max> <pct>%` monitor chip and the context bar's fill + tint.
   */
  contextWindow: ContextWindowState;
  /**
   * True while an auto/manual compaction LLM call is in flight. Render-only: it makes
   * the otherwise-silent compaction window VISIBLE (the `cmp` chip switches to an active
   * `compacting…` form) so a submit dropped during the window is no longer invisible.
   */
  isCompacting?: boolean;
  /**
   * Per-turn tool-call budget for the iteration guard. `used` is the running count this turn;
   * `max` is the configured ceiling (undefined => unbounded). Render-only: the StatusLine shows
   * a `tools:used/max` chip (warn tint near the limit) only when a ceiling is set and used > 0,
   * so the runaway guard is VISIBLE rather than silent.
   */
  toolBudget?: { used: number; max?: number };
  /**
   * Cumulative session USD cost derived from the session's total tokens × the
   * active model's pricing. Absent when the model has no per-token price
   * (subscription backend) — the chip then renders nothing. Render-only.
   */
  cost?: CostState;
  /**
   * Async MCP connect state (Wave 2 async-mcp). Present only when MCP servers are
   * configured; drives the state-carrying `mcp` chip (connecting/partial/failed;
   * a fully-`ready` fleet renders no chip). Absent ⇒ no chip. Render-only.
   */
  mcp?: McpConnectionState;
}

/**
 * Compaction trigger default: summarize once the estimated re-sent transcript crosses
 * 50% of `maxContext`. Tunable via config (`compactionThreshold`).
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.5;

/**
 * Context-window monitor tint thresholds (fractions of the window). At/above WARN
 * the chip + bar go amber (a good "consider clearing soon" line, aligned with the
 * default compaction threshold); at/above DANGER they go red ("clear now").
 */
export const CONTEXT_WARN_FRACTION = 0.5;
export const CONTEXT_DANGER_FRACTION = 0.8;

/** Default context window when the caller threads no model-specific size. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Floor on committed length before compaction is allowed. Below this, a compaction
 * could not meaningfully shrink the transcript (summary + tail ≈ original), so the
 * trigger stays off regardless of pressure.
 */
export const MIN_MESSAGES_TO_COMPACT = 4;

/** Rough per-message framing overhead (role tags / delimiters), in estimated tokens. */
const PER_MSG_OVERHEAD = 4;
/** Rough per-tool-block cost (tool name + arg framing), in estimated tokens. */
const PER_TOOL_BLOCK = 6;

/**
 * ESTIMATE (not a real tokenizer) of the transcript that `toTurnMessages` will
 * RE-SEND next turn: sum over committed messages of `ceil(textLen/4) + overhead`,
 * plus a small constant per tool block. `char/4` is the standard rough token
 * heuristic. Pure — no React, no import of the hook's `textFromBlocks`.
 *
 * Deliberately keyed to `state.committed` (current transcript), NOT to `state.tokens`
 * (lifetime cumulative spend, which over-counts re-sends and never falls after a
 * compaction). After a compaction `committed` shrinks, so this drops and the trigger
 * self-clears.
 */
export function estimateMessageTokens(msg: Msg): number {
  let textLen = 0;
  let toolBlocks = 0;
  let wireBlocks = 0;
  for (const block of msg.blocks) {
    // `notice` blocks (F) are local UI feedback — the `session cleared`/`compacted`
    // lines — that `toTurnMessages` never sends to the model. They occupy no context
    // window, so they must not contribute to the occupancy estimate (a lone `session
    // cleared` notice after /clear must leave the ctx chip at zero occupancy).
    if (block.kind === 'notice') continue;
    // A resumed `unknown` passthrough block is never sent to the model
    // (`toTurnMessages` strips it), so it must cost 0 — neither a wire block nor a
    // tool block — or the ctx chip inflates after a forward-compat resume.
    if (block.kind === 'text') {
      wireBlocks += 1;
      textLen += block.text.length;
    } else if (block.kind === 'tool') {
      wireBlocks += 1;
      toolBlocks += 1;
    }
  }
  // A message with no wire-bound content (e.g. a pure `notice`) costs nothing.
  if (wireBlocks === 0) return 0;
  return Math.ceil(textLen / 4) + PER_MSG_OVERHEAD + toolBlocks * PER_TOOL_BLOCK;
}

export function estimateTranscriptTokens(state: State): number {
  let total = 0;
  for (const msg of state.committed) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * ESTIMATE of one wire-shaped `TurnMessage` (the coordinator/turnRunner transcript
 * type), the analog of `estimateMessageTokens` for the mid-turn re-entry loop where
 * only `TurnMessage[]` is in hand (never the reducer `Msg`). Same `char/4 + overhead`
 * heuristic and the SAME `PER_MSG_OVERHEAD`/`PER_TOOL_BLOCK` constants, so the mid-turn
 * pressure gauge reads on the same scale as the idle committed-transcript meter.
 *
 * `content` covers every variant's payload (a `tool` message's `content` is its
 * serialized result string); only an `assistant` message's `toolCalls` add per-tool
 * framing, mirroring the reducer estimate's per-tool-block cost.
 */
export function estimateTurnMessageTokens(m: TurnMessage): number {
  const toolBlocks = m.role === 'assistant' ? (m.toolCalls?.length ?? 0) : 0;
  return Math.ceil(m.content.length / 4) + PER_MSG_OVERHEAD + toolBlocks * PER_TOOL_BLOCK;
}

/** Sum `estimateTurnMessageTokens` over a `TurnMessage[]` transcript (mid-turn gauge). */
export function estimateTurnTranscriptTokens(msgs: TurnMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateTurnMessageTokens(m);
  }
  return total;
}

/** Estimate-based context pressure in [0,1] over the current committed transcript. */
export function selectContextPressure(state: State, maxContext = 1_000_000): number {
  if (maxContext <= 0) return 0;
  return Math.min(1, estimateTranscriptTokens(state) / maxContext);
}

/**
 * Whether the harness should compact now: pressure at/over `threshold` AND enough
 * committed messages to shrink. Pure + side-effect-free; the compactor (Unit 2) is
 * the sole caller for the auto path and owns the actual summarize/dispatch.
 */
export function shouldCompact(
  state: State,
  maxContext: number,
  threshold = DEFAULT_COMPACTION_THRESHOLD,
): boolean {
  return (
    selectContextPressure(state, maxContext) >= threshold &&
    state.committed.length > MIN_MESSAGES_TO_COMPACT
  );
}

export function selectTokenBar(state: State): TokenBar {
  return { in: state.tokens.in, out: state.tokens.out, total: state.tokens.in + state.tokens.out };
}

/**
 * Pure cumulative session USD cost, priced against `pricing`.
 *
 * Uses `state.tokens` — the cumulative session totals — consistent with the
 * `tok:total` chip the StatusLine already shows. (A true per-turn delta would
 * need a new State field / reducer change, which is a frozen-seam touch and is
 * therefore out of scope; this selector reads only the existing cumulative
 * totals and touches no frozen file.)
 *
 * Returns undefined when `pricing` is absent (e.g. the subscription claude-cli
 * backend) so the caller hides the chip rather than rendering a misleading $0.00.
 */
export function selectCost(
  state: State,
  pricing?: { inputPerMTok: number; outputPerMTok: number },
): CostState | undefined {
  if (pricing === undefined) return undefined;
  const usd =
    (state.tokens.in / 1_000_000) * pricing.inputPerMTok +
    (state.tokens.out / 1_000_000) * pricing.outputPerMTok;
  return { usd };
}

/** Context-bar fraction. `max` defaults to a placeholder until config supplies the real window. */
export function selectContextFraction(state: State, max = 128000): number {
  if (max <= 0) return 0;
  return Math.min(1, (state.tokens.in + state.tokens.out) / max);
}

/**
 * Live context-window occupancy: the REAL measured input size of the most recent
 * request (`state.contextWindowTokens`) when present, else the char/4 transcript
 * ESTIMATE. This — NOT the cumulative `tokens.in+out` of `selectContextFraction`,
 * which over-counts every re-sent turn — is the quantity that answers "how full is
 * the window now." `max` is the active model's context window.
 */
export function selectContextWindow(state: State, max = DEFAULT_CONTEXT_WINDOW): ContextWindowState {
  const estimated = state.contextWindowTokens === undefined;
  const used = state.contextWindowTokens ?? estimateTranscriptTokens(state);
  const fraction = max <= 0 ? 0 : Math.min(1, used / max);
  return { used, max, fraction, estimated };
}

export function selectEffort(state: State): State['effort'] {
  return state.effort;
}

export function selectOverlay(state: State): State['overlay'] {
  return state.overlay;
}

export function selectPhase(state: State): State['phase'] {
  return state.phase;
}

export function selectPendingPermission(state: State): string | null {
  return state.pendingPermissionToolCallId;
}

/**
 * The live-turn activity indicator (status-strip item D). Non-null ONLY while a
 * turn is in flight — drives the single busy line above the composer
 * (`<spinner> <label> · <n>s · esc to abort`). Pure/phase-derived so the label
 * table is unit-testable without rendering.
 *
 * Honest state mapping (Tour finding): a gated tool is NEVER shown as running —
 * `awaiting-permission` yields `waiting on permission`, distinct from
 * `running-tool`. `streaming` splits thinking (no visible text yet) vs responding
 * (the live message has emitted prose) purely from the live block contents.
 */
export interface ActivityState {
  /** e.g. 'thinking…' | 'responding…' | 'running grep…' | 'waiting on permission'. */
  label: string;
  /** True while the turn can be aborted with Esc (every in-flight phase). */
  abortable: boolean;
  /** True for the amber attention state (a permission prompt is open). */
  attention: boolean;
}

/** First tool currently in the `running` status, if any (drives `running <name>…`). */
function runningToolName(state: State): string | undefined {
  for (const tool of Object.values(state.tools)) {
    if (tool.status === 'running') return tool.name;
  }
  return undefined;
}

/** Compact backoff label for the retry busy line: `2s` / `500ms` (one decimal for
 * sub-10s seconds, e.g. `1.5s`). Pure — no clock, no locale. */
export function formatBackoff(ms: number): string {
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function selectActivity(state: State): ActivityState | null {
  // Wave 13 (retry-ui): a live pre-first-byte transport retry OUTRANKS the phase
  // mapping. It is checked FIRST and phase-independently because during the backoff
  // the phase is idle (initial call) or stale-streaming (tool_use re-entry) — a
  // phase switch alone would miss both windows. A retry cannot co-exist with an open
  // permission prompt (it fires strictly before any assistant output), so precedence
  // over `awaiting-permission` is moot. Cleared by assistant-start/error/aborted.
  if (state.retry !== undefined) {
    return {
      label: `retrying ${state.retry.attempt}/${state.retry.max} · ${formatBackoff(state.retry.delayMs)} backoff`,
      abortable: true,
      attention: false,
    };
  }
  switch (state.phase) {
    case 'idle':
    case 'error':
      return null;
    case 'awaiting-permission':
      return { label: 'waiting on permission', abortable: true, attention: true };
    case 'running-tool': {
      const name = runningToolName(state);
      return {
        label: name !== undefined ? `running ${name}…` : 'running tool…',
        abortable: true,
        attention: false,
      };
    }
    case 'streaming': {
      const hasText =
        state.live?.blocks.some((block) => block.kind === 'text' && block.text.length > 0) ?? false;
      return { label: hasText ? 'responding…' : 'thinking…', abortable: true, attention: false };
    }
  }
}

/**
 * True iff `tool`'s `parentToolUseId` chain reaches `ancestorId`. A visited-set bounds
 * a cyclic or duplicated chain so a malformed stream can never loop the walk (the same
 * malformed-input contract the nested renderer holds).
 */
function descendantOf(
  tools: Record<string, ToolState>,
  tool: ToolState,
  ancestorId: string,
): boolean {
  const visited = new Set<string>();
  let parentId = tool.parentToolUseId;
  while (parentId !== undefined) {
    if (parentId === ancestorId) return true;
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    parentId = tools[parentId]?.parentToolUseId;
  }
  return false;
}

/**
 * Live per-subagent activity rollup (wave-6 lane C). Given the parent subagent's
 * tool-call id, returns a one-line label for what THAT subagent is doing right now,
 * derived from its RUNNING descendants in `state.tools`: `running <tool>…` for the
 * newest running descendant, or the `working…` fallback when it has no running child
 * at this instant (it just spawned, or sits between tool calls). The descendant test
 * walks the `parentToolUseId` chain, so a running grandchild's activity is still
 * attributed to the top-ancestor Agent card (a subagent that itself spawned one).
 *
 * "Newest" = last in `state.tools` iteration order: the reducer appends new tools and
 * updates existing ones in place, so insertion order is creation order.
 *
 * Works on BOTH subagent paths. On claude-cli a subagent's child tool calls land in
 * the main `state.tools` (carrying `parentToolUseId`) natively. On the raw-API /
 * cross-provider path the juno-side orchestrator (`src/tools/subagentTool.ts`)
 * re-emits each child tool event into the SAME stream with `parentToolUseId` set (and
 * a namespaced child id), so those descendants are equally real here — the
 * `working…` fallback now only shows in the genuine gap between a spawn and its first
 * child tool call (or for a child doing text-only work).
 */
export function runningChildActivity(state: Pick<State, 'tools'>, parentToolCallId: string): string {
  let newest: ToolState | undefined;
  for (const tool of Object.values(state.tools)) {
    if (tool.status !== 'running') continue;
    if (!descendantOf(state.tools, tool, parentToolCallId)) continue;
    newest = tool;
  }
  return newest !== undefined ? `running ${newest.name}…` : 'working…';
}

/**
 * Tool names that spawn a subagent: claude-cli's native `Agent`/`Task`, and juno's
 * portable `spawn_subagent`. Shared by the renderer (nested-card suppression) and the
 * subagent-browser selectors so "what counts as a subagent" is defined in ONE place.
 */
export function isSubagentToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'agent' || lower === 'task' || lower === 'spawn_subagent';
}

/** One browsable subagent, rolled up from `state.tools` for the below-composer panel. */
export interface SubagentEntry {
  /**
   * The spawning tool-use id. Equals the parent tool card's `toolCallId`, the value
   * its children carry as `parentToolUseId`, AND the recorder JSONL basename
   * (`<sessionId>.subagents/<id>.jsonl`) — so the panel row, its live children, and the
   * durable on-disk record all key off this one id.
   */
  readonly id: string;
  /** Parent tool name (`Agent` / `Task` / `spawn_subagent`). */
  readonly name: string;
  /** Human description from the spawn args (`task`/`description`/`prompt`), else the name. */
  readonly description: string;
  /** Child model id / `subagent_type`, when the spawn args carry one. */
  readonly model?: string;
  /**
   * The backend the subagent ran on (raw `entry.provider`; classify with `providerKindOf`),
   * when known — the juno orchestrator resolves it at the spawn source and it survives on the
   * settled spawn card's result (live) or its rehydrated `provider` field (resume). Absent
   * for a still-running or native claude-cli subagent. Lets the panel tag a rehydrated
   * cross-provider subagent with the CLI it actually used, honestly (decision d).
   */
  readonly provider?: string;
  /**
   * Rolled-up lifecycle status (drives the strip's `running/done` counts + the row glyph).
   * `aborted` is a cancel (user Esc/Ctrl+C or a parent-abort cascade) split OUT of `error`
   * so a benign cancel reads with a neutral glyph instead of a red FAIL — see
   * `isAbortReason`. A genuine failure stays `error`.
   */
  readonly status: 'running' | 'error' | 'aborted' | 'done';
  /** Direct child tool-call count recorded so far (the row's "N steps"). */
  readonly childCount: number;
  /** Live rollup label (`running <tool>…` / `working…`); meaningful only while running. */
  readonly runningLabel: string;
  /**
   * ERROR or ABORTED only: the first line of the parent card's `ToolState.error` — the
   * failure reason, or for a cancel the abort marker (`interrupted` / `sub-agent aborted`).
   * The expanded dropdown row shows it as the exit tag IN PLACE of the step count, so a
   * settled-not-clean row never reads like a clean finish (`fake · 1 step`) — the exit
   * reason is on the dropdown row too, not only the transcript spawn card. Absent for
   * running/done.
   */
  readonly reason?: string;
}

/** Pull a `{ description, model }` pair out of a spawn/Agent tool call's args.
 * Exported so the transcript renderer can label a subagent's per-agent status row
 * off the same field grammar the panel uses. */
export function describeSubagent(tool: ToolState | undefined): { description?: string; model?: string } {
  const args = tool?.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  const record = args as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  };
  // juno `spawn_subagent` → { task, model, agent }; claude-cli Agent/Task →
  // { description, prompt, subagent_type }. Cover both.
  return {
    ...(pick('description', 'task', 'prompt') !== undefined
      ? { description: pick('description', 'task', 'prompt') }
      : {}),
    ...(pick('model', 'subagent_type') !== undefined ? { model: pick('model', 'subagent_type') } : {}),
  };
}

/**
 * The backend a subagent ran on, if durably known. The juno orchestrator stamps
 * `entry.provider` at the spawn source (decision d), so it surfaces two equivalent ways: on a
 * RESUMED card the reader rehydrates it as `card.provider`; on a LIVE card it rides the settled
 * spawn result's `{ …, provider }` (`subagentTool`). Prefer the rehydrated field, then the
 * result. Undefined while running, or for a native claude-cli subagent (no juno result). */
export function subagentProvider(card: ToolState | undefined): string | undefined {
  if (card === undefined) return undefined;
  if (typeof card.provider === 'string' && card.provider.length > 0) return card.provider;
  const result = card.result;
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const provider = (result as Record<string, unknown>).provider;
    if (typeof provider === 'string' && provider.length > 0) return provider;
  }
  return undefined;
}

/**
 * Roll `state.tools` up into the browsable subagent list for the subagent-browser
 * panel (LANE B). A "subagent" is any tool card that is EITHER named like a spawn
 * (`isSubagentToolName`) OR referenced as some other card's `parentToolUseId` — so a
 * just-spawned subagent with no children yet still lists, and an orphan-parent id never
 * does. Rows are returned in creation order (Object insertion order = the reducer's
 * append order), which reads like a task list.
 *
 * PURE and live: it derives entirely from the live `tools` map (the same tool events the
 * recorder persists), so a child tool-call landing re-rolls the list for free on the next
 * render — no polling, no disk read. The on-disk `<id>.jsonl` remains the durable mirror.
 */
export function selectSubagents(state: Pick<State, 'tools'>): SubagentEntry[] {
  const tools = state.tools;
  // Parent ids referenced by at least one child that still exists in the map.
  const referenced = new Set<string>();
  const directChildCount = new Map<string, number>();
  for (const tool of Object.values(tools)) {
    const parent = tool.parentToolUseId;
    if (parent !== undefined && tools[parent] !== undefined) {
      referenced.add(parent);
      directChildCount.set(parent, (directChildCount.get(parent) ?? 0) + 1);
    }
  }

  const entries: SubagentEntry[] = [];
  for (const [id, card] of Object.entries(tools)) {
    if (!isSubagentToolName(card.name) && !referenced.has(id)) continue;
    // A card lands on ToolStatus 'error' for BOTH a genuine failure and a cancel (turn-level
    // Esc/Ctrl+C → 'interrupted', or a parent-abort cascade → 'sub-agent aborted'). Split the
    // cancel out to 'aborted' via the shared predicate so it renders with a neutral glyph
    // instead of a red FAIL; a real failure stays 'error'.
    const status: SubagentEntry['status'] =
      card.status === 'error'
        ? isAbortReason(card.error)
          ? 'aborted'
          : 'error'
        : card.status === 'running' || card.status === 'pending'
          ? 'running'
          : 'done';
    const { description, model } = describeSubagent(card);
    const provider = subagentProvider(card);
    // ERROR/ABORTED rows carry the first line of the card's `error` (the failure reason, or
    // the abort marker) so the dropdown row can print WHY (not a step count). Falls back to
    // 'failed' when an error status somehow carried no message, so the tag is never empty.
    const reason =
      status === 'error' || status === 'aborted'
        ? (card.error ?? '').split('\n')[0]?.trim() || 'failed'
        : undefined;
    entries.push({
      id,
      name: card.name,
      description: description ?? card.name,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      status,
      childCount: directChildCount.get(id) ?? 0,
      runningLabel: runningChildActivity(state, id),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return entries;
}

/** Human-readable status for the StatusLine, derived purely from phase. */
export function selectStatusText(state: State): string {
  switch (state.phase) {
    case 'idle':
      return 'idle';
    case 'streaming':
      return 'thinking…';
    case 'awaiting-permission':
      return 'awaiting permission';
    case 'running-tool':
      return 'running tool…';
    case 'error':
      return state.errorMessage ?? 'error';
  }
}

/**
 * Bundle for the StatusLine. `model`/`cwd` are runtime/config concerns the UI
 * passes in (the reducer doesn't own them), with safe placeholders.
 */
export function selectStatusLine(
  state: State,
  context: {
    model?: string;
    cwd?: string;
    maxContext?: number;
    skills?: ReadonlyArray<string>;
    permissionMode?: 'default' | 'acceptEdits';
    isCompacting?: boolean;
    toolBudget?: { used: number; max?: number };
    pricing?: { inputPerMTok: number; outputPerMTok: number };
    mcp?: McpConnectionState;
  } = {},
): StatusLineState {
  return {
    model: context.model ?? 'fake',
    cwd: context.cwd ?? '.',
    tokens: selectTokenBar(state),
    contextFraction: selectContextFraction(state, context.maxContext),
    effort: state.effort,
    overlay: state.overlay,
    phase: state.phase,
    statusText: selectStatusText(state),
    pendingPermissionToolCallId: state.pendingPermissionToolCallId,
    skills: context.skills,
    permissionMode: context.permissionMode,
    contextPressure: selectContextPressure(state, context.maxContext),
    contextWindow: selectContextWindow(state, context.maxContext),
    compactions: state.compactions ?? 0,
    isCompacting: context.isCompacting ?? false,
    toolBudget: context.toolBudget,
    cost: selectCost(state, context.pricing),
    mcp: context.mcp,
  };
}
