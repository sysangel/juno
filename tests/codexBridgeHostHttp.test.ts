// tests/codexBridgeHostHttp.test.ts — Wave 8 (codex-bridge) security regression for the
// DEFAULT httpListener. The endpoint carries a subagent's summary (which can include
// workspace file contents) and spends the user's tokens, so a loopback bind alone is not
// enough: it must reject unknown paths and spoofed Host headers. These bind a REAL
// ephemeral loopback port (the one exception to the hermetic-no-port rule — no live codex
// is involved) and drive it with node:http (fetch forbids overriding the Host header).
//
// Each case uses a FRESH host: the stateless JSON transport is single-use, so we never send
// two transport-touching requests to one server.
import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createCodexBridgeHost } from '../src/services/codexBridgeHost';
import type { SpawnBridgeHandler } from '../src/services/subagentMcpServer';

const handler: SpawnBridgeHandler = async () => ({ text: 'summary', isError: false });

/** POST `body` to `url` with `headers` (which may override Host) via node:http; resolve the
 * status code. */
function post(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const MCP_ACCEPT = 'application/json, text/event-stream';
const RPC_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

describe('codexBridgeHost httpListener — loopback hardening', () => {
  it('serves at an unguessable secret path, 404-ing a blind /mcp POST', async () => {
    const host = await createCodexBridgeHost({ handler });
    try {
      // The advertised url carries a random path segment, not a fixed /mcp.
      expect(host.mcpConfig.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
      const origin = new URL(host.mcpConfig.url!).origin;
      // A process that only knows the port (blind /mcp) is refused before the transport.
      const status = await post(`${origin}/mcp`, { accept: MCP_ACCEPT }, RPC_BODY);
      expect(status).toBe(404);
    } finally {
      await host.shutdown();
    }
  });

  it('rejects a spoofed Host header on the secret path (DNS-rebinding protection)', async () => {
    const host = await createCodexBridgeHost({ handler });
    try {
      // A DNS-rebinding page resolves its own hostname to 127.0.0.1 but still sends THAT
      // hostname as Host — not in allowedHosts → 403, never reaching the spawn handler.
      const status = await post(
        host.mcpConfig.url!,
        { accept: MCP_ACCEPT, host: 'evil.example.com' },
        RPC_BODY,
      );
      expect(status).toBe(403);
    } finally {
      await host.shutdown();
    }
  });

  it('routes a correct-Host request on the secret path through to the transport (not 404)', async () => {
    const host = await createCodexBridgeHost({ handler });
    try {
      // Correct loopback Host + the secret path clears BOTH guards and reaches the SDK
      // transport (which then handles the JSON-RPC itself) — proving the path is the only
      // thing gating access, and that a legitimate codex child is not locked out.
      const status = await post(host.mcpConfig.url!, { accept: MCP_ACCEPT }, RPC_BODY);
      expect(status).not.toBe(404);
    } finally {
      await host.shutdown();
    }
  });
});
