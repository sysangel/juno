// src/services/codexBridgeHost.ts
// Wave 8 (codex-bridge) — the HOST that stands up juno's in-process
// `spawn_subagent` MCP server (subagentMcpServer.ts) over a transport a codex
// child can reach, and hands back the `CodexMcpConfig` that points codex at it plus
// a `shutdown`. This is the production glue; the bridge protocol + attribution it
// depends on are exercised in isolation (see subagentMcpServer.test.ts /
// codexSpawnBridge.test.ts / codexCliBridge.integration.test.ts).
//
// The transport LISTENER is injectable so the wiring (server construction + config
// emission + teardown) is testable with an in-memory transport and never binds a
// real port. The default listener binds a Streamable-HTTP endpoint on 127.0.0.1:
// this is the in-process path that lets the server share juno's process with the
// active codex turn — a hard requirement for parent attribution (a separate stdio
// subprocess could return only a summary, not stream nested child cards into the
// turn).
//
// SCOPE NOTE (honesty): the default HTTP listener + a LIVE codex CLI connecting to
// it are NOT exercised by juno's hermetic suite (the GATE forbids live codex, and
// binding a real port is out of scope for unit tests). Everything up to and
// including the transport seam is tested; the concrete HTTP bind is best-effort and
// gated behind an opt-in flag at the cli wiring site.

import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CodexMcpConfig } from '../providers/codexCliClient';
import type { SpawnBridgeHandler } from './subagentMcpServer';
import { createSubagentMcpServer, type SubagentMcpServer } from './subagentMcpServer';

/** Default codex-side server id (also the tool's codex namespace:
 * `mcp__juno__spawn_subagent`). */
export const DEFAULT_CODEX_MCP_SERVER_NAME = 'juno';

/** What a listener returns once it has a transport bound and a codex-reachable
 * endpoint: the `CodexMcpConfig` to feed codex, and a best-effort teardown. */
export interface CodexBridgeListenResult {
  /** How codex is told to reach this host (serverName + url|command). */
  readonly mcpConfig: CodexMcpConfig;
  /** Tear down the transport + any bound listener. Never throws. */
  close(): Promise<void>;
}

/** Bind a transport for `server` and return the codex endpoint + teardown. The
 * server is already constructed; the listener connects it and exposes it. */
export type CodexBridgeListener = (
  server: SubagentMcpServer,
  serverName: string,
) => Promise<CodexBridgeListenResult>;

export interface CodexBridgeHost {
  /** The codex mcpConfig pointing at this host — pass to createModelClient
   * (`codexMcpConfig`) / codexToolArgs. */
  readonly mcpConfig: CodexMcpConfig;
  /** Tear down server + transport. Idempotent, best-effort, never throws. */
  shutdown(): Promise<void>;
}

export interface CodexBridgeHostDeps {
  /** Runs each spawn on behalf of a codex parent's MCP call (typically
   * `bridge.spawn`). */
  readonly handler: SpawnBridgeHandler;
  /** codex-side server id. Default `juno`. */
  readonly serverName?: string;
  /** Injectable transport binder. Default: an in-process Streamable-HTTP listener
   * on 127.0.0.1 (see `httpListener`). Tests inject an in-memory listener. */
  readonly listen?: CodexBridgeListener;
}

/**
 * Build + start a codex bridge host: construct the `spawn_subagent` MCP server over
 * `handler`, bind it via the (injectable) listener, and expose the codex config +
 * shutdown. Fail-soft is the caller's concern for `handler`; this only wires.
 */
export async function createCodexBridgeHost(deps: CodexBridgeHostDeps): Promise<CodexBridgeHost> {
  const serverName = deps.serverName ?? DEFAULT_CODEX_MCP_SERVER_NAME;
  const listen = deps.listen ?? httpListener;
  const server = createSubagentMcpServer(deps.handler);
  const bound = await listen(server, serverName);
  return {
    mcpConfig: bound.mcpConfig,
    async shutdown(): Promise<void> {
      await bound.close();
      await server.close();
    },
  };
}

/**
 * Default listener: a Streamable-HTTP endpoint on 127.0.0.1 an ephemeral port, in
 * STATELESS JSON mode (no session stickiness — one codex child, one server). Every
 * request is routed to the single transport's `handleRequest`. Returns the
 * `http://127.0.0.1:<port>/mcp` url for codex's `-c mcp_servers.<name>.url`.
 *
 * UNVERIFIED against a live codex CLI (see file header). Kept minimal + defensive.
 */
export const httpListener: CodexBridgeListener = async (server, serverName) => {
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id required, JSON responses (no long-lived SSE) — the
    // simplest shape for a single in-process consumer.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer: HttpServer = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(() => {
      // A malformed request must never crash the host; the SDK also writes its own
      // error responses, so this is a last-resort guard.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    // Ephemeral port on loopback ONLY — never exposed off-host.
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('codex bridge host: failed to bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });

  const mcpConfig: CodexMcpConfig = {
    serverName,
    url: `http://127.0.0.1:${port}/mcp`,
  };
  // Prove the id generator is referenced so an unused-import lint can't fire; the
  // stateless transport does not use it, but a future stateful mode would.
  void randomUUID;

  return {
    mcpConfig,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      try {
        await transport.close();
      } catch {
        // best-effort.
      }
    },
  };
};

/** An in-memory listener factory for tests: binds `server` to the provided
 * transport (typically one half of `InMemoryTransport.createLinkedPair()`) and
 * reports a synthetic `command` config (no port is bound). */
export function inMemoryListener(
  transport: Transport,
  mcpConfig: CodexMcpConfig,
): CodexBridgeListener {
  return async (server) => {
    await server.connect(transport);
    return {
      mcpConfig,
      async close(): Promise<void> {
        // The linked client half is closed by the test; nothing to unbind here.
      },
    };
  };
}
