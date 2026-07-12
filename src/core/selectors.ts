// src/core/selectors.ts
// W3-PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No React/Ink imports; pure functions over State. Flagged as proposed in NOTES.
import type { Msg, State, ToolState } from './reducer';

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
    wireBlocks += 1;
    if (block.kind === 'text') {
      textLen += block.text.length;
    } else {
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

export function selectActivity(state: State): ActivityState | null {
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
 * claude-cli path ONLY. There, a subagent's child tool calls DO land in the main
 * `state.tools` (carrying `parentToolUseId`), so this rollup is real. The raw-API
 * subagent path dispatches its inner turn through a LOCAL reducer
 * (`src/tools/subagentTool.ts`) that never reaches `state.tools`, so it has no running
 * descendants here and honestly falls back to `working…`. Surfacing a live rollup for
 * the raw-API path is a state-design change (rewiring that local dispatch) — deferred
 * this wave; the fallback is the honest, non-papered-over behaviour.
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
