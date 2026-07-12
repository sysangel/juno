import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { ACCEPT_EDITS_TOOLS } from '../permissions/policy';

/**
 * The child's stderr read-end. We attach a `'data'` listener EAGERLY at spawn to
 * accumulate a bounded tail (see `captureStderrTail`) — Node's `flushStdio` runs
 * one tick after the child's `exit` event and DISCARDS any unread buffered stdio,
 * so a reader attached late (after exit is observed) reads nothing from a real
 * pipe. Node's `Readable` satisfies this structurally (`.on`, `.destroy`).
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

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean; cwd?: string },
) => ChildProcessLike;

/**
 * Injectable timer handle. `setTimer` returns one of these so a stall timer can
 * be cancelled. The default wraps the global setTimeout/clearTimeout; tests
 * inject a deterministic fake clock so no real 60–90s wait is ever incurred.
 */
export interface TimerHandle {
  clear: () => void;
}

export interface ClaudeCliDeps {
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  spawnImpl?: SpawnImpl;
  /** Override the resolved `claude` binary path/name. Defaults to `claude`. */
  binPath?: string;
  /** Process env (reserved; the CLI uses the logged-in OAuth, no key needed). */
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
   * keepalive-but-no-progress hang that the idle timer misses. Default 90_000
   * (Hermes "90s stale-stream detector"). Conceptually >= idleTimeoutMs.
   */
  staleStreamMs?: number;
  /**
   * Injectable scheduler so stall timers are deterministic in tests (no real
   * 60–90s waits). Default wraps global setTimeout/clearTimeout.
   */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /**
   * EXIT-WAIT timeout (ms): after stdout closes with no terminal `result`, how
   * long to wait for the child's `exit` event before deciding success vs error.
   * stdout close and the `exit` event are SEPARATE and race — stdout usually
   * closes first — so without a short wait `exitCode` is still null when the
   * decision runs and a fast-failing child (exit 1, no result) is misread as a
   * clean turn. Bounded so a child that lingers after closing stdout cannot hang
   * the turn. Default 2_000. Only ever incurred on the (rare) no-result path, so
   * a normal successful turn never pays it.
   */
  exitWaitMs?: number;
}

type JsonObject = Record<string, unknown>;

