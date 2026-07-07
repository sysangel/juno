// src/tools/mcpTools.ts
// Wave 3 of the MCP client — adapts the manager's discovered remote tools into
// juno `Tool`s. Each remote tool becomes one namespaced `mcp__<server>__<tool>`
// juno tool (collision-free across servers) whose spec carries the server's own
// JSON Schema verbatim, and whose run() dispatches through the manager and folds
// the outcome into a `ToolResult` — never throwing, mirroring brainReadTools.
//
// Risk: per-server via `mcpServers.<name>.risk` in config, defaulting to
// 'risky' (prompt-gated). Remote tools are arbitrary third-party code, so they
// are NEVER auto-allowed by default.
//
// Registered AFTER the subagent snapshot at the registry call site, so MCP
// tools are a depth-1, parent-agent-only capability (matching brain/shell/
// memory). juno-INTERNAL: no claude-cli analogue — absent from
// JUNO_TO_CLI_TOOL, so the CLI backend never grants them.
import type { RiskLevel } from '../core/events';
import type { Tool, ToolCtx, ToolResult } from '../core/contracts';
import type { McpServerConfig } from '../services/config';
import type { McpDiscoveredTool, McpManager } from '../services/mcpManager';

/** The manager surface the adapter needs (narrow so tests can fake it). */
export type McpToolsManager = Pick<McpManager, 'listTools' | 'callTool'>;

export interface McpToolsDeps {
  /** A STARTED manager — `listTools()` is read once, at build time. */
  readonly manager: McpToolsManager;
  /** The configured servers (typically `settings.mcpServers`), read for the
   * per-server `risk` override. Missing/unset risk defaults to 'risky'. */
  readonly servers: Record<string, McpServerConfig>;
}

/** Namespaced juno tool name for a remote tool: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pull the human-readable text out of an MCP content-block array (blocks like
 * `{ type: 'text', text: '...' }`). Undefined when no text blocks exist —
 * callers then fall back to the raw content. */
function extractText(content: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('\n');
}

function createMcpTool(discovered: McpDiscoveredTool, deps: McpToolsDeps): Tool {
  const { server, tool } = discovered;
  const name = mcpToolName(server, tool.name);
  const risk: RiskLevel = deps.servers[server]?.risk ?? 'risky';
  const remoteDescription = tool.description?.trim();
  const description =
    remoteDescription !== undefined && remoteDescription !== ''
      ? `MCP tool "${tool.name}" from server "${server}". ${remoteDescription}`
      : `MCP tool "${tool.name}" from server "${server}".`;
  return {
    name,
    risk,
    spec: {
      name,
      description,
      // The server's own JSON Schema, passed through verbatim.
      inputSchema: tool.inputSchema,
    },
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      let callArgs: Record<string, unknown> | undefined;
      if (args === undefined || args === null) {
        callArgs = undefined;
      } else if (isRecord(args)) {
        callArgs = args;
      } else {
        return { ok: false, error: 'invalid args: expected an object' };
      }
      const outcome = await deps.manager.callTool(server, tool.name, callArgs);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      const { result } = outcome;
      const text = extractText(result.content);
      if (result.isError) {
        // The server executed the call but reports a tool-level error.
        return {
          ok: false,
          error: text ?? `mcp: tool "${tool.name}" on server "${server}" reported an error`,
        };
      }
      if (result.structuredContent !== undefined) {
        return { ok: true, data: result.structuredContent };
      }
      // Text when the blocks carry it; otherwise the raw content array (an
      // unexpected shape is still surfaced rather than dropped).
      return { ok: true, data: text ?? result.content };
    },
  };
}

/** One juno Tool per remote tool discovered by the (started) manager. */
export function createMcpTools(deps: McpToolsDeps): Tool[] {
  return deps.manager.listTools().map((discovered) => createMcpTool(discovered, deps));
}
