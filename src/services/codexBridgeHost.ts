// src/services/codexBridgeHost.ts
// Wave 8 (codex-bridge) — the HOST that stands up juno's in-process
// Juno bridge MCP server (subagentMcpServer.ts) over a transport a codex child can
// reach, and hands back the `CodexMcpConfig` that points codex at it plus
// a `shutdown`. This is the production glue; the bridge protocol + attribution it
// depends on are exercised in isolation (see subagentMcpServer.test.ts /
// codexSpawnBridge.test.ts / codexCliBridge.integration.test.ts).
//
// The transport LISTENER is injectable so the wiring (server construction + config
// emission + teardown) is testable with an in-memory transport. The default listener
// binds a Streamable-HTTP endpoint on 127.0.0.1:
// this is the in-process path that lets the server share juno's process with the
// active codex turn — a hard requirement for parent attribution (a separate stdio
// subprocess could return only a summary, not stream nested child cards into the
// turn).
//
// The production HTTP protocol path is exercised with the SDK's real HTTP client
// over loopback (no live codex/model call). The bridge itself remains gated behind
// an opt-in flag at the cli wiring site.

import {
  createServer,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CodexMcpConfig } from '../providers/codexCliClient';
import type { CodexBridgeToolSet, SpawnBridgeHandler } from './subagentMcpServer';
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

/** Build a fresh protocol server for one transport/session. A Codex CLI child is
 * a fresh process on every turn, so the HTTP listener must be able to replace a
 * completed child's server rather than reusing a one-request stateless transport. */
export type CodexBridgeServerFactory = () => SubagentMcpServer;

/** Bind transport(s) for fresh protocol servers and return the endpoint + teardown. */
export type CodexBridgeListener = (
  createServer: CodexBridgeServerFactory,
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
  /** Additional Juno-managed tools routed through the active Codex turn. */
  readonly tools?: CodexBridgeToolSet;
  /** codex-side server id. Default `juno`. */
  readonly serverName?: string;
  /** Injectable transport binder. Default: an in-process Streamable-HTTP listener
   * on 127.0.0.1 (see `httpListener`). Tests inject an in-memory listener. */
  readonly listen?: CodexBridgeListener;
}

/**
 * Build + start a codex bridge host: construct the MCP server over the spawn and
 * optional managed-tool handlers, bind it via the injectable listener, and expose the codex config +
 * shutdown. Fail-soft is the caller's concern for `handler`; this only wires.
 */
export async function createCodexBridgeHost(deps: CodexBridgeHostDeps): Promise<CodexBridgeHost> {
  const serverName = deps.serverName ?? DEFAULT_CODEX_MCP_SERVER_NAME;
  const listen = deps.listen ?? httpListener;
  const bound = await listen(
    () => createSubagentMcpServer(deps.handler, deps.tools),
    serverName,
  );
  return {
    mcpConfig: bound.mcpConfig,
    async shutdown(): Promise<void> {
      await bound.close();
    },
  };
}

/**
 * Default listener: a Streamable-HTTP endpoint on 127.0.0.1 at an ephemeral port, in
 * stateful JSON mode (one short-lived session per Codex child). Returns the
 * `http://127.0.0.1:<port>/mcp/<secret>` url for codex's `-c mcp_servers.<name>.url`.
 *
 * The SDK explicitly forbids reusing a stateless StreamableHTTPServerTransport
 * across requests: initialize and notifications/initialized are separate POSTs.
 * Codex also launches a fresh MCP client process on later turns. We therefore give
 * each incoming initialization a fresh stateful transport + protocol server and
 * retire the prior child's connection. Juno permits only one parent turn at a time,
 * so one active bridge session is the truthful concurrency bound.
 *
 * DEFENSE-IN-DEPTH (the endpoint carries a subagent's summary — which can include workspace
 * file contents read by the child's auto-allowed safe tools — and can spend the user's
 * tokens). The local threat boundary is explicit: the URL travels in Codex's argv, so a
 * hostile local user that can inspect Juno/Codex processes is out of scope. Within that
 * boundary, loopback bind alone still does not stop DNS-rebinding pages or blind scans. We:
 *   - enable the SDK's DNS-rebinding protection with an explicit `allowedHosts` allowlist,
 *     so a browser whose attacker hostname resolves to 127.0.0.1 is rejected (its Host
 *     header is the attacker's name, never `127.0.0.1:<port>`); and
 *   - serve only at a random path `/mcp/<uuid>`, 404-ing every other path BEFORE the
 *     transport sees it. This reduces blind local scans; it is not cross-user authentication.
 *
 * The HTTP protocol is covered by real loopback SDK tests, and the complete path has
 * also been exercised with a live Codex CLI subscription acceptance run.
 */