interface ToolAccumulator {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

/** Which guard timer fired — surfaced verbatim in the stall error message. */
type StallKind = 'idle' | 'stale';

/**
 * File-local sentinel thrown out of the stdout pump when a guard timer fires.
 * It is caught by the EXISTING try/catch around the consumption loop, which
 * surfaces it via the existing `error` + `assistant-done('error')` events — no
 * new AgentEvent variant. NOT exported: a stall is an internal control signal,
 * not part of the client's public surface.
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
 * How one `claude -p` spawn+consume attempt ended. Returned by the inner consume
 * generator so the outer `streamTurn` can decide the terminal AgentEvents and
 * whether to transparently re-spawn (the resume-failure → fresh fallback). A
 * `done` is a clean stream; `error`/`exit-error` are failures the fallback may
 * retry (only when a resume attempt produced no content); `aborted` is a user
 * cancellation (never retried).
 */
type AttemptResult =
  | { kind: 'done'; stopReason: string | undefined }
  | { kind: 'error'; message: string }
  | { kind: 'exit-error'; code: number | null; signal?: NodeJS.Signals | null; stderr?: string }
  | { kind: 'aborted' };

/**
 * Subscription `claude` CLI adapter — the PRIMARY backend. Spawns
 *   `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages [--model <m>]`
 * and TRANSLATES the NDJSON stream into the SAME normalized AgentEvents that
 * `anthropicClient.ts` emits (assistant-start, text-delta, reasoning-delta,
 * tool-call-delta, tool-call, usage, assistant-done, aborted, error).
 *
 * Auth is the logged-in Max-subscription OAuth (`~/.claude/.credentials.json`);
 * NO API key is passed. NEVER `--bare` — it disables OAuth (Wave 0A §2).
 *
 * Windows-robust: stdin is `'ignore'` so the child does not block ~3s waiting on
 * stdin; `windowsHide` suppresses a console flash; abort kills the child.
 *
 * Streaming health: two idle timers (read + stale-stream) guard stdout
 * consumption so a hung `claude -p` terminates the turn with an error card
 * instead of freezing the UI forever (see `readLinesWithTimeout`).
 */
export function createClaudeCliClient(entry: ModelEntry, deps: ClaudeCliDeps = {}): ModelClient {
  // Tests ALWAYS inject `spawnImpl`, so the real node:child_process.spawn below
  // is only ever reached in production (the GATE forbids live subprocess calls).
  const spawnImpl: SpawnImpl =
    deps.spawnImpl ??
    ((command, args, options) =>
      nodeSpawn(command, [...args], options) as unknown as ChildProcessLike);
  const binPath = deps.binPath ?? 'claude';

  // Stall-guard configuration. Defaults match Hermes (60s read / 90s stale).
  const idleTimeoutMs = deps.idleTimeoutMs ?? 60_000;
  const staleStreamMs = deps.staleStreamMs ?? 90_000;
  // Bounded wait for the child's `exit` event after stdout closes (see docstring
  // on ClaudeCliDeps.exitWaitMs). Short: a real crash exits within ms of close.
  const exitWaitMs = deps.exitWaitMs ?? 2_000;
  // Default scheduler wraps the real timers; tests inject a deterministic clock.
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });

  // Cross-turn session reuse (opt-in, claude-cli only). The client instance is
  // memoized per backend in app.tsx, so this closure persists across turns for a
  // stable backend. We remember the CLI's `session_id` plus the (epoch, model) it
  // belongs to; the NEXT turn resumes that session with `--resume` + a TAIL-ONLY
  // prompt instead of replaying the whole transcript. Any of { epoch bump
  // (clear/compact/resume-session), model switch, abort, turn error } invalidates
  // the id so the next turn starts fresh and re-sends juno's authoritative history.
  let sessionId: string | undefined;
  let sessionEpoch: number | undefined;
  let sessionModel: string | undefined;
  // Watermark for the resume tail: how many transcript messages the CLI session
  // already accounts for (everything we sent in prior prompts plus the assistant
  // messages it generated). The NEXT resume tail is exactly the messages committed
  // SINCE this point — which is what carries a mid-turn `/steer` (a user message
  // that commits BEFORE the turn's assistant message) into the tail. Advanced every
  // delivered turn to the submit-time message count.
  let deliveredMessageCount: number | undefined;

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      // Epoch/model invalidation: a new transcript epoch (clear/compact/resume-
      // session) or a model switch means the CLI's server-side session no longer
      // matches juno's context, so drop any captured id and start fresh.
      const epoch = input.conversationEpoch ?? 0;
      if (epoch !== sessionEpoch || input.model !== sessionModel) {
        sessionId = undefined;
      }
      sessionEpoch = epoch;
      sessionModel = input.model;

      // Resume iff we still hold a session id after invalidation.
      let resume = sessionId !== undefined;
      // Snapshot the prior watermark for THIS turn's tail, then advance it so the
      // NEXT turn resumes from here. Done AFTER the entry-abort early-return above so
      // an aborted-before-spawn turn leaves the watermark untouched and its
      // committed-but-unsent user message rides the next tail. Fresh spawns ignore
      // this value (they replay the whole transcript); a resume/fresh fallback within
      // this same turn keeps the same submit-time count, so setting it once is correct.
      const resumeFromIndex = deliveredMessageCount ?? 0;
      deliveredMessageCount = input.messages.length;
      // assistant-start is emitted AT MOST ONCE per streamTurn. A fresh spawn emits
      // it eagerly (the block-mode / non-zero-exit paths expect a start even with no
      // content); a resume spawn DEFERS it to the first real content event so a
      // resume-failure fallback can re-spawn fresh WITHOUT a double start.
      let assistantStarted = false;

      // Consume ONE spawned child: translate its NDJSON to content AgentEvents,
      // capture the CLI `session_id`, and return HOW the attempt ended. It does NOT
      // emit assistant-start / assistant-done / aborted — the caller owns those so it
      // can inject the deferred start and drive the resume-failure retry. It removes
      // `onAbort` on every exit path (the listener is `{ once: true }`, so a fired
      // abort self-removes; these calls cover the non-fired paths).
      const consumeAttempt = async function* (
        child: ChildProcessLike,
        lifecycle: { spawnError?: Error; exitCode: number | null; exitSignal: NodeJS.Signals | null },
        waitForExit: () => Promise<void>,
        onStall: (kind: StallKind) => never,
        onAbort: () => void,
        readStderrTail: () => string,
      ): AsyncGenerator<AgentEvent, AttemptResult> {
        const toolCalls = new Map<number, ToolAccumulator>();
        // Child (subagent) stream_event deltas are accumulated in a SEPARATE,
        // per-parent Map so their numeric `index` never collides with the parent's
        // shared `toolCalls` index space (the Wave-2 index-collision bug). Block-mode
        // child tool calls arrive complete and bypass this entirely (see
        // emitFromContentBlocks). The capture has no child deltas; this is forward-compat.
        const childToolCallsByParent = new Map<string, Map<number, ToolAccumulator>>();
        let stopReason: string | undefined;
        let sawResult = false;
        // With --include-partial-messages (always passed) the CLI emits BOTH the
        // fine-grained `stream_event` deltas AND a consolidated `assistant` block
        // for the SAME content. Once any delta is seen, the block is redundant —
        // emitting both would double-render text/reasoning and double-EXECUTE tool
        // calls. This flag makes delta mode authoritative; block mode is the
        // fallback only when no `stream_event` ever arrives (flag absent).
        let sawStreamEvent = false;

        try {
          const stdout = child.stdout;
          if (stdout !== null) {
            for await (const line of readLinesWithTimeout(stdout, signal, {
              idleTimeoutMs,
              staleStreamMs,
              setTimer,
              onStall,
            })) {
              if (signal.aborted) {
                signal.removeEventListener('abort', onAbort);
                return { kind: 'aborted' };
              }

              const evt = parseJsonObject(line);
              if (evt === undefined) {
                // Skip unparseable / partial NDJSON lines (mirror garbage tolerance).
                continue;
              }

              const type = stringField(evt, 'type');

              switch (type) {
                case 'system':
                  // Capture the CLI `session_id` from the init line so the NEXT turn
                  // can resume this session. (assistant-start is owned by the caller.)
                  if (stringField(evt, 'subtype') === 'init') {
                    const captured = stringField(evt, 'session_id');
                    if (captured !== undefined) {
                      sessionId = captured;
                    }
                  }
                  break;
                case 'rate_limit_event':
                  // Subscription quota signal; not an AgentEvent in v1.
                  break;
                case 'assistant': {
                  // Consolidated content block. In delta mode this duplicates the
                  // already-emitted stream_event deltas, so we only mine it for the
                  // stop_reason and suppress re-emission. In block mode (no deltas)
                  // it is the sole content source.
                  const message = asObject(evt.message);
                  if (message === undefined) {
                    break;
                  }
                  // Subagent (child) blocks are attributed via parent_tool_use_id.
                  // They arrive ONLY as `assistant` blocks (never as stream_event
                  // deltas), so they have no delta twin → no double-emit risk. Emit
                  // their content UNCONDITIONALLY (bypassing the sawStreamEvent
                  // suppression below), carrying parentToolUseId so the renderer can
                  // nest them. Do NOT mine stop_reason / touch usage from a child.
                  const parentToolUseId = stringField(evt, 'parent_tool_use_id');
                  if (parentToolUseId !== undefined) {
                    yield* emitFromContentBlocks(message, input, toolCalls, parentToolUseId);
                    break;
                  }
                  const stop = stringField(message, 'stop_reason');
                  if (stop !== undefined && stop !== null) {
                    stopReason = stop;
                  }
                  if (sawStreamEvent) {
                    // Delta mode is authoritative; the block is a redundant summary.
                    break;
                  }
                  yield* emitFromContentBlocks(message, input, toolCalls);
                  break;
                }
                case 'stream_event': {
                  // Delta mode (--include-partial-messages): wraps raw Anthropic SSE.
                  const sse = asObject(evt.event);
                  if (sse === undefined) {
                    break;
                  }
                  // Child (subagent) deltas carry a non-null parent_tool_use_id.
                  // The capture has NONE (children are block-only), but for
                  // forward-compat we route them through a per-parent child Map so
                  // their `index` never collides with the parent's `toolCalls`, and
                  // we thread parentToolUseId into the emitted tool-call. We do NOT
                  // mine stop_reason or usage from a child stream (handled inside
                  // emitFromStreamEvent by suppressing usage when parentToolUseId set).
                  const parentToolUseId = stringField(evt, 'parent_tool_use_id');
                  if (parentToolUseId !== undefined) {
                    let childToolCalls = childToolCallsByParent.get(parentToolUseId);
                    if (childToolCalls === undefined) {
                      childToolCalls = new Map<number, ToolAccumulator>();
                      childToolCallsByParent.set(parentToolUseId, childToolCalls);
                    }
                    yield* emitFromStreamEvent(sse, input, childToolCalls, parentToolUseId);
                    break;
                  }
                  // Only a TOP-LEVEL (non-child) stream_event puts the top-level turn
                  // into delta mode. `sawStreamEvent` gates suppression of the top-level
                  // consolidated assistant block and the result usage, both of which are
                  // top-level concerns — so a child-only delta must NOT set it, or it
                  // would wrongly drop a later block-mode top-level assistant message and
                  // its usage.
                  sawStreamEvent = true;
                  yield* emitFromStreamEvent(sse, input, toolCalls);
                  const sseStop = streamEventStopReason(sse);
                  if (sseStop !== undefined) {
                    stopReason = sseStop;
                  }
                  break;
                }
                case 'user': {
                  // tool_result echoes: the CLI ran the tool ITSELF and reports the
                  // outcome here. This is a RENDER-ONLY backend — juno never
                  // re-executes — so surface the result as a terminal tool-status,
                  // completing the tool card instead of leaving it 'pending'.
                  // Child (subagent) results carry a non-null parent_tool_use_id but
                  // route purely by `tool_use_id` (globally unique), so emitting them
                  // here completes the correct nested child card with NO parent field
                  // needed on tool-status. The reducer drops statuses for tool ids it
                  // never registered, so any stray parent-level echo remains safe.
                  yield* emitFromUserEcho(evt);
                  break;
                }
                case 'result': {
                  sawResult = true;
                  const resultStop = stringField(evt, 'stop_reason');
                  if (resultStop !== undefined) {
                    stopReason = resultStop;
                  }
                  // Fallback `session_id` capture: only when the init line did not
                  // already provide one (init is authoritative; they always agree).
                  if (sessionId === undefined) {
                    const captured = stringField(evt, 'session_id');
                    if (captured !== undefined) {
                      sessionId = captured;
                    }
                  }
                  // In delta mode, usage already streamed via message_start +
                  // message_delta (parity with anthropicClient). Emitting the
                  // result usage too would double-count against the additive
                  // reducer, so only emit it in block mode.
                  if (!sawStreamEvent) {
                    yield* emitUsageFromResult(evt);
                  }
                  break;
                }
                default:
                  break;
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
        // stdout has closed. The child's terminal `exit` event fires SEPARATELY and
        // usually LOSES the race to stdout close, so when the CLI gave us no terminal
        // `result` and no exit/spawn signal has landed yet, WAIT (bounded) for the
        // exit before deciding — otherwise a fast-failing child (exit 1, tiny stderr,
        // no result) is misread as a clean `done` turn (the downstream /compact
        // "nothing to compact" casualty). A child that lingers after closing stdout
        // hits the timeout and falls through to the best-effort decision below (a
        // clean close with no error signal → done). The success path (a `result`
        // arrived) never waits, so a normal turn pays no added latency.
        if (!sawResult && lifecycle.spawnError === undefined && lifecycle.exitCode === null) {
          await waitForExit();
          if (signal.aborted) {
            return { kind: 'aborted' };
          }
        }
        // A spawn failure or a non-zero exit without a terminal `result` is an error.
        if (lifecycle.spawnError !== undefined) {
          return { kind: 'error', message: lifecycle.spawnError.message };
        }
        if (!sawResult && lifecycle.exitCode !== null && lifecycle.exitCode !== 0) {
          // Include a stderr snippet so the error card (and the downstream /compact
          // notice) carries WHY the child failed, not just the bare exit code. The
          // snippet is read SYNCHRONOUSLY from the tail buffer captured eagerly at
          // spawn — a reader attached now (post-exit) would read nothing, since
          // Node's flushStdio discards unread buffered stdio one tick after exit.
          return { kind: 'exit-error', code: lifecycle.exitCode, stderr: readStderrTail() };
        }
        // A child that died by SIGNAL (exitCode null, a signal set) with no usable
        // result is also an error — NOT a clean turn. The abort case already
        // returned `{aborted}` above (juno's own kill lands as a signal death too,
        // but signal.aborted is set), so any signal death reaching here is a
        // NON-abort death (OOM kill, crash) and the signal name rides the message.
        if (!sawResult && lifecycle.exitCode === null && lifecycle.exitSignal !== null) {
          return { kind: 'exit-error', code: null, signal: lifecycle.exitSignal, stderr: readStderrTail() };
        }
        return { kind: 'done', stopReason };
      };

      // Attempt loop: at most TWO passes — a resume attempt that fails before any
      // content falls back to ONE fresh full-transcript spawn.
      for (;;) {
        const resumeSessionId = resume ? sessionId : undefined;
        const args = buildArgs(entry, input, tools, resumeSessionId, resumeFromIndex);

        let child: ChildProcessLike;
        try {
          // `cwd` sets the CLI's project root = juno's workspace jail root, so the
          // render-only backend is confined to the same directory the file tools are.
          child = spawnImpl(binPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            cwd: input.cwd,
          });
        } catch (error: unknown) {
          // A resume spawn that fails before any content falls back to fresh.
          if (resume && !assistantStarted) {
            sessionId = undefined;
            resume = false;
            continue;
          }
          yield { type: 'error', message: errorMessage(error) };
          yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
          return;
        }

        // Capture stderr EAGERLY, the instant the attempt spawns: attach a 'data'
        // listener now, accumulating a bounded TAIL. This is load-bearing — Node's
        // flushStdio runs one tick after the child's `exit` event and DISCARDS any
        // unread buffered stdio, so a reader attached late (after we observe exit)
        // reads nothing from a real pipe and the error card would carry only the
        // bare exit code. The exit-error path reads this buffer synchronously.
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

        // Track terminal lifecycle (spawn error / non-zero exit without a result).
        // `whenExited` resolves the moment the child's `exit` (or spawn `error`) event
        // fires. That event races — and usually LOSES to — stdout close, so the consume
        // loop below WAITS (bounded) on it before deciding success vs error.
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
          // Normalize a missing signal to null so the signal-death check below
          // ('exitSignal !== null') never false-positives on `undefined`.
          lifecycle.exitSignal = exitSignal ?? null;
          settleExit();
        });
        // Bounded, ABORT-AWARE wait for the terminal exit: resolves on the exit
        // event, or after `exitWaitMs` if the child lingers after closing stdout,
        // or IMMEDIATELY on abort. Abort-awareness is load-bearing: the consume
        // loop removes the child-kill `onAbort` listener BEFORE calling this, so
        // an Esc landing in the stdout-closed-but-not-exited window would otherwise
        // be ignored until the full `exitWaitMs` elapses. Here abort kills the child
        // and resolves at once, so the aborted result is prompt. Uses the injected
        // `setTimer` so tests drive it deterministically, and clears the timer/
        // listener once resolved so no handle dangles.
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
            // The TIMEOUT branch must ALSO remove the abort listener: on main only
            // the whenExited branch did, so a wait that timed out (child lingered,
            // never exited) leaked `onAbortDuringWait` on the signal — a later abort
            // would then fire it and kill an unrelated/already-concluded turn's child.
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

        // Stall handler: reap the hung child, then throw the sentinel out of the
        // pump so consumeAttempt's catch surfaces it as an `error` result. Returns
        // `never` so the pump's control-flow analysis narrows the race winner.
        const onStall = (kind: StallKind): never => {
          try {
            child.kill();
          } catch {
            // best-effort; the child may already be gone.
          }
          const ms = kind === 'idle' ? idleTimeoutMs : staleStreamMs;
          throw new StreamStallError(kind, `claude stream stalled (${kind} timeout after ${ms}ms)`);
        };

        // Fresh spawns emit assistant-start EAGERLY (existing behavior — a start is
        // expected even when the stream carries no content). Resume spawns defer to
        // the first real content event (handled in the consume loop below).
        if (!resume && !assistantStarted) {
          assistantStarted = true;
          yield { type: 'assistant-start', id: input.id };
        }

        const gen = consumeAttempt(child, lifecycle, waitForExit, onStall, onAbort, readStderrTail);
        let result: AttemptResult;
        for (;;) {
          const next = await gen.next();
          if (next.done === true) {
            result = next.value;
            break;
          }
          // First real content event → emit the deferred assistant-start (resume path).
          if (!assistantStarted) {
            assistantStarted = true;
            yield { type: 'assistant-start', id: input.id };
          }
          yield next.value;
        }

        // This attempt has concluded (however it ended: done, error, exit-error,
        // aborted, killed). Release OUR read-ends of the child's stdout/stderr and
        // unref it BEFORE branching — a grandchild that inherited fd 2 can otherwise
        // keep those pipes (and juno's event loop) alive long past quit even though
        // the direct child was killed. Any stderr snippet was already read into
        // `result` above, so this never races the failure message. In the retry loop
        // this releases the failed attempt's child before the fresh re-spawn.
        releaseChild(child);

        if (result.kind === 'aborted') {
          // A cancelled turn diverges the CLI's server-side history from juno's
          // (juno drops the partial live msg); force the next turn fresh.
          sessionId = undefined;
          yield { type: 'aborted' };
          return;
        }

        if (result.kind === 'done') {
          yield {
            type: 'assistant-done',
            id: input.id,
            stopReason: cliStopReason(result.stopReason, signal.aborted),
          };
          return;
        }

        // result.kind === 'error' | 'exit-error'. A resume attempt that failed
        // BEFORE any content event falls back to ONE fresh full-transcript spawn
        // (transparent single retry — no error card, no double assistant-start).
        if (resume && !assistantStarted) {
          sessionId = undefined;
          resume = false;
          continue;
        }

        // Fresh failure, or a resume failure after content already streamed: surface
        // a normal error and invalidate the session so the next turn is fresh.
        sessionId = undefined;
        const message =
          result.kind === 'exit-error'
            ? `${
                result.signal !== undefined && result.signal !== null
                  ? `claude killed by signal ${result.signal}`
                  : `claude exited with code ${result.code}`
              }${result.stderr !== undefined && result.stderr.length > 0 ? `: ${result.stderr}` : ''}`
            : result.message;
        yield { type: 'error', message };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }
    },
  };
}

