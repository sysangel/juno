# Writer brief — juno Wave 4 Unit 2: nested subagent render on the claude-cli backend

You are an expert TypeScript/React(Ink) engineer. Implement a self-contained change to **juno** (a TS/Ink terminal agent). You CANNOT browse the repo — everything you need is in this brief. Output full files per the OUTPUT CONTRACT at the end.

## Mission (one sentence)
On juno's `claude-cli` backend, the native Claude Code CLI runs subagents itself; today juno DROPS all subagent activity. Make juno **render each subagent's tool calls as cards nested under the parent `Agent` card**, while **dropping subagent text/reasoning** (the parent's summary stays authoritative) and **never re-executing or re-spawning** anything.

## What is ALREADY DONE (the frozen seam — do NOT re-output these files)
The conductor already landed the additive seam. Treat these as given and build on them:
- `src/core/events.ts`: the `tool-call` AgentEvent variant now has an optional field:
  `{ type: 'tool-call'; id: string; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }`. `eventToAction` threads `parentToolUseId` through.
- `src/core/reducer.ts`: the `Action` `tool-call` variant has `parentToolUseId?: string`; `ToolState` has `parentToolUseId?: string`; the `tool-call` reducer case files it onto the tool's `ToolState`; `snapshotTools` carries it into `Msg.toolSnapshot` (a `Record<toolCallId, ToolState>`) at commit time.
- `src/ui/ToolCallCard.tsx`: `ToolCallCardProps` now has `nested?: boolean` (indent + dim border; layout-only, default off). Render a nested child card by passing `nested`.

So: emit `tool-call` events with `parentToolUseId` set for subagent tool calls; the reducer files it; you consume `toolSnapshot[id].parentToolUseId` in `Message.tsx` and pass `nested` to `ToolCallCard`.

## YOUR deliverables (output these THREE files in full)
1. `src/providers/claudeCliClient.ts` — adapter: un-drop subagent tool cards (stamped `parentToolUseId`), keep dropping subagent text + subagent stream deltas, un-drop subagent tool_result echoes.
2. `src/ui/Message.tsx` — committed render: nest child tool cards under their parent.
3. `tests/nestedSubagentRender.test.ts` — NEW deterministic test file (adapter + reducer + render). Reuse the harness style shown below.

(The conductor will separately update ONE existing test and run the gate + a live verify. Do not output other files.)

## NON-NEGOTIABLES
- **THE GATE:** `npx tsc --noEmit && npx vitest run` must stay tsc-0 and all-green. `strict: true`, but `exactOptionalPropertyTypes` OFF and `noUncheckedIndexedAccess` OFF (passing `undefined` to an optional prop is fine; `arr[i]` is `T` not `T|undefined`). NO live network / NO live `claude` subprocess in tests — inject fakes via the existing harness.
- **Option A (MANDATORY):** drop subagent **text and reasoning**. Only subagent **tool_use** blocks become cards. Reason: every emit in this adapter stamps `id: input.id` = the PARENT turn id, and the reducer appends text/reasoning deltas to the message whose `id === input.id` (the parent). Un-dropping child text would CORRUPT the parent's answer.
- **Re-spawn invariant (MOST IMPORTANT):** the adapter must NEVER let a subagent change the terminal `stopReason` to `'tool_use'`. juno's turn runner re-enters (re-executes tools + re-spawns `claude -p`) ONLY when `stopReason === 'tool_use'`. The CLI already ran everything; a leaked `'tool_use'` causes an infinite re-spawn loop. `cliStopReason` maps `tool_use`→`'end'`; your child path must run BEFORE any stop-mining so children can't touch `stopReason`.
- **Committed-only nesting:** nest only in the committed render path (reads `msg.toolSnapshot`). During live streaming `toolSnapshot` is undefined and tool blocks render as bare `[tool {id}]` text — leave that exactly as-is.
- **Additive / no regressions:** with no subagents present, byte-identical behavior. All 307 existing tests must still pass.

## GROUND TRUTH (from a real captured `claude -p` multi-subagent stream — do not design from assumptions)
A parent turn spawned TWO subagents in parallel via the CLI-native `Agent` tool; each child ran a `Bash` tool. Verified facts:

1. **`parent_tool_use_id` is a TOP-LEVEL field** on the record wrapper (sibling of `type`/`message`/`event`), NOT inside `.message`. It is `null` for the parent turn and a **string** for subagent turns, and that string **equals the parent `Agent` tool_use id**. (Nesting key: `child.parent_tool_use_id === parentAgentToolCall.toolCallId`.)
2. **Subagents NEVER stream token deltas.** Every `stream_event` record has `parent_tool_use_id: null` (parent only). Subagent internal turns surface ONLY as **complete block-mode `assistant`/`user` messages** (+ `system` lifecycle events). → leave the `stream_event` subagent guard dropping; do NOT touch the `Map<number,ToolAccumulator>` / index counter.
3. **Subagent assistant messages have `message.stop_reason: null`.** Only the parent's `message_delta` carries stop_reason (`tool_use` then `end_turn`); terminal `result.stop_reason = end_turn`.
4. **Subagent tool_use blocks carry a COMPLETE `input` object** (no `input_json_delta` for children) → no accumulator needed; emit a `tool-call` keyed by the unique `block.id`.
5. **Subagent tool_result**: a `user` record with `parent_tool_use_id` set and `message.content[].tool_use_id` = the child's own tool id.

Canonical shapes (values illustrative):
```jsonc
// CHILD assistant (subagent tool call):
{ "type":"assistant", "parent_tool_use_id":"toolu_AGENT", "subagent_type":"file-counter",
  "task_description":"…",
  "message": { "role":"assistant", "stop_reason": null,
               "content": [ { "type":"tool_use", "id":"toolu_CHILD", "name":"Bash", "input": { "command":"wc -l data1.txt" } } ] } }
// CHILD tool_result:
{ "type":"user", "parent_tool_use_id":"toolu_AGENT",
  "message": { "content": [ { "type":"tool_result", "tool_use_id":"toolu_CHILD", "content":"8 …", "is_error": false } ] } }
// PARENT Agent tool_use (top-level):
{ "type":"assistant", "parent_tool_use_id": null,
  "message": { "stop_reason": null, "content": [ { "type":"tool_use", "id":"toolu_AGENT", "name":"Agent", "input": {…} } ] } }
```
Render target (committed):
```
assistant
  text1
  ▸ Agent (parent card, top level)
      └ Bash [result] …   (child card, nested: indent + dim border)
  ▸ Agent
      └ Bash [result] …
  text2 (summary)
```

## EXACT DESIGN for `src/providers/claudeCliClient.ts`
Three drop guards exist today (in the `switch (type)`): `assistant`, `stream_event`, `user`. Change them as follows; everything else in the file is UNCHANGED.

**(a) `assistant` case** — replace the early `break` on non-null `parent_tool_use_id` with a child path that runs BEFORE stop-mining and BEFORE the `sawStreamEvent` short-circuit:
```ts
case 'assistant': {
  const message = asObject(evt.message);
  if (message === undefined) break;
  const parentToolUseId = stringField(evt, 'parent_tool_use_id');
  if (parentToolUseId !== undefined) {
    // CHILD (subagent) message. Render its TOOL cards nested under the parent
    // (stamped parentToolUseId); DROP child text/reasoning (Option A). Children
    // carry stop_reason:null and are never in the delta stream, so emit here
    // (block mode is their sole source) and return BEFORE stop-mining +
    // sawStreamEvent so a child can never touch `stopReason`.
    yield* emitChildToolCalls(message, input, parentToolUseId);
    break;
  }
  const stop = stringField(message, 'stop_reason');
  if (stop !== undefined && stop !== null) stopReason = stop;
  if (sawStreamEvent) break;
  yield* emitFromContentBlocks(message, input, toolCalls);
  break;
}
```
New helper (place near `emitFromContentBlocks`):
```ts
/**
 * Emit tool-call AgentEvents for a SUBAGENT's complete assistant message, stamped
 * with the parent Agent tool_use id for nested rendering. Drops the subagent's
 * text/reasoning (Option A). Children carry a complete `input` (no input_json_delta),
 * so no numeric accumulator is needed; the globally-unique block id keys each call.
 */
function* emitChildToolCalls(message: JsonObject, input: TurnInput, parentToolUseId: string): Generator<AgentEvent> {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block === undefined) continue;
    if (stringField(block, 'type') !== 'tool_use') continue;
    const id = stringField(block, 'id');
    const name = stringField(block, 'name');
    if (id !== undefined && name !== undefined) {
      yield { type: 'tool-call', id: input.id, toolCallId: id, name, args: asObject(block.input) ?? {}, parentToolUseId };
    }
  }
}
```

**(b) `stream_event` case** — KEEP dropping subagent stream events; only add a comment (no functional change):
```ts
// Children NEVER stream deltas (verified live: every stream_event carries
// parent_tool_use_id:null; subagent turns surface only as complete block-mode
// messages). Retained as defense-in-depth; un-dropping would require partitioning
// the index accumulator and is unnecessary.
if (evt.parent_tool_use_id !== null && evt.parent_tool_use_id !== undefined) break;
```

**(c) `user` case** — REMOVE the `parent_tool_use_id` guard so a subagent's tool_result completes its nested card (`emitFromUserEcho` already keys by the globally-unique `tool_use_id`):
```ts
case 'user': {
  // tool_result echoes — parent AND subagent results complete their cards.
  // Subagent results key by the same globally-unique tool_use_id, so
  // emitFromUserEcho routes them with no change. (Was dropped pre-Unit-2.)
  yield* emitFromUserEcho(evt);
  break;
}
```
Do NOT change `cliStopReason`, `emitFromStreamEvent`, `emitFromContentBlocks`, the `toolCalls` map, or anything else.

## EXACT DESIGN for `src/ui/Message.tsx`
Restructure the committed render so child tool blocks nest under their parent. Committed-only: read `msg.toolSnapshot`; if undefined (live), keep today's bare-`[tool]` behavior. Algorithm:
- `parentOf(toolCallId) = msg.toolSnapshot?.[toolCallId]?.parentToolUseId`.
- Build `childrenByParent: Map<parentId, Block[]>` from `msg.blocks` tool blocks whose `parentOf(...)` is defined.
- Iterate `msg.blocks` in order:
  - text block → render text (unchanged).
  - tool block that IS a child (`parentOf` defined) → SKIP (it renders under its parent).
  - tool block that is parent/standalone → render its `ToolCallCard`, then render each of its children (from the map) as `ToolCallCard` with `nested` (committed children only — look up each child's `ToolState` from `toolSnapshot`).
- Fallback: a child whose parent block is not present in this message must still render (at top level) — never drop a tool card.
Keep the existing role label, reasoning line, and text rendering. Only the tool-block grouping changes.

## CURRENT FILE — `src/providers/claudeCliClient.ts` (modify per (a)(b)(c) above)
```ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

export interface ChildProcessLike {
  readonly stdout: AsyncIterable<string | Uint8Array> | null;
  readonly stderr?: AsyncIterable<string | Uint8Array> | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessLike;

export interface ClaudeCliDeps {
  spawnImpl?: SpawnImpl;
  binPath?: string;
  env?: NodeJS.ProcessEnv;
}

type JsonObject = Record<string, unknown>;

interface ToolAccumulator {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

export function createClaudeCliClient(entry: ModelEntry, deps: ClaudeCliDeps = {}): ModelClient {
  const spawnImpl: SpawnImpl =
    deps.spawnImpl ??
    ((command, args, options) =>
      nodeSpawn(command, [...args], options) as unknown as ChildProcessLike);
  const binPath = deps.binPath ?? 'claude';

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

      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // best-effort; the child may already be gone.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      let spawnError: Error | undefined;
      let exitCode: number | null = null;
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('exit', (code) => {
        exitCode = code;
      });

      yield { type: 'assistant-start', id: input.id };

      const toolCalls = new Map<number, ToolAccumulator>();
      let stopReason: string | undefined;
      let sawResult = false;
      let sawStreamEvent = false;

      try {
        const stdout = child.stdout;
        if (stdout !== null) {
          for await (const line of readLines(stdout, signal)) {
            if (signal.aborted) {
              yield { type: 'aborted' };
              return;
            }

            const evt = parseJsonObject(line);
            if (evt === undefined) {
              continue;
            }

            const type = stringField(evt, 'type');

            switch (type) {
              case 'system':
                break;
              case 'rate_limit_event':
                break;
              case 'assistant': {
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
                  break;
                }
                yield* emitFromContentBlocks(message, input, toolCalls);
                break;
              }
              case 'stream_event': {
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

function* emitUsageFromResult(evt: JsonObject): Generator<AgentEvent> {
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

async function* readLines(
  stdout: AsyncIterable<string | Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stdout) {
    if (signal.aborted) {
      return;
    }
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        yield line;
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  const tail = buffer.replace(/\r$/, '');
  if (tail.length > 0) {
    yield tail;
  }
}

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
```

## CURRENT FILE — `src/ui/Message.tsx` (modify the tool-block grouping per the design)
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Block, Msg } from '../core/reducer';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { ToolCallCard } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
}

