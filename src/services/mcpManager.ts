// src/services/mcpManager.ts
// Owns EVERY configured MCP server connection — Wave 2 of the MCP client. Where
// mcpClient.ts is one server, the manager is the fleet: it connects them all in
// PARALLEL, tolerates any one failing (fail-soft: a dead/slow server is skipped
// with a collected warning, never thrown), and exposes the union of their tools
// each tagged with its origin server, plus a `callTool(server, tool, args)`
// dispatch and a `shutdownAll()` teardown.
//
// No UI/registry wiring lives here (a later wave adapts discovered tools into
// juno Tool specs); this layer is purely the connection + discovery substrate,
// and — like its per-server connections — it never throws across its boundary.

import type { RiskLevel } from '../core/events';
import { classifyRisk } from '../tools/mcpTools';
import type { TimerHandle } from './brain';
import type { McpServerConfig } from './config';
import {
  createMcpClientConnection,
  type McpCallToolOutcome,
  type McpClientConnection,
  type McpClientDeps,
  type McpToolInfo,
} from './mcpClient';

/**
 * Bounded exponential-backoff reconnect policy for a server that DROPS mid-session
 * (the transport `onclose` seam — see mcpClient's onDrop). PRESENCE is opt-in: pass
 * an options object (even `{}` for all-defaults) to enable reconnect; OMIT it
 * (undefined) to keep the Wave-9 behaviour where a drop is terminal (status stays
 * `failed`, no retries). This split keeps the pure-discovery manager tests free of
 * any lingering real timer while letting production (and the reconnect seam tests)
 * turn it on.
 */
export interface McpReconnectOptions {
  /** Delay before the FIRST retry; each subsequent retry doubles it (capped at
   * `maxDelayMs`). Default 1000ms. */
  baseDelayMs?: number;
  /** Ceiling on the backoff delay so a long outage retries at a steady cadence
   * rather than an ever-growing one. Default 30000ms. */
  maxDelayMs?: number;
  /** HARD cap on consecutive failed retries for one outage. After this many
   * failures the server is TERMINAL `failed` — no further retries. A successful
   * reconnect resets the counter, so a later drop gets a fresh budget. Default 5. */
  maxRetries?: number;
  /** Injectable backoff scheduler — deterministic in tests (a manual clock),
   * DISTINCT from the per-connection connect/call timer so the two never collide on
   * a single-slot fake. Default wraps global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

/** A tool discovered on a server, tagged with the server it came from. The tool
 * layer later namespaces these (server + tool name) into juno tool specs. */
export interface McpDiscoveredTool {
  /** Origin server id (a key of the configured `mcpServers`). */
  server: string;
  /** The server's own tool descriptor. */
  tool: McpToolInfo;
}

/** The outcome of `start()`: which servers came up, and human-readable warnings
 * for the ones that were skipped (each server is independent — a failure is a
 * warning, never fatal). */
export interface McpManagerStartResult {
  /** Server ids that connected AND listed their tools successfully. */
  connected: string[];
  /** One line per skipped server (connect or tools/list failure). */
  warnings: string[];
}

/** A point-in-time snapshot of one configured server for the `/mcp` status panel.
 * `state` is 'connected' once the server connected AND listed its tools, else
 * 'failed'. BEFORE `start()` resolves every server reads 'failed' (nothing is live
 * yet) — the panel gates on the overall connecting state to show "connecting…"
 * instead of these premature rows. Each tool carries its shared-classifier risk. */
export interface McpServerStatus {
  readonly server: string;
  readonly state: 'connected' | 'failed';
  readonly toolCount: number;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly risk: RiskLevel }>;
}

export interface McpManager {
  /** Connect every configured server in parallel and discover its tools. Fail-
   * soft: a server that fails to connect or list is skipped with a warning.
   * Idempotent — a second call returns the already-computed result. */
  start(): Promise<McpManagerStartResult>;
  /** The union of discovered tools across all live servers, each server-tagged.
   * Empty until `start()` resolves. */
  listTools(): McpDiscoveredTool[];
  /** A per-server snapshot for the `/mcp` status panel: every CONFIGURED server
   * (sorted), its connected/failed state, and its discovered tools tagged with
   * their shared-classifier risk. A pure read — safe to call every frame while the
   * panel is open, and safe mid-connect (returns all-'failed' rows the panel
   * overrides with a "connecting…" state). */
  status(): McpServerStatus[];
  /** Dispatch a `tools/call` to `server`. An unknown/unavailable server resolves
   * to a structured error (never throws). */
  callTool(server: string, tool: string, args?: Record<string, unknown>): Promise<McpCallToolOutcome>;
  /** Close every live connection (parallel, best-effort). Idempotent. Also cancels
   * any pending reconnect timers so a shutdown never leaves a backoff dangling. */
  shutdownAll(): Promise<void>;
  /**
   * Subscribe to LIVENESS/DISCOVERY changes — a mid-session drop, a recovered
   * reconnect, or a reconnect giving up at the cap. Returns an unsubscribe. The UI
   * re-reads `status()`/`listTools()` on each fire, so a recovered server re-registers
   * its tools without a restart of juno itself. OPTIONAL on the interface (hand-built
   * test fakes may omit it); the real manager always provides it, and the initial
   * `start()` connect does NOT fire it (the caller drives that path directly).
   */
  subscribe?(listener: () => void): () => void;
}