/**
 * juno's own tool names → the equivalent Claude Code CLI built-in tool. The
 * claude-cli backend is RENDER-ONLY: `claude -p` runs its OWN tools within the
 * single invocation, so juno's executor/permission gate never sees those calls.
 * We therefore constrain the CLI up front — allow ONLY the CLI tools that mirror
 * the file tools juno itself exposes. juno-internal tools (load_skill,
 * spawn_subagent, run_shell, remember_fact/recall_facts, and the brain tools
 * brain_remember / brain_recall / brain_get) have no CLI analogue and are omitted
 * (they run inside juno, not the CLI).
 */
const JUNO_TO_CLI_TOOL: Readonly<Record<string, string>> = {
  read_file: 'Read',
  list_files: 'Glob',
  grep: 'Grep',
  write_file: 'Write',
  edit_file: 'Edit',
};

/**
 * CLI capabilities juno NEVER grants (no shell, no network, no sub-agents — see
 * docs/SECURITY.md). Hard-denied via `--disallowedTools`: a deny rule wins over
 * any `~/.claude` allow setting, so the render-only backend cannot shell out or
 * reach the network regardless of the user's global config.
 */
const CLI_DENIED_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent', // newer CLI builds name the sub-agent tool Agent instead of Task
];

/**
 * Scope a CLI file tool to the workspace jail root using Claude Code's
 * permission-rule syntax: `Tool(//<abs-path>/**)`. The leading `//` (a single
 * `/` prepended to the already-absolute `cwd`) marks an ABSOLUTE, gitignore-style
 * path pattern, so the pre-approval only covers paths INSIDE the jail — an
 * out-of-jail absolute path the CLI's Read/Write/Edit would otherwise accept is
 * NOT pre-approved and is denied headlessly. When `cwd` is absent (the child
 * would inherit juno's own process cwd, so there is no distinct jail root to pin
 * to) we fall back to a bare tool grant.
 */
