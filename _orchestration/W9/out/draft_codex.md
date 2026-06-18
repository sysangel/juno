=== FILE: src/providers/openaiCompatClient.ts ===
```ts
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

interface OpenAICompatDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type JsonObject = Record<string, unknown>;

interface ToolAccumulator {
  id?: string;
  name?: string;
  argsText: string;
  emitted: boolean;
}

export function createOpenAICompatClient(entry: ModelEntry, deps: OpenAICompatDeps = {}): ModelClient {
  const providerName = entry.provider;
  const baseUrl = normalizeBaseUrl(
    deps.provider?.baseUrl ?? (providerName === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_BASE_URL),
  );
  const apiKeyEnv = deps.provider?.apiKeyEnv ?? defaultApiKeyEnv(providerName);
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const apiKey = (deps.env ?? process.env)[apiKeyEnv];
      if (apiKey === undefined || apiKey.length === 0) {
        yield { type: 'error', message: `missing API key for ${providerName} (${apiKeyEnv})` };
        return;
      }

      const body = buildRequestBody(entry, input, tools, baseUrl);
      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }

        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (!response.ok) {
        yield { type: 'error', message: `provider request failed: ${response.status} ${response.statusText}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (response.body === null) {
        yield { type: 'error', message: 'provider response did not include a stream body' };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      yield { type: 'assistant-start', id: input.id };

      const toolCalls = new Map<number, ToolAccumulator>();
      let finishReason: string | undefined;
      let emittedUsage = false;

      try {
        for await (const payload of readSseData(response.body, signal)) {
          if (signal.aborted) {
            yield { type: 'aborted' };
            return;
          }

          if (payload === '[DONE]') {
            break;
          }

          const parsed = parseJsonObject(payload);
          if (parsed === undefined) {
            continue;
          }

          const usage = asObject(parsed.usage);
          if (usage !== undefined) {
            const tokensIn = numberField(usage, 'prompt_tokens');
            const tokensOut = numberField(usage, 'completion_tokens');
            if (tokensIn !== undefined && tokensOut !== undefined) {
              emittedUsage = true;
              yield { type: 'usage', tokensIn, tokensOut };
            }
          }

          const choice = firstObject(parsed.choices);
          if (choice === undefined) {
            continue;
          }

          const finish = stringField(choice, 'finish_reason');
          if (finish !== undefined) {
            finishReason = finish;
          }

          const delta = asObject(choice.delta);
          if (delta === undefined) {
            continue;
          }

          const content = stringField(delta, 'content');
          if (content !== undefined && content.length > 0) {
            yield { type: 'text-delta', id: input.id, delta: content };
          }

          const reasoning = stringField(delta, 'reasoning_content') ?? stringField(delta, 'reasoning');
          if (reasoning !== undefined && reasoning.length > 0) {
            yield { type: 'reasoning-delta', id: input.id, delta: reasoning };
          }

          const rawToolCalls = asArray(delta.tool_calls);
          if (rawToolCalls !== undefined) {
            for (const rawToolCall of rawToolCalls) {
              const toolCall = asObject(rawToolCall);
              if (toolCall === undefined) {
                continue;
              }

              const index = numberField(toolCall, 'index') ?? 0;
              const acc = toolCalls.get(index) ?? { argsText: '', emitted: false };
              const id = stringField(toolCall, 'id');
              if (id !== undefined) {
                acc.id = id;
              }

              const fn = asObject(toolCall.function);
              if (fn !== undefined) {
                const name = stringField(fn, 'name');
                if (name !== undefined) {
                  acc.name = name;
                }

                const argsDelta = stringField(fn, 'arguments');
                if (argsDelta !== undefined && argsDelta.length > 0) {
                  acc.argsText += argsDelta;
                  yield { type: 'tool-call-delta', toolCallId: acc.id ?? `tool-call-${index}`, argsDelta };
                }
              }

              toolCalls.set(index, acc);
            }
          }
        }

        for (const [index, acc] of toolCalls) {
          if (!acc.emitted && acc.id !== undefined && acc.name !== undefined) {
            acc.emitted = true;
            yield {
              type: 'tool-call',
              id: input.id,
              toolCallId: acc.id,
              name: acc.name,
              args: parseToolArgs(acc.argsText, index),
            };
          }
        }

        if (!emittedUsage) {
          const usageFromHeader = usageFromHeaders(response.headers);
          if (usageFromHeader !== undefined) {
            yield usageFromHeader;
          }
        }

        yield {
          type: 'assistant-done',
          id: input.id,
          stopReason: stopReasonFromOpenAI(finishReason, toolCalls.size > 0, signal.aborted),
        };
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }

        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
      }
    },
  };
}

