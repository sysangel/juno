import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent } from '../core/events';
import type { ModelClient, PermissionPolicy, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import type { McpServerConfig } from '../services/config';
import { matchesPattern, normalizePattern } from '../permissions/patterns';
import { classifyRisk } from '../tools/mcpTools';
import type { CodexSpawnBridge } from './codexSpawnBridge';
import { asObject, errorMessage, numberField, parseJsonObject, stringField, type JsonObject } from './jsonUtil';

/**
 * How codex is told to reach juno's in-process `spawn_subagent` MCP server. Codex
 * `exec` has no inline `--tool` flag — its only custom-tool channel is an MCP
 * server registered via `-c mcp_servers.<name>.…` (see codexToolArgs). `serverName`
 * becomes the codex-side namespace (codex exposes the tool to its model as
 * `mcp__<serverName>__spawn_subagent`). Provide EITHER `url` (a streamable-HTTP
 * endpoint juno binds in-process — the primary path, needed so the server shares
 * the process with the active turn for parent attribution) OR `command` (a stdio
 * launcher argv). Absent config ⇒ codexToolArgs emits no flags and codex keeps only
 * its built-in shell + apply_patch toolset.
 */
export interface CodexMcpConfig {
  /** MCP server id codex registers (also the tool's codex-side namespace). */
  serverName: string;
  /** Streamable-HTTP endpoint codex connects to, e.g. `http://127.0.0.1:PORT/mcp`. */
  url?: string;
  /** Alternatively, a stdio launcher argv codex spawns as the MCP server. */
  command?: readonly string[];
}

/**
 * The child's stderr read-end. We attach a `'data'` listener EAGERLY at spawn to
 * accumulate a bounded tail (see `captureStderrTail`) — Node's `flushStdio` runs
 * one tick after the child's `exit` event and DISCARDS any unread buffered stdio,
 * so a reader attached late (after exit is observed) reads nothing from a real
 * pipe. Node's `Readable` satisfies this structurally (`.on`, `.destroy`).
 * Lifted verbatim from claudeCliClient — the four hard-won Node child-stdio facts
 * (attach-late drain, stdout/exit race, grandchild-inherited fds, fakes lie) apply
 * identically to `codex exec`.
 */
export interface StderrStreamLike {
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  /** Release OUR read-end so a grandchild holding fd 2 can't keep the loop alive. */
  destroy?(): void;
}

/**
 * Minimal child-process surface the client depends on, so tests can inject a
 * fake without dragging in Node's real `ChildProcess`. The real
 * `node:child_process.spawn` return value structurally satisfies this.
 */
export interface ChildProcessLike {
  /** stdout as an async-iterable of chunks (string or Uint8Array). */
  readonly stdout: AsyncIterable<string | Uint8Array> | null;
  /** stderr (optional; captured eagerly at spawn for the failure message). */
  readonly stderr?: StderrStreamLike | null;
  /** Terminate the child. Mirrors ChildProcess.kill's boolean return. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /**
   * Drop the child from the event-loop's ref count so a still-dying child (or a
   * grandchild holding an inherited fd) cannot keep juno alive at quit. Released
   * on every attempt-end path (see `releaseChild`). Structural on Node's child.
   */
  unref?(): void;
  /**
   * Lifecycle listeners. `exit`/`close` carry the exit code AND, for a
   * signal-killed child, the death signal (code is null, signal set — e.g.
   * 'SIGKILL'). `error` carries a spawn failure.
   */
  on(event: 'exit' | 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/**
 * Spawn options. Unlike claudeCliClient, codex REQUIRES a scrubbed `env`: if
 * `OPENAI_API_KEY` reaches the child, Codex may silently bill an API account
 * instead of the ChatGPT subscription (the whole point of this backend). The
 * client always passes an env with `OPENAI_API_KEY` removed (see `scrubbedEnv`),
 * so the option is threaded through the SpawnImpl seam and asserted in tests.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
) => ChildProcessLike;

/**
 * Injectable timer handle. `setTimer` returns one of these so a stall timer can
 * be cancelled. The default wraps the global setTimeout/clearTimeout; tests
 * inject a deterministic fake clock so no real 60–90s wait is ever incurred.
 */
export interface TimerHandle {
  clear: () => void;
}

export interface CodexCliDeps {
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  spawnImpl?: SpawnImpl;
  /** Override the resolved `codex` binary path/name. Defaults to `codex`. */
  binPath?: string;
  /**
   * Base process env the child inherits. Defaults to `process.env`. The client
   * ALWAYS strips `OPENAI_API_KEY` from a shallow copy before spawning (auth
   * safety — see the class docstring), so injecting an env that contains the key
   * still yields a child without it (the unit test relies on exactly this).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Per-chunk READ timeout (ms): resets on EVERY stdout chunk. If no chunk at
   * all arrives within the window the stream is treated as stalled. Default
   * 60_000 (Hermes "60s read timeout").
   */
  idleTimeoutMs?: number;
  /**
   * STALE-STREAM timeout (ms): resets only when a NON-EMPTY parsed NDJSON line
   * is actually yielded (real progress). Catches the trickle-whitespace /
   * keepalive-but-no-progress hang that the idle timer misses. Default 90_000.
   * Conceptually >= idleTimeoutMs.
   */
  staleStreamMs?: number;
  /**
   * Injectable scheduler so stall timers are deterministic in tests (no real
   * 60–90s waits). Default wraps global setTimeout/clearTimeout.
   */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /**
   * EXIT-WAIT timeout (ms): after stdout closes with no terminal turn event, how
   * long to wait for the child's `exit` event before deciding success vs error.
   * stdout close and the `exit` event are SEPARATE and race — stdout usually
   * closes first — so without a short wait `exitCode` is still null when the
   * decision runs and a fast-failing startup error (codex exit 1/2 with NO NDJSON)
   * is misread as a clean turn. Bounded so a lingering child cannot hang the turn.
   * Default 2_000. Only ever incurred on the (rare) no-terminal path.
   */
  exitWaitMs?: number;
  /**
   * The codex spawn bridge (Wave 8). When present, a codex PARENT can call juno's
   * in-process `spawn_subagent` MCP server: the client (1) registers each turn with
   * the bridge so the MCP handler can emit the spawn card + nested child tool events
   * into THIS turn's output stream, (2) MERGES those bridge events with codex's
   * translated stdout, and (3) SUSPENDS its idle/stale stall timers while a spawn is
   * in flight (codex is legitimately blocked on the MCP result, so a quiet stdout is
   * expected). Absent ⇒ the client behaves exactly as before (no merge, no timer
   * suppression). Pairs with `mcpConfig` (which points codex at the server).
   */
  bridge?: CodexSpawnBridge;
  /**
   * How codex is told to reach the in-process `spawn_subagent` MCP server. Threaded
   * into `codexToolArgs` to emit the `-c mcp_servers.<name>.…` flags. Absent ⇒ no
   * MCP flags (codex keeps only its built-in toolset). Set together with `bridge`.
   */
  mcpConfig?: CodexMcpConfig;
  /**
   * juno's configured MCP servers (`settings.mcpServers`) — the Wave-10 codex MCP
   * PASSTHROUGH (parent turns only, present only on the parent factory). When present
   * with `policy`, the render-only codex child is handed `-c mcp_servers.<name>.…`
   * overrides for the servers juno's gate AUTO-ALLOWS, plus `--ignore-user-config` so
   * the user's ambient `~/.codex/config.toml` MCP servers can never load ungated.
   * TRANSLATION not proxy: codex opens its OWN stdio connection to the SAME servers
   * (exactly as the claude-cli child does), gated by juno's toolRisk/permissions.
   *
   * CAPABILITY GAPS vs the claude-cli passthrough (codex `exec` genuinely cannot match
   * all of it — reported, never faked):
   *  - NO per-tool MCP allowlist in codex `exec`, so gating is SERVER-granularity: a
   *    server is wired ONLY IF EVERY one of its exposed tools auto-allows (one
   *    risky/prompt/deny tool denies the whole server). A mixed-risk server (e.g. the
   *    brain server: recall/get_episode safe, remember risky) is therefore denied
   *    wholesale.
   *  - NO `--mcp-config` FILE channel: codex takes MCP config only via `-c key=value`
   *    (on argv) or config.toml. A server's `env` on argv is `ps`-visible, so a server
   *    that carries `env` is NOT wired (fail-closed) — only command/args (already
   *    process-visible) are translated.
   *  - `--ignore-user-config` is BROADER than claude's `--strict-mcp-config`: it drops
   *    ALL of the user's config.toml, not just the MCP sources.
   * Omitted ⇒ no passthrough and no ambient suppression (the pre-Wave-10 behaviour).
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * juno's live permission policy, used READ-ONLY to mirror juno's OWN gate decision
   * onto the codex passthrough: a server is wired only when its every exposed tool
   * evaluates to `auto-allow`. Required alongside `mcpServers`.
   */
  policy?: PermissionPolicy;
}

/** Which guard timer fired — surfaced verbatim in the stall error message. */
type StallKind = 'idle' | 'stale';

/**
 * File-local sentinel thrown out of the stdout pump when a guard timer fires.
 * Caught by the try/catch around the consumption loop, which surfaces it via the
 * existing `error` + `assistant-done('error')` events — no new AgentEvent variant.
 */
class StreamStallError extends Error {
  readonly kind: StallKind;
  constructor(kind: StallKind, message: string) {
    super(message);
    this.name = 'StreamStallError';
    this.kind = kind;
  }
}

/**
 * How one `codex exec --json` spawn+consume attempt ended.
 * - `done`       : a `turn.completed` (success) OR a clean exit-0 with no terminal.
 * - `failed`     : an in-band `turn.failed` / top-level `error` (model/API error).
 * - `error`      : a thrown stream/stall/parse exception during consumption.
 * - `exit-error` : a non-zero exit / signal death with NO in-band terminal (a
 *                  startup error that emits no NDJSON — bad flag, untrusted dir).
 * - `aborted`    : user cancellation (never surfaced as an error).
 */
type AttemptResult =
  | { kind: 'done' }
  | { kind: 'failed'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'exit-error'; code: number | null; signal?: NodeJS.Signals | null; stderr?: string }
  | { kind: 'aborted' };

/**
 * Subscription `codex` CLI adapter — drives the OpenAI Codex CLI over Aiden's
 * ChatGPT subscription. Spawns
 *   `codex exec --json --skip-git-repo-check -m <model> --sandbox <s> \
 *     -c approval_policy=never -c preferred_auth_method=chatgpt [--cd <dir>] <prompt>`
 * and TRANSLATES the item-granular NDJSON stream into juno's normalized
 * AgentEvents (assistant-start/text-delta/tool-call/tool-status/usage/
 * assistant-done/aborted/error), mirroring the render-only seam of
 * claudeCliClient. `codex exec --json` is ITEM-granular (whole item.started /
 * item.completed events) — there are NO assistant-text deltas and NO reasoning
 * deltas in this transport, so a whole agent_message renders as one text-delta
 * and no reasoning pane is produced (recon 0.144.1).
 *
 * AUTH SAFETY (load-bearing): the CLI's own subscription OAuth (~/.codex/auth.json)
 * is used — NO API key. `auth.json` still carries an OPENAI_API_KEY field, so if
 * that env var reaches the child Codex may silently switch to API-key billing.
 * The child env therefore ALWAYS has `OPENAI_API_KEY` scrubbed, and
 * `-c preferred_auth_method=chatgpt` pins the subscription path.
 *
 * RENDER-ONLY: `codex exec` runs its own tools (shell + apply_patch) to completion
 * within the single invocation, so juno never re-executes. A successful turn maps
 * to StopReason 'end' (never 'tool_use') — if 'tool_use' leaked out, turnRunner
 * would re-spawn codex in a loop.
 *
 * SESSION RESUME (v2): the first turn spawns fresh and captures the codex
 * `thread_id` from `thread.started`; each subsequent turn (same epoch + model)
 * spawns `codex exec resume <thread_id>` with a TAIL-ONLY prompt (only the messages
 * committed since the last delivered turn) instead of replaying the whole transcript.
 * The session id is invalidated by an epoch bump (clear/compact/resume-session), a
 * model switch, an abort, or a turn error/failure — the next turn then re-spawns
 * fresh. There is deliberately NO in-turn resume→fresh retry loop (unlike
 * claudeCliClient): a resume spawn that fails surfaces its error and the clear-on-
 * failure rule makes the FOLLOW-UP turn fresh, keeping this backend a single
 * spawn+consume per turn. Flag-surface caveat: `exec resume` rejects `--sandbox`/
 * `--cd`, so sandbox mode is re-pinned via `-c sandbox_mode=<mode>` and cwd rides the
 * spawn `cwd` option — see `buildArgs` for the live-verified rationale.
 */
export function createCodexCliClient(entry: ModelEntry, deps: CodexCliDeps = {}): ModelClient {
  // Tests ALWAYS inject `spawnImpl`, so the real node:child_process.spawn below
  // is only ever reached in production (the GATE forbids live subprocess calls).
  const spawnImpl: SpawnImpl =
    deps.spawnImpl ??
    ((command, args, options) =>
      nodeSpawn(command, [...args], options) as unknown as ChildProcessLike);
  const binPath = deps.binPath ?? 'codex';
  const baseEnv = deps.env ?? process.env;

  const idleTimeoutMs = deps.idleTimeoutMs ?? 60_000;
  const staleStreamMs = deps.staleStreamMs ?? 90_000;
  const exitWaitMs = deps.exitWaitMs ?? 2_000;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });

  // Cross-turn session reuse (v2, `codex exec resume`). The client instance is
  // memoized per backend in app.tsx, so this closure persists across turns for a
  // stable backend. We remember the codex `thread_id` (the resumable session id
  // carried on `thread.started`) plus the (epoch, model) it belongs to; the NEXT
  // turn resumes that session with `exec resume <id>` + a TAIL-ONLY prompt instead
  // of replaying the whole transcript. Any of { epoch bump (clear/compact/resume-
  // session), model switch, abort, turn error/failure } invalidates the id so the
  // next turn starts fresh and re-sends juno's authoritative full transcript.
  let sessionId: string | undefined;
  let sessionEpoch: number | undefined;
  let sessionModel: string | undefined;
  // Watermark for the resume tail: how many transcript messages the codex session
  // already accounts for (everything sent in prior prompts plus the assistant
  // messages it generated). The NEXT resume tail is exactly the messages committed
  // SINCE this point — which is what carries a mid-turn `/steer` (a user message
  // that commits BEFORE the turn's assistant message) into the tail. Advanced every
  // delivered turn to the submit-time message count.
  let deliveredMessageCount: number | undefined;

  const bridge = deps.bridge;
  // Wave-10 MCP passthrough bundle (parent turns only): set only when juno both
  // configured servers AND handed us its policy. When present, buildArgs pins the
  // child's MCP universe to juno's gated servers and suppresses the user's ambient
  // config with --ignore-user-config (see CodexCliDeps.mcpServers for the gaps).
  const mcpPassthrough =
    deps.mcpServers !== undefined &&
    deps.policy !== undefined &&
    Object.keys(deps.mcpServers).length > 0
      ? { servers: deps.mcpServers, policy: deps.policy }
      : undefined;

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      // Wave 8: with a `mcpConfig` the tools arg drives the codex `-c mcp_servers.…`
      // flags that offer juno's `spawn_subagent` to a codex parent over MCP; without
      // one it still produces no flags (codex keeps its built-in toolset).
      const toolArgs = codexToolArgs(tools, deps.mcpConfig);
      // Wave 10: translate juno's configured, gated MCP servers into their OWN
      // `-c mcp_servers.…` overrides (deny-by-default, server-granularity, env
      // fail-closed — see codexMcpPassthroughArgs). Coexists with the spawn_subagent
      // flags above (distinct server names). Empty when passthrough is off.
      const passthroughArgs =
        mcpPassthrough !== undefined ? codexMcpPassthroughArgs(tools, mcpPassthrough) : [];

      // Wave 8 bridge plumbing (only meaningful when a bridge is injected). The
      // in-process MCP handler emits AgentEvents (the spawn card + nested child tool
      // events) into THIS turn via `enqueueBridgeEvent`; the merged read loop below
      // drains them alongside codex's translated stdout. A single reusable waiter
      // (recreated only after it resolves) avoids accumulating pending promises.
      const bridgeQueue: AgentEvent[] = [];
      let bridgeNotify: (() => void) | undefined;
      let bridgeWaiter: Promise<{ kind: 'bridge' }> | undefined;
      const enqueueBridgeEvent = (event: AgentEvent): void => {
        bridgeQueue.push(event);
        bridgeNotify?.();
      };
      const drainBridgeQueue = (): AgentEvent[] => {
        if (bridgeQueue.length === 0) return [];
        const drained = bridgeQueue.slice();
        bridgeQueue.length = 0;
        return drained;
      };
      const bridgeWait = (): Promise<{ kind: 'bridge' }> => {
        if (bridgeQueue.length > 0) return Promise.resolve({ kind: 'bridge' });
        if (bridgeWaiter === undefined) {
          bridgeWaiter = new Promise<{ kind: 'bridge' }>((resolve) => {
            bridgeNotify = (): void => {
              bridgeNotify = undefined;
              bridgeWaiter = undefined;
              resolve({ kind: 'bridge' });
            };
          });
        }
        return bridgeWaiter;
      };

      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      // Epoch/model invalidation: a new transcript epoch (clear/compact/resume-
      // session) or a model switch means the codex session no longer matches juno's
      // context, so drop any captured id and start fresh. Done AFTER the entry-abort
      // early-return above so an aborted-before-spawn turn leaves session state and
      // the watermark untouched.
      const epoch = input.conversationEpoch ?? 0;
      if (epoch !== sessionEpoch || input.model !== sessionModel) {
        sessionId = undefined;
      }
      sessionEpoch = epoch;
      sessionModel = input.model;

      // Resume iff we still hold a session id after invalidation.
      const resume = sessionId !== undefined;
      const resumeSessionId = resume ? sessionId : undefined;
      // Snapshot the prior watermark for THIS turn's tail, then advance it so the
      // NEXT turn resumes from here. Fresh spawns ignore this value (they replay the
      // whole transcript); a resumed turn sends only messages committed since it.
      const resumeFromIndex = deliveredMessageCount ?? 0;
      deliveredMessageCount = input.messages.length;

      const args = buildArgs(
        entry,
        input,
        resumeSessionId,
        resumeFromIndex,
        toolArgs,
        passthroughArgs,
        mcpPassthrough !== undefined,
      );

      let child: ChildProcessLike;
      try {
        child = spawnImpl(binPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Pin the child cwd to juno's workspace jail root, mirroring claudeCliClient.
          cwd: input.cwd,
          // AUTH SAFETY: strip OPENAI_API_KEY so Codex cannot silently bill an API
          // account instead of the ChatGPT subscription.
          env: scrubbedEnv(baseEnv),
        });
      } catch (error: unknown) {
        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      // Capture stderr EAGERLY at spawn (attach-late readers get nothing — Node's
      // flushStdio discards unread buffered stdio one tick after exit). The
      // exit-error path reads this bounded tail synchronously.
      const readStderrTail = captureStderrTail(child);

      // Abort wiring: kill the child the moment the signal fires.
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // best-effort; the child may already be gone.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Terminal lifecycle. `exit` (or spawn `error`) races — and usually LOSES
      // to — stdout close, so the consume loop WAITS (bounded) on it before
      // deciding success vs error on the no-terminal path.
      const lifecycle: {
        spawnError?: Error;
        exitCode: number | null;
        exitSignal: NodeJS.Signals | null;
      } = { exitCode: null, exitSignal: null };
      let exitObserved = false;
      let markExited: (() => void) | undefined;
      const whenExited = new Promise<void>((resolve) => {
        markExited = resolve;
      });
      const settleExit = (): void => {
        exitObserved = true;
        markExited?.();
      };
      child.on('error', (err) => {
        lifecycle.spawnError = err;
        settleExit();
      });
      child.on('exit', (code, exitSignal) => {
        lifecycle.exitCode = code;
        lifecycle.exitSignal = exitSignal ?? null;
        settleExit();
      });

      // Bounded, ABORT-AWARE wait for the terminal exit (see claudeCliClient for the
      // full rationale): resolves on the exit event, after `exitWaitMs`, or
      // IMMEDIATELY on abort. The timeout branch ALSO removes the abort listener so
      // a lingering child that never exits cannot leak a listener that later kills an
      // unrelated turn's child.
      const waitForExit = (): Promise<void> => {
        if (exitObserved) {
          return Promise.resolve();
        }
        if (signal.aborted) {
          onAbort();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          let handle: TimerHandle;
          const onAbortDuringWait = (): void => {
            handle.clear();
            onAbort();
            resolve();
          };
          handle = setTimer(() => {
            signal.removeEventListener('abort', onAbortDuringWait);
            resolve();
          }, exitWaitMs);
          signal.addEventListener('abort', onAbortDuringWait, { once: true });
          void whenExited.then(() => {
            handle.clear();
            signal.removeEventListener('abort', onAbortDuringWait);
            resolve();
          });
        });
      };

      // Stall handler: reap the hung child, then throw the sentinel out of the pump
      // so the consume catch surfaces it as an `error` result. Returns `never`.
      const onStall = (kind: StallKind): never => {
        try {
          child.kill();
        } catch {
          // best-effort; the child may already be gone.
        }
        const ms = kind === 'idle' ? idleTimeoutMs : staleStreamMs;
        throw new StreamStallError(kind, `codex stream stalled (${kind} timeout after ${ms}ms)`);
      };

      // Register this turn with the bridge for the duration of its stream, so an
      // in-process codex-parent MCP spawn can emit the spawn card + nested child tool
      // events into THIS turn's output (via `enqueueBridgeEvent`). Disposed in the
      // finally below so a leaked registration can never mis-attribute a later turn.
      const disposeTurn = bridge?.beginTurn({
        turnId: input.id,
        cwd: input.cwd ?? '',
        signal,
        emit: enqueueBridgeEvent,
      });

      try {
      // v1 always spawns fresh, so assistant-start is emitted EAGERLY (even a
      // no-content / error stream expects a start before its terminal event).
      yield { type: 'assistant-start', id: input.id };

      // Consume ONE spawned child: translate its NDJSON to content AgentEvents and
      // return HOW the attempt ended. Does NOT emit assistant-start / assistant-done
      // / aborted — the caller owns those terminals.
      const result = yield* consumeAttempt();
      async function* consumeAttempt(): AsyncGenerator<AgentEvent, AttemptResult> {
        // toolCallIds (item.id) we've already registered a tool-call for, so a
        // command_execution / file_change whose item.started was dropped still gets
        // its args registered on item.completed before the terminal tool-status.
        const emittedToolCall = new Set<string>();
        // Sibling of emittedToolCall for agent_message items: the item ids we've
        // already turned into a text-delta this turn. Some codex runtimes emit the
        // assistant message as TWO item.completed events with the SAME id (a
        // streaming-preview completion followed by the final one) — without this
        // guard both reach the reducer's text-delta concat and the answer commits
        // twice. Distinct ids still emit (a turn may legitimately carry several
        // agent_message items — e.g. a preamble + a final answer). Mirrors the
        // claude-cli dedup and the tool-item guard below.
        const emittedMessage = new Set<string>();
        let sawTurnCompleted = false;
        // In-band terminal failure reasons. `turn.failed` is preferred; the
        // top-level `error` event is a duplicate emitted just before it.
        let turnFailedMessage: string | undefined;
        let topLevelErrorMessage: string | undefined;

        // Translate ONE codex NDJSON line into content AgentEvents, mutating the
        // terminal-state flags above. Shared by the plain and bridge-merged loops.
        const translateLine = async function* (line: string): AsyncGenerator<AgentEvent> {
          const evt = parseJsonObject(line);
          if (evt === undefined) {
            // Skip unparseable / partial NDJSON lines (garbage tolerance).
            return;
          }
          const type = stringField(evt, 'type');
          switch (type) {
            case 'thread.started': {
              // Capture the resumable session id so the NEXT turn can
              // `codex exec resume <thread_id>` + send only the tail. A resumed
              // turn re-emits `thread.started` with the SAME id (verified live),
              // so re-capturing here is idempotent. (assistant-start is owned by
              // the caller — nothing else to emit for this event.)
              const captured = stringField(evt, 'thread_id');
              if (captured !== undefined && captured.length > 0) {
                sessionId = captured;
              }
              break;
            }
            case 'turn.started':
              // Turn boundary; no payload, no AgentEvent.
              break;
            case 'item.started':
              yield* emitItemStarted(evt, input, emittedToolCall);
              break;
            case 'item.completed':
              yield* emitItemCompleted(evt, input, emittedToolCall, emittedMessage);
              break;
            case 'turn.completed':
              sawTurnCompleted = true;
              yield* emitUsageFromTurn(evt);
              break;
            case 'turn.failed': {
              const err = asObject(evt.error);
              const raw = err === undefined ? undefined : stringField(err, 'message');
              turnFailedMessage = decodeCodexError(raw) ?? 'codex turn failed';
              break;
            }
            case 'error': {
              // Top-level request/API error, emitted BEFORE turn.failed. Capture
              // it as a fallback but prefer turn.failed's message (they agree).
              const raw = stringField(evt, 'message');
              if (raw !== undefined) {
                topLevelErrorMessage = decodeCodexError(raw) ?? raw;
              }
              break;
            }
            default:
              break;
          }
        };

        try {
          const stdout = child.stdout;
          if (stdout !== null) {
            const readOpts: ReadLinesTimeoutOpts = {
              idleTimeoutMs,
              staleStreamMs,
              setTimer,
              onStall,
              // While a spawn is in flight the codex process is BLOCKED on the MCP
              // result, so a quiet stdout is expected — suspend the stall timers for
              // exactly that window (see readLinesWithTimeout / CodexSpawnBridge).
              ...(bridge !== undefined
                ? { isStallSuppressed: (): boolean => bridge.isSpawnActive() }
                : {}),
            };
            if (bridge === undefined) {
              // Fast path (no bridge): behaviour identical to pre-Wave-8.
              for await (const line of readLinesWithTimeout(stdout, signal, readOpts)) {
                if (signal.aborted) {
                  signal.removeEventListener('abort', onAbort);
                  return { kind: 'aborted' };
                }
                yield* translateLine(line);
              }
            } else {
              // Merged path: race codex stdout against the in-process bridge event
              // queue so the spawn card + nested child tool events interleave LIVE
              // into this turn's output while codex is blocked on the MCP result.
              const linesIt = readLinesWithTimeout(stdout, signal, readOpts)[
                Symbol.asyncIterator
              ]();
              let pendingLine:
                | Promise<{ kind: 'line'; res: IteratorResult<string> }>
                | undefined;
              const abortRace = new Promise<{ kind: 'abort' }>((resolve) => {
                if (signal.aborted) resolve({ kind: 'abort' });
                else signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
              });
              try {
                while (true) {
                  // Flush bridge events emitted since the last iteration first.
                  for (const event of drainBridgeQueue()) {
                    yield event;
                  }
                  if (signal.aborted) {
                    signal.removeEventListener('abort', onAbort);
                    return { kind: 'aborted' };
                  }
                  // Keep ONE in-flight next() across bridge wakeups — recreating it
                  // while the previous is unsettled would iterate stdout concurrently.
                  if (pendingLine === undefined) {
                    pendingLine = linesIt.next().then((res) => ({ kind: 'line' as const, res }));
                  }
                  const winner = await Promise.race([pendingLine, bridgeWait(), abortRace]);
                  if (winner.kind === 'abort') {
                    signal.removeEventListener('abort', onAbort);
                    return { kind: 'aborted' };
                  }
                  if (winner.kind === 'bridge') {
                    // A bridge event is queued — loop; it is drained at the top.
                    continue;
                  }
                  // A codex stdout line won the race.
                  pendingLine = undefined;
                  const { value: line, done } = winner.res;
                  if (done === true) {
                    break;
                  }
                  yield* translateLine(line);
                }
              } finally {
                // Run readLinesWithTimeout's own finally (guard-timer cleanup) even on
                // an early return/throw out of the merged loop.
                await linesIt.return?.(undefined);
              }
              // A subagent that finished right as stdout closed may have queued its
              // terminal card status — flush it before deciding the attempt result.
              for (const event of drainBridgeQueue()) {
                yield event;
              }
            }
          }
        } catch (error: unknown) {
          signal.removeEventListener('abort', onAbort);
          // Abort wins over a stall: an aborted hung stream is an abort, not an error.
          if (signal.aborted) {
            return { kind: 'aborted' };
          }
          return { kind: 'error', message: errorMessage(error) };
        }

        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          return { kind: 'aborted' };
        }

        // In-band terminals are authoritative when present.
        if (turnFailedMessage !== undefined || topLevelErrorMessage !== undefined) {
          return { kind: 'failed', message: turnFailedMessage ?? topLevelErrorMessage ?? 'codex turn failed' };
        }
        if (sawTurnCompleted) {
          return { kind: 'done' };
        }

        // No in-band terminal (startup error emits no NDJSON): wait (bounded) for the
        // real exit before deciding, since stdout close usually beats the exit event.
        if (lifecycle.spawnError === undefined && lifecycle.exitCode === null) {
          await waitForExit();
          if (signal.aborted) {
            return { kind: 'aborted' };
          }
        }
        if (lifecycle.spawnError !== undefined) {
          return { kind: 'error', message: lifecycle.spawnError.message };
        }
        if (lifecycle.exitCode !== null && lifecycle.exitCode !== 0) {
          return { kind: 'exit-error', code: lifecycle.exitCode, stderr: readStderrTail() };
        }
        if (lifecycle.exitCode === null && lifecycle.exitSignal !== null) {
          return { kind: 'exit-error', code: null, signal: lifecycle.exitSignal, stderr: readStderrTail() };
        }
        // A clean exit 0 with no turn.completed (shouldn't happen) is a best-effort done.
        return { kind: 'done' };
      }

      // Attempt concluded (done / failed / error / exit-error / aborted / killed).
      // Release OUR read-ends and unref the child BEFORE branching — a grandchild
      // that inherited fd 1/2 can otherwise keep those pipes (and juno's event loop)
      // alive past quit. Any stderr snippet was already read into `result`.
      releaseChild(child);

      if (result.kind === 'aborted') {
        // A cancelled turn diverges codex's session state from juno's transcript
        // (juno drops the partial live message); force the next turn fresh.
        sessionId = undefined;
        yield { type: 'aborted' };
        return;
      }
      if (result.kind === 'done') {
        // RENDER-ONLY collapse: codex ran its own tools to completion, so the turn is
        // always 'end', never 'tool_use' (which would make turnRunner re-spawn codex).
        // sessionId (captured from thread.started) is RETAINED so the next turn resumes.
        yield { type: 'assistant-done', id: input.id, stopReason: signal.aborted ? 'abort' : 'end' };
        return;
      }

      // failed / error / exit-error → a normal error surface. Clear the session so
      // the NEXT turn re-spawns fresh with the full transcript (no in-turn retry loop
      // this wave — a resume spawn that fails simply surfaces the error and the
      // follow-up turn starts clean).
      sessionId = undefined;
      const message =
        result.kind === 'exit-error'
          ? `${
              result.signal !== undefined && result.signal !== null
                ? `codex killed by signal ${result.signal}`
                : `codex exited with code ${result.code}`
            }${result.stderr !== undefined && result.stderr.length > 0 ? `: ${result.stderr}` : ''}`
          : result.message;
      yield { type: 'error', message };
      yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
      } finally {
        disposeTurn?.();
      }
    },
  };
}