function roleToken(role: Msg['role']): FlatTokenName {
  switch (role) {
    case 'user':
      return 'roleUser';
    case 'assistant':
      return 'roleAssistant';
    case 'system':
      return 'roleSystem';
    case 'tool':
      return 'textDim';
  }
}

function roleLabel(role: Msg['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
  }
}

function renderBlock(msg: Msg, block: Block, d: ColorDepth): ReactElement {
  switch (block.kind) {
    case 'text':
      return (
        <Text key={block.id} color={token(roleToken(msg.role), d)}>
          {block.text}
        </Text>
      );
    case 'tool': {
      const tool = msg.toolSnapshot?.[block.toolCallId];
      return tool !== undefined ? (
        <ToolCallCard key={block.id} tool={tool} depth={d} />
      ) : (
        <Text key={block.id} color={token('textDim', d)}>
          [tool {block.toolCallId}]
        </Text>
      );
    }
  }
}

export function Message({ msg, depth }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Text color={token(roleToken(msg.role), d)} bold>
        {roleLabel(msg.role)}
      </Text>
      {msg.reasoning !== undefined && msg.reasoning.length > 0 ? (
        <Text color={token('textDim', d)} dimColor>
          thinking: {msg.reasoning}
        </Text>
      ) : null}
      {msg.blocks.map((block) => renderBlock(msg, block, d))}
    </Box>
  );
}
```
Notes for the renderer: `Block` is `{ kind:'text'; id; text } | { kind:'tool'; id; toolCallId }`. `Msg.toolSnapshot?: Record<string, ToolState>`; `ToolState` has `name`, `status`, `args`, `result?`, `error?`, `argsText?`, and now `parentToolUseId?`. `ToolCallCard` accepts `{ tool, depth?, nested? }`. Keep stable React keys (use `block.id`; for nested children use the child block's own `id`).

## TEST HARNESS (reuse this style in `tests/nestedSubagentRender.test.ts`)
The existing `tests/claudeCliClient.test.ts` uses a fake child process. Mirror it. Key scaffolding:
```ts
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createClaudeCliClient, type ChildProcessLike, type SpawnImpl } from '../src/providers/claudeCliClient';