function scopeToCwd(cliTool: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) {
    return cliTool;
  }
  const root = cwd.replace(/\/+$/u, '');
  return `${cliTool}(/${root}/**)`;
}

/**
 * Partition this turn's CLI `--allowedTools` / `--disallowedTools` from juno's
 * live permission mode + the tools juno exposes, using juno's OWN policy
 * semantics (deny-what-would-prompt). A CLI file tool is pre-approved ONLY when
 * juno's policy would auto-allow its mirror in the current mode:
 *   - read-only mirrors (Read/Glob/Grep) map juno's `safe` tools, which
 *     auto-allow in EVERY mode → always allowlisted (when exposed this turn);
 *   - write mirrors (Write/Edit) map the tools in juno's `ACCEPT_EDITS_TOOLS`
 *     set, which juno auto-allows in `acceptEdits` but PROMPTS for in `default`.
 *     A headless `claude -p` cannot prompt, so in `default` mode they are NOT
 *     allowlisted and are pushed onto the DENY side — a deny rule wins over any
 *     user `~/.claude` allow rule, so writes are hard-denied rather than left to
 *     an implicit deny a global allow could silently re-enable.
 * All allow entries are path-scoped to the jail root (see `scopeToCwd`).
 */
function buildCliToolGrants(
  tools: readonly ToolSpec[],
  mode: 'default' | 'acceptEdits',
  cwd: string | undefined,
): { allow: string[]; disallow: string[] } {
  const allow: string[] = [];
  const disallow: string[] = [...CLI_DENIED_TOOLS];
  const pushUnique = (list: string[], value: string): void => {
    if (!list.includes(value)) {
      list.push(value);
    }
  };

  // Read-only file tools juno exposes this turn → always pre-approve (scoped).
  for (const tool of tools) {
    const cli = JUNO_TO_CLI_TOOL[tool.name];
    if (cli === undefined || ACCEPT_EDITS_TOOLS.has(tool.name)) {
      continue;
    }
    pushUnique(allow, scopeToCwd(cli, cwd));
  }

  // Write tools, governed by juno's mode exactly as its policy would decide.
  for (const junoName of ACCEPT_EDITS_TOOLS) {
    const cli = JUNO_TO_CLI_TOOL[junoName];
    if (cli === undefined) {
      continue;
    }
    if (mode === 'acceptEdits') {
      // juno auto-allows these in acceptEdits → pre-approve if exposed this turn.
      if (tools.some((tool) => tool.name === junoName)) {
        pushUnique(allow, scopeToCwd(cli, cwd));
      }
    } else {
      // juno `default` PROMPTS → a headless child can't prompt → hard-deny.
      pushUnique(disallow, cli);
    }
  }

  return { allow, disallow };
}

