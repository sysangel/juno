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
 * Build a juno-hosted MCP server that offers `spawn_subagent` plus optional
 * Juno-managed tools. Spawn routes to `handler`; additional calls route to the
 * injected tool set. The advertised spawn schema is `spawnSubagentSpec.inputSchema`
 * verbatim — the SAME schema the raw-API tool uses — so a codex parent sees an
 * identical `{ task, agent?, model? }` contract.
 */
export function createSubagentMcpServer(
  handler: SpawnBridgeHandler,
  bridgeTools?: CodexBridgeToolSet,
): SubagentMcpServer {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  // A duplicate spawn_subagent definition could shadow the dedicated handler and
  // silently lose its nested-agent semantics. Drop duplicates at this boundary.
  const extraSpecs = (bridgeTools?.specs ?? []).filter(
    (spec) => spec.name !== SPAWN_SUBAGENT_TOOL,
  );
  const extraNames = new Set(extraSpecs.map((spec) => spec.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: SPAWN_SUBAGENT_TOOL,
        description: spawnSubagentSpec.description,
        inputSchema: spawnSubagentSpec.inputSchema as Record<string, unknown>,
      },
      ...extraSpecs.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema as Record<string, unknown>,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    if (name !== SPAWN_SUBAGENT_TOOL && !extraNames.has(name)) {
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
      const result =
        name === SPAWN_SUBAGENT_TOOL
          ? await handler(args, extra.signal)
          : bridgeTools === undefined
            ? { text: `unknown tool: ${name}`, isError: true }
            : await bridgeTools.call(name, args, extra.signal);
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