/**
 * Build the `codex exec --json` arg vector against codex-cli 0.144.x (recon
 * fixtures — NOT the 0.143 flags). Notes that drove each flag:
 *  - `--json`              : NDJSON on stdout (the transport we translate).
 *  - `--skip-git-repo-check`: juno's workspace may be non-git; without it a
 *    non-git cwd exits 1 "Not inside a trusted directory".
 *  - `-m <model>`          : the selected model id.
 *  - `--sandbox <s>`       : juno's permission mode projected onto codex's sandbox —
 *    default → read-only, acceptEdits → workspace-write. NEVER danger-full-access.
 *  - `-c approval_policy=never`: `--ask-for-approval` was REMOVED from `codex exec`
 *    in 0.144; this replicates the "no interactive approval" intent (a headless
 *    child cannot answer a prompt).
 *  - `-c preferred_auth_method=chatgpt`: pin subscription OAuth (auth safety).
 *  - `--cd <dir>`          : pin codex's working root to juno's jail (belt-and-
 *    suspenders with the spawn `cwd`), emitted whenever a cwd is known.
 * The prompt is the trailing positional (folded transcript). stdin is `'ignore'`
 * (= /dev/null) at spawn, which is required — an open stdin pipe makes `codex exec`
 * hang on "Reading additional input from stdin...".
 *
 * RESUME (v2) — `codex exec resume <session_id> [PROMPT]`. When a `resumeSessionId`
 * is supplied the argv resumes the codex session by id and sends only the TAIL
 * (messages committed since the last delivered turn) instead of replaying the whole
 * transcript. The resume subcommand has a NARROWER flag surface than fresh `exec`:
 * it REJECTS `-s/--sandbox` and `-C/--cd`. Two consequences, both verified against a
 * live codex-cli 0.144.1 (`codex exec` then `codex exec resume <that id>`):
 *   - SANDBOX must be re-pinned via a `-c sandbox_mode=<mode>` config override.
 *     Proven decisive: the same resumed session blocked a write under read-only and
 *     allowed it under `-c sandbox_mode=workspace-write` — so the config override
 *     controls the resumed turn's sandbox exactly, with no silent loss. (Codex does
 *     NOT restore the original session's sandbox on its own; without this override a
 *     workspace-write turn would silently regress to codex's read-only default.)
 *   - CWD rides the spawn `cwd: input.cwd` option (set at the spawn site), which
 *     fully governs the resumed child's working directory. Proven: a resume with no
 *     `--cd` ran `pwd` in the PROCESS cwd, not the session's original `--cd` dir — so
 *     codex never restores the session cwd, and the spawn `cwd` alone pins it. No
 *     `-c` cwd override is needed (and none is passed).
 */