/**
 * Build the `claude -p` arg vector. `--effort <level>` maps 1:1 from
 * `input.effort` (the CLI owns the model-keyed field translation internally, so
 * no body math is needed on this backend; valid CLI levels are
 * low|medium|high|xhigh|max, per the recorded subscription-drive
 * investigation). Defaults to `medium` when unset.
 * NEVER `--bare` (it disables subscription OAuth).
 *
 * Permission regime (closes the default-backend bypass): the render-only CLI
 * is brought under juno's own decisions —
 *   - `--permission-mode` mirrors juno's live `permissionMode` (default | acceptEdits),
 *   - `--allowedTools` pre-approves ONLY the CLI tools whose juno mirror the
 *     policy would AUTO-ALLOW this mode (read-only tools always; Write/Edit only
 *     in acceptEdits), each PATH-SCOPED to the jail root, and
 *   - `--disallowedTools` hard-denies the shell/network/sub-agent escape hatches
 *     AND, in juno `default` mode, Write/Edit (juno would prompt; a headless
 *     child cannot, so they are denied rather than silently auto-approved).
 * Combined with the workspace-root `cwd` on spawn, this keeps juno's gate and
 * file jail effective on the DEFAULT backend instead of inert. See
 * `buildCliToolGrants` for the deny-what-would-prompt derivation.
 */
