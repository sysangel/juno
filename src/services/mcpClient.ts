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

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
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
  /** `retriable` marks a failure the manager may recover by reviving the connection
   * and re-calling ONCE: a not-connected client or a transport-class error. It is
   * DELIBERATELY absent on a timeout (the call may have executed server-side, so a
   * blind retry is unsafe) and never set on a tool-level `isError` (that is `ok:true`). */
  | { ok: false; error: string; retriable?: boolean };

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

/** A destroyable stdio stream on the spawned child (structural — matches Node's
 * `Socket`/`Readable`/`Writable` without importing them). */
interface DestroyableStream {
  destroy?: () => void;
}
/** The subset of a Node `ChildProcess` this module force-releases. Structural so
 * it also matches whatever the SDK's `StdioClientTransport` stores at `_process`. */
interface ChildLike {
  /** The spawned child's pid. When the child was spawned `detached` it is also its
   * process-GROUP leader, so `-pid` addresses the whole tree (see releaseChild). */
  pid?: number;
  stdin?: DestroyableStream | null;
  stdout?: DestroyableStream | null;
  stderr?: DestroyableStream | null;
  kill?: (signal?: NodeJS.Signals) => boolean;
  unref?: () => void;
}

/**
 * The spawned child behind a default stdio transport, or `undefined` for any
 * injected (non-stdio) transport. Read structurally from the SDK
 * `StdioClientTransport`'s `_process`; MUST be captured BEFORE the SDK's
 * `close()` runs, since that nulls `_process`.
 */
function captureChild(transport: Transport | undefined): ChildLike | undefined {
  if (transport === undefined) {
    return undefined;
  }
  const proc = (transport as unknown as { _process?: unknown })._process;
  if (proc === null || typeof proc !== 'object') {
    return undefined;
  }
  return proc as ChildLike;
}

/**
 * Forcibly release OUR ends of a stdio child's pipes and terminate it.
 *
 * The SDK's `StdioClientTransport.close()` keeps the spawned child's stdio pipes
 * as Node `Socket`s on our side and never destroys them: it kills the child and
 * waits for the child's `'close'` event, which fires only once every stdio stream
 * is closed. When any DESCENDANT of the child (an `npx`/`sh` launcher, a forked
 * worker) inherits and holds the stdout pipe's write end, that `'close'` never
 * fires — our readable stdout `Socket` stays referenced and keeps the Node event
 * loop alive indefinitely, so juno cannot exit after a quit-during-connect (the
 * exit-hang: process still alive minutes later, needing a second Ctrl+C).
 *
 * Destroying our socket ends releases those handles regardless of who else holds
 * the pipe; SIGKILL-ing the child (round-1's guarantee — the direct child must
 * die, no orphan of it) and unref-ing it drains any remaining child handle. This
 * MUST run AFTER the SDK's own `close()` has attached its `'close'` waiter (see
 * teardown), so the death this triggers resolves that waiter rather than racing
 * it. Best-effort — an already-dead child / already-destroyed stream is fine.
 */
function releaseChild(child: ChildLike | undefined): void {
  if (child === undefined) {
    return;
  }
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy?.();
    } catch {
      // best-effort — a stream already errored/destroyed is fine.
    }
  }
  // Process-GROUP teardown (POSIX). The DetachedStdioTransport spawns the child with
  // `detached:true`, so setsid makes it its own process-group leader; a negative-pid
  // signal then reaps the WHOLE tree — an `npx`→`node` server, a forked worker, any
  // grandchild that ignores stdin EOF — not just the direct child (the orphaned-
  // grandchild leak). A detached child is NOT auto-killed when juno exits, so this must
  // run on BOTH the close() and the unexpected-drop paths — and both funnel through
  // here. Best-effort: the group may already be gone (ESRCH), or the child may not be a
  // leader (a non-detached injected test transport) — either way we fall through to the
  // direct kill below. Windows has no process groups, so skip the negative-pid signal
  // there and rely on the direct kill.
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 1) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // best-effort — the group is already reaped, or the child is not a group leader.
    }
  }
  try {
    child.kill?.('SIGKILL');
  } catch {
    // best-effort — already dead, or we lack permission (it dies when we exit).
  }
  try {
    child.unref?.();
  } catch {
    // best-effort — a still-dying child must not hold the loop open.
  }
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

/**
 * A shell-free stdio transport that spawns the server child in its OWN process
 * GROUP (`detached:true` → POSIX setsid), so a teardown can reap the entire tree
 * with a process-group signal (see releaseChild). The SDK's `StdioClientTransport`
 * hardcodes its spawn options with no `detached`, so juno owns this thin transport;
 * message framing reuses the SDK's exported `ReadBuffer` + `serializeMessage`, and
 * the spawned child is stored at `_process` — exactly where `captureChild` reads it,
 * so the existing pipe-destroy / SIGKILL teardown keeps working unchanged.
 */
