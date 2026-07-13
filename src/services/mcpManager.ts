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
import type { McpServerConfig } from './config';
import {
  createMcpClientConnection,
  type McpCallToolOutcome,
  type McpClientConnection,
  type McpClientDeps,
  type McpToolInfo,
} from './mcpClient';

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
  /** Close every live connection (parallel, best-effort). Idempotent. */
  shutdownAll(): Promise<void>;
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
): McpManager {
  // Populated by start(): only servers that connected AND listed successfully. A
  // server that drops mid-session is removed here (via its onDrop) so it stops
  // reporting live.
  const live = new Set<string>();

  // Every configured server gets an idle connection up front, keyed by id. Each is
  // handed an onDrop that removes it from `live` on an unexpected transport close,
  // so status() flips to 'failed' and callTool short-circuits — instead of the
  // server lingering 'connected' until the next per-call timeout would trip.
  const connections = new Map<string, McpClientConnection>();
  for (const [name, config] of Object.entries(servers)) {
    connections.set(
      name,
      createMcpClientConnection(name, config, fallbackCwd, deps, () => {
        live.delete(name);
      }),
    );
  }

  let discovered: McpDiscoveredTool[] = [];
  let startResult: McpManagerStartResult | undefined;

  return {
    async start(): Promise<McpManagerStartResult> {
      if (startResult !== undefined) {
        return startResult;
      }

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
      tools.sort((a, b) =>
        a.server === b.server ? a.tool.name.localeCompare(b.tool.name) : a.server.localeCompare(b.server),
      );

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
      await Promise.all([...connections.values()].map((connection) => connection.close()));
      live.clear();
      discovered = [];
      startResult = undefined;
    },
  };
}
