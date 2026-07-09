// src/services/mcpClient.ts
// One MCP (Model Context Protocol) stdio SERVER connection — Wave 2 of the MCP
// client. It wraps the official SDK's `Client` over a `StdioClientTransport`:
// connect (spawn + `initialize` handshake) → `tools/list` → `tools/call` → close.
//
// Like brainRecall.ts every failure path (build/spawn error, connect/list/call
// timeout, transport rejection, missing command) resolves to a structured
// `{ ok:false, error }` — the service NEVER throws across its boundary, so one
// misbehaving server can never crash the session or the manager that owns it.
//
// The transport is built by an INJECTABLE factory (default: a shell-free
// StdioClientTransport from the server config) so tests can hand in an
// InMemoryTransport half linked to a scripted in-process server. The connect /
// per-call timeouts go through the SAME injectable `setTimer` seam brainRecall
// uses, so the timeout paths are deterministic under test.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './config';
import type { TimerHandle } from './brain';

/** Client identity advertised in the `initialize` handshake. */
const CLIENT_INFO = { name: 'juno', version: '0.1.0' } as const;

/** Default connect / per-call timeout (ms) when a server sets no `timeoutMs`.
 * Deliberately shorter than the 120s per-execution tool timeout
 * (executor.ts `DEFAULT_TOOL_TIMEOUT_MS`): a wedged handshake or call should
 * fail soft well before the tool executor's outer guard would trip. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** A discovered tool as juno sees it — the SDK's tool descriptor, narrowed to the
 * fields the tool layer needs (server tagging happens in the manager). */
export interface McpToolInfo {
  /** Tool name, unique within its server. */
  name: string;
  /** Human/model-facing description, if the server provided one. */
  description?: string;
  /** JSON-Schema input shape, passed through verbatim for the model's tool spec. */
  inputSchema: Record<string, unknown>;
}

/** The normalized outcome of a `tools/call`. `content` is the SDK content-block
 * array (text/image/resource/…), passed through for the caller to render;
 * `isError` reflects the server's tool-level error flag (NOT a transport error —
 * those surface as `{ ok:false }`). */
export interface McpToolCallResult {
  content: unknown[];
  isError: boolean;
  /** Structured output, when the tool declared an output schema. */
  structuredContent?: Record<string, unknown>;
}

export type McpConnectOutcome = { ok: true } | { ok: false; error: string };
export type McpListToolsOutcome =
  | { ok: true; tools: McpToolInfo[]; warnings: string[] }
  | { ok: false; error: string };
export type McpCallToolOutcome =
  | { ok: true; result: McpToolCallResult }
  | { ok: false; error: string };

/** Builds the transport for one server. Injected in tests (e.g. an
 * `InMemoryTransport` half); the default spawns a shell-free stdio child. */
export type McpTransportFactory = (config: McpServerConfig, fallbackCwd: string) => Transport;

export interface McpClientDeps {
  /** Injectable transport factory. Default: shell-free StdioClientTransport. */
  transportFactory?: McpTransportFactory;
  /** Injectable scheduler so connect/call timeouts are deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

/** A live (or connectable) handle to one MCP server. All methods fail soft. */
export interface McpClientConnection {
  /** The server id this connection was created for (stable, from config keys). */
  readonly serverName: string;
  /** Spawn/connect + `initialize`. Idempotent: a second call on a live
   * connection is a no-op `{ ok:true }`. Bounded by the resolved timeout. */
  connect(): Promise<McpConnectOutcome>;
  /** `tools/list`. Requires a prior successful connect. */
  listTools(): Promise<McpListToolsOutcome>;
  /** `tools/call`. Requires a prior successful connect. */
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolOutcome>;
  /** Close the transport/child. Best-effort and idempotent; never throws. */
  close(): Promise<void>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The three-way result of racing an op against a bounded timer. */
type RaceResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error'; error: unknown };

/** Race a promise against a bounded timer. The underlying op is left running on
 * timeout (the caller closes the connection to unwind it); this never throws. */
async function withTimeout<T>(
  op: Promise<T>,
  timeoutMs: number,
  setTimer: (fn: () => void, ms: number) => TimerHandle,
): Promise<RaceResult<T>> {
  return new Promise<RaceResult<T>>((resolve) => {
    let settled = false;
    const settle = (result: RaceResult<T>): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const timer = setTimer(() => settle({ kind: 'timeout' }), timeoutMs);
    op.then(
      (value) => {
        timer.clear();
        settle({ kind: 'value', value });
      },
      (error: unknown) => {
        timer.clear();
        settle({ kind: 'error', error });
      },
    );
  });
}

/** Default transport: a shell-free stdio child from the server config. `env`
 * layers the config env over the SDK's safe-default environment (so a partial
 * `env` does not blank out PATH etc.); `cwd` falls back to the workspace root. */
function defaultStdioTransportFactory(config: McpServerConfig, fallbackCwd: string): Transport {
  const [command, ...args] = config.command;
  return new StdioClientTransport({
    command: command ?? '',
    args,
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    cwd: config.cwd ?? fallbackCwd,
    // Ignore the child's stderr: a chatty server must not stream into our memory,
    // and any protocol-level failure surfaces through the structured outcomes.
    stderr: 'ignore',
  });
}

/** The provider APIs (Anthropic/OpenAI) constrain a tool spec name to
 * `^[a-zA-Z0-9_-]{1,64}$` — and it is the FULL namespaced `mcp__<server>__<tool>`
 * name that lands in the model request, so the bound applies to that. */
const TOOL_SPEC_NAME_MAX = 64;
/** Chars the namespace wrapper adds around the server id: `mcp__` + `__`. Keep
 * in sync with `mcpToolName` (mcpTools.ts). */
const NAMESPACE_OVERHEAD = 'mcp__'.length + '__'.length;

/** A discovered tool name must round-trip cleanly through the
 * `mcp__<server>__<tool>` namespace, the permission-pattern grammar
 * (patterns.ts), AND the provider APIs' tool-name constraint (one out-of-charset
 * or over-long spec name 400s EVERY parent-agent turn). So this is an ALLOWLIST,
 * mirroring `isValidMcpServerId` (config.ts):
 *   - charset `[A-Za-z0-9_-]` only — which by construction also excludes the
 *     permission grammar's meaningful chars (`*` glob, `:` matchKey separator),
 *     spaces, dots, and unicode;
 *   - no `__` inside the name — the namespace separator: a tool `b__c` on
 *     server `a` would produce the SAME final name `mcp__a__b__c` as tool `c`
 *     on server `a__b`, so one would silently shadow the other at dispatch;
 *   - short enough that the FULL namespaced name fits `TOOL_SPEC_NAME_MAX` —
 *     computed against the actual server name, both in hand at listTools time.
 * A rejected name is dropped fail-soft with a warning (never throws). */
function isSafeToolName(name: string, serverName: string): boolean {
  return (
    /^[A-Za-z0-9_-]+$/.test(name) &&
    !name.includes('__') &&
    NAMESPACE_OVERHEAD + serverName.length + name.length <= TOOL_SPEC_NAME_MAX
  );
}

/** Narrow one SDK tool descriptor to juno's McpToolInfo, dropping anything
 * without a usable name/schema (a defensive guard — servers vary). */
function normalizeToolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0) {
    return undefined;
  }
  const info: McpToolInfo = {
    name: raw.name,
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object' },
  };
  if (typeof raw.description === 'string') {
    info.description = raw.description;
  }
  return info;
}

/**
 * Build a connection handle for one configured MCP server. Nothing is spawned
 * until `connect()` is called; the SDK `Client` is created lazily so a config-
 * only manager can hold idle handles cheaply.
 */