class DetachedStdioTransport implements Transport {
  /** The spawned child. Named to match the SDK field `captureChild` reads. */
  private _process: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('DetachedStdioTransport already started');
    }
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn(this.command, this.args, {
        env: this.env,
        cwd: this.cwd,
        // Ignore the child's stderr: a chatty server must not stream into our memory,
        // and any protocol-level failure surfaces through the structured outcomes.
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
        // POSIX: setsid → the child leads its own process group, so releaseChild can
        // reap the whole tree. No-op on Windows (no process groups), where the
        // negative-pid kill is skipped and we rely on the direct child kill.
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
      });
      this._process = child;
      child.on('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on('spawn', () => {
        resolve();
      });
      child.on('close', () => {
        // Fire onclose FIRST, while `_process` still points at the (now-exited) child, so
        // the connection's drop handler — which captures the child SYNCHRONOUSLY off this
        // transport's `_process` to run the process-group teardown (releaseChild) — actually
        // finds it. Nulling before onclose made captureChild return undefined on EVERY real
        // unexpected exit, so releaseChild no-op'd: no killpg, no direct kill, no unref, and
        // a detached grandchild/worker outlived both the drop and juno's own exit. Null it
        // only AFTER onclose has run its teardown.
        this.onclose?.();
        this._process = undefined;
      });
      child.stdin?.on('error', (error) => {
        this.onerror?.(error);
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.drainReadBuffer();
      });
      child.stdout?.on('error', (error) => {
        this.onerror?.(error);
      });
    });
  }

  /** Pull every complete newline-framed message the buffer holds, surfacing a parse
   * error out of band (onerror) without collapsing the stream — matches the SDK. */
  private drainReadBuffer(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) {
        return;
      }
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this._process?.stdin;
    if (stdin === undefined || stdin === null) {
      throw new Error('DetachedStdioTransport: not connected');
    }
    const json = serializeMessage(message);
    await new Promise<void>((resolve) => {
      if (stdin.write(json)) {
        resolve();
      } else {
        stdin.once('drain', resolve);
      }
    });
  }

  async close(): Promise<void> {
    // Best-effort nudge: end our write end so a well-behaved child sees stdin EOF. The
    // connection's releaseChild does the hard teardown (pipe destroy + process-group
    // kill) AFTER capturing the child; firing onclose here unwinds the SDK Client.
    const child = this._process;
    this.readBuffer.clear();
    try {
      child?.stdin?.end();
    } catch {
      // best-effort — the pipe may already be gone.
    }
    this.onclose?.();
  }
}

/** Default transport: a shell-free, process-group-leading stdio child from the server
 * config. `env` layers the config env over the SDK's safe-default environment (so a
 * partial `env` does not blank out PATH etc.); `cwd` falls back to the workspace root. */