function buildRequestBody(entry: ModelEntry, input: TurnInput, tools: ToolSpec[], baseUrl: string): JsonObject {
  const body: JsonObject = {
    model: input.model ?? entry.id,
    messages: input.messages.map(toOpenAIMessage),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  if (baseUrl === OPENROUTER_BASE_URL) {
    body.provider = {
      data_collection: 'deny',
      allow_fallbacks: true,
    };
  }

  return body;
}

function toOpenAIMessage(message: TurnMessage): JsonObject {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.toolCallId,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

async function* readSseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      buffer += decoder.decode(read.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const data = parseSseMessage(part);
        if (data !== undefined) {
          yield data;
        }
      }
    }

    buffer += decoder.decode();
    const finalData = parseSseMessage(buffer);
    if (finalData !== undefined) {
      yield finalData;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseMessage(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length === 0 ? undefined : dataLines.join('\n');
}

function stopReasonFromOpenAI(reason: string | undefined, hasToolCall: boolean, aborted: boolean): StopReason {
  if (aborted) {
    return 'abort';
  }

  if (hasToolCall || reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use';
  }

  if (reason === 'stop' || reason === undefined) {
    return 'end';
  }

  if (reason === 'length') {
    return 'max_tokens';
  }

  return 'error';
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

function usageFromHeaders(headers: Headers): AgentEvent | undefined {
  const tokensIn = numberFromString(headers.get('x-usage-input-tokens'));
  const tokensOut = numberFromString(headers.get('x-usage-output-tokens'));

  return tokensIn === undefined || tokensOut === undefined ? undefined : { type: 'usage', tokensIn, tokensOut };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function defaultApiKeyEnv(provider: string): string {
  switch (provider) {
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'openai':
    default:
      return 'OPENAI_API_KEY';
  }
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

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstObject(value: unknown): JsonObject | undefined {
  const array = asArray(value);
  return array === undefined ? undefined : asObject(array[0]);
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function numberFromString(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}
```

=== FILE: src/providers/anthropicClient.ts ===
```ts
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

interface AnthropicDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

type JsonObject = Record<string, unknown>;

interface ToolAccumulator {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

export function createAnthropicClient(entry: ModelEntry, deps: AnthropicDeps = {}): ModelClient {
  const providerName = entry.provider;
  const baseUrl = normalizeBaseUrl(deps.provider?.baseUrl ?? DEFAULT_BASE_URL);
  const apiKeyEnv = deps.provider?.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async *streamTurn(input: TurnInput, tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const apiKey = (deps.env ?? process.env)[apiKeyEnv];
      if (apiKey === undefined || apiKey.length === 0) {
        yield { type: 'error', message: `missing API key for ${providerName} (${apiKeyEnv})` };
        return;
      }

      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(buildRequestBody(entry, input, tools)),
          signal,
        });
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }

        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (!response.ok) {
        yield { type: 'error', message: `provider request failed: ${response.status} ${response.statusText}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (response.body === null) {
        yield { type: 'error', message: 'provider response did not include a stream body' };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      yield { type: 'assistant-start', id: input.id };

      const toolCalls = new Map<number, ToolAccumulator>();
      let stopReason: string | undefined;

      try {
        for await (const event of readAnthropicEvents(response.body, signal)) {
          if (signal.aborted) {
            yield { type: 'aborted' };
            return;
          }

          const data = parseJsonObject(event.data);
          if (data === undefined) {
            continue;
          }

          switch (event.event) {
            case 'content_block_start': {
              const index = numberField(data, 'index') ?? 0;
              const block = asObject(data.content_block);
              if (block === undefined) {
                break;
              }

              const type = stringField(block, 'type');
              if (type !== 'tool_use') {
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
              const index = numberField(data, 'index') ?? 0;
              const delta = asObject(data.delta);
              if (delta === undefined) {
                break;
              }

              const type = stringField(delta, 'type');
              if (type === 'text_delta') {
                const text = stringField(delta, 'text');
                if (text !== undefined && text.length > 0) {
                  yield { type: 'text-delta', id: input.id, delta: text };
                }
              } else if (type === 'thinking_delta') {
                const thinking = stringField(delta, 'thinking');
                if (thinking !== undefined && thinking.length > 0) {
                  yield { type: 'reasoning-delta', id: input.id, delta: thinking };
                }
              } else if (type === 'input_json_delta') {
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
              const index = numberField(data, 'index') ?? 0;
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
              const delta = asObject(data.delta);
              if (delta !== undefined) {
                const stop = stringField(delta, 'stop_reason');
                if (stop !== undefined) {
                  stopReason = stop;
                }
              }

              const usage = asObject(data.usage);
              if (usage !== undefined) {
                const tokensOut = numberField(usage, 'output_tokens');
                if (tokensOut !== undefined) {
                  yield { type: 'usage', tokensIn: 0, tokensOut };
                }
              }
              break;
            }
            case 'message_start': {
              const message = asObject(data.message);
              const usage = message === undefined ? undefined : asObject(message.usage);
              if (usage !== undefined) {
                const tokensIn = numberField(usage, 'input_tokens');
                const tokensOut = numberField(usage, 'output_tokens') ?? 0;
                if (tokensIn !== undefined) {
                  yield { type: 'usage', tokensIn, tokensOut };
                }
              }
              break;
            }
            case 'ping':
            case 'message_stop':
              break;
            default:
              break;
          }
        }

        yield {
          type: 'assistant-done',
          id: input.id,
          stopReason: stopReasonFromAnthropic(stopReason, toolCalls.size > 0, signal.aborted),
        };
      } catch (error: unknown) {
        if (isAbort(signal, error)) {
          yield { type: 'aborted' };
          return;
        }

        yield { type: 'error', message: errorMessage(error) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
      }
    },
  };
}

function buildRequestBody(entry: ModelEntry, input: TurnInput, tools: ToolSpec[]): JsonObject {
  const systemMessages = input.messages.filter((message) => message.role === 'system');
  const nonSystemMessages = input.messages.filter((message) => message.role !== 'system');

  const body: JsonObject = {
    model: input.model ?? entry.id,
    max_tokens: 4096,
    stream: true,
    messages: nonSystemMessages.map(toAnthropicMessage),
  };

  const systemParts = [
    input.systemPrompt,
    ...systemMessages.map((message) => message.content),
  ].filter((part): part is string => part !== undefined && part.length > 0);

  if (systemParts.length > 0) {
    body.system = systemParts.join('\n\n');
  }

  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  return body;
}

function toAnthropicMessage(message: Exclude<TurnMessage, { role: 'system' }>): JsonObject {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const content: JsonObject[] = [];
      if (message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }

      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.toolCallId,
          name: call.name,
          input: call.args,
        });
      }

      return { role: 'assistant', content };
    }
    case 'tool':
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      };
  }
}

interface SseEvent {
  event: string;
  data: string;
}

async function* readAnthropicEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      buffer += decoder.decode(read.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const parsed = parseSseEvent(part);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    buffer += decoder.decode();
    const finalEvent = parseSseEvent(buffer);
    if (finalEvent !== undefined) {
      yield finalEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(message: string): SseEvent | undefined {
  const lines = message.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length === 0 ? undefined : { event, data: dataLines.join('\n') };
}

function stopReasonFromAnthropic(reason: string | undefined, hasToolCall: boolean, aborted: boolean): StopReason {
  if (aborted) {
    return 'abort';
  }

  if (hasToolCall || reason === 'tool_use') {
    return 'tool_use';
  }

  if (reason === 'end_turn' || reason === 'stop_sequence' || reason === undefined) {
    return 'end';
  }

  if (reason === 'max_tokens') {
    return 'max_tokens';
  }

  return 'error';
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
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

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}
```

=== FILE: src/providers/index.ts ===
```ts
import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { createAnthropicClient } from './anthropicClient';
import { createOpenAICompatClient } from './openaiCompatClient';

export interface ProviderDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export type ProviderId = 'openai' | 'openrouter' | 'anthropic';

/** Resolve a ModelClient by entry.provider. Throws on an unknown provider id. */
export function createModelClient(entry: ModelEntry, deps: ProviderDeps = {}): ModelClient {
  switch (entry.provider) {
    case 'openai':
    case 'openrouter':
      return createOpenAICompatClient(entry, deps);
    case 'anthropic':
      return createAnthropicClient(entry, deps);
    default:
      throw new Error(`unknown provider: ${entry.provider}`);
  }
}
```

=== FILE: tests/modelClients.fake.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createModelClient, type ProviderDeps } from '../src/providers';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
}

const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'hello' }],
};

const noTools: ToolSpec[] = [];

describe('streaming model clients', () => {
  it('normalizes OpenAI-compatible text chunks and usage', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch(
        [
          sseData({ choices: [{ delta: { content: 'Hel' } }] }),
          sseData({ choices: [{ delta: { content: 'lo' } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
          sseData('[DONE]'),
        ],
        captured,
      ),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'turn-1', delta: 'Hel' },
      { type: 'text-delta', id: 'turn-1', delta: 'lo' },
    ]);
    expect(events).toContainEqual({ type: 'usage', tokensIn: 3, tokensOut: 2 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-openai-key');
    expect(captured[0]?.url).toBe('https://api.openai.test/v1/chat/completions');
  });

  it('normalizes OpenAI-compatible tool-call deltas and completed args', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([
        sseData({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q"' } },
                ],
              },
            },
          ],
        }),
        sseData({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':"books"}' } },
                ],
              },
            },
          ],
        }),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sseData('[DONE]'),
      ]),
    });

    const events = await drain(client, baseInput, [
      { name: 'lookup', description: 'Lookup things', inputSchema: { type: 'object' } },
    ]);

    expect(events.filter((event) => event.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', toolCallId: 'call-1', argsDelta: '{"q"' },
      { type: 'tool-call-delta', toolCallId: 'call-1', argsDelta: ':"books"}' },
    ]);
    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'call-1',
      name: 'lookup',
      args: { q: 'books' },
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'tool_use' });
    expect(JSON.stringify(events)).not.toContain('secret-openai-key');
  });

  it('adds OpenRouter no-train routing without provider.only', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(
      { ...openAIEntry(), provider: 'openrouter', id: 'openai/gpt-4.1' },
      {
        provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
        env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
        fetchImpl: fakeFetch([
          sseData({ choices: [{ delta: { content: 'ok' } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sseData('[DONE]'),
        ], captured),
      },
    );

    const events = await drain(client, baseInput, noTools);
    const body = asObject(captured[0]?.body);
    const provider = asObject(body.provider);

    expect(provider.data_collection).toBe('deny');
    expect(provider.allow_fallbacks).toBe(true);
    expect(Object.hasOwn(provider, 'only')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-openrouter-key');
  });

  it('normalizes Anthropic text, thinking, usage, and stop reason', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('message_start', { message: { usage: { input_tokens: 9, output_tokens: 0 } } }),
        sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        sseEvent('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'because' } }),
        sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
        sseEvent('message_stop', {}),
      ]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'reasoning-delta', id: 'turn-1', delta: 'because' });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 0 });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 0, tokensOut: 4 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-anthropic-key');
  });

  it('normalizes Anthropic tool-use deltas and completed args', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-1', name: 'lookup', input: {} },
        }),
        sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"q"' } }),
        sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: ':"music"}' } }),
        sseEvent('content_block_stop', { index: 0 }),
        sseEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
        sseEvent('message_stop', {}),
      ]),
    });

    const events = await drain(client, baseInput, [
      { name: 'lookup', description: 'Lookup things', inputSchema: { type: 'object' } },
    ]);

    expect(events.filter((event) => event.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', toolCallId: 'toolu-1', argsDelta: '{"q"' },
      { type: 'tool-call-delta', toolCallId: 'toolu-1', argsDelta: ':"music"}' },
    ]);
    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu-1',
      name: 'lookup',
      args: { q: 'music' },
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'tool_use' });
    expect(JSON.stringify(events)).not.toContain('secret-anthropic-key');
  });

  it('yields exactly one error event when the API key is missing', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: {},
      fetchImpl: fakeFetch([sseData('[DONE]')]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events).toEqual([{ type: 'error', message: 'missing API key for openai (OPENAI_TEST_KEY)' }]);
  });

  it('returns promptly for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([sseData('[DONE]')]),
    });

    const events = await drain(client, baseInput, noTools, controller.signal);

    expect(events).toEqual([{ type: 'aborted' }]);
  });
});

async function drain(
  client: ModelClient,
  input: TurnInput,
  tools: ToolSpec[],
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of client.streamTurn(input, tools, signal)) {
    events.push(event);
  }
  return events;
}

function fakeFetch(chunks: string[], captured: CapturedRequest[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    captured.push({ url: String(input), init: init ?? {}, body });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function sseData(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openAIEntry(): ModelEntry {
  return {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT 4.1',
    contextWindow: 128000,
  };
}

function anthropicEntry(): ModelEntry {
  return {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    label: 'Claude Sonnet 4',
    contextWindow: 200000,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }

  return value as Record<string, unknown>;
}
```

=== NOTES ===
I kept the adapters self-contained, network-free under tests, and API keys read only inside `streamTurn`. The tests use injected `fetch`, canned `ReadableStream` SSE payloads, request-body capture for OpenRouter no-train routing, missing-key behavior, pre-abort behavior, tool-call assembly, usage events, and key non-leak assertions.