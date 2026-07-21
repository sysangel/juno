// src/ui/workspace/types.ts
// The Observatory's VIEW-MODEL boundary — the full vocabulary the orchestration
// workspace renders, expressed as plain serializable data. Codex adapts live runner
// state INTO these shapes; the components in this directory never reach into stores,
// hooks, or services, so the adapter can evolve without touching the UI.
//
// Two invariants the types encode on purpose:
//   - Time is TEXT. `elapsed`/`terminal` arrive preformatted ('42s', 'exit 1') so the
//     workspace holds no clock and renders deterministically — the sole animation in
//     the whole surface is the one spinner the selected stream header may show.
//   - Status is the shared {@link PresentedStatus} vocabulary from core, so every
//     glyph/colour decision routes through the same presentation seam
//     (glyphs.presentedStatusToken et al.) as the rest of juno's surfaces.
import type { PresentedStatus } from '../../core/selectors';

/** Lifecycle of one orchestrated agent, reusing juno's shared presented vocabulary:
 *  'queued' | 'waiting' | 'running' | 'done' | 'error' | 'aborted' | 'declined'. */
export type WorkspaceAgentStatus = PresentedStatus;

/**
 * One agent on the ORBIT RAIL — the compact one-line presence every non-selected
 * agent keeps. Provenance is textual on purpose (colour never encodes model
 * identity): `model` is the model/backend name, `provider` the short delegate label
 * (e.g. 'codex cli'). Exactly one of `elapsed`/`terminal` is expected at a time —
 * `elapsed` while running, `terminal` once settled — but the row renders whichever
 * is present and stays truthful if the adapter sends neither.
 */
export interface OrbitAgentVM {
  readonly id: string;
  /** Concise human label for the agent's task (clipped by the rail, never wrapped). */
  readonly label: string;
  readonly status: WorkspaceAgentStatus;
  /** Textual model provenance, e.g. 'fable-mini'. */
  readonly model?: string;
  /** Textual provider provenance, e.g. 'codex cli' / 'claude cli' / 'api'. */
  readonly provider?: string;
  /** Preformatted running elapsed, e.g. '42s'. Rendered dim after the provenance. */
  readonly elapsed?: string;
  /** Preformatted terminal state, e.g. 'done 84s' / 'exit 1' / 'cancelled'. */
  readonly terminal?: string;
  /** True when the agent needs the user (permission gate, steering request). The row
   *  gains a trailing warning `!` and the header counts it under "need input". */
  readonly attention?: boolean;
}

/** Assistant prose from the selected agent (may be multi-line; wrapped + row-capped). */
export interface AssistantTextEventVM {
  readonly kind: 'assistant';
  readonly id: string;
  readonly text: string;
}

/** Extended-thinking excerpt. Rendered RESTRAINED: dim italic under a ✻ marker,
 *  capped to two rows — presence over content. */
export interface ReasoningEventVM {
  readonly kind: 'reasoning';
  readonly id: string;
  readonly text: string;
}

/** One tool call/status card, pre-summarised by the adapter (activity + outcome in
 *  `detail`). `provenance` is the textual `via …` marker from providerKind. */
export interface ToolEventVM {
  readonly kind: 'tool';
  readonly id: string;
  readonly name: string;
  readonly status: WorkspaceAgentStatus;
  readonly detail?: string;
  readonly provenance?: string;
}

/** A user steering message injected into the agent's run. */
export interface SteeringEventVM {
  readonly kind: 'steering';
  readonly id: string;
  readonly text: string;
}

/** A permission checkpoint and its (possibly still pending) outcome. */
export interface PermissionEventVM {
  readonly kind: 'permission';
  readonly id: string;
  readonly toolName: string;
  readonly risk?: string;
  readonly resolution: 'pending' | 'granted' | 'denied';
}

/** Lifecycle / terminal notice ('spawned', 'agent completed · exit 0', …). */
export interface LifecycleEventVM {
  readonly kind: 'lifecycle';
  readonly id: string;
  readonly text: string;
  readonly tone: 'neutral' | 'success' | 'error';
}

/** The ordered stream vocabulary of the selected agent — a discriminated union so
 *  the renderer's switch is exhaustive and a new kind fails the build, not the UI. */
export type WorkspaceStreamEventVM =
  | AssistantTextEventVM
  | ReasoningEventVM
  | ToolEventVM
  | SteeringEventVM
  | PermissionEventVM
  | LifecycleEventVM;

/** The one agent shown at FULL fidelity: identity + task header over its ordered
 *  event stream. Provenance/timing fields mirror {@link OrbitAgentVM}. */
export interface SelectedAgentVM {
  readonly id: string;
  /** Identity line — the agent's name/handle (e.g. 'auth-fixer', 'agent #3'). */
  readonly title: string;
  /** The full task text (long-safe: clipped to one row by the header). */
  readonly task: string;
  readonly status: WorkspaceAgentStatus;
  readonly model?: string;
  readonly provider?: string;
  readonly elapsed?: string;
  readonly terminal?: string;
  readonly events: readonly WorkspaceStreamEventVM[];
}

/** One advertised key in the command footer, e.g. { key: 'tab', action: 'focus' }. */
export interface WorkspaceKeyHint {
  readonly key: string;
  readonly action: string;
}

/** Which pane owns keyboard focus (visualised, never inferred — supplied by props). */
export type WorkspaceFocus = 'orbit' | 'stream';

/** Which single surface the narrow (<{@link WIDE_MIN_COLUMNS} cols) layout drills
 *  into. Chosen by the integrator via props; the workspace never self-navigates. */
export type WorkspacePane = 'orbit' | 'stream';

/**
 * Props of the top-level {@link OrchestrationWorkspace}. `rows` is the TOTAL row
 * budget the integrator grants; the workspace renders AT MOST `rows - 1` lines so it
 * never intentionally occupies the terminal's final row (the classic scroll-jiggle
 * trigger). `columns` decides wide (two-pane, >= {@link WIDE_MIN_COLUMNS}) vs narrow
 * (single drill-in pane per `narrowPane`).
 */
export interface OrchestrationWorkspaceProps {
  readonly rows: number;
  readonly columns: number;
  readonly agents: readonly OrbitAgentVM[];
  readonly selectedAgentId?: string;
  readonly selected?: SelectedAgentVM;
  readonly focus: WorkspaceFocus;
  readonly narrowPane: WorkspacePane;
  /** Row offset from the live tail for browsing the selected agent's stream. */
  readonly streamScrollRows?: number;
  /** Transient action/interrupt feedback shown in place of key hints. */
  readonly notice?: string;
  /** Footer key hints, in display order. The footer advertises ONLY what it is given. */
  readonly keys: readonly WorkspaceKeyHint[];
  /** Optional session label rendered dim beside the brand (e.g. 'wave-9 · juno'). */
  readonly sessionLabel?: string;
  /** Colour depth override (tests pass 'ansi16'); defaults to detection at the edge. */
  readonly depth?: import('../theme').ColorDepth;
}

/** Column threshold at/above which the two-pane overview+stream layout renders. */
export const WIDE_MIN_COLUMNS = 110;