const cliEntry: ModelEntry = { id: 'claude-opus-4-8', provider: 'claude-cli', label: 'x', contextWindow: 1_000_000 };
const baseInput: TurnInput = { id: 'turn-1', messages: [{ role: 'user', content: 'hello' }] };
const noTools: ToolSpec[] = [];

function makeSpawn(lines: string[]): SpawnImpl {
  return () => ({
    stdout: (async function* () { for (const l of lines) yield `${l}\n`; })(),
    kill: () => true,
    on(): ChildProcessLike { return this as unknown as ChildProcessLike; },
  }) as ChildProcessLike;
}
async function drain(client: ModelClient, input = baseInput, tools = noTools): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of client.streamTurn(input, tools, new AbortController().signal)) events.push(e);
  return events;
}
```
Build NDJSON lines as `JSON.stringify({...})`. An `assistant` parent tool_use line uses `parent_tool_use_id: null`; a CHILD line uses `parent_tool_use_id: '<parent Agent id>'`. Use the canonical shapes above. For a `result` line: `{ type:'result', subtype:'success', is_error:false, stop_reason:'end_turn', usage:{input_tokens:9,output_tokens:4} }`.

For the **reducer + render** tests, import from `../src/core/reducer` (`reducer`, `initialState`, types `Msg`, `ToolState`) and, for render, use the project's ink test renderer. The existing repo renders components with `ink-testing-library`'s `render(...)` returning `{ lastFrame() }` (see `tests/components.test.tsx`). Example shape:
```ts
import { render } from 'ink-testing-library';
import { Message } from '../src/ui/Message';
// build a committed Msg with toolSnapshot: { [parentId]: {name:'Agent',status:'result',args:{}},
//   [childId]: {name:'Bash',status:'result',args:{},result:'8',parentToolUseId: parentId} }
// and blocks: [ {kind:'tool',id:'m:block:1',toolCallId:parentId}, {kind:'tool',id:'m:block:2',toolCallId:childId} ]
// assert lastFrame() shows both 'Agent' and 'Bash' and the child is indented (e.g. nested marginLeft → leading spaces before the Bash card / its border).
```

### Required test cases (in `tests/nestedSubagentRender.test.ts`)
1. **stopReason invariant:** interleaved fixture — INIT line, parent `assistant` Agent tool_use (`parent_tool_use_id:null`, stop_reason null), child `assistant` Bash tool_use (`parent_tool_use_id` = the Agent id), child `user` tool_result (`parent_tool_use_id` = Agent id), parent `user` tool_result for the Agent id (`parent_tool_use_id:null`), `result('end_turn')`. Assert `events.at(-1)` === `{ type:'assistant-done', id:'turn-1', stopReason:'end' }` (NEVER `'tool_use'`).
2. **child tool-call carries parentToolUseId:** the emitted `tool-call` for the child Bash has `parentToolUseId` = the Agent id; the parent's Agent `tool-call` (if you also emit one) has `parentToolUseId` undefined.
3. **Option A drop:** a child `assistant` message containing BOTH a `text` block and a `tool_use` block emits NO `text-delta` for the child text, but DOES emit the child `tool-call`.
4. **child tool_result surfaces:** the child `user` tool_result echo emits a `tool-status` keyed by the child Bash id (status `'result'`).
5. **no cross-contamination / single emit:** exactly one `tool-call` per distinct tool id; the child args are not merged into the parent args.
6. **reducer filing:** dispatching a `tool-call` action with `parentToolUseId` then `assistant-done` yields a committed `Msg` whose `toolSnapshot[childId].parentToolUseId` === the parent id.
7. **render nesting:** a committed `Msg` (parent tool + child tool with `toolSnapshot[child].parentToolUseId === parentId`) renders both cards and the child indented under the parent (assert via `lastFrame()`).

If you cannot get the exact ink render assertion to compile, keep the render test minimal but real (assert both tool names appear and the child frame differs from a non-nested render); never stub the component.

## OUTPUT CONTRACT
Respond with a SINGLE markdown document. For every file you propose, put a line `=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block with the FULL file contents. Output exactly these three files: `src/providers/claudeCliClient.ts`, `src/ui/Message.tsx`, `tests/nestedSubagentRender.test.ts`. After all files, add a `=== NOTES ===` section (<200 words) on key design choices and the seams you consume. Do NOT write to the filesystem — output only this document.