function buildArgs(
  entry: ModelEntry,
  input: TurnInput,
  tools: readonly ToolSpec[],
  resumeSessionId?: string,
  resumeFromIndex = 0,
): string[] {
  const model = input.model ?? entry.id;
  // Resuming: reuse the CLI's server-side session and send only the TAIL (the
  // messages committed since the last delivered turn) — the CLI already holds the rest.
  // Fresh: replay the whole labeled transcript. All OTHER flags + cwd are identical.
  const resuming = resumeSessionId !== undefined;
  const args: string[] = [
    '-p',
    resuming ? buildPromptTail(input, resumeFromIndex) : buildPrompt(input),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (resuming) {
    args.push('--resume', resumeSessionId);
  }
  if (model.length > 0) {
    args.push('--model', model);
  }
  args.push('--effort', input.effort ?? 'medium');

  // juno's permission decisions, projected onto the CLI's own gate.
  const mode = input.permissionMode ?? 'default';
  args.push('--permission-mode', mode);
  const { allow, disallow } = buildCliToolGrants(tools, mode, input.cwd);
  if (allow.length > 0) {
    args.push('--allowedTools', allow.join(','));
  }
  args.push('--disallowedTools', disallow.join(','));
  return args;
}

/**
 * Fold the turn's messages + systemPrompt into a single prompt string (the CLI
 * takes one `-p` prompt). v1 serialization: a labeled transcript. System content
 * (override + any system messages) leads; then the role-tagged conversation.
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
 * submit (the `deliveredCount` watermark) into the `-p` prompt — the just-submitted
 * user text PLUS any mid-turn `/steer` user messages. Slicing by a delivery watermark
 * rather than "everything after the last assistant" is load-bearing: a `/steer` issued
 * while the turn streams commits as a user message BEFORE that turn's assistant message,
 * so an after-last-assistant slice drops it from this and every subsequent resume tail —
 * it renders in the transcript but never reaches the model. Assistant messages after the
 * watermark were generated by the CLI on the resumed session (already in its history), so
 * they are excluded; re-sending them would double the context. The session already holds
 * the earlier turns and their tool exchanges too, and system content is not re-sent (the
 * session has it); ambient-recall context is folded into the trailing user message
 * upstream, so tail-only still carries it.
 */
export function buildPromptTail(input: TurnInput, deliveredCount: number): string {
  const parts: string[] = [];
  for (const message of input.messages.slice(deliveredCount)) {
    // The CLI generated its own assistant replies on the resumed session; echoing them
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

/** Emit AgentEvents from a complete `assistant.message.content[]` (block mode). */
function* emitFromContentBlocks(
  message: JsonObject,
  input: TurnInput,
  toolCalls: Map<number, ToolAccumulator>,
  parentToolUseId?: string,
): Generator<AgentEvent> {
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }

  let index = toolCalls.size;
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block === undefined) {
      continue;
    }
    const blockType = stringField(block, 'type');
    if (blockType === 'text') {
      // A CHILD (subagent) text block is the subagent's OWN narration. It has no
      // top-level home: `text-delta` cannot carry `parentToolUseId`, and the
      // reducer appends text deltas straight onto the live top-level turn by id.
      // Emitting it here splices the child's prose into the PARENT turn's text —
      // the duplicate-paragraph bug — while ALSO bypassing the `sawStreamEvent`
      // dedup upstream. juno never surfaces subagent narration (only its nested
      // tool calls/results), so drop child text. Only child tool_use blocks below
      // are emitted, carrying parentToolUseId for nested attribution.
      if (parentToolUseId !== undefined) {
        continue;
      }
      const text = stringField(block, 'text');
      if (text !== undefined && text.length > 0) {
        yield { type: 'text-delta', id: input.id, delta: text };
      }
    } else if (blockType === 'thinking') {
      // Same reasoning as text: child thinking has no top-level home. Drop it.
      if (parentToolUseId !== undefined) {
        continue;
      }
      const thinking = stringField(block, 'thinking');
      if (thinking !== undefined && thinking.length > 0) {
        yield { type: 'reasoning-delta', id: input.id, delta: thinking };
      }
    } else if (blockType === 'tool_use') {
      const id = stringField(block, 'id');
      const name = stringField(block, 'name');
      if (id !== undefined && name !== undefined) {
        const inputObj = asObject(block.input) ?? {};
        if (parentToolUseId !== undefined) {
          // CHILD block tool call: do NOT register into the parent's shared
          // `toolCalls` numeric index space (the index-collision bug). Child
          // tool calls arrive COMPLETE in the block (never as deltas), so no
          // accumulator is needed — emit directly, keyed by the globally-unique
          // tool_use `id`, carrying parentToolUseId for nested rendering.
          yield { type: 'tool-call', id: input.id, toolCallId: id, name, args: inputObj, parentToolUseId };
          continue;
        }
        toolCalls.set(index, { id, name, argsText: '', emitted: true });
        index += 1;
        yield { type: 'tool-call', id: input.id, toolCallId: id, name, args: inputObj };
      }
    }
  }
}

/**
 * Emit AgentEvents from a wrapped Anthropic SSE event (delta mode). Reuses the
 * SAME vocabulary `anthropicClient.ts` parses: message_start usage,
 * content_block_start (tool_use), content_block_delta
 * (text_delta/thinking_delta/input_json_delta), content_block_stop.
 */
