import type { AgentEvent, StopReason } from '../core/events';
import type { ModelClient, ToolSpec, TurnInput, TurnMessage } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { asObject, errorMessage, numberField, parseJsonObject, parseToolArgs, stringField, type JsonObject } from './jsonUtil';

/**
 * Construction options for the OpenAI-compatible adapter. `baseUrl`/`apiKeyEnv`
 * come from W10 `Settings.providers[entry.provider]`; `isOpenRouter` gates the
 * no-train routing block (keyed on the catalog entry's provider id, NOT on URL
 * matching, so a custom/trailing-slash base URL still routes correctly).
 */
export interface OpenAICompatDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  isOpenRouter?: boolean;
}

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface ToolAccumulator {
  id?: string;
  name?: string;
  argsText: string;
  emitted: boolean;
}

/**
 * OpenAI-compatible streaming adapter. Serves the `openai` and `openrouter`
 * providers (base-url switched). Reads the API key INSIDE `streamTurn` at call
 * time; never stores, logs, or emits it. Yields ONLY normalized AgentEvents.
 */
export function createOpenAICompatClient(entry: ModelEntry, deps: OpenAICompatDeps = {}): ModelClient {
  const isOpenRouter = deps.isOpenRouter ?? entry.provider === 'openrouter';
  const baseUrl = normalizeBaseUrl(
    deps.provider?.baseUrl ?? (isOpenRouter ? OPENROUTER_BASE_URL : OPENAI_BASE_URL),
  );
  const apiKeyEnv = deps.provider?.apiKeyEnv ?? (isOpenRouter ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY');
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

      const body = buildRequestBody(entry, input, tools, isOpenRouter);
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

function buildRequestBody(
  entry: ModelEntry,
  input: TurnInput,
  tools: ToolSpec[],
  isOpenRouter: boolean,
): JsonObject {
  const messages: TurnMessage[] = [];
  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    messages.push({ role: 'system', content: input.systemPrompt });
  }
  messages.push(...input.messages);

  const body: JsonObject = {
    model: input.model ?? entry.id,
    messages: messages.map(toOpenAIMessage),
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

  // NO-TRAIN routing (OpenRouter only). No `only:[...]` geographic allowlist —
  // that screen is retired; no-train is the whole policy.
  if (isOpenRouter) {
    body.provider = {
      data_collection: 'deny',
      allow_fallbacks: true,
    };
  }

  return applyEffort(body, input.effort, isOpenRouter);
}

/**
 * LOAD-BEARING effort hook. Routes the turn's `effort` into the request body:
 *   - OpenRouter: `reasoning: { effort: <level> }` — OpenRouter's normalized,
 *     model-dependent passthrough. The no-train `provider` block already on the
 *     body is left untouched (effort must never clobber it).
 *   - OpenAI: `reasoning_effort: <level>` — the OpenAI reasoning param. It is a
 *     NO-OP on the currently-catalogued non-reasoning gpt-4.1/-mini (the API
 *     ignores it on those), so it is set defensively / forward-compatibly and
 *     never errors. The value set medium|high|xhigh is within OpenAI's accepted
 *     reasoning-effort range, so no clamping is required.
 * When `effort` is undefined the body passes through unchanged (model default).
 * The raw effort string is never emitted as a top-level `effort`/`mode` key — it
 * appears only inside `reasoning.effort` (OpenRouter) / `reasoning_effort` (OpenAI).
 */
function applyEffort(
  body: JsonObject,
  effort: TurnInput['effort'],
  isOpenRouter: boolean,
): JsonObject {
  if (effort === undefined) {
    return body;
  }
  if (isOpenRouter) {
    body.reasoning = { effort };
  } else {
    body.reasoning_effort = effort;
  }
  return body;
}

function toOpenAIMessage(message: TurnMessage): JsonObject {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant': {
      const out: JsonObject = { role: 'assistant', content: message.content };
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        }));
      }
      return out;
    }
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function firstObject(value: unknown): JsonObject | undefined {
  const array = asArray(value);
  return array === undefined ? undefined : asObject(array[0]);
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}
