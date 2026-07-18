// src/app/deps.ts
// W9 app-decompose — the App component's dependency contract, moved verbatim
// from app.tsx. This is the composition seam between cli.ts (which assembles
// every service) and the App tree (which only consumes them); app.tsx
// re-exports the type so existing imports ('./app' / '../src/app') keep
// working unchanged.
import type { ModelClient, PermissionPolicy, Tool, ToolSpec } from '../core/contracts';
import type { ToolState } from '../core/reducer';
import type { Settings, McpServerConfig } from '../services/config';
import type { ModelCatalog, ModelEntry } from '../services/catalog';
import type { McpManager } from '../services/mcpManager';
import type { SessionStore } from '../services/sessions';
import type { SubagentRecorder } from '../services/subagentRecorder';

export interface AppDeps {
  /**
   * Build a ModelClient for the SELECTED catalog entry. Replaces the old
   * build-once-at-startup `client`: each entry can belong to a different
   * provider, so the client must be (re)built from the chosen entry's provider
   * — otherwise a foreign slug would be sent to the startup provider's endpoint
   * (cross-provider 404/401/400). cli.ts closes over provider config / env /
   * fetch; App only hands it the entry.
   *
   * Wave 13 (retry-ui): the optional `onRetry` observer lets App receive
   * `retryFetch`'s pre-first-byte backoff callbacks (bridged to a `retry-attempt`
   * reducer action). Optional so back-compat callers/tests that omit it still compile.
   */
  readonly createClient: (
    entry: ModelEntry,
    onRetry?: (attempt: number, max: number, delayMs: number) => void,
  ) => ModelClient;
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