function* emitFromStreamEvent(
  sse: JsonObject,
  input: TurnInput,
  toolCalls: Map<number, ToolAccumulator>,
  parentToolUseId?: string,
): Generator<AgentEvent> {
  const sseType = stringField(sse, 'type');

  switch (sseType) {
    case 'message_start': {
      // Child (subagent) usage is reported separately and IGNORED for v1; only
      // top-level message_start contributes to the token totals.
      if (parentToolUseId !== undefined) {
        break;
      }
      const message = asObject(sse.message);
      const usage = message === undefined ? undefined : asObject(message.usage);
      if (usage !== undefined) {
        const tokensIn = numberField(usage, 'input_tokens');
        if (tokensIn !== undefined) {
          // `contextTokens` = full window occupancy (input + cache read/creation); the
          // CLI caches heavily, so `input_tokens` alone badly understates the live window.
          // The cost meter still uses the billable `tokensIn`. Emit input here, output 0
          // (cumulative output re-reported at message_delta).
          const cacheRead = numberField(usage, 'cache_read_input_tokens') ?? 0;
          const cacheCreate = numberField(usage, 'cache_creation_input_tokens') ?? 0;
          yield {
            type: 'usage',
            tokensIn,
            tokensOut: 0,
            contextTokens: tokensIn + cacheRead + cacheCreate,
          };
        }
      }
      break;
    }
    case 'content_block_start': {
      const index = numberField(sse, 'index') ?? 0;
      const block = asObject(sse.content_block);
      if (block === undefined || stringField(block, 'type') !== 'tool_use') {
        break;
      }
      const id = stringField(block, 'id');
      const name = stringField(block, 'name');
      if (id !== undefined && name !== undefined) {
        toolCalls.set(index, { id, name, argsText: '', emitted: false });
      }
      break;
    }
    case 'content_block_delta': {
      const index = numberField(sse, 'index') ?? 0;
      const delta = asObject(sse.delta);
      if (delta === undefined) {
        break;
      }
      const deltaType = stringField(delta, 'type');
      if (deltaType === 'text_delta') {
        // A CHILD (subagent) text delta is the subagent's OWN narration. Parity
        // with the block path (emitFromContentBlocks): it has no top-level home —
        // `text-delta` cannot carry `parentToolUseId`, and the reducer would splice
        // the child's prose onto the PARENT turn's text by `id`. juno never surfaces
        // subagent narration (only its nested tool calls/results), so drop it. Child
        // tool-call deltas below (input_json_delta) still thread through.
        if (parentToolUseId !== undefined) {
          break;
        }
        const text = stringField(delta, 'text');
        if (text !== undefined && text.length > 0) {
          yield { type: 'text-delta', id: input.id, delta: text };
        }
      } else if (deltaType === 'thinking_delta') {
        // Same reasoning as text_delta: child thinking has no top-level home. Drop it.
        if (parentToolUseId !== undefined) {
          break;
        }
        const thinking = stringField(delta, 'thinking');
        if (thinking !== undefined && thinking.length > 0) {
          yield { type: 'reasoning-delta', id: input.id, delta: thinking };
        }
      } else if (deltaType === 'input_json_delta') {
        const argsDelta = stringField(delta, 'partial_json');
        const acc = toolCalls.get(index);
        if (argsDelta !== undefined && argsDelta.length > 0 && acc !== undefined) {
          acc.argsText += argsDelta;
          yield { type: 'tool-call-delta', toolCallId: acc.id, argsDelta };
        }
      }
      break;
    }
    case 'content_block_stop': {
      const index = numberField(sse, 'index') ?? 0;
      const acc = toolCalls.get(index);
      if (acc !== undefined && !acc.emitted) {
        acc.emitted = true;
        yield {
          type: 'tool-call',
          id: input.id,
          toolCallId: acc.id,
          name: acc.name,
          args: parseToolArgs(acc.argsText, index),
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
        };
      }
      break;
    }
    case 'message_delta': {
      // Child (subagent) usage is IGNORED for v1 (parity with message_start).
      if (parentToolUseId !== undefined) {
        break;
      }
      const usage = asObject(sse.usage);
      if (usage !== undefined) {
        const tokensOut = numberField(usage, 'output_tokens');
        if (tokensOut !== undefined) {
          yield { type: 'usage', tokensIn: 0, tokensOut };
        }
      }
      break;
    }
    default:
      break;
  }
}

function streamEventStopReason(sse: JsonObject): string | undefined {
  if (stringField(sse, 'type') !== 'message_delta') {
    return undefined;
  }
  const delta = asObject(sse.delta);
  return delta === undefined ? undefined : stringField(delta, 'stop_reason');
}

/** Terminal `result` event → a single `usage` (from modelUsage or usage). */
function* emitUsageFromResult(evt: JsonObject): Generator<AgentEvent> {
  // Prefer the flat `usage` block; fall back to summing `modelUsage`.
  const usage = asObject(evt.usage);
  if (usage !== undefined) {
    const tokensIn = numberField(usage, 'input_tokens');
    const tokensOut = numberField(usage, 'output_tokens');
    if (tokensIn !== undefined || tokensOut !== undefined) {
      // Cache-inclusive window occupancy (snake_case in the flat `usage` block).
      const cacheRead = numberField(usage, 'cache_read_input_tokens') ?? 0;
      const cacheCreate = numberField(usage, 'cache_creation_input_tokens') ?? 0;
      yield {
        type: 'usage',
        tokensIn: tokensIn ?? 0,
        tokensOut: tokensOut ?? 0,
        contextTokens: (tokensIn ?? 0) + cacheRead + cacheCreate,
      };
      return;
    }
  }

  const modelUsage = asObject(evt.modelUsage);
  if (modelUsage !== undefined) {
    let tokensIn = 0;
    let tokensOut = 0;
    let contextTokens = 0;
    let saw = false;
    for (const value of Object.values(modelUsage)) {
      const per = asObject(value);
      if (per === undefined) {
        continue;
      }
      const perIn = numberField(per, 'inputTokens') ?? 0;
      // Cache fields are camelCase under `modelUsage` (vs snake_case in `usage`).
      const perCacheRead = numberField(per, 'cacheReadInputTokens') ?? 0;
      const perCacheCreate = numberField(per, 'cacheCreationInputTokens') ?? 0;
      tokensIn += perIn;
      tokensOut += numberField(per, 'outputTokens') ?? 0;
      contextTokens += perIn + perCacheRead + perCacheCreate;
      saw = true;
    }
    if (saw) {
      yield { type: 'usage', tokensIn, tokensOut, contextTokens };
    }
  }
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
}

/**
 * Read an async-iterable stdout as newline-delimited lines (NDJSON), guarded by
 * two independent idle timers (mirrors the Hermes harness):
 *   T1 READ (idleTimeoutMs):  resets on EVERY chunk. No chunk at all → 'idle'.
 *   T2 STALE (staleStreamMs): resets only when a NON-EMPTY line is yielded (real
 *                             progress). Catches trickle/keepalive-but-no-progress.
 *
 * `for await` cannot be timeout-raced directly, so the iterator is consumed
 * MANUALLY: each loop races `it.next()` against both guard timers and the abort
 * signal. On a timer winning, `onStall` reaps the child and throws out of the
 * loop (the caller's existing catch surfaces it). On abort, the loop simply
 * returns so the caller's existing `signal.aborted` paths yield `{aborted}`
 * (abort wins over a stall). Both timers are ALWAYS cleared in `finally`, so no
 * handle dangles. The newline-splitting / `\r`-strip / trailing-tail logic below
 * is preserved verbatim from the original `readLines`.
 */