function defaultStdioTransportFactory(config: McpServerConfig, fallbackCwd: string): Transport {
  const [command, ...args] = config.command;
  return new DetachedStdioTransport(
    command ?? '',
    args,
    { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    config.cwd ?? fallbackCwd,
  );
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
  onDrop?: () => void,
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
  // The transport paired with `client`/`pendingClient` (whichever is in play).
  // Teardown needs it to force-release the spawned child's stdio pipes: the SDK
  // `Client.close()` alone leaves our pipe `Socket`s alive whenever a descendant of
  // the child holds the pipe open, which is what keeps the event loop from draining
  // (see releaseChild). Mirrors the pending/live split above.
  let pendingTransport: Transport | undefined;
  let liveTransport: Transport | undefined;
  // Latched by close(). connect()'s continuation checks it so a handshake that
  // resolves AFTER a close (a cold-start race) is torn down, never published.
  let closed = false;

  /** Fully tear a client + its transport down so the event loop can drain even if
   * a descendant of the spawned child holds a pipe open. Used by close() AND every
   * connect() unwind path (timeout / error / closed-during-connect) — a wedged
   * connect leaks the same pipe as a quit-during-connect does.
   *
   * Order matters. Capture the child FIRST (the SDK close nulls the transport's
   * `_process`). Then KICK the SDK client close best-effort but do NOT await it:
   * its synchronous part is all we need (fire onclose so the in-flight handshake
   * rejects, end the child's stdin), while its tail awaits the child's `'close'`
   * event — which, once we destroy our pipe ends and unref the child below, may
   * never fire because nothing is left to keep the loop alive to reap the child.
   * Blocking on it would leave close() unsettled. Finally force-release the child:
   * destroy OUR pipe ends and SIGKILL it, so the loop drains regardless of any
   * descendant still holding a pipe. */
  const teardown = (target: Client, transport: Transport | undefined): void => {
    const child = captureChild(transport);
    void target.close().catch(() => {
      // best-effort — a failed close still drops our reference.
    });
    releaseChild(child);
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

      // Track the in-flight client AND its transport BEFORE awaiting: the child is
      // spawned by `pending.connect`, so a close() that lands during the handshake
      // needs both a client to close and the transport to force-release the child's
      // pipes (see close()/teardown).
      const pending = new Client(CLIENT_INFO, { capabilities: {} });
      pendingClient = pending;
      pendingTransport = transport;
      const race = await withTimeout(pending.connect(transport), timeoutMs, setTimer);
      pendingClient = undefined;
      pendingTransport = undefined;
      // A close() during the handshake wins the race: tear the freshly spawned
      // child down and never publish the client, so the process can exit.
      if (closed) {
        teardown(pending, transport);
        return { ok: false, error: `mcp[${serverName}]: connection closed` };
      }
      if (race.kind === 'timeout') {
        teardown(pending, transport);
        return { ok: false, error: `mcp[${serverName}]: connect timed out after ${timeoutMs}ms` };
      }
      if (race.kind === 'error') {
        teardown(pending, transport);
        return { ok: false, error: `mcp[${serverName}]: connect failed (${errText(race.error)})` };
      }
      client = pending;
      liveTransport = transport;
      // Drop detection: the SDK invokes the client's `onclose` when the transport
      // closes. An UNEXPECTED close (the child died / a pipe broke) — as opposed to
      // our own close(), which latches `closed` first — nulls the live client and
      // notifies the owner, so a dead server stops reporting connected and its next
      // callTool short-circuits instead of waiting out the full per-call timeout.
      pending.onclose = () => {
        if (closed || client !== pending) {
          return;
        }
        // Force-release OUR ends of the DROPPED child's stdio pipes (destroy the pipe
        // Sockets, then SIGKILL + unref the child) — the SAME exit-hang guard that
        // close()/teardown apply, now on the UNEXPECTED-drop path. The SDK's transport
        // close leaves our readable stdout `Socket` alive whenever a DESCENDANT of the
        // child (an npx/sh launcher, a forked worker) still holds the pipe's write end,
        // so without this a mid-session drop would leak that pipe and keep the Node event
        // loop alive past the drop. Capture the child from `liveTransport` BEFORE nulling
        // it (that is the field teardown/close read from too). Best-effort — an
        // already-dead child / already-destroyed stream is fine. Runs BEFORE onDrop, so a
        // reconnect the owner schedules on drop always builds its fresh transport against
        // a fully-released old child.
        const child = captureChild(liveTransport);
        client = undefined;
        liveTransport = undefined;
        releaseChild(child);
        onDrop?.();
      };
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
        // Not connected (e.g. the server dropped moments ago) — the manager may revive
        // and re-call, so mark it retriable.
        return { ok: false, error: `mcp[${serverName}]: not connected`, retriable: true };
      }
      const race = await withTimeout(
        client.callTool({ name, arguments: args ?? {} }),
        timeoutMs,
        setTimer,
      );
      if (race.kind === 'timeout') {
        // NOT retriable: the call may already be executing server-side, so a blind
        // re-call could double a side effect.
        return { ok: false, error: `mcp[${serverName}]: tool "${name}" timed out after ${timeoutMs}ms` };
      }
      if (race.kind === 'error') {
        // A transport-class error (e.g. the child died mid-call) — retriable: the
        // manager can rebuild the connection and re-call once.
        return {
          ok: false,
          error: `mcp[${serverName}]: tool "${name}" failed (${errText(race.error)})`,
          retriable: true,
        };
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
      // Tear down whichever client we hold — the live one, or an in-flight `pending`
      // whose handshake has not yet resolved — together with its transport. The two
      // are mutually exclusive, so `?? ` picks the pair in play. teardown() both
      // closes the SDK client AND force-releases the spawned child's stdio pipes, so
      // a quit during connect neither leaks the child NOR leaves a pipe `Socket` that
      // keeps the event loop alive (the exit-hang).
      const target = client ?? pendingClient;
      const transport = liveTransport ?? pendingTransport;
      if (target !== undefined) {
        client = undefined;
        pendingClient = undefined;
        liveTransport = undefined;
        pendingTransport = undefined;
        teardown(target, transport);
      }
    },
  };
}
