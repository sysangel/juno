=== FILE: src/providers/openaiCompatClient.ts ===
```ts
import type { AgentEvent } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKeyEnv: string;
  providerId: 'openai' | 'openrouter';
  defaultModel: string;
}

export interface OpenAICompatDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface ToolCallAccum {
  index: number;
  id: string;
  name: string;
  argsBuffer: string;
}

interface OpenAIDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChoice {
  delta?: OpenAIDelta;
  finish_reason?: string | null;
}

interface OpenAIChunk {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isAbortError(e: unknown): boolean {
  return isRecord(e) && typeof e.name === 'string' && e.name === 'AbortError';
}

function errMessage(e: unknown): string {
  if (isRecord(e) && typeof e.message === 'string') return e.message;
  return String(e);
}

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split('\n')) {
        yield line.replace(/\r$/, '');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function mapFinishReason(
  reason: string | null | undefined,
  hasTools: boolean,
): 'end' | 'tool_use' | 'max_tokens' | 'error' {
  if (reason === 'stop') return 'end';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'content_filter') return 'error';
  if (hasTools) return 'tool_use';
  return 'end';
}

function toOpenAIMessages(messages: TurnMessage[]): unknown[] {
  return messages.map((m): unknown => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.toolCallId,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

export function createOpenAICompatClient(
  config: OpenAICompatConfig,
  deps: OpenAICompatDeps = {},
): ModelClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  return {
    async *streamTurn(
      input: TurnInput,
      tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const apiKey = env[config.apiKeyEnv] ?? '';
      if (!apiKey) {
        yield { type: 'error', message: `missing API key for ${config.apiKeyEnv}` };
        return;
      }

      yield { type: 'assistant-start', id: input.id };

      const model = input.model ?? config.defaultModel;
      const url = `${config.baseUrl}/chat/completions`;

      const messages: TurnMessage[] = [];
      if (input.systemPrompt) {
        messages.push({ role: 'system', content: input.systemPrompt });
      }
      messages.push(...input.messages);

      const body: Record<string, unknown> = {
        model,
        messages: toOpenAIMessages(messages),
        stream: true,
      };
      if (tools.length > 0) {
        body.tools = toOpenAITools(tools);
      }
      if (config.providerId === 'openrouter') {
        body.provider = { data_collection: 'deny', allow_fallbacks: true };
      }

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted || isAbortError(e)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errMessage(e) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (!res.ok || !res.body) {
        yield { type: 'error', message: `HTTP ${res.status}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      const toolAccum = new Map<number, ToolCallAccum>();
      let finishReason: string | null = null;
      let usageIn = 0;
      let usageOut = 0;
      let hasUsage = false;

      try {
        for await (const line of readSseLines(res.body)) {
          if (signal.aborted) {
            yield { type: 'aborted' };
            return;
          }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '') continue;
          if (data === '[DONE]') break;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;
          const chunk = parsed as unknown as OpenAIChunk;

          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            yield { type: 'text-delta', id: input.id, delta: choice.delta.content };
          }
          if (choice?.delta?.reasoning_content) {
            yield { type: 'reasoning-delta', id: input.id, delta: choice.delta.reasoning_content };
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              let accum = toolAccum.get(tc.index);
              if (!accum) {
                accum = { index: tc.index, id: '', name: '', argsBuffer: '' };
                toolAccum.set(tc.index, accum);
              }
              if (tc.id) accum.id = tc.id;
              if (tc.function?.name) accum.name = tc.function.name;
              if (tc.function?.arguments) {
                accum.argsBuffer += tc.function.arguments;
                yield {
                  type: 'tool-call-delta',
                  toolCallId: accum.id,
                  argsDelta: tc.function.arguments,
                };
              }
            }
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (chunk.usage) {
            usageIn = chunk.usage.prompt_tokens ?? usageIn;
            usageOut = chunk.usage.completion_tokens ?? usageOut;
            hasUsage = true;
          }
        }
      } catch (e) {
        if (signal.aborted || isAbortError(e)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errMessage(e) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      const hasTools = toolAccum.size > 0;

      for (const [, accum] of toolAccum) {
        let args: unknown = {};
        if (accum.argsBuffer) {
          try {
            args = JSON.parse(accum.argsBuffer);
          } catch {
            args = accum.argsBuffer;
          }
        }
        yield {
          type: 'tool-call',
          id: input.id,
          toolCallId: accum.id,
          name: accum.name,
          args,
        };
      }

      if (hasUsage) {
        yield { type: 'usage', tokensIn: usageIn, tokensOut: usageOut };
      }

      yield {
        type: 'assistant-done',
        id: input.id,
        stopReason: mapFinishReason(finishReason, hasTools),
      };
    },
  };
}
```

=== FILE: src/providers/anthropicClient.ts ===
```ts
import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';

