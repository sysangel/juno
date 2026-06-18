=== FILE: src/providers/claudeCliClient.ts ===
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
                if (message === undefined) break;
                const parentToolUseId = stringField(evt, 'parent_tool_use_id');
                if (parentToolUseId !== undefined) {
                  // CHILD (subagent) message. Render its TOOL cards nested under the
                  // parent (stamped parentToolUseId); DROP child text/reasoning
                  // (Option A). Children carry stop_reason:null and are never in the
                  // delta stream, so emit here (block mode is their sole source) and
                  // return BEFORE stop-mining + sawStreamEvent so a child can never
                  // touch `stopReason`.
                  yield* emitChildToolCalls(message, input, parentToolUseId);
                  break;
                }
                const stop = stringField(message, 'stop_reason');
                if (stop !== undefined && stop !== null) stopReason = stop;
                if (sawStreamEvent) break;
                yield* emitFromContentBlocks(message, input, toolCalls);
                break;
              }
              case 'stream_event': {
                sawStreamEvent = true;
                // Children NEVER stream deltas (verified live: every stream_event
                // carries parent_tool_use_id:null; subagent turns surface only as
                // complete block-mode messages). Retained as defense-in-depth;
                // un-dropping would require partitioning the index accumulator and
                // is unnecessary.
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
                // tool_result echoes — parent AND subagent results complete their
                // cards. Subagent results key by the same globally-unique
                // tool_use_id, so emitFromUserEcho routes them with no change.
                // (Was dropped pre-Unit-2.)
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

/**
 * Emit tool-call AgentEvents for a SUBAGENT's complete assistant message, stamped
 * with the parent Agent tool_use id for nested rendering. Drops the subagent's
 * text/reasoning (Option A). Children carry a complete `input` (no input_json_delta),
 * so no numeric accumulator is needed; the globally-unique block id keys each call.
 */
function* emitChildToolCalls(
  message: JsonObject,
  input: TurnInput,
  parentToolUseId: string,
): Generator<AgentEvent> {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asObject(rawBlock);
    if (block === undefined) continue;
    if (stringField(block, 'type') !== 'tool_use') continue;
    const id = stringField(block, 'id');
    const name = stringField(block, 'name');
    if (id !== undefined && name !== undefined) {
      yield {
        type: 'tool-call',
        id: input.id,
        toolCallId: id,
        name,
        args: asObject(block.input) ?? {},
        parentToolUseId,
      };
    }
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

=== FILE: src/ui/Message.tsx ===
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

function renderToolCard(msg: Msg, block: Block, d: ColorDepth, nested: boolean): ReactElement {
  const tool = msg.toolSnapshot?.[block.toolCallId];
  return tool !== undefined ? (
    <ToolCallCard key={block.id} tool={tool} depth={d} nested={nested} />
  ) : (
    <Text key={block.id} color={token('textDim', d)}>
      [tool {block.toolCallId}]
    </Text>
  );
}

export function Message({ msg, depth }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;

  const parentOf = (toolCallId: string): string | undefined =>
    msg.toolSnapshot?.[toolCallId]?.parentToolUseId;

  // Build childrenByParent map (committed only — requires toolSnapshot).
  const childrenByParent = new Map<string, Block[]>();
  if (msg.toolSnapshot !== undefined) {
    for (const block of msg.blocks) {
      if (block.kind !== 'tool') continue;
      const pid = parentOf(block.toolCallId);
      if (pid === undefined) continue;
      const arr = childrenByParent.get(pid);
      if (arr === undefined) {
        childrenByParent.set(pid, [block]);
      } else {
        arr.push(block);
      }
    }
  }

  const elements: ReactElement[] = [];
  for (const block of msg.blocks) {
    if (block.kind === 'text') {
      elements.push(
        <Text key={block.id} color={token(roleToken(msg.role), d)}>
          {block.text}
        </Text>,
      );
      continue;
    }

    // tool block
    const pid = parentOf(block.toolCallId);
    if (pid !== undefined) {
      // This is a child. If its parent tool block is also in this message, it
      // renders under the parent (skip here). Otherwise render at top level
      // (fallback — never drop a tool card).
      const parentPresent = msg.blocks.some(
        (b) => b.kind === 'tool' && b.toolCallId === pid,
      );
      if (parentPresent) continue;
      elements.push(renderToolCard(msg, block, d, false));
      continue;
    }

    // Parent or standalone tool block — render it, then its nested children.
    elements.push(renderToolCard(msg, block, d, false));
    const children = childrenByParent.get(block.toolCallId);
    if (children !== undefined) {
      for (const childBlock of children) {
        elements.push(renderToolCard(msg, childBlock, d, true));
      }
    }
  }

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
      {elements}
    </Box>
  );
}
```

=== FILE: tests/nestedSubagentRender.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import {
  createClaudeCliClient,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/providers/claudeCliClient';
import { reducer, initialState } from '../src/core/reducer';
import type { Msg, ToolState } from '../src/core/reducer';
import { Message } from '../src/ui/Message';

const cliEntry: ModelEntry = {
  id: 'claude-opus-4-8',
  provider: 'claude-cli',
  label: 'x',
  contextWindow: 1_000_000,
};
const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'hello' }],
};
const noTools: ToolSpec[] = [];

function makeSpawn(lines: string[]): SpawnImpl {
  return () =>
    ({
      stdout: (async function* () {
        for (const l of lines) yield `${l}\n`;
      })(),
      kill: () => true,
      on(): ChildProcessLike {
        return this as unknown as ChildProcessLike;
      },
    }) as ChildProcessLike;
}

async function drain(
  client: ModelClient,
  input: TurnInput = baseInput,
  tools: ToolSpec[] = noTools,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of client.streamTurn(input, tools, new AbortController().signal)) {
    events.push(e);
  }
  return events;
}

type ToolCallEvent = Extract<AgentEvent, { type: 'tool-call' }>;
type ToolStatusEvent = Extract<AgentEvent, { type: 'tool-status' }>;

function subagentLines(): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        stop_reason: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_AGENT',
            name: 'Agent',
            input: { description: 'count files' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_AGENT',
      subagent_type: 'file-counter',
      task_description: 'count lines',
      message: {
        role: 'assistant',
        stop_reason: null,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_CHILD',
            name: 'Bash',
            input: { command: 'wc -l data1.txt' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: 'toolu_AGENT',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_CHILD',
            content: '8 data1.txt',
            is_error: false,
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_AGENT',
            content: 'found 8 lines',
            is_error: false,
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 4 },
    }),
  ];
}

describe('nested subagent render', () => {
  it('never lets a subagent change stopReason to tool_use', async () => {
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: makeSpawn(subagentLines()),
    });
    const events = await drain(client);
    expect(events.at(-1)).toEqual({
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'end',
    });
  });

  it('stamps parentToolUseId on child tool-call but not parent', async () => {
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: makeSpawn(subagentLines()),
    });
    const events = await drain(client);
    const toolCalls = events.filter(
      (e): e is ToolCallEvent => e.type === 'tool-call',
    );
    const childCall = toolCalls.find((t) => t.toolCallId === 'toolu_CHILD');
    const parentCall = toolCalls.find((t) => t.toolCallId === 'toolu_AGENT');
    expect(childCall).toBeDefined();
    expect(childCall!.parentToolUseId).toBe('toolu_AGENT');
    expect(parentCall).toBeDefined();
    expect(parentCall!.parentToolUseId).toBeUndefined();
  });

  it('drops child text but keeps child tool_use (Option A)', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_AGENT',
        message: {
          role: 'assistant',
          stop_reason: null,
          content: [
            { type: 'text', text: 'child reasoning text' },
            { type: 'tool_use', id: 'toolu_CHILD', name: 'Bash', input: { command: 'x' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const client = createClaudeCliClient(cliEntry, { spawnImpl: makeSpawn(lines) });
    const events = await drain(client);
    const textDeltas = events.filter((e) => e.type === 'text-delta');
    expect(textDeltas).toHaveLength(0);
    const toolCalls = events.filter(
      (e): e is ToolCallEvent => e.type === 'tool-call',
    );
    expect(toolCalls.some((t) => t.toolCallId === 'toolu_CHILD')).toBe(true);
  });

  it('surfaces child tool_result as tool-status', async () => {
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: makeSpawn(subagentLines()),
    });
    const events = await drain(client);
    const statuses = events.filter(
      (e): e is ToolStatusEvent => e.type === 'tool-status',
    );
    const childStatus = statuses.find((s) => s.toolCallId === 'toolu_CHILD');
    expect(childStatus).toBeDefined();
    expect(childStatus!.status).toBe('result');
  });

  it('emits exactly one tool-call per distinct tool id with no arg cross-contamination', async () => {
    const client = createClaudeCliClient(cliEntry, {
      spawnImpl: makeSpawn(subagentLines()),
    });
    const events = await drain(client);
    const toolCalls = events.filter(
      (e): e is ToolCallEvent => e.type === 'tool-call',
    );
    const ids = toolCalls.map((t) => t.toolCallId);
    expect(ids).toEqual(['toolu_AGENT', 'toolu_CHILD']);
    expect(new Set(ids).size).toBe(ids.length);
    const parentCall = toolCalls.find((t) => t.toolCallId === 'toolu_AGENT')!;
    const childCall = toolCalls.find((t) => t.toolCallId === 'toolu_CHILD')!;
    expect(parentCall.args).toEqual({ description: 'count files' });
    expect(childCall.args).toEqual({ command: 'wc -l data1.txt' });
  });

  it('files parentToolUseId into toolSnapshot at commit', () => {
    let state = initialState;
    state = reducer(state, { type: 'assistant-start', id: 'turn-1' });
    state = reducer(state, {
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu_AGENT',
      name: 'Agent',
      args: {},
    });
    state = reducer(state, {
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu_CHILD',
      name: 'Bash',
      args: { command: 'x' },
      parentToolUseId: 'toolu_AGENT',
    });
    state = reducer(state, {
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'end',
    });
    const committed = state.messages.at(-1);
    expect(committed).toBeDefined();
    expect(committed!.toolSnapshot?.['toolu_CHILD']?.parentToolUseId).toBe(
      'toolu_AGENT',
    );
    expect(committed!.toolSnapshot?.['toolu_AGENT']?.parentToolUseId).toBeUndefined();
  });

  it('renders nested child card under parent (committed)', () => {
    const parentId = 'toolu_AGENT';
    const childId = 'toolu_CHILD';
    const parentTool = {
      name: 'Agent',
      status: 'result',
      args: {},
    } as ToolState;
    const childTool = {
      name: 'Bash',
      status: 'result',
      args: { command: 'wc -l' },
      result: '8 lines',
      parentToolUseId: parentId,
    } as ToolState;

    const nestedMsg = {
      id: 'turn-1',
      role: 'assistant',
      blocks: [
        { kind: 'tool', id: 'b1', toolCallId: parentId },
        { kind: 'tool', id: 'b2', toolCallId: childId },
      ],
      toolSnapshot: { [parentId]: parentTool, [childId]: childTool },
    } as unknown as Msg;

    const nested = render(createElement(Message, { msg: nestedMsg })).lastFrame();
    expect(nested).toBeDefined();
    expect(nested!).toContain('Agent');
    expect(nested!).toContain('Bash');

    // Flat (non-nested) render: child has no parentToolUseId → both at top level.
    const flatChild = {
      name: 'Bash',
      status: 'result',
      args: { command: 'wc -l' },
      result: '8 lines',
    } as ToolState;
    const flatMsg = {
      id: 'turn-1',
      role: 'assistant',
      blocks: [
        { kind: 'tool', id: 'b1', toolCallId: parentId },
        { kind: 'tool', id: 'b2', toolCallId: childId },
      ],
      toolSnapshot: { [parentId]: parentTool, [childId]: flatChild },
    } as unknown as Msg;

    const flat = render(createElement(Message, { msg: flatMsg })).lastFrame();
    expect(flat).toBeDefined();
    expect(nested).not.toEqual(flat);
  });
});
```

=== NOTES ===
**Adapter:** The `assistant` case now reads `parent_tool_use_id` via `stringField` (returns `undefined` for `null`, so parent turns fall through unchanged). Child turns route to `emitChildToolCalls` — which yields only `tool_use` blocks stamped with `parentToolUseId` — then `break` BEFORE stop-mining, preserving the re-spawn invariant. The `user` guard is removed so subagent `tool_result` echoes complete their nested cards via the existing `emitFromUserEcho` (keyed by globally-unique `tool_use_id`). The `stream_event` guard stays (defense-in-depth; children never stream deltas).

**Renderer:** `Message.tsx` builds a `childrenByParent` map from `toolSnapshot[id].parentToolUseId` (committed-only; undefined during streaming leaves bare `[tool]` behavior intact). Child blocks whose parent is present are skipped at top level and rendered as `ToolCallCard` with `nested` immediately after their parent. Orphan children fall back to top-level rendering — no card is ever dropped.

**Seams consumed:** `AgentEvent.tool-call.parentToolUseId`, `Action.tool-call.parentToolUseId`, `ToolState.parentToolUseId`, `Msg.toolSnapshot`, and `ToolCallCardProps.nested` — all landed by the conductor.