/**
 * The codex custom-tool SEAM (Wave 7 seam; Wave 8 closes it). Translate juno's
 * ToolSpecs into extra `codex exec` CLI flags that offer those tools to the codex
 * model.
 *
 * CHOICE OF MECHANISM: codex `exec` has no inline `--tool`/JSON-schema flag. Its
 * ONLY channel for non-built-in tools is an MCP server, configured via
 * `-c mcp_servers.<name>.…` (or a `~/.codex/config.toml` `[mcp_servers.<name>]`
 * block). So juno hosts an in-process `spawn_subagent` MCP server
 * (subagentMcpServer.ts) and points codex at it here.
 *
 * WAVE 8 — how the render gap is closed: the server runs IN juno's process and,
 * via the CodexSpawnBridge, emits the spawn card + nested child tool events into
 * the active turn's stream with `parentToolUseId` attribution — so a codex parent's
 * subagents render exactly like a raw-API parent's (see codexSpawnBridge.ts).
 *
 * FLAGS: with a `mcpConfig` we emit the `-c mcp_servers.<name>.…` override that
 * points codex at the server — `url` (streamable HTTP, the in-process path) or a
 * stdio `command` argv. Values are JSON-quoted so codex's TOML `-c` parser accepts
 * a URL/string (which is not a bare TOML scalar). WITHOUT a `mcpConfig` this still
 * returns `[]` (the `tools` arg is referenced so it is genuinely threaded, not
 * discarded), leaving codex on its built-in shell + apply_patch toolset.
 */