export interface AnthropicConfig {
  baseUrl: string;
  apiKeyEnv: string;
  defaultModel: string;
}

export interface AnthropicDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface AnthropicBlock {
  type: 'text' | 'thinking' | 'tool_use';
  id: string;
  name: string;
  argsBuffer: string;
}

interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isAbortError(e: unknown): boolean {
  return isRecord(e) && typeof e.name === 'string' && e.name === 'AbortError';
}

function errMessage(e: unknown): string {
  if (isRecord(e) && typeof e.message === 'string') return e.message;
  return String(e);
}

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const line of buffer.split('\n')) {
        yield line.replace(/\r$/, '');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function mapAnthropicStop(reason: string | undefined, hasTools: boolean): StopReason {
  if (reason === 'end_turn') return 'end';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'end';
  if (hasTools) return 'tool_use';
  return 'end';
}

function toAnthropicMessages(
  messages: TurnMessage[],
): { system: string | undefined; messages: unknown[] } {
  const systemParts: string[] = [];
  const out: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        systemParts.push(m.content);
        break;
      case 'user':
        out.push({ role: 'user', content: m.content });
        break;
      case 'assistant': {
        if (m.toolCalls && m.toolCalls.length > 0) {
          const content: unknown[] = [];
          if (m.content) content.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls) {
            content.push({ type: 'tool_use', id: tc.toolCallId, name: tc.name, input: tc.args });
          }
          out.push({ role: 'assistant', content });
        } else {
          out.push({ role: 'assistant', content: m.content });
        }
        break;
      }
      case 'tool':
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        });
        break;
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

export function createAnthropicClient(
  config: AnthropicConfig,
  deps: AnthropicDeps = {},
): ModelClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  return {
    async *streamTurn(
      input: TurnInput,
      tools: ToolSpec[],
      signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      if (signal.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const apiKey = env[config.apiKeyEnv] ?? '';
      if (!apiKey) {
        yield { type: 'error', message: `missing API key for ${config.apiKeyEnv}` };
        return;
      }

      yield { type: 'assistant-start', id: input.id };

      const model = input.model ?? config.defaultModel;
      const baseUrl = config.baseUrl || 'https://api.anthropic.com';
      const url = `${baseUrl}/v1/messages`;

      const messages: TurnMessage[] = [];
      if (input.systemPrompt) {
        messages.push({ role: 'system', content: input.systemPrompt });
      }
      messages.push(...input.messages);
      const { system, messages: apiMessages } = toAnthropicMessages(messages);

      const body: Record<string, unknown> = {
        model,
        messages: apiMessages,
        stream: true,
        max_tokens: 4096,
      };
      if (system) body.system = system;
      if (tools.length > 0) body.tools = toAnthropicTools(tools);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal.aborted || isAbortError(e)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errMessage(e) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (!res.ok || !res.body) {
        yield { type: 'error', message: `HTTP ${res.status}` };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      const blocks = new Map<number, AnthropicBlock>();
      let stopReason: string | undefined;
      let usageIn = 0;
      let usageOut = 0;
      let hasUsage = false;
      let hasTools = false;

      try {
        for await (const line of readSseLines(res.body)) {
          if (signal.aborted) {
            yield { type: 'aborted' };
            return;
          }
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '') continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;
          const evt = parsed as unknown as AnthropicEvent;

          switch (evt.type) {
            case 'message_start': {
              if (evt.message?.usage) {
                usageIn = evt.message.usage.input_tokens ?? 0;
                usageOut = evt.message.usage.output_tokens ?? 0;
                hasUsage = true;
              }
              break;
            }
            case 'content_block_start': {
              const idx = evt.index ?? 0;
              const cb = evt.content_block;
              if (cb) {
                const blockType = (cb.type ?? 'text') as 'text' | 'thinking' | 'tool_use';
                blocks.set(idx, {
                  type: blockType,
                  id: cb.id ?? '',
                  name: cb.name ?? '',
                  argsBuffer: '',
                });
              }
              break;
            }
            case 'content_block_delta': {
              const idx = evt.index ?? 0;
              const block = blocks.get(idx);
              const d = evt.delta;
              if (!block || !d) break;
              if (d.type === 'text_delta' && d.text) {
                yield { type: 'text-delta', id: input.id, delta: d.text };
              } else if (d.type === 'thinking_delta' && d.thinking) {
                yield { type: 'reasoning-delta', id: input.id, delta: d.thinking };
              } else if (d.type === 'input_json_delta' && d.partial_json) {
                block.argsBuffer += d.partial_json;
                yield {
                  type: 'tool-call-delta',
                  toolCallId: block.id,
                  argsDelta: d.partial_json,
                };
              }
              break;
            }
            case 'content_block_stop': {
              const idx = evt.index ?? 0;
              const block = blocks.get(idx);
              if (block && block.type === 'tool_use') {
                hasTools = true;
                let args: unknown = {};
                if (block.argsBuffer) {
                  try {
                    args = JSON.parse(block.argsBuffer);
                  } catch {
                    args = block.argsBuffer;
                  }
                }
                yield {
                  type: 'tool-call',
                  id: input.id,
                  toolCallId: block.id,
                  name: block.name,
                  args,
                };
              }
              break;
            }
            case 'message_delta': {
              if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              if (evt.usage?.output_tokens !== undefined) {
                usageOut = evt.usage.output_tokens;
                hasUsage = true;
              }
              break;
            }
            case 'message_stop':
            case 'ping':
              break;
            default:
              break;
          }
        }
      } catch (e) {
        if (signal.aborted || isAbortError(e)) {
          yield { type: 'aborted' };
          return;
        }
        yield { type: 'error', message: errMessage(e) };
        yield { type: 'assistant-done', id: input.id, stopReason: 'error' };
        return;
      }

      if (hasUsage) {
        yield { type: 'usage', tokensIn: usageIn, tokensOut: usageOut };
      }

      yield {
        type: 'assistant-done',
        id: input.id,
        stopReason: mapAnthropicStop(stopReason, hasTools),
      };
    },
  };
}
```

=== FILE: src/providers/index.ts ===
```ts
import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { createOpenAICompatClient } from './openaiCompatClient';
import { createAnthropicClient } from './anthropicClient';