/**
 * Build a manager over a map of configured servers (typically
 * `settings.mcpServers`). Connections are created idle here and only spawned on
 * `start()`. `deps` are threaded to every per-server connection so a test can
 * inject one transport factory / timer for the whole fleet.
 */
export function createMcpManager(
  servers: Record<string, McpServerConfig>,
  fallbackCwd: string,
  deps: McpClientDeps = {},
  reconnect?: McpReconnectOptions,
): McpManager {
  // Populated by start(): only servers that connected AND listed successfully. A
  // server that drops mid-session is removed here (via its onDrop) so it stops
  // reporting live.
  const live = new Set<string>();
  const connections = new Map<string, McpClientConnection>();
  let discovered: McpDiscoveredTool[] = [];
  let startResult: McpManagerStartResult | undefined;

  // Stable, deterministic ordering shared by start() and reconnect (parallel /
  // out-of-band completion is nondeterministic): server id, then tool name.
  const sortDiscovered = (a: McpDiscoveredTool, b: McpDiscoveredTool): number =>
    a.server === b.server ? a.tool.name.localeCompare(b.tool.name) : a.server.localeCompare(b.server);

  // ---- Change subscription (UI late-bind) --------------------------------
  // A drop, a recovered reconnect, or a reconnect giving up fires these so the UI
  // re-reads status()/listTools() and a recovered server re-registers its tools.
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  // ---- Reconnect (opt-in) ------------------------------------------------
  const reconnectEnabled = reconnect !== undefined;
  const baseDelayMs = reconnect?.baseDelayMs ?? 1_000;
  const maxDelayMs = reconnect?.maxDelayMs ?? 30_000;
  const maxRetries = reconnect?.maxRetries ?? 5;
  const setReconnectTimer =
    reconnect?.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  // Consecutive failed retries per server for the CURRENT outage (reset on recovery).
  const reconnectAttempts = new Map<string, number>();
  // The single pending backoff timer per server — cancelled on shutdown.
  const reconnectTimers = new Map<string, TimerHandle>();
  // Servers with an attempt currently executing — guards against a concurrent second.
  const reconnecting = new Set<string>();
  // Latched by shutdownAll so an in-flight attempt can't mutate state post-teardown.
  let stopped = false;

  // A server dropped mid-session (its transport onclose fired). Flip it not-live and
  // notify (chip/panel reflect the outage immediately — the Wave-9 seam), then, when
  // reconnect is enabled, kick a bounded-backoff retry sequence. Discovery is left
  // INTACT so the model's already-bound tool specs stay stable across the outage; a
  // callTool short-circuits via `live` until the server recovers.
  const onServerDrop = (name: string): void => {
    live.delete(name);
    notify();
    if (reconnectEnabled) {
      scheduleReconnect(name);
    }
  };

  function scheduleReconnect(name: string): void {
    if (stopped || reconnectTimers.has(name)) {
      return;
    }
    const attempt = reconnectAttempts.get(name) ?? 0;
    if (attempt >= maxRetries) {
      return; // hard cap reached → terminal failed, no further retries
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const handle = setReconnectTimer(() => {
      reconnectTimers.delete(name);
      void attemptReconnect(name);
    }, delay);
    reconnectTimers.set(name, handle);
  }

  async function attemptReconnect(name: string): Promise<void> {
    const connection = connections.get(name);
    if (connection === undefined || stopped || reconnecting.has(name) || live.has(name)) {
      return;
    }
    reconnecting.add(name);
    try {
      // A drop leaves the connection's `closed` flag false, so connect() spawns a
      // FRESH transport (the dropped child was already released — see mcpClient onclose).
      const connectOutcome = await connection.connect();
      if (stopped) return;
      if (!connectOutcome.ok) {
        failReconnect(name);
        return;
      }
      const listOutcome = await connection.listTools();
      if (stopped) return;
      if (!listOutcome.ok) {
        // Connected but can't list yet: do NOT close() HERE (that latches the connection
        // permanently dead and forbids further retries) — count the failure and retry,
        // which re-lists on the now-live client. The freshly connected child is left LIVE
        // across the retry window; if the retries EXHAUST, failReconnect() closes the
        // still-live connection so that child is never orphaned (the resource-leak gate).
        failReconnect(name);
        return;
      }
      // Recovered: re-add to live, REPLACE this server's discovered tools (a reconnect
      // may expose a changed set), reset the retry budget, and notify so the UI
      // re-registers the tools cleanly.
      live.add(name);
      reconnectAttempts.delete(name);
      discovered = [
        ...discovered.filter((entry) => entry.server !== name),
        ...listOutcome.tools.map((tool) => ({ server: name, tool })),
      ].sort(sortDiscovered);
      notify();
    } finally {
      reconnecting.delete(name);
    }
  }

  function failReconnect(name: string): void {
    const attempt = (reconnectAttempts.get(name) ?? 0) + 1;
    reconnectAttempts.set(name, attempt);
    if (attempt >= maxRetries) {
      // Give up: TERMINAL failed. A connect-ok/list-fail attempt deliberately keeps its
      // freshly connected client LIVE so a retry can re-list on it (see attemptReconnect);
      // now that we stop retrying, that live child would be ORPHANED — the resource-leak
      // gate — so close() the connection to force-release it. Best-effort/idempotent and
      // never throws; a connect-FAIL give-up (no live child) closes to a near no-op.
      // Notify the final state afterward; nothing more is scheduled.
      void connections.get(name)?.close();
      notify();
      return;
    }
    scheduleReconnect(name);
  }

  // Every configured server gets an idle connection up front, keyed by id. Each is
  // handed an onDrop that removes it from `live` on an unexpected transport close, so
  // status() flips to 'failed' and callTool short-circuits — and (opt-in) starts the
  // bounded-backoff reconnect above — instead of the server lingering 'connected'
  // until the next per-call timeout would trip.
  for (const [name, config] of Object.entries(servers)) {
    connections.set(
      name,
      createMcpClientConnection(name, config, fallbackCwd, deps, () => onServerDrop(name)),
    );
  }

  return {
    async start(): Promise<McpManagerStartResult> {
      if (startResult !== undefined) {
        return startResult;
      }
      // Re-arm reconnect in case a prior shutdownAll latched `stopped` (start() only
      // reaches here after shutdown cleared startResult, so a re-start is intentional).
      stopped = false;

      const connected: string[] = [];
      const warnings: string[] = [];
      const tools: McpDiscoveredTool[] = [];

      // Connect + discover each server independently and IN PARALLEL; one server's
      // failure or slowness never blocks or fails another.
      await Promise.all(
        [...connections.entries()].map(async ([name, connection]) => {
          const connectOutcome = await connection.connect();
          if (!connectOutcome.ok) {
            warnings.push(connectOutcome.error);
            await connection.close();
            return;
          }
          const listOutcome = await connection.listTools();
          if (!listOutcome.ok) {
            warnings.push(listOutcome.error);
            await connection.close();
            return;
          }
          live.add(name);
          connected.push(name);
          // Per-tool drop warnings (unsafe/duplicate names) surface through the
          // SAME channel as skipped-server warnings — fail-soft, never fatal.
          for (const warning of listOutcome.warnings) {
            warnings.push(warning);
          }
          for (const tool of listOutcome.tools) {
            tools.push({ server: name, tool });
          }
        }),
      );

      // Stable, deterministic ordering (parallel completion is nondeterministic).
      connected.sort();
      warnings.sort();
      tools.sort(sortDiscovered);

      discovered = tools;
      startResult = { connected, warnings };
      return startResult;
    },

    listTools(): McpDiscoveredTool[] {
      return [...discovered];
    },

    status(): McpServerStatus[] {
      // Bucket the discovered tools by their origin server (stamping each with its
      // shared-classifier risk), then emit one row per CONFIGURED server — even a
      // failed server appears (with zero tools), so the panel lists the whole fleet.
      const toolsByServer = new Map<string, { name: string; risk: RiskLevel }[]>();
      for (const { server, tool } of discovered) {
        const bucket = toolsByServer.get(server) ?? [];
        bucket.push({ name: tool.name, risk: classifyRisk(servers, server, tool.name) });
        toolsByServer.set(server, bucket);
      }
      return [...connections.keys()].sort().map((server) => {
        const tools = toolsByServer.get(server) ?? [];
        return {
          server,
          state: live.has(server) ? 'connected' : 'failed',
          toolCount: tools.length,
          tools,
        };
      });
    },

    async callTool(
      server: string,
      tool: string,
      args?: Record<string, unknown>,
    ): Promise<McpCallToolOutcome> {
      const connection = connections.get(server);
      if (connection === undefined || !live.has(server)) {
        return { ok: false, error: `mcp: unknown or unavailable server "${server}"` };
      }
      return connection.callTool(tool, args);
    },

    async shutdownAll(): Promise<void> {
      // Latch first so any in-flight reconnect attempt bails before mutating state,
      // then cancel every pending backoff timer so a shutdown never leaves one dangling.
      stopped = true;
      for (const handle of reconnectTimers.values()) {
        handle.clear();
      }
      reconnectTimers.clear();
      reconnectAttempts.clear();
      reconnecting.clear();
      await Promise.all([...connections.values()].map((connection) => connection.close()));
      live.clear();
      discovered = [];
      startResult = undefined;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