/**
 * Per-call MCP tool timeout (seconds) pinned for juno's spawn_subagent server.
 * Codex's default `tool_timeout_sec` is 60s — a real subagent run routinely takes
 * MINUTES, so at the default the codex parent receives a tool-timeout error mid-run
 * while juno's spawn card later resolves to success (the headline flow breaks for
 * exactly the runs it exists for). Pinned large so the parent waits for the whole
 * subagent run. 1 hour is comfortably beyond any single delegated task.
 */
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 3600;

export function codexToolArgs(
  tools: ReadonlyArray<ToolSpec>,
  mcpConfig?: CodexMcpConfig,
): string[] {
  // `tools` is threaded through the seam even though the MCP server (not this arg
  // vector) is what actually advertises the tool schema to codex.
  void tools;
  if (mcpConfig === undefined) {
    return [];
  }
  const name = mcpConfig.serverName;
  // Pin the per-call MCP timeout alongside whichever transport is configured (an
  // integer is a bare TOML scalar, so no JSON-quoting needed). Only emitted when a
  // transport is actually set — no server, no timeout flag.
  const timeoutArgs = [
    '-c',
    `mcp_servers.${name}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  ];
  if (mcpConfig.url !== undefined && mcpConfig.url.length > 0) {
    return ['-c', `mcp_servers.${name}.url=${JSON.stringify(mcpConfig.url)}`, ...timeoutArgs];
  }
  if (mcpConfig.command !== undefined && mcpConfig.command.length > 0) {
    const [bin, ...rest] = mcpConfig.command;
    const args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(bin)}`];
    if (rest.length > 0) {
      args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(rest)}`);
    }
    args.push(...timeoutArgs);
    return args;
  }
  return [];
}

/**
 * Reverse a namespaced `mcp__<server>__<tool>` name back into its parts using the
 * CONFIGURED server keys (a server segment may itself contain `__`, so match the
 * LONGEST configured server whose `mcp__<server>__` prefixes the name). Undefined ⇒
 * the tool belongs to no configured server (deny-by-default). Mirrors claudeCliClient.
 */
function splitMcpToolName(
  name: string,
  servers: Record<string, McpServerConfig>,
): { server: string; tool: string } | undefined {
  let matched: { server: string; tool: string } | undefined;
  for (const server of Object.keys(servers)) {
    const prefix = `mcp__${server}__`;
    if (name.startsWith(prefix) && (matched === undefined || server.length > matched.server.length)) {
      matched = { server, tool: name.slice(prefix.length) };
    }
  }
  return matched;
}

/**
 * True when juno's policy carries a DENY rule targeting `name` but SCOPED to specific
 * call args — a `name:<pattern>` that does NOT match the empty-args key `name:`. The
 * gate translation evaluates each MCP tool ONCE with empty args (no per-call args at
 * spawn time), so such a rule would never fire there and the tool would look
 * auto-allowed while juno's live gate would deny some calls. Fail closed: the tool
 * (and thus its whole server, since codex can't gate per-tool) is denied. Mirrors
 * claudeCliClient.hasArgScopedDenyRule.
 */
function hasArgScopedDenyRule(policy: PermissionPolicy, name: string): boolean {
  for (const { pattern, decision } of policy.rules?.() ?? []) {
    if (decision !== 'deny') {
      continue;
    }
    const normalized = normalizePattern(pattern);
    if (matchesPattern(normalized, `${name}:`)) {
      // Fires on the empty-args key too → evaluate() already sees it (deny wins there).
      continue;
    }
    const namePattern = normalized.slice(0, normalized.indexOf(':'));
    if (matchesPattern(`${namePattern}:*`, `${name}:`)) {
      return true;
    }
  }
  return false;
}

/**
 * Translate juno's configured, GATED MCP servers into codex `-c mcp_servers.<name>.…`
 * TOML overrides — the Wave-10 passthrough (parent turns only). Deny-by-default at
 * SERVER granularity (codex `exec` has no per-tool MCP allowlist): a server is wired
 * ONLY IF EVERY one of its exposed `mcp__<server>__<tool>` tools this turn AUTO-ALLOWS
 * under juno's own gate (empty-args evaluate === 'auto-allow', and no arg-scoped deny)
 * — one risky/prompt/deny tool denies the whole server. Servers carrying `env` are
 * ALSO denied (fail-closed): codex has no off-argv MCP-config channel and `-c …env…`
 * would expose secrets via `ps`, so only command/args (already process-visible) are
 * translated, JSON-quoted so codex's TOML `-c` parser accepts the string/array. Pairs
 * with `--ignore-user-config` (buildArgs) so ambient servers can't reintroduce the
 * tools this loop denied. Returns `[]` when no server qualifies (the strict-empty
 * posture — the child then sees NO MCP servers at all).
 */
function codexMcpPassthroughArgs(
  tools: ReadonlyArray<ToolSpec>,
  mcp: { servers: Record<string, McpServerConfig>; policy: PermissionPolicy },
): string[] {
  // Bucket the exposed mcp__ tools by their configured server. A tool on no configured
  // server is ignored (never wired — deny-by-default).
  const toolsByServer = new Map<string, string[]>();
  for (const tool of tools) {
    if (!tool.name.startsWith('mcp__')) {
      continue;
    }
    const parts = splitMcpToolName(tool.name, mcp.servers);
    if (parts === undefined) {
      continue;
    }
    const bucket = toolsByServer.get(parts.server) ?? [];
    bucket.push(tool.name);
    toolsByServer.set(parts.server, bucket);
  }

  const configArgs: string[] = [];
  // Sorted for a stable argv across runs.
  for (const server of [...toolsByServer.keys()].sort()) {
    const cfg = mcp.servers[server];
    if (cfg === undefined) {
      continue;
    }
    // env fail-closed: no off-argv channel for a server's secrets in codex exec.
    if (cfg.env !== undefined && Object.keys(cfg.env).length > 0) {
      continue;
    }
    // Server-granularity deny-by-default: EVERY exposed tool must auto-allow.
    const toolNames = toolsByServer.get(server) ?? [];
    const allAutoAllow = toolNames.every((name) => {
      const parts = splitMcpToolName(name, mcp.servers);
      if (parts === undefined) {
        return false;
      }
      const risk = classifyRisk(mcp.servers, parts.server, parts.tool);
      return (
        !hasArgScopedDenyRule(mcp.policy, name) &&
        mcp.policy.evaluate(name, {}, risk) === 'auto-allow'
      );
    });
    if (!allAutoAllow) {
      continue;
    }
    const [command, ...args] = cfg.command;
    if (command === undefined) {
      continue;
    }
    configArgs.push('-c', `mcp_servers.${server}.command=${JSON.stringify(command)}`);
    if (args.length > 0) {
      configArgs.push('-c', `mcp_servers.${server}.args=${JSON.stringify(args)}`);
    }
  }
  return configArgs;
}

function buildArgs(
  entry: ModelEntry,
  input: TurnInput,
  resumeSessionId?: string,
  resumeFromIndex = 0,
  toolArgs: ReadonlyArray<string> = [],
  passthroughArgs: ReadonlyArray<string> = [],
  passthroughActive = false,
): string[] {
  const model = input.model ?? entry.id;
  const mode = input.permissionMode ?? 'default';
  const sandbox = mode === 'acceptEdits' ? 'workspace-write' : 'read-only';
  const resuming = resumeSessionId !== undefined;

  // Resume: `exec resume <id> …`; session id is the first positional. Fresh: `exec …`.
  const args: string[] = resuming
    ? ['exec', 'resume', resumeSessionId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check'];
  if (model.length > 0) {
    args.push('-m', model);
  }
  if (resuming) {
    // `--sandbox`/`--cd` are REJECTED by `exec resume` — pin the sandbox via config
    // instead (proven to govern the resumed turn), and let the spawn `cwd` pin cwd.
    args.push('-c', `sandbox_mode=${sandbox}`);
  } else {
    args.push('--sandbox', sandbox);
  }
  args.push('-c', 'approval_policy=never');
  args.push('-c', 'preferred_auth_method=chatgpt');
  // Wave-10 MCP passthrough strictness: when juno is gating MCP, DROP the user's ambient
  // `$CODEX_HOME/config.toml` so its MCP servers can never load ungated (deny-by-default);
  // juno's own gated servers ride the `-c mcp_servers.…` overrides below. `exec resume`
  // accepts this flag too (verified against codex-cli 0.144.1), so it applies uniformly.
  // Broader than claude's `--strict-mcp-config` (it drops ALL user config, not only MCP)
  // — the only ambient-suppression codex exec offers; see CodexCliDeps.mcpServers.
  if (passthroughActive) {
    args.push('--ignore-user-config');
  }
  if (!resuming && input.cwd !== undefined && input.cwd.length > 0) {
    args.push('--cd', input.cwd);
  }
  // Custom-tool flags (codexToolArgs seam) + the Wave-10 MCP passthrough overrides go
  // BEFORE the trailing prompt positional. Both are `-c mcp_servers.<name>.…` on distinct
  // server names, so they compose.
  args.push(...toolArgs);
  args.push(...passthroughArgs);
  // Prompt LAST (trailing positional): fresh replays the whole transcript; resume
  // sends only the tail (messages committed since the last delivered turn).
  args.push(resuming ? buildPromptTail(input, resumeFromIndex) : buildPrompt(input));
  return args;
}

/**
 * Fold the turn's messages + systemPrompt into a single prompt string (codex exec
 * takes one positional prompt). v1 serialization: a labeled transcript. System
 * content leads; then the role-tagged conversation. Mirrors claudeCliClient's
 * buildPrompt so the two delegate-CLI backends serialize identically.
 */
function buildPrompt(input: TurnInput): string {
  const parts: string[] = [];

  const systemContents: string[] = [];
  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    systemContents.push(input.systemPrompt);
  }
  for (const message of input.messages) {
    if (message.role === 'system') {
      systemContents.push(message.content);
    }
  }
  if (systemContents.length > 0) {
    parts.push(`System:\n${systemContents.join('\n\n')}`);
  }

  for (const message of input.messages) {
    parts.push(promptLineFor(message));
  }

  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Resume serialization: fold ONLY the messages committed since the PRIOR turn's
 * submit (the `deliveredCount` watermark) into the resume prompt — the just-submitted
 * user text PLUS any mid-turn `/steer` user messages. Slicing by a delivery watermark
 * rather than "everything after the last assistant" is load-bearing: a `/steer` issued
 * while the turn streams commits as a user message BEFORE that turn's assistant message,
 * so an after-last-assistant slice would drop it from this and every subsequent resume
 * tail — it would render in the transcript but never reach the model. Assistant messages
 * after the watermark were generated by codex on the resumed session (already in its
 * history), so they are excluded; re-sending them would double the context. System
 * content is not re-sent either (the session already holds it — `promptLineFor` maps a
 * system message to `''`, which is filtered out). Mirrors claudeCliClient.buildPromptTail.
 */
export function buildPromptTail(input: TurnInput, deliveredCount: number): string {
  const parts: string[] = [];
  for (const message of input.messages.slice(deliveredCount)) {
    // codex generated its own assistant replies on the resumed session; echoing them
    // back as input would double the context (and feed the model its own words).
    if (message.role === 'assistant') {
      continue;
    }
    parts.push(promptLineFor(message));
  }

  return parts.filter((part) => part.length > 0).join('\n\n');
}

function promptLineFor(message: TurnMessage): string {
  switch (message.role) {
    case 'system':
      return '';
    case 'user':
      return `User:\n${message.content}`;
    case 'assistant':
      return `Assistant:\n${message.content}`;
    case 'tool':
      return `Tool result (${message.toolCallId}):\n${message.content}`;
  }
}

/**
 * Return a shallow copy of `env` with `OPENAI_API_KEY` removed. Load-bearing for
 * auth safety: `~/.codex/auth.json` carries an OPENAI_API_KEY field, so leaving the
 * env var in place risks Codex silently billing an API account instead of the
 * ChatGPT subscription. Never mutates the caller's env (a copy is returned).
 */
function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy.OPENAI_API_KEY;
  return copy;
}

/**
 * Translate an `item.started` event. Only command_execution / file_change begin a
 * renderable tool card here (agent_message is atomic — item.completed only; error
 * items are non-terminal warnings we drop). Emits a `tool-call` (registers the
 * card + its args) then a `tool-status('running')` so the card shows a live
 * spinner until the matching item.completed finalizes it.
 */
function* emitItemStarted(
  evt: JsonObject,
  input: TurnInput,
  emittedToolCall: Set<string>,
): Generator<AgentEvent> {
  const item = asObject(evt.item);
  if (item === undefined) {
    return;
  }
  const itemType = stringField(item, 'type');
  if (itemType !== 'command_execution' && itemType !== 'file_change') {
    return;
  }
  const id = stringField(item, 'id');
  if (id === undefined) {
    return;
  }
  yield* registerToolCall(item, itemType, id, input, emittedToolCall);
  yield { type: 'tool-status', toolCallId: id, status: 'running' };
}

/**
 * Translate an `item.completed` event into terminal AgentEvents:
 *  - agent_message     → a single text-delta (the whole `text`; this transport has
 *    no token deltas, and a turn may carry MULTIPLE agent_message items — each is
 *    appended in arrival order).
 *  - command_execution → finalize the tool card: exit_code 0 → tool-status result
 *    with aggregated_output; non-zero → tool-status error.
 *  - file_change       → finalize the tool card with a result summary (path + kind;
 *    codex carries NO diff body inline).
 *  - error             → a NON-terminal warning (e.g. "Model metadata … not found");
 *    surfacing it as a juno error would spuriously fail an otherwise-successful turn,
 *    so v1 drops it — the fatal reason rides turn.failed instead.
 * command_execution / file_change also register a tool-call first if item.started
 * was somehow missed, so a terminal tool-status is never dropped by the reducer.
 */
function* emitItemCompleted(
  evt: JsonObject,
  input: TurnInput,
  emittedToolCall: Set<string>,
  emittedMessage: Set<string>,
): Generator<AgentEvent> {
  const item = asObject(evt.item);
  if (item === undefined) {
    return;
  }
  const itemType = stringField(item, 'type');
  const id = stringField(item, 'id');

  if (itemType === 'agent_message') {
    // Dedup by item id: a duplicate item.completed for the SAME agent_message
    // (streaming-preview + final on newer codex) must NOT re-emit — otherwise the
    // reducer concatenates the text into the live block twice. A distinct id is a
    // genuinely separate message and still emits. Mirrors registerToolCall below.
    if (id !== undefined) {
      if (emittedMessage.has(id)) {
        return;
      }
      emittedMessage.add(id);
    }
    const text = stringField(item, 'text');
    if (text !== undefined && text.length > 0) {
      yield { type: 'text-delta', id: input.id, delta: text };
    }
    return;
  }

  if (itemType === 'command_execution') {
    if (id === undefined) {
      return;
    }
    yield* registerToolCall(item, itemType, id, input, emittedToolCall);
    const output = stringField(item, 'aggregated_output') ?? '';
    const exitCode = numberField(item, 'exit_code');
    if (exitCode !== undefined && exitCode !== 0) {
      yield {
        type: 'tool-status',
        toolCallId: id,
        status: 'error',
        error: output.length > 0 ? output : `exited with code ${exitCode}`,
      };
    } else {
      yield { type: 'tool-status', toolCallId: id, status: 'result', result: output };
    }
    return;
  }

  if (itemType === 'file_change') {
    if (id === undefined) {
      return;
    }
    yield* registerToolCall(item, itemType, id, input, emittedToolCall);
    yield { type: 'tool-status', toolCallId: id, status: 'result', result: fileChangeSummary(item) };
    return;
  }

  // itemType === 'error' (non-terminal warning) and anything else: drop.
}

/**
 * Emit the `tool-call` that registers a command_execution / file_change card,
 * once per item id. command_execution → name 'shell', args `{ command }` (so the
 * ToolCallCard humanizer shows the command). file_change → name 'apply_patch',
 * args `{ changes }`.
 */
function* registerToolCall(
  item: JsonObject,
  itemType: 'command_execution' | 'file_change',
  id: string,
  input: TurnInput,
  emittedToolCall: Set<string>,
): Generator<AgentEvent> {
  if (emittedToolCall.has(id)) {
    return;
  }
  emittedToolCall.add(id);
  if (itemType === 'command_execution') {
    const command = stringField(item, 'command') ?? '';
    yield { type: 'tool-call', id: input.id, toolCallId: id, name: 'shell', args: { command } };
  } else {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    yield { type: 'tool-call', id: input.id, toolCallId: id, name: 'apply_patch', args: { changes } };
  }
}

/** Summarize a file_change item's `changes[]` as `<kind> <path>` lines (no diff body). */
function fileChangeSummary(item: JsonObject): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const lines: string[] = [];
  for (const raw of changes) {
    const change = asObject(raw);
    if (change === undefined) {
      continue;
    }
    const path = stringField(change, 'path');
    if (path === undefined) {
      continue;
    }
    const kind = stringField(change, 'kind') ?? 'change';
    lines.push(`${kind} ${path}`);
  }
  return lines.join('\n');
}

/**
 * Emit a single `usage` from `turn.completed.usage` (cumulative for the turn).
 * Codex/OpenAI semantics differ from Anthropic: `input_tokens` is the TOTAL prompt
 * size and INCLUDES the cached subset (`cached_input_tokens`), so:
 *   - contextTokens = input_tokens              (full window occupancy)
 *   - tokensIn      = input_tokens - cached      (billable, cache-excluded input)
 *   - tokensOut     = output_tokens              (already includes reasoning tokens)
 * (reasoning_output_tokens is a subset of output_tokens — do NOT add it again.)
 */
function* emitUsageFromTurn(evt: JsonObject): Generator<AgentEvent> {
  const usage = asObject(evt.usage);
  if (usage === undefined) {
    return;
  }
  const inputTokens = numberField(usage, 'input_tokens');
  const outputTokens = numberField(usage, 'output_tokens');
  if (inputTokens === undefined && outputTokens === undefined) {
    return;
  }
  const cached = numberField(usage, 'cached_input_tokens') ?? 0;
  const inTotal = inputTokens ?? 0;
  yield {
    type: 'usage',
    tokensIn: Math.max(0, inTotal - cached),
    tokensOut: outputTokens ?? 0,
    contextTokens: inTotal,
  };
}

/**
 * Codex `turn.failed.error.message` / top-level `error.message` is often a
 * JSON-encoded error string, e.g. `{"type":"error","status":400,"error":{"message":
 * "…"}}`. Extract the innermost human message when parseable; otherwise return the
 * raw string (undefined stays undefined).
 */
function decodeCodexError(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) {
    return raw;
  }
  const inner = asObject(parsed.error);
  const innerMessage = inner === undefined ? undefined : stringField(inner, 'message');
  if (innerMessage !== undefined) {
    return innerMessage;
  }
  return stringField(parsed, 'message') ?? raw;
}

/** Tagged winner of the stdout consumption race (chunk vs a guard timer vs abort). */
type PumpRace =
  | { kind: 'chunk'; result: IteratorResult<string | Uint8Array> }
  | { kind: 'idle' }
  | { kind: 'stale' }
  | { kind: 'abort' };

interface ReadLinesTimeoutOpts {
  idleTimeoutMs: number;
  staleStreamMs: number;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  /** Reaps the child and throws `StreamStallError`; typed `never` for narrowing. */
  onStall: (kind: StallKind) => never;
  /**
   * Wave 8 — when this returns true, a fired guard timer is RE-ARMED instead of
   * triggering `onStall`. Used by the codex spawn bridge: while a subagent spawn is
   * in flight the codex process is legitimately blocked waiting on the MCP result,
   * so a quiet stdout is expected and must not be read as a wedged stream. Absent
   * (the default) ⇒ a fired timer stalls exactly as before.
   */
  isStallSuppressed?: () => boolean;
}

/**
 * Read an async-iterable stdout as newline-delimited lines (NDJSON), guarded by
 * two independent idle timers (lifted verbatim from claudeCliClient / the Hermes
 * harness):
 *   T1 READ (idleTimeoutMs):  resets on EVERY chunk. No chunk at all → 'idle'.
 *   T2 STALE (staleStreamMs): resets only when a NON-EMPTY parseable line is yielded
 *                             (real progress). Catches trickle/keepalive hangs.
 * `for await` cannot be timeout-raced directly, so the iterator is consumed
 * MANUALLY: each loop races `it.next()` against both guard timers and the abort
 * signal. Both timers are ALWAYS cleared in `finally`.
 */
async function* readLinesWithTimeout(
  stdout: AsyncIterable<string | Uint8Array>,
  signal: AbortSignal,
  opts: ReadLinesTimeoutOpts,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const it = stdout[Symbol.asyncIterator]();

  function makeGuard(kind: StallKind, ms: number): {
    promise(): Promise<PumpRace>;
    reset(): void;
    clear(): void;
  } {
    let resolve: (() => void) | undefined;
    let promise!: Promise<PumpRace>;
    let handle: TimerHandle | undefined;
    const arm = (): void => {
      promise = new Promise<PumpRace>((res) => {
        resolve = () => res({ kind });
      });
      handle = opts.setTimer(() => resolve?.(), ms);
    };
    arm();
    return {
      promise: () => promise,
      reset: () => {
        handle?.clear();
        arm();
      },
      clear: () => handle?.clear(),
    };
  }

  const idle = makeGuard('idle', opts.idleTimeoutMs);
  const stale = makeGuard('stale', opts.staleStreamMs);

  const abortPromise = new Promise<PumpRace>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'abort' });
    } else {
      signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
    }
  });

  // The in-flight chunk read, kept ACROSS guard-timer wins so a re-armed timer
  // (stall suppression) never issues a second concurrent `it.next()` on the same
  // iterator. Reset to undefined only once a chunk is actually consumed.
  let nextPromise: Promise<PumpRace> | undefined;
  try {
    while (true) {
      if (nextPromise === undefined) {
        nextPromise = it.next().then((result) => ({ kind: 'chunk', result }) as const);
      }

      const winner = await Promise.race([nextPromise, idle.promise(), stale.promise(), abortPromise]);

      if (winner.kind === 'abort') {
        // Abort wins over a stall; let the caller's signal.aborted path handle it.
        return;
      }
      if (winner.kind === 'idle' || winner.kind === 'stale') {
        // A spawn in flight? The quiet stdout is expected — re-arm the fired guard
        // (the still-pending chunk read is preserved) and keep waiting.
        if (opts.isStallSuppressed?.() === true) {
          if (winner.kind === 'idle') idle.reset();
          else stale.reset();
          continue;
        }
        opts.onStall(winner.kind);
      }

      // A chunk won — this read is consumed; the next iteration issues a fresh one.
      nextPromise = undefined;
      const { value: chunk, done } = winner.result;
      if (done === true) {
        break;
      }

      idle.reset();

      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      let yieldedProgress = false;
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
          // Real progress = a parseable NDJSON object, NOT any non-empty raw line.
          if (parseJsonObject(line) !== undefined) {
            yieldedProgress = true;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }

      if (yieldedProgress) {
        stale.reset();
      }
    }

    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, '');
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    idle.clear();
    stale.clear();
  }
}

/**
 * Cap on the eagerly-buffered stderr tail. Keep only the LAST this-many chars — a
 * crash dump can be large and the failure REASON lives at the END of stderr.
 */
const STDERR_TAIL_CAP = 4096;

/**
 * Begin capturing the child's stderr EAGERLY — call the instant the attempt spawns.
 * Node's `flushStdio` runs one macrotask after the child's `exit` event and DISCARDS
 * any unread buffered stdio, so a reader attached late reads nothing from a real pipe
 * (the error card would carry only "codex exited with code 1"). Attaching a `'data'`
 * listener now puts the pipe in flowing mode from spawn, so the bytes accumulate into
 * a bounded TAIL buffer before flushStdio can drop them. Returns a synchronous reader
 * the exit-error path calls to snapshot the tail.
 */
function captureStderrTail(child: ChildProcessLike): () => string {
  const stderr = child.stderr;
  if (stderr === undefined || stderr === null) {
    return () => '';
  }
  const decoder = new TextDecoder();
  let tail = '';
  const onData = (chunk: string | Uint8Array): void => {
    tail += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (tail.length > STDERR_TAIL_CAP) {
      tail = tail.slice(tail.length - STDERR_TAIL_CAP);
    }
  };
  try {
    stderr.on('data', onData);
    // A 'data' listener switches the stream to flowing mode; an 'error' handler keeps
    // a stderr hiccup from surfacing as an unhandled 'error' that masks the real exit.
    stderr.on('error', () => {});
  } catch {
    // best-effort — a stream we cannot listen to simply yields no snippet.
  }
  return () => tail.trim();
}

/**
 * Release OUR read-ends of a concluded attempt's child and drop it from the event
 * loop. The child was already killed (abort/stall) or exited, but a DESCENDANT that
 * inherited fd 1/2 can hold OUR readable pipe ends open past the direct child's
 * death — keeping those sockets referenced and the Node event loop alive. All
 * best-effort — an already-destroyed stream / dead child must never throw over the
 * turn result. Runs on EVERY attempt-end path.
 */
function releaseChild(child: ChildProcessLike): void {
  for (const stream of [child.stdout, child.stderr]) {
    const destroy = (stream as { destroy?: unknown } | null | undefined)?.destroy;
    if (typeof destroy === 'function') {
      try {
        (destroy as () => void).call(stream);
      } catch {
        // best-effort — a stream already errored/destroyed is fine.
      }
    }
  }
  try {
    child.unref?.();
  } catch {
    // best-effort — a still-dying child must not hold the loop open.
  }
}