export interface ProviderDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export type ProviderId = 'openai' | 'openrouter' | 'anthropic';

export function createModelClient(entry: ModelEntry, deps: ProviderDeps = {}): ModelClient {
  const provider = deps.provider ?? {};
  const apiKeyEnv = provider.apiKeyEnv ?? '';

  switch (entry.provider) {
    case 'openai':
      return createOpenAICompatClient(
        {
          baseUrl: provider.baseUrl ?? 'https://api.openai.com/v1',
          apiKeyEnv,
          providerId: 'openai',
          defaultModel: entry.id,
        },
        { env: deps.env, fetchImpl: deps.fetchImpl },
      );
    case 'openrouter':
      return createOpenAICompatClient(
        {
          baseUrl: provider.baseUrl ?? 'https://openrouter.ai/api/v1',
          apiKeyEnv,
          providerId: 'openrouter',
          defaultModel: entry.id,
        },
        { env: deps.env, fetchImpl: deps.fetchImpl },
      );
    case 'anthropic':
      return createAnthropicClient(
        {
          baseUrl: provider.baseUrl ?? '',
          apiKeyEnv,
          defaultModel: entry.id,
        },
        { env: deps.env, fetchImpl: deps.fetchImpl },
      );
    default:
      throw new Error('unknown provider: ' + entry.provider);
  }
}
```

=== FILE: tests/modelClients.fake.test.ts ===
```ts
import { describe, it, expect } from 'vitest';
import { createModelClient, type ProviderDeps } from '../src/providers/index';
import type { ModelEntry } from '../src/services/catalog';
import type { AgentEvent } from '../src/core/events';
import type { TurnInput, ToolSpec } from '../src/core/contracts';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakeFetch(
  chunks: string[],
  capture?: (body: Record<string, unknown>) => void,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (capture && init?.body) {
      try {
        capture(JSON.parse(String(init.body)) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    }
    return sseResponse(chunks);
  };
}

async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const openaiEntry: ModelEntry = {
  id: 'gpt-4.1',
  provider: 'openai',
  label: 'GPT-4.1',
  contextWindow: 128000,
};

const openrouterEntry: ModelEntry = {
  id: 'anthropic/claude-sonnet-4',
  provider: 'openrouter',
  label: 'Claude via OpenRouter',
  contextWindow: 200000,
};

const anthropicEntry: ModelEntry = {
  id: 'claude-sonnet-4-5',
  provider: 'anthropic',
  label: 'Claude Sonnet 4.5',
  contextWindow: 200000,
};

const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'Hello' }],
};

const noTools: ToolSpec[] = [];

function textDeltas(events: AgentEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'text-delta' }> => e.type === 'text-delta')
    .map((e) => e.delta);
}

describe('OpenAI-compatible client', () => {
  it('streams text deltas, usage, and ends with stop reason "end"', async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: 'sk-test-secret-12345' },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(openaiEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(textDeltas(events)).toEqual(['Hello', ' world']);

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', tokensIn: 5, tokensOut: 2 });

    expect(events[events.length - 1]).toEqual({
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'end',
    });
  });

  it('streams tool-call-delta then tool-call with parsed args', async () => {
    const chunks = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: 'sk-test-secret-12345' },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(openaiEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    const deltas = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-call-delta' }> => e.type === 'tool-call-delta',
    );
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    const toolCall = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call',
    );
    expect(toolCall).toEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'call_1',
      name: 'get_weather',
      args: { city: 'SF' },
    });

    expect(events[events.length - 1]).toEqual({
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'tool_use',
    });
  });
});

describe('Anthropic client', () => {
  it('streams text deltas, usage, and ends with stop reason "end"', async () => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 10, output_tokens: 0 } },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      env: { ANTHROPIC_API_KEY: 'ant-test-secret-67890' },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(anthropicEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(textDeltas(events)).toEqual(['Hello', ' world']);

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', tokensIn: 10, tokensOut: 2 });

    expect(events[events.length - 1]).toEqual({
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'end',
    });
  });

  it('streams tool-call-delta then tool-call with parsed args', async () => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 10, output_tokens: 0 } },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"SF"}' },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      env: { ANTHROPIC_API_KEY: 'ant-test-secret-67890' },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(anthropicEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    const deltas = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-call-delta' }> => e.type === 'tool-call-delta',
    );
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    const toolCall = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call',
    );
    expect(toolCall).toEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'toolu_1',
      name: 'get_weather',
      args: { city: 'SF' },
    });

    expect(events[events.length - 1]).toEqual({
      type: 'assistant-done',
      id: 'turn-1',
      stopReason: 'tool_use',
    });
  });
});

describe('error and abort handling', () => {
  it('yields a single error event naming the env var when the key is missing', async () => {
    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      env: {},
      fetchImpl: fakeFetch([]),
    };

    const client = createModelClient(openaiEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt.type !== 'error') throw new Error('expected error event');
    expect(evt.message).toContain('OPENAI_API_KEY');
    expect(evt.message).not.toContain('sk-');
  });

  it('yields aborted and returns promptly on a pre-aborted signal', async () => {
    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: 'sk-test-secret-12345' },
      fetchImpl: fakeFetch([]),
    };

    const client = createModelClient(openaiEntry, deps);
    const ac = new AbortController();
    ac.abort();

    const events = await drain(client.streamTurn(baseInput, noTools, ac.signal));

    const hasAborted = events.some((e) => e.type === 'aborted');
    expect(hasAborted || events.length === 0).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('OpenRouter no-train routing', () => {
  it('sets provider.data_collection=deny and has no "only" field', async () => {
    let captured: Record<string, unknown> | undefined;

    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
      env: { OPENROUTER_API_KEY: 'or-test-secret-abcde' },
      fetchImpl: fakeFetch(chunks, (b) => {
        captured = b;
      }),
    };

    const client = createModelClient(openrouterEntry, deps);
    await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    expect(captured).toBeDefined();
    expect(captured?.model).toBe('anthropic/claude-sonnet-4');
    expect(captured?.provider).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(captured?.only).toBeUndefined();
  });
});

describe('API key never leaks into events', () => {
  it('OpenAI: no event contains the key string', async () => {
    const key = 'sk-test-secret-12345';
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: key },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(openaiEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    const json = JSON.stringify(events);
    expect(json).not.toContain(key);
  });

  it('Anthropic: no event contains the key string', async () => {
    const key = 'ant-test-secret-67890';
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hi' },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];

    const deps: ProviderDeps = {
      provider: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      env: { ANTHROPIC_API_KEY: key },
      fetchImpl: fakeFetch(chunks),
    };

    const client = createModelClient(anthropicEntry, deps);
    const events = await drain(client.streamTurn(baseInput, noTools, new AbortController().signal));

    const json = JSON.stringify(events);
    expect(json).not.toContain(key);
  });
});
```

=== NOTES ===
All four files are self-contained, importing only from `../core/contracts`, `../core/events`, and `../services/catalog`. The OpenAI-compat adapter serves both `openai` and `openrouter` (no-train `provider` block added only for OpenRouter — no geographic allowlist). The Anthropic adapter parses `message_start`/`content_block_*`/`message_delta` SSE events, mapping thinking deltas to `reasoning-delta` and `input_json_delta` to `tool-call-delta`. API keys are read inside `streamTurn` from injected env, never stored or emitted. Abort is checked before fetch and inside the SSE loop; `AbortError` is caught and converted to a single `aborted` event. Tests use a fake `fetch` returning canned `ReadableStream` SSE bodies — no network, no real keys. All narrowing uses `unknown` + type guards; no `any` anywhere.
