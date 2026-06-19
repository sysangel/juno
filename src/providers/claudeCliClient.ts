import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

/**
 * Minimal child-process surface the client depends on, so tests can inject a
 * fake without dragging in Node's real `ChildProcess`. The real
 * `node:child_process.spawn` return value structurally satisfies this.
 */
export interface ChildProcessLike {
  /** stdout as an async-iterable of chunks (string or Uint8Array). */
  readonly stdout: AsyncIterable<string | Uint8Array> | null;
  /** stderr (optional; only read on failure for the error message). */
  readonly stderr?: AsyncIterable<string | Uint8Array> | null;
  /** Terminate the child. Mirrors ChildProcess.kill's boolean return. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Lifecycle listeners. `exit`/`close` carry the exit code; `error` a spawn failure. */
  on(event: 'exit' | 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean },
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
  // Default scheduler wraps the real timers; tests inject a deterministic clock.
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const args = buildArgs(entry, input);

      let child: ChildProcessLike;
      try {
        child = spawnImpl(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error: unknown) {
        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

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
      let spawnError: Error | undefined;
      let exitCode: number | null = null;
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('exit', (code) => {
        exitCode = code;
      });

      // Stall handler: reap the hung child, then throw the sentinel out of the
      // pump so the EXISTING catch surfaces it. Returns `never` so the pump's
      // control-flow analysis narrows the race winner to a real chunk.
      const onStall = (kind: StallKind): never => {
        try {
          child.kill();
        } catch {
          // best-effort; the child may already be gone.
        }
        const ms = kind === 'idle' ? idleTimeoutMs : staleStreamMs;
        throw new StreamStallError(kind, `claude stream stalled (${kind} timeout after ${ms}ms)`);
      };

      yield { type: 'assistant-start', id: input.id };

      const toolCalls = new Map<number, ToolAccumulator>();
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
              yield { type: 'aborted' };
              return;
            }

            const evt = parseJsonObject(line);
            if (evt === undefined) {
              // Skip unparseable / partial NDJSON lines (mirror garbage tolerance).
              continue;
            }

            const type = stringField(evt, 'type');

            switch (type) {
              case 'system':
                // init / other system events: assistant-start already emitted.
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
                // Subagent output is attributed via parent_tool_use_id; ignore for v1.
                if (evt.parent_tool_use_id !== null && evt.parent_tool_use_id !== undefined) {
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
                sawStreamEvent = true;
                // Subagent deltas carry a non-null parent_tool_use_id; ignore for
                // v1 (parity with the block-mode subagent filter above).
                if (evt.parent_tool_use_id !== null && evt.parent_tool_use_id !== undefined) {
                  break;
                }
                const sse = asObject(evt.event);
                if (sse === undefined) {
                  break;
                }
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
                // Subagent results (parent_tool_use_id non-null) are skipped.
                if (evt.parent_tool_use_id !== null && evt.parent_tool_use_id !== undefined) {
                  break;
                }
                yield* emitFromUserEcho(evt);
                break;
              }
              case 'result': {
                sawResult = true;
                const resultStop = stringField(evt, 'stop_reason');
                if (resultStop !== undefined) {
                  stopReason = resultStop;
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
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      signal.removeEventListener('abort', onAbort);

      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      // A spawn failure or a non-zero exit without a terminal `result` is an error.
      if (spawnError !== undefined) {
        yield { type: 'error', message: spawnError.message };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }
      if (!sawResult && exitCode !== null && exitCode !== 0) {
        yield { type: 'error', message: `claude exited with code ${exitCode}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      yield {
        type: 'assistant-done',
        id: input.id,
        stopReason: cliStopReason(stopReason, signal.aborted),
      };
    },
  };
}

/**
 * Build the `claude -p` arg vector. `--effort <level>` maps 1:1 from
 * `input.effort` (the CLI owns the model-keyed field translation internally, so
 * no body math is needed on this backend; valid CLI levels are
 * low|medium|high|xhigh|max — WAVE0A §4). Defaults to `medium` when unset.
 * NEVER `--bare` (it disables subscription OAuth).
 */
function buildArgs(entry: ModelEntry, input: TurnInput): string[] {
  const model = input.model ?? entry.id;
  const args: string[] = [
    '-p',
    buildPrompt(input),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (model.length > 0) {
    args.push('--model', model);
  }
  args.push('--effort', input.effort ?? 'medium');
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
      const text = stringField(block, 'text');
      if (text !== undefined && text.length > 0) {
        yield { type: 'text-delta', id: input.id, delta: text };
      }
    } else if (blockType === 'thinking') {
      const thinking = stringField(block, 'thinking');
      if (thinking !== undefined && thinking.length > 0) {
        yield { type: 'reasoning-delta', id: input.id, delta: thinking };
      }
    } else if (blockType === 'tool_use') {
      const id = stringField(block, 'id');
      const name = stringField(block, 'name');
      if (id !== undefined && name !== undefined) {
        const inputObj = asObject(block.input) ?? {};
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
): Generator<AgentEvent> {
  const sseType = stringField(sse, 'type');

  switch (sseType) {
    case 'message_start': {
      const message = asObject(sse.message);
      const usage = message === undefined ? undefined : asObject(message.usage);
      if (usage !== undefined) {
        const tokensIn = numberField(usage, 'input_tokens');
        if (tokensIn !== undefined) {
          // Emit input here, output 0 (cumulative output re-reported at message_delta).
          yield { type: 'usage', tokensIn, tokensOut: 0 };
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
        const text = stringField(delta, 'text');
        if (text !== undefined && text.length > 0) {
          yield { type: 'text-delta', id: input.id, delta: text };
        }
      } else if (deltaType === 'thinking_delta') {
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
        };
      }
      break;
    }
    case 'message_delta': {
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
      yield { type: 'usage', tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 };
      return;
    }
  }

  const modelUsage = asObject(evt.modelUsage);
  if (modelUsage !== undefined) {
    let tokensIn = 0;
    let tokensOut = 0;
    let saw = false;
    for (const value of Object.values(modelUsage)) {
      const per = asObject(value);
      if (per === undefined) {
        continue;
      }
      tokensIn += numberField(per, 'inputTokens') ?? 0;
      tokensOut += numberField(per, 'outputTokens') ?? 0;
      saw = true;
    }
    if (saw) {
      yield { type: 'usage', tokensIn, tokensOut };
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
      let yieldedNonEmpty = false;
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          yield line;
          yieldedNonEmpty = true;
        }
        newlineIndex = buffer.indexOf('\n');
      }

      // Reset the STALE guard ONLY on real progress (a non-empty line yielded).
      if (yieldedNonEmpty) {
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