export function createMcpClientConnection(
  serverName: string,
  config: McpServerConfig,
  fallbackCwd: string,
  deps: McpClientDeps = {},
): McpClientConnection {
  const transportFactory = deps.transportFactory ?? defaultStdioTransportFactory;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

  // The live client once connected; undefined while idle/closed.
  let client: Client | undefined;
  // The client whose handshake is in flight (assigned before the connect await,
  // cleared once it settles). close() must be able to tear this down: the child is
  // already spawned before `client` is published, so without this a quit during an
  // in-flight connect would leak the process (close() no-ops on `client`).
  let pendingClient: Client | undefined;
  // Latched by close(). connect()'s continuation checks it so a handshake that
  // resolves AFTER a close (a cold-start race) is torn down, never published.
  let closed = false;

  /** Best-effort close that swallows any error (used on both teardown and the
   * timeout/error unwind paths). */
  const safeClose = async (target: Client): Promise<void> => {
    try {
      await target.close();
    } catch {
      // best-effort — a failed close still drops our reference.
    }
  };

  return {
    serverName,

    async connect(): Promise<McpConnectOutcome> {
      if (client !== undefined) {
        return { ok: true };
      }
      if (closed) {
        return { ok: false, error: `mcp[${serverName}]: connection closed` };
      }
      const [bin] = config.command;
      if (bin === undefined || bin.length === 0) {
        return { ok: false, error: `mcp[${serverName}]: no command configured` };
      }

      let transport: Transport;
      try {
        transport = transportFactory(config, fallbackCwd);
      } catch (err) {
        return { ok: false, error: `mcp[${serverName}]: failed to build transport (${errText(err)})` };
      }

      // Track the in-flight client BEFORE awaiting: the child is spawned by
      // `pending.connect`, so a close() that lands during the handshake needs a
      // handle to kill (see close()).
      const pending = new Client(CLIENT_INFO, { capabilities: {} });
      pendingClient = pending;
      const race = await withTimeout(pending.connect(transport), timeoutMs, setTimer);
      pendingClient = undefined;
      // A close() during the handshake wins the race: tear the freshly spawned
      // child down and never publish the client, so the process can exit.
      if (closed) {
        await safeClose(pending);
        return { ok: false, error: `mcp[${serverName}]: connection closed` };
      }
      if (race.kind === 'timeout') {
        await safeClose(pending);
        return { ok: false, error: `mcp[${serverName}]: connect timed out after ${timeoutMs}ms` };
      }
      if (race.kind === 'error') {
        await safeClose(pending);
        return { ok: false, error: `mcp[${serverName}]: connect failed (${errText(race.error)})` };
      }
      client = pending;
      return { ok: true };
    },

    async listTools(): Promise<McpListToolsOutcome> {
      if (client === undefined) {
        return { ok: false, error: `mcp[${serverName}]: not connected` };
      }
      const race = await withTimeout(client.listTools(), timeoutMs, setTimer);
      if (race.kind === 'timeout') {
        return { ok: false, error: `mcp[${serverName}]: tools/list timed out after ${timeoutMs}ms` };
      }
      if (race.kind === 'error') {
        return { ok: false, error: `mcp[${serverName}]: tools/list failed (${errText(race.error)})` };
      }
      const rawTools = isRecord(race.value) && Array.isArray(race.value.tools) ? race.value.tools : [];
      const tools: McpToolInfo[] = [];
      const warnings: string[] = [];
      // Track accepted names so an untrusted server returning two descriptors with
      // the SAME name can never yield duplicate `mcp__<server>__<tool>` specs (the
      // model APIs reject duplicate tool names — one such server would otherwise
      // fail every parent-agent turn). Keep first, warn on each dropped duplicate.
      const seen = new Set<string>();
      for (const raw of rawTools) {
        const info = normalizeToolInfo(raw);
        if (info === undefined) {
          // Malformed descriptor (no usable name/shape) — skipped silently, as before.
          continue;
        }
        if (!isSafeToolName(info.name, serverName)) {
          warnings.push(
            `mcp[${serverName}]: dropped tool "${info.name}" (name must be [A-Za-z0-9_-] without "__", and "mcp__${serverName}__<tool>" must fit ${TOOL_SPEC_NAME_MAX} chars)`,
          );
          continue;
        }
        if (seen.has(info.name)) {
          warnings.push(
            `mcp[${serverName}]: dropped duplicate tool "${info.name}" (a tool with this name was already discovered)`,
          );
          continue;
        }
        seen.add(info.name);
        tools.push(info);
      }
      return { ok: true, tools, warnings };
    },

    async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolOutcome> {
      if (client === undefined) {
        return { ok: false, error: `mcp[${serverName}]: not connected` };
      }
      const race = await withTimeout(
        client.callTool({ name, arguments: args ?? {} }),
        timeoutMs,
        setTimer,
      );
      if (race.kind === 'timeout') {
        return { ok: false, error: `mcp[${serverName}]: tool "${name}" timed out after ${timeoutMs}ms` };
      }
      if (race.kind === 'error') {
        return { ok: false, error: `mcp[${serverName}]: tool "${name}" failed (${errText(race.error)})` };
      }
      const value = race.value;
      const result: McpToolCallResult = {
        content: isRecord(value) && Array.isArray(value.content) ? value.content : [],
        isError: isRecord(value) && value.isError === true,
      };
      if (isRecord(value) && isRecord(value.structuredContent)) {
        result.structuredContent = value.structuredContent;
      }
      return { ok: true, result };
    },

    async close(): Promise<void> {
      closed = true;
      // Close whichever client we hold — the live one, or an in-flight `pending`
      // whose handshake has not yet resolved. Killing `pending` unwinds the
      // spawned child so a quit during connect can't leak the process; the two are
      // mutually exclusive, so `client ?? pendingClient` picks the one in play.
      const target = client ?? pendingClient;
      if (target !== undefined) {
        client = undefined;
        pendingClient = undefined;
        await safeClose(target);
      }
    },
  };
}
