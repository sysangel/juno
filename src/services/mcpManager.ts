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
   * failures the server is TERMINAL `failed` — no further retries. The counter
   * resets ONLY when a STABLE session (one that stayed live at least
   * `stableThresholdMs`) drops — that fresh incident earns a fresh budget; a bare
   * reconnect success does NOT reset it, so a server that keeps recovering then
   * flapping still latches terminal instead of retrying forever. Default 5. */
  maxRetries?: number;
  /** Injectable backoff scheduler — deterministic in tests (a manual clock),
   * DISTINCT from the per-connection connect/call timer so the two never collide on
   * a single-slot fake. Default wraps global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Minimum uptime a live session must reach before a drop is treated as a fresh
   * incident (budget reset). A drop SOONER than this is a FLAP: it consumes a retry-
   * budget unit so a server that keeps recovering-then-dropping still latches terminal
   * `failed` instead of reconnect-looping forever (its attempts all succeed, so
   * failReconnect would otherwise never fire). Default `2 * baseDelayMs`. */
  stableThresholdMs?: number;
  /** Injectable monotonic clock (ms) for the stability window above — deterministic
   * under the manual-timer tests. Default `() => Date.now()`. */
  now?: () => number;
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
  // A session must stay live at least this long before a drop counts as a fresh
  // incident; a shorter-lived drop is a flap (see onServerDrop). Default 2× base.
  const stableThresholdMs = reconnect?.stableThresholdMs ?? 2 * baseDelayMs;
  const now = reconnect?.now ?? ((): number => Date.now());
  const setReconnectTimer =
    reconnect?.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  // Consecutive failed retries per server for the CURRENT outage. Reset ONLY when a
  // STABLE session (>= stableThresholdMs uptime) drops — a fresh incident, handled at
  // the drop seam in onServerDrop — NOT on a bare reconnect success, so a clean-recover-
  // then-flap server still latches terminal instead of reconnect-looping forever.
  const reconnectAttempts = new Map<string, number>();
  // When each live session was established (via `now()`), keyed by server. Set at every
  // live.add, cleared on drop. onServerDrop reads it to decide flap-vs-fresh-incident:
  // a drop whose session lived < stableThresholdMs is a flap. Absent = a drop DURING a
  // reconnect attempt (before its live.add), which the generation guard already owns.
  const connectedAt = new Map<string, number>();
  // The single pending backoff timer per server — cancelled on shutdown.
  const reconnectTimers = new Map<string, TimerHandle>();
  // Servers with an attempt currently executing — guards against a concurrent second.
  const reconnecting = new Set<string>();
  // Monotonic per-server DROP counter. Every observed drop bumps it, so a reconnect
  // attempt can tell whether the very connection it just brought up dropped again
  // WHILE it was listing — the latch race below. Never reset (monotonic is enough for
  // an equality check across one attempt); pruned on shutdown with the rest of state.
  const dropGeneration = new Map<string, number>();
  // Latched by shutdownAll so an in-flight attempt can't mutate state post-teardown.
  let stopped = false;

  // A server dropped mid-session (its transport onclose fired). Flip it not-live, bump
  // the drop generation (so a racing reconnect attempt sees its connection died), and
  // notify (chip/panel reflect the outage immediately — the Wave-9 seam); then, when
  // reconnect is enabled, kick a bounded-backoff retry sequence. Discovery is left
  // INTACT so the model's already-bound tool specs stay stable across the outage; a
  // callTool short-circuits via `live` until the server recovers.
  const onServerDrop = (name: string): void => {
    // Capture how long this session lived BEFORE clearing the timestamp — the flap gate
    // below needs it. `undefined` means the drop landed DURING a reconnect attempt
    // (before its live.add), so no live session existed.
    const startedAt = connectedAt.get(name);
    connectedAt.delete(name);
    live.delete(name);
    dropGeneration.set(name, (dropGeneration.get(name) ?? 0) + 1);
    notify();
    if (!reconnectEnabled) {
      return;
    }
    if (startedAt !== undefined && now() - startedAt < stableThresholdMs) {
      // FLAP: a session that recovered then dropped again within the stability window.
      // Route through failReconnect so the drop CONSUMES a budget unit (and at the cap
      // close()s + latches terminal `failed`). This is REQUIRED because a clean-recover-
      // then-drop flapper's reconnect attempts all SUCCEED, so failReconnect would never
      // fire on its own and the server would reconnect-loop forever.
      failReconnect(name);
    } else if (startedAt !== undefined) {
      // A STABLE session dropped: this is a fresh incident, so reset the retry budget
      // and schedule a normal (attempt-0) reconnect.
      reconnectAttempts.delete(name);
      scheduleReconnect(name);
    } else {
      // Dropped DURING a reconnect attempt (before its live.add): attemptReconnect's
      // generation guard owns the budget for this cycle (its failReconnect consumes the
      // unit), so just schedule — scheduleReconnect no-ops if that path already did.
      scheduleReconnect(name);
    }
  };

  // Publish a successful (re)connection: mark the server live, STAMP its uptime clock
  // (so onServerDrop's flap gate can measure the session length), REPLACE this server's
  // discovered tools with the freshly listed set (a reconnect may expose a changed set),
  // and notify so the UI re-registers cleanly. The single shared success tail for the
  // background attemptReconnect AND the call-time bringLive, so the two can't diverge.
  function publishLive(name: string, tools: McpToolInfo[]): void {
    live.add(name);
    connectedAt.set(name, now());
    discovered = [
      ...discovered.filter((entry) => entry.server !== name),
      ...tools.map((tool) => ({ server: name, tool })),
    ].sort(sortDiscovered);
    notify();
  }

  // Synchronously revive a dropped connection for a call-time retry: connect (idempotent
  // — a no-op `{ ok:true }` if a racing background attempt already re-established the
  // client) + list, then publish. Guarded against racing the background attemptReconnect:
  // if the server is already live use it, and if an attempt is mid-flight don't spawn a
  // second (report whether it has flipped live yet). Carries attemptReconnect's OWN two
  // seams so the two revival paths can't diverge: the answer-then-drop generation guard
  // (never latch `live` on a connection that dropped while we listed it) and the post-await
  // `stopped` re-checks (a shutdownAll racing this revive must win). Returns whether the
  // server is live afterward. Never throws — the per-connection methods fail soft.
  async function bringLive(name: string, connection: McpClientConnection): Promise<boolean> {
    if (live.has(name)) {
      return true;
    }
    if (startResult === undefined) {
      // start() has not resolved yet: it is connecting the fleet, and its per-server
      // connect() does NOT hold the `reconnecting` slot below — so a call-time revive
      // here would run a SECOND concurrent connection.connect() while start()'s is still
      // in flight. connect() is only idempotent AFTER a client is published, so the two
      // in-flight connects clobber the connection's pending client/transport and orphan
      // the loser's live child (with rank 13's detached spawn, a child that then outlives
      // juno). MCP tools only register after start() resolves, so the UI never reaches
      // this; the public callTool API can — refuse to revive until start() has published
      // its result (also correct post-shutdownAll, which clears startResult). Once start()
      // resolves, the `reconnecting` slot below owns every concurrent-connect race.
      return false;
    }
    if (reconnecting.has(name)) {
      // A background attempt owns the rebuild; don't double-spawn. Use it if it already
      // went live, else let the caller surface the error (the loop keeps trying).
      return live.has(name);
    }
    // CLAIM the rebuild slot BEFORE the first await. Without this a background
    // attemptReconnect whose backoff timer fires mid-connect — reachable with defaults: a
    // drop at t0 schedules t0+baseDelay, a callTool at t0+0.9·baseDelay begins a connect
    // that outlasts the timer — or a second concurrent callTool would pass the guard above
    // and run a SECOND connection.connect() in parallel. connect() is only idempotent AFTER
    // a client is published, so two in-flight connects clobber the connection's pending
    // client/transport and orphan the loser's live child (with rank 13's detached spawn, a
    // child that then outlives juno). Mirrors attemptReconnect's own `reconnecting` guard.
    reconnecting.add(name);
    try {
      const connectOutcome = await connection.connect();
      // A shutdownAll may have raced this call-time revive to teardown while connect() was
      // in flight; if it latched `stopped`, bail WITHOUT publishing state it just cleared —
      // mirroring attemptReconnect's post-await re-checks so an in-flight revive can't
      // re-add live/discovered/connectedAt (or notify listeners) after teardown, which would
      // leave status() reporting 'connected' post-shutdown. Re-checked after listTools too.
      if (stopped) {
        return false;
      }
      if (connectOutcome.ok) {
        // Snapshot the drop generation once the fresh transport's onclose is armed, so we can
        // tell — right before latching `live` — whether THIS connection dropped again while we
        // were listing (the answer-then-drop latch race, mirrored from attemptReconnect/start).
        // Without it, a revive whose server answers tools/list then drops in the SAME read would
        // publishLive on a DEAD connection: onServerDrop has already cleared `live` and scheduled
        // a retry that then short-circuits on `live.has`, while every later callTool takes the
        // `live.has(name)` fast path above and re-calls the nulled client → permanent 'not
        // connected' with status() still 'connected' (the Wave-11 dead-latch, on the call path).
        const generationAtConnect = dropGeneration.get(name) ?? 0;
        const listOutcome = await connection.listTools();
        if (stopped) {
          return false;
        }
        if (listOutcome.ok && (dropGeneration.get(name) ?? 0) === generationAtConnect) {
          publishLive(name, listOutcome.tools);
          return true;
        }
      }
      // Revive failed (connect fail, list fail, or the connection dropped mid-attempt). If a
      // background attemptReconnect's timer fired while we held the `reconnecting` slot, that
      // attempt skipped WITHOUT rescheduling (it saw the slot taken), so the outage's recovery
      // sequence would be stranded here — bringLive consumed the pending retry and produced
      // nothing. Re-arm it. scheduleReconnect no-ops while a backoff timer is still pending
      // (including the one an answer-then-drop already scheduled via onServerDrop), so a healthy
      // background sequence is never double-scheduled.
      if (reconnectEnabled && !stopped) {
        scheduleReconnect(name);
      }
      return false;
    } finally {
      reconnecting.delete(name);
    }
  }

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
      // The fresh transport's onclose is now armed — snapshot the drop generation so we
      // can tell, right before latching `live`, whether THIS connection dropped again
      // while we were listing its tools.
      const generationAtConnect = dropGeneration.get(name) ?? 0;
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
      // Liveness re-check — the reconnect latch race. A server can answer tools/list and
      // then drop within the SAME synchronous read (it replied, then its child died):
      // listTools still resolves ok, but onServerDrop has ALREADY cleared `live` and
      // scheduled the next retry. Latching `live.add` here would re-mark a DEAD server
      // connected — and because the pending retry then short-circuits on `live.has`, the
      // server would stay 'connected' forever. If the generation moved, the connection we
      // just listed is already gone: leave it not-live and let that scheduled retry (which
      // onServerDrop owns) rebuild it cleanly.
      if ((dropGeneration.get(name) ?? 0) !== generationAtConnect) {
        // The connection we just listed dropped again mid-attempt, so onServerDrop already
        // scheduled a retry. Consume a retry-budget unit here too (scheduleReconnect no-ops on
        // that pending timer, so this never double-schedules) — otherwise a pathological server
        // that ALWAYS answers-then-drops would reconnect-loop forever at baseDelayMs, spawning a
        // fresh child every cycle and never reaching the documented maxRetries terminal cap.
        failReconnect(name);
        return;
      }
      // Recovered: publish the live connection (mark live, stamp uptime, replace this
      // server's discovered tools, notify). The retry budget is DELIBERATELY not reset
      // here — that reset now lives at the drop seam (onServerDrop), gated on the prior
      // session's uptime, so a clean-recover-then-drop flapper still latches terminal.
      publishLive(name, listOutcome.tools);
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
          // The fresh transport's onclose is armed once connect() resolves — snapshot the
          // drop generation so we can tell, right before latching `live`, whether THIS
          // connection dropped again while we were listing its tools (the SAME answer-then-
          // drop latch race attemptReconnect guards, on the startup path).
          const generationAtConnect = dropGeneration.get(name) ?? 0;
          const listOutcome = await connection.listTools();
          if (!listOutcome.ok) {
            warnings.push(listOutcome.error);
            await connection.close();
            return;
          }
          // Liveness re-check. A server can answer tools/list and then drop within the SAME
          // synchronous read: listTools still resolves ok, but onServerDrop has already cleared
          // `live` (a no-op here — start hasn't added it yet) and, when reconnect is enabled,
          // scheduled a retry. Latching `live.add` on that stale success would mark a DEAD
          // server 'connected' — and the pending retry then short-circuits on the `live.has`
          // guard, so it stays 'connected' forever with no path back to actual liveness. If the
          // generation moved, the connection we just listed is already gone: leave it not-live
          // and let that scheduled retry (which onServerDrop owns) rebuild it cleanly.
          if ((dropGeneration.get(name) ?? 0) !== generationAtConnect) {
            return;
          }
          live.add(name);
          // Stamp uptime so a later drop's flap gate (onServerDrop) can measure how long
          // this initial session lived.
          connectedAt.set(name, now());
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
      if (connection === undefined) {
        return { ok: false, error: `mcp: unknown or unavailable server "${server}"` };
      }
      // At-most-one synchronous revive per call, shared by the not-live path below and
      // the retriable-error path further down (a latch, per the side-effect budget).
      let revived = false;
      const reviveOnce = async (): Promise<boolean> => {
        if (revived) {
          return false;
        }
        revived = true;
        return bringLive(server, connection);
      };

      if (!live.has(server)) {
        // The server dropped (its background reconnect may not have caught up yet). Only
        // try a synchronous revive when reconnect is enabled; if it fails, the server is
        // genuinely unavailable.
        if (!reconnectEnabled || !(await reviveOnce())) {
          return { ok: false, error: `mcp: unknown or unavailable server "${server}"` };
        }
      }

      const outcome = await connection.callTool(tool, args);
      // Success, a per-call timeout, or a tool-level error → return as-is. Only a
      // transport-class failure (retriable) earns the one revive + re-call.
      if (outcome.ok || outcome.retriable !== true) {
        return outcome;
      }
      if (reconnectEnabled && (await reviveOnce())) {
        return connection.callTool(tool, args);
      }
      return outcome;
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
      connectedAt.clear();
      reconnecting.clear();
      dropGeneration.clear();
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
