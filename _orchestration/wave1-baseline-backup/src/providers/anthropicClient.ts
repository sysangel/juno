import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';

export interface AnthropicDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

type JsonObject = Record<string, unknown>;

interface ToolAccumulator {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

/**
 * Anthropic Messages streaming adapter. Reads the API key INSIDE `streamTurn`
 * at call time; never stores, logs, or emits it. Yields ONLY normalized
 * AgentEvents. Thinking deltas → `reasoning-delta`; `input_json_delta` →
 * `tool-call-delta`; a completed `tool_use` block → `tool-call`.
 */
export function createAnthropicClient(entry: ModelEntry, deps: AnthropicDeps = {}): ModelClient {
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
        yield { type: 'error', message: `missing API key for ${entry.provider} (${apiKeyEnv})` };
        return;
      }

      let response: Response;

      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'anthropic-version': ANTHROPIC_VERSION,
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
            case 'message_start': {
              const message = asObject(data.message);
              const usage = message === undefined ? undefined : asObject(message.usage);
              if (usage !== undefined) {
                const tokensIn = numberField(usage, 'input_tokens');
                if (tokensIn !== undefined) {
                  // Emit input here, but ALWAYS 0 for output: Anthropic reports the
                  // cumulative `output_tokens` again at `message_delta`, and the
                  // reducer's `usage` handler is additive. Counting the message_start
                  // output value too would double-count output by that amount.
                  yield { type: 'usage', tokensIn, tokensOut: 0 };
                }
              }
              break;
            }
            case 'content_block_start': {
              const index = numberField(data, 'index') ?? 0;
              const block = asObject(data.content_block);
              if (block === undefined) {
                break;
              }
              if (stringField(block, 'type') !== 'tool_use') {
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
            case 'ping':
            case 'content_block':
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
  const systemContents: string[] = [];
  const conversation: TurnMessage[] = [];
  for (const message of input.messages) {
    if (message.role === 'system') {
      systemContents.push(message.content);
    } else {
      conversation.push(message);
    }
  }

  const body: JsonObject = {
    model: input.model ?? entry.id,
    max_tokens: DEFAULT_MAX_TOKENS,
    stream: true,
    messages: conversation.map(toAnthropicMessage),
  };

  const systemParts = [input.systemPrompt, ...systemContents].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );

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

function toAnthropicMessage(message: TurnMessage): JsonObject {
  switch (message.role) {
    case 'system':
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