async function* readLinesWithTimeout(
  stdout: AsyncIterable<string | Uint8Array>,
  signal: AbortSignal,
  opts: ReadLinesTimeoutOpts,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const it = stdout[Symbol.asyncIterator]();

  // A guard timer resolves its race promise to a tagged result when it fires.
  // `clear` cancels it; `reset` cancels-and-rearms (a fresh window).
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

  try {
    while (true) {
      const nextPromise: Promise<PumpRace> = it
        .next()
        .then((result) => ({ kind: 'chunk', result }) as const);

      const winner = await Promise.race([nextPromise, idle.promise(), stale.promise(), abortPromise]);

      if (winner.kind === 'abort') {
        // Abort wins over a stall; let the caller's signal.aborted path handle it.
        return;
      }
      if (winner.kind === 'idle' || winner.kind === 'stale') {
        // Reap the hung child and throw the sentinel (returns `never`).
        opts.onStall(winner.kind);
      }

      // winner.kind === 'chunk'
      const { value: chunk, done } = winner.result;
      if (done === true) {
        break;
      }

      // A chunk arrived → real read activity. Reset the READ guard.
      idle.reset();

      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      let yieldedProgress = false;
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
          // Real progress = a parseable NDJSON object, NOT any non-empty raw
          // line. Whitespace / keepalive / unparseable garbage must NOT reset
          // the stale guard, or a trickle of '   \n' would hang forever (the
          // exact threat T2 exists to catch — see opts.staleStreamMs docstring).
          if (parseJsonObject(line) !== undefined) {
            yieldedProgress = true;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }

      // Reset the STALE guard ONLY on real progress (a parsed NDJSON line).
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
    // The only new resource; clearing both here bounds them on any exit path
    // (normal return, stall throw, or abort).
    idle.clear();
    stale.clear();
  }
}

/**
 * Map the CLI's terminal Anthropic stop_reason → juno StopReason. The claude-cli
 * backend is RENDER-ONLY: `claude -p` runs its own tools to completion within a
 * single invocation, so a 'tool_use' reason means "the CLI used tools and
 * finished", NOT "juno should run a tool". It is therefore mapped to 'end'. If
 * it leaked through as 'tool_use', the turn runner would re-EXECUTE the tool the
 * CLI already ran and then re-spawn `claude -p` in a loop. Only a genuinely
 * unknown/failed reason is an error.
 */
function cliStopReason(reason: string | undefined, aborted: boolean): StopReason {
  if (aborted) {
    return 'abort';
  }
  if (reason === 'max_tokens') {
    return 'max_tokens';
  }
  if (
    reason === undefined ||
    reason === 'end_turn' ||
    reason === 'stop_sequence' ||
    reason === 'tool_use'
  ) {
    return 'end';
  }
  return 'error';
}

/**
 * Emit a terminal tool-status for each tool_result the CLI echoes back in a
 * `user` event (it ran the tool itself). String or structured content passes
 * through as the result; `is_error` flips it to an error status. The reducer
 * drops statuses for tool ids it never registered, so stray echoes are safe.
 */
function* emitFromUserEcho(evt: JsonObject): Generator<AgentEvent> {
  const message = asObject(evt.message);
  if (message === undefined) {
    return;
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block === undefined || stringField(block, 'type') !== 'tool_result') {
      continue;
    }
    const toolCallId = stringField(block, 'tool_use_id');
    if (toolCallId === undefined) {
      continue;
    }
    if (block.is_error === true) {
      yield { type: 'tool-status', toolCallId, status: 'error', error: resultText(block.content) };
    } else {
      yield { type: 'tool-status', toolCallId, status: 'result', result: block.content };
    }
  }
}

function resultText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function parseToolArgs(argsText: string, index: number): unknown {
  if (argsText.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(argsText) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`tool call ${index} arguments were not a JSON object`);
  }

  return parsed;
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cap on the eagerly-buffered stderr tail. We keep only the LAST this-many chars —
 * a crash dump can be large, and the failure REASON lives at the END of stderr
 * (the final "Error: ..." line), so a rolling tail both bounds memory and keeps the
 * useful part. Surfaced verbatim in the error card / downstream /compact notice.
 */
const STDERR_TAIL_CAP = 4096;

/**
 * Begin capturing the child's stderr EAGERLY — call the instant the attempt spawns,
 * NOT after exit. Node's `flushStdio` runs one macrotask after the child's `exit`
 * event and DISCARDS any unread buffered stdio, so a reader attached late reads
 * nothing from a real pipe: a genuinely failing child would yield "claude exited
 * with code 1" with NO reason attached. Attaching a `'data'` listener now puts the
 * pipe in flowing mode from the start, so the bytes are accumulated into a bounded
 * TAIL buffer before flushStdio can drop them.
 *
 * Returns a synchronous reader the exit-error path calls to snapshot the tail. A
 * `'data'` listener also drains stderr on the SUCCESS path (preventing a full pipe
 * from back-pressuring the child); `releaseChild` destroys our end at attempt-end.
 * Best-effort: a stream that can't be listened to simply yields an empty snippet,
 * and an 'error' handler is attached so a stderr hiccup never throws unhandled.
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
      // Evict the oldest bytes; keep the last STDERR_TAIL_CAP (the failure reason).
      tail = tail.slice(tail.length - STDERR_TAIL_CAP);
    }
  };
  try {
    stderr.on('data', onData);
    // A 'data' listener switches the stream to flowing mode; without an 'error'
    // handler a stderr error would surface as an unhandled 'error' and throw. A
    // stderr hiccup must never mask the child's real exit outcome, so swallow it.
    stderr.on('error', () => {});
  } catch {
    // best-effort — a stream we cannot listen to simply yields no snippet.
  }
  return () => tail.trim();
}

/**
 * Release OUR read-ends of a concluded attempt's child and drop it from the event
 * loop, mirroring `mcpClient.releaseChild` (commit ddd71a1). The child was already
 * killed (abort/stall) or exited (done/exit-error), but a DESCENDANT that inherited
 * fd 1/2 (an npx/sh launcher's grandchild) can hold OUR readable pipe ends open past
 * the direct child's death — keeping those `Socket`s referenced and the Node event
 * loop alive, so juno cannot exit at quit. Destroying our ends releases the handles
 * regardless of who else holds the write end; `unref` drains any remaining child
 * handle. Runs on EVERY attempt-end path. All best-effort — an already-destroyed
 * stream / already-dead child is fine and must never throw over the turn result.
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
