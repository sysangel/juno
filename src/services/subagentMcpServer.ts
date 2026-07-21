// src/services/subagentMcpServer.ts
// Wave 8 (codex-bridge) — a juno-HOSTED MCP server originally exposing
// `spawn_subagent`, now also carrying a narrow set of Juno-managed parent tools.
// A codex PARENT has no inline custom-tool flag — its only channel for non-built-in
// tools is an MCP server. This is the SERVER side of MCP; everything else in
// src/services/mcp* is juno-as-MCP-CLIENT. Built on the SAME `@modelcontextprotocol`
// SDK already in the repo (mcpClient.ts uses its `Client`; here we use its `Server`),
// so no new dependency is introduced.
//
// The server is PROTOCOL-ONLY: it owns the tools/list + tools/call wire handlers and
// nothing else. The actual spawn (running a nested juno turn + attributing the
// child's tool cards to the codex parent's turn) is delegated to an INJECTED handler
// (the codex spawn bridge), so this module is fully testable with an in-memory
// transport + a fake handler, and never itself touches a ModelClient. Like every
// other service edge in juno it NEVER throws across its boundary — a handler that
// rejects is folded into an MCP tool-level error (`isError: true`).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolSpec } from '../core/contracts';
import { spawnSubagentSpec } from '../tools/subagentTool';

/** The tool name the codex parent invokes. Codex namespaces it as
 * `mcp__<serverName>__spawn_subagent` on its side; on the wire (and to this server)
 * it is the bare name. Kept identical to the raw-API `spawn_subagent` tool so a
 * codex parent and a claude parent offer the model the SAME capability. */
export const SPAWN_SUBAGENT_TOOL = 'spawn_subagent';

/**
 * Server-wide guidance for Codex's deferred MCP-tool inventory. Current Codex
 * builds intentionally keep MCP tools behind their native tool-search surface,
 * so checking the eager `ALL_TOOLS` list from inside another tool produces a
 * false negative. MCP `instructions` is the protocol-level place for this
 * cross-tool discovery rule; Codex reads it during initialization even when the
 * individual tool schemas are deferred.
 */
export function codexBridgeInstructions(toolNames: ReadonlyArray<string>): string {
  return [
    'Juno harness bridge. Codex may defer these MCP tools from its initial inventory.',
    'Before saying a requested Juno capability is unavailable, use Codex\'s native tool_search to load the matching tool from this server.',
    'Do not inspect ALL_TOOLS inside functions.exec for availability: deferred MCP tools are omitted there.',
    'Use these Juno tools, not similarly named built-ins, when the user requests harness evidence, and only claim success after completed tool receipts.',
    `Advertised tools: ${toolNames.join(', ')}.`,
  ].join(' ');
}

/** Server identity advertised in the MCP `initialize` handshake. */
const SERVER_INFO = { name: 'juno-subagent', version: '0.1.0' } as const;

/** The bridge handler outcome for one spawn: the subagent's final summary text
 * (surfaced to codex as the tool result) plus whether it should be reported as an
 * MCP tool-level error. A thrown handler is also mapped to an error result. */
export interface SpawnBridgeResult {
  /** Text the codex parent consumes as the tool result (summary, or error text). */
  readonly text: string;
  /** True → reported to codex as a tool-level error (`isError: true`). */
  readonly isError: boolean;
}

/** Runs one spawn on behalf of a codex parent's MCP `tools/call`. Injected by the
 * bridge; MUST fail soft (return an `isError` result rather than throw), though a
 * throw is still caught and mapped here as a backstop. `signal` is the SDK's
 * per-request AbortSignal, which — in the installed SDK — fires only on an explicit
 * `notifications/cancelled` or a FULL transport close, NOT on a per-request HTTP socket
 * drop. The handler combines it with the turn's own abort AND a per-turn end signal, so
 * an explicit codex cancel cascades into the child abort path here, while a codex
 * crash/OOM/exit is covered by the turn-end disposer in the bridge (which aborts any
 * in-flight spawn when streamTurn finalizes) — either way the subagent never runs on
 * unattended. */
export type SpawnBridgeHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<SpawnBridgeResult>;

/** Additional parent-only Juno tools offered over the same in-process MCP server.
 * The bridge, not this protocol layer, owns policy checks and event attribution. */
export interface CodexBridgeToolSet {
  /** Whether `spawn_subagent` belongs in this server's advertised catalog. Defaults
   * true for backwards compatibility. The CLI sets this from the explicit spawn
   * bridge grant so a managed-tools-only host never advertises disabled spend. */
  readonly spawnEnabled?: boolean;
  readonly specs: ReadonlyArray<ToolSpec>;
  readonly call: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<SpawnBridgeResult>;
}

/** A connectable juno-hosted subagent MCP server. Nothing is spawned/bound here —
 * the caller connects it to a transport (stdio/HTTP in production, in-memory in
 * tests). */
export interface SubagentMcpServer {
  /** Attach a transport and run the MCP handshake. One transport per server. */
  connect(transport: Transport): Promise<void>;
  /** Close the transport/connection. Best-effort, idempotent, never throws. */
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a juno-hosted MCP server that offers optional `spawn_subagent` plus
 * Juno-managed tools. When enabled, spawn routes to `handler`; additional calls
 * route to the injected tool set. The advertised spawn schema is
 * `spawnSubagentSpec.inputSchema` verbatim — the SAME schema the raw-API tool uses
 * — so a codex parent sees an identical `{ task, agent?, model? }` contract.
 */
export function createSubagentMcpServer(
  handler: SpawnBridgeHandler,
  bridgeTools?: CodexBridgeToolSet,
): SubagentMcpServer {
  // Build one truthful, deduplicated catalog and derive instructions, tools/list,
  // and tools/call routing from it. A duplicate spawn_subagent definition must not
  // shadow the dedicated handler or silently lose its nested-agent semantics.
  const catalog = new Map<
    string,
    {
      readonly spec: ToolSpec;
      readonly call: SpawnBridgeHandler;
    }
  >();
  if (bridgeTools?.spawnEnabled !== false) {
    catalog.set(SPAWN_SUBAGENT_TOOL, { spec: spawnSubagentSpec, call: handler });
  }
  if (bridgeTools !== undefined) {
    for (const spec of bridgeTools.specs) {
      if (catalog.has(spec.name) || spec.name === SPAWN_SUBAGENT_TOOL) continue;
      catalog.set(spec.name, {
        spec,
        call: (args, signal) => bridgeTools.call(spec.name, args, signal),
      });
    }
  }
  const advertisedTools = [...catalog.values()];
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: codexBridgeInstructions(advertisedTools.map(({ spec }) => spec.name)),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertisedTools.map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const advertised = catalog.get(name);
    if (advertised === undefined) {
      return {
        content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
        isError: true,
      };
    }
    const rawArgs = req.params.arguments;
    const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
    try {
      // Forward the SDK's per-request AbortSignal so an MCP-side cancel (codex
      // timeout / notifications/cancelled / connection drop) cascades into the child.
      const result = await advertised.call(args, extra.signal);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    } catch (err) {
      // Backstop: the bridge is contracted to fail soft, but a throw must never
      // crash the codex parent's MCP session — fold it into a tool-level error.
      return {
        content: [{ type: 'text' as const, text: `${name} failed: ${errText(err)}` }],
        isError: true,
      };
    }
  });

  return {
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
    },
    async close(): Promise<void> {
      try {
        await server.close();
      } catch {
        // best-effort — a failed close still drops our reference.
      }
    },
  };
}