export const httpListener: CodexBridgeListener = async (createProtocolServer, serverName) => {
  // Unguessable path segment — knowing the port is not enough to drive the endpoint.
  const secretPath = `/mcp/${randomUUID()}`;
  interface ManagedSession {
    readonly server: SubagentMcpServer;
    readonly transport: StreamableHTTPServerTransport;
    phase: 'pending' | 'active' | 'closing' | 'closed';
    sessionId?: string;
    closePromise?: Promise<void>;
  }
  let active: ManagedSession | undefined;
  const pending = new Set<ManagedSession>();
  let allowedHosts: string[] = [];
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  let lifecycleTail: Promise<void> = Promise.resolve();

  /** Serialize ownership changes without poisoning later transitions when one fails. */
  const transition = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** Drop ownership before closing so callbacks/repeated shutdown cannot close twice. */
  const closeSession = (session: ManagedSession): Promise<void> => {
    if (session.closePromise !== undefined) return session.closePromise;
    if (active === session) active = undefined;
    pending.delete(session);
    session.phase = 'closing';
    session.closePromise = Promise.resolve()
      .then(() => session.server.close())
      .catch(() => {
        // Best-effort: a dead Codex child must not block replacement or shutdown.
      })
      .finally(() => {
        session.phase = 'closed';
      });
    return session.closePromise;
  };

  /** The SDK calls this while handling DELETE and again when the transport closes. */
  const markTransportClosed = (session: ManagedSession): void => {
    if (active === session) active = undefined;
    pending.delete(session);
    if (session.phase !== 'closing') session.phase = 'closed';
  };

  const jsonError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
  ): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
  };

  const createCandidate = (): Promise<ManagedSession | undefined> =>
    transition(async () => {
      if (closing) return undefined;

      const server = createProtocolServer();
      let candidate!: ManagedSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts,
        // This callback runs only after the SDK has parsed a single, valid MCP
        // initialize request. Until then the candidate cannot displace `active`.
        onsessioninitialized: (sessionId) =>
          transition(async () => {
            if (
              closing ||
              candidate.phase !== 'pending' ||
              !pending.has(candidate) ||
              transport.sessionId !== sessionId
            ) {
              throw new Error('Codex bridge session is no longer available');
            }

            const previous = active;
            pending.delete(candidate);
            candidate.phase = 'active';
            candidate.sessionId = sessionId;
            active = candidate;
            if (previous !== undefined && previous !== candidate) {
              await closeSession(previous);
            }
          }),
        // DELETE is the protocol-level terminal signal. Clear routing before the
        // SDK closes the transport so a following client can initialize cleanly.
        onsessionclosed: () =>
          transition(() => {
            markTransportClosed(candidate);
          }),
      });
      candidate = { server, transport, phase: 'pending' };
      pending.add(candidate);
      transport.onclose = () => {
        void transition(() => {
          markTransportClosed(candidate);
        });
      };

      try {
        await server.connect(transport);
        return candidate;
      } catch (error) {
        await closeSession(candidate);
        throw error;
      }
    });

  const httpServer: HttpServer = createServer((req, res) => {
    // Reject anything but the secret path, before the transport is touched.
    const pathname = (req.url ?? '').split('?', 1)[0];
    if (pathname !== secretPath) {
      res.statusCode = 404;
      res.end();
      return;
    }

    void (async (): Promise<void> => {
      if (closing) {
        jsonError(res, 503, -32000, 'Codex bridge is shutting down');
        return;
      }

      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

      if (sessionId === undefined) {
        // A headerless POST gets an isolated candidate. The SDK validates whether
        // it is really initialize; malformed/non-initialize traffic is discarded
        // without evicting the active Codex child.
        if (req.method !== 'POST') {
          jsonError(res, 400, -32000, 'Mcp-Session-Id header is required');
          return;
        }
        const candidate = await createCandidate();
        if (candidate === undefined || closing) {
          if (!res.headersSent) jsonError(res, 503, -32000, 'Codex bridge is shutting down');
          if (candidate !== undefined) {
            await transition(() => closeSession(candidate));
          }
          return;
        }

        try {
          await candidate.transport.handleRequest(req, res);
        } finally {
          // A valid initialize promotes itself in onsessioninitialized. Every
          // other headerless request leaves a pending candidate that must be closed.
          await transition(() =>
            candidate.phase === 'pending' ? closeSession(candidate) : undefined,
          );
        }
        return;
      }

      const session = await transition(() =>
        !closing && active?.sessionId === sessionId ? active : undefined,
      );
      if (session === undefined) {
        if (closing) {
          jsonError(res, 503, -32000, 'Codex bridge is shutting down');
          return;
        }
        jsonError(res, 404, -32001, 'Session not found');
        return;
      }

      await session.transport.handleRequest(req, res);
    })().catch(() => {
      // A malformed request must never crash the host; the SDK also writes its own
      // error responses, so this is a last-resort guard.
      if (!res.headersSent) jsonError(res, 500, -32603, 'Internal server error');
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

  // Validate the Host header against a loopback-only allowlist (both the exact
  // host:port codex sends and the bare/localhost forms) so a DNS-rebinding page cannot
  // drive the endpoint even though its hostname resolves to 127.0.0.1.
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost'];

  const mcpConfig: CodexMcpConfig = {
    serverName,
    url: `http://127.0.0.1:${port}${secretPath}`,
  };

  return {
    mcpConfig,
    close(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;

      // Flip this synchronously, before queuing cleanup, so no request can create
      // or promote a new session in the shutdown window.
      closing = true;
      shutdownPromise = (async () => {
        await transition(async () => {
          const sessions = new Set(pending);
          if (active !== undefined) sessions.add(active);
          await Promise.all([...sessions].map((session) => closeSession(session)));
        });
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      })();
      return shutdownPromise;
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
  return async (createProtocolServer) => {
    const server = createProtocolServer();
    await server.connect(transport);
    return {
      mcpConfig,
      async close(): Promise<void> {
        await server.close();
      },
    };
  };
}
