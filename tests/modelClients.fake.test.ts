import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createModelClient } from '../src/providers/index';

interface CapturedRequest {
  url: string;
  body: Record<string, unknown> | undefined;
}

const baseInput: TurnInput = {
  id: 'turn-1',
  messages: [{ role: 'user', content: 'hello' }],
};

const noTools: ToolSpec[] = [];

const lookupTool: ToolSpec = {
  name: 'lookup',
  description: 'Lookup things',
  inputSchema: { type: 'object' },
};

function openAIEntry(): ModelEntry {
  return { id: 'gpt-4.1', provider: 'openai', label: 'GPT 4.1', contextWindow: 128000 };
}

function openRouterEntry(): ModelEntry {
  return {
    id: 'anthropic/claude-sonnet-4',
    provider: 'openrouter',
    label: 'Claude via OpenRouter',
    contextWindow: 200000,
  };
}

function anthropicEntry(): ModelEntry {
  return {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200000,
  };
}

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
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    }
    captured.push({ url: String(input), body });

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

/**
 * Fake fetch that returns a non-OK Response (status >= 400). Captures the
 * request the same way `fakeFetch` does, and lets a body string be supplied so
 * tests can prove no response-body content (e.g. a token-like string) leaks
 * into emitted events.
 */
function fakeErrorFetch(
  status: number,
  statusText: string,
  responseBody = '',
  captured: CapturedRequest[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    }
    captured.push({ url: String(input), body });

    return new Response(responseBody, {
      status,
      statusText,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicEndTurnChunks(): string[] {
  return [
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

describe('OpenAI-compatible client', () => {
  it('normalizes text chunks, usage, and stop reason "end"', async () => {
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
    expect(captured[0]?.url).toBe('https://api.openai.test/v1/chat/completions');
    expect(JSON.stringify(events)).not.toContain('secret-openai-key');
  });

  it('normalizes tool-call deltas and emits a completed tool-call', async () => {
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
        sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"books"}' } }] } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sseData('[DONE]'),
      ]),
    });

    const events = await drain(client, baseInput, [lookupTool]);

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
  });

  it('maps finish_reason "length" to stopReason "max_tokens"', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([
        sseData({ choices: [{ delta: { content: 'cut' } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'length' }] }),
        sseData('[DONE]'),
      ]),
    });

    const events = await drain(client, baseInput, noTools);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'max_tokens' });
  });

  it('sends the resolved wire model id (input.model overrides entry.id)', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')], captured),
    });

    await drain(client, { ...baseInput, model: 'gpt-4.1-mini' }, noTools);
    expect(captured[0]?.body?.model).toBe('gpt-4.1-mini');
  });
});

describe('OpenRouter no-train routing', () => {
  it('sets provider.data_collection="deny" with allow_fallbacks and NO "only" allowlist', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openRouterEntry(), {
      provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
      env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
      fetchImpl: fakeFetch(
        [
          sseData({ choices: [{ delta: { content: 'ok' } }] }),
          sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sseData('[DONE]'),
        ],
        captured,
      ),
    });

    const events = await drain(client, baseInput, noTools);
    const provider = asObject(captured[0]?.body?.provider);

    expect(provider).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(provider.data_collection).toBe('deny');
    expect(provider.allow_fallbacks).toBe(true);
    expect(Object.hasOwn(provider, 'only')).toBe(false);
    expect(captured[0]?.body?.model).toBe('anthropic/claude-sonnet-4');
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-openrouter-key');
  });

  it('openai provider does NOT add a provider routing block', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')], captured),
    });

    await drain(client, baseInput, noTools);
    expect(captured[0]?.body?.provider).toBeUndefined();
  });
});

describe('Anthropic client', () => {
  it('normalizes text, thinking, usage, and stop reason "end"', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        // Anthropic carries a NON-ZERO output_tokens at message_start. The adapter
        // must NOT propagate it (the reducer is additive and message_delta reports
        // the cumulative output again) — it emits input here, output 0.
        sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 2 } } }),
        sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'because' },
        }),
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'reasoning-delta', id: 'turn-1', delta: 'because' });
    // message_start emits output 0 (NOT the non-zero 2 it carried) to avoid double-count.
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 0 });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 0, tokensOut: 4 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-anthropic-key');
  });

  it('output double-count regression: non-zero message_start output is counted once (accumulated == message_delta value)', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 3 } } }),
        sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }),
        // Cumulative output at message_delta, larger than the message_start value.
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });

    const events = await drain(client, baseInput, noTools);

    // Sum the emitted usage events the way the additive reducer would.
    const usageEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage',
    );
    const totalOut = usageEvents.reduce((sum, event) => sum + event.tokensOut, 0);
    const totalIn = usageEvents.reduce((sum, event) => sum + event.tokensIn, 0);
    // Output counted ONCE: equals the message_delta cumulative (25), not 3 + 25.
    expect(totalOut).toBe(25);
    expect(totalIn).toBe(12);
  });

  it('normalizes tool-use deltas and emits a completed tool-call', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-1', name: 'lookup', input: {} },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q"' },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: ':"music"}' },
        }),
        sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });

    const events = await drain(client, baseInput, [lookupTool]);

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
  });

  it('posts to /v1/messages and emits systemPrompt as a cache-marked system block', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(client, { ...baseInput, systemPrompt: 'be terse' }, noTools);
    expect(captured[0]?.url).toBe('https://api.anthropic.test/v1/messages');
    // body.system is now a structured block array carrying the cache breakpoint,
    // not a bare string — only the array form can hold cache_control.
    expect(captured[0]?.body?.system).toEqual([
      { type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('keeps the cached system prefix byte-identical when volatile system transcript content changes', async () => {
    // The actual regression: a NEW role:'system' message appended to the transcript
    // must NOT mutate body.system (which would bust the server-side prompt cache).
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([...anthropicEndTurnChunks(), ...anthropicEndTurnChunks()], captured),
    });

    await drain(client, { ...baseInput, systemPrompt: 'stable instructions' }, noTools);
    await drain(
      client,
      {
        id: 'turn-2',
        systemPrompt: 'stable instructions',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: 'volatile injection' },
        ],
      },
      noTools,
    );

    const firstSystem = captured[0]?.body?.system;
    const secondSystem = captured[1]?.body?.system;
    expect(firstSystem).toEqual([
      { type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral' } },
    ]);
    expect(JSON.stringify(firstSystem)).toBe(JSON.stringify(secondSystem));
  });

  it('maps system transcript messages to user-role messages without adding them to body.system', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(
      client,
      {
        id: 'turn-with-system-message',
        systemPrompt: 'stable prefix',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'system', content: 'volatile transcript note' },
          { role: 'user', content: 'continue' },
        ],
      },
      noTools,
    );

    expect(captured[0]?.body?.system).toEqual([
      { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
    ]);
    expect(JSON.stringify(captured[0]?.body?.system)).not.toContain('volatile transcript note');
    expect(captured[0]?.body?.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'volatile transcript note' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('omits body.system when systemPrompt is undefined or empty', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([...anthropicEndTurnChunks(), ...anthropicEndTurnChunks()], captured),
    });

    await drain(client, baseInput, noTools);
    await drain(client, { ...baseInput, systemPrompt: '' }, noTools);

    expect(Object.hasOwn(captured[0]?.body ?? {}, 'system')).toBe(false);
    expect(Object.hasOwn(captured[1]?.body ?? {}, 'system')).toBe(false);
  });
});

describe('credential handling', () => {
  it('yields exactly one error event naming the env var when the key is missing', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: {},
      fetchImpl: fakeFetch([sseData('[DONE]')]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events).toEqual([{ type: 'error', message: 'missing API key for openai (OPENAI_TEST_KEY)' }]);
    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
  });

  it('Anthropic missing key names the env var and never the value', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: {},
      fetchImpl: fakeFetch([]),
    });

    const events = await drain(client, baseInput, noTools);
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt.type !== 'error') {
      throw new Error('expected an error event');
    }
    expect(evt.message).toContain('ANTHROPIC_TEST_KEY');
    expect(evt.message).not.toContain('secret');
  });
});

describe('abort handling', () => {
  it('OpenAI: returns promptly for a pre-aborted signal (only "aborted", never "error")', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([sseData('[DONE]')]),
    });

    const events = await drain(client, baseInput, noTools, controller.signal);
    expect(events).toEqual([{ type: 'aborted' }]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('Anthropic: returns promptly for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([]),
    });

    const events = await drain(client, baseInput, noTools, controller.signal);
    expect(events).toEqual([{ type: 'aborted' }]);
  });
});

describe('registry', () => {
  it('throws on an unknown provider id', () => {
    const entry: ModelEntry = { id: 'x', provider: 'mystery', label: 'X', contextWindow: 1 };
    expect(() => createModelClient(entry)).toThrow('unknown provider: mystery');
  });

  it('the API key never appears in any emitted event (OpenAI + Anthropic)', async () => {
    const openaiClient = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'sk-secret-openai-12345' },
      fetchImpl: fakeFetch([
        sseData({ choices: [{ delta: { content: 'hi' } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        sseData('[DONE]'),
      ]),
    });
    const openaiEvents = await drain(openaiClient, baseInput, noTools);
    expect(JSON.stringify(openaiEvents)).not.toContain('sk-secret-openai-12345');

    const anthropicClient = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'ant-secret-67890' },
      fetchImpl: fakeFetch([
        sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });
    const anthropicEvents = await drain(anthropicClient, baseInput, noTools);
    expect(JSON.stringify(anthropicEvents)).not.toContain('ant-secret-67890');
  });
});

describe('OpenRouter no-train routing is identity-keyed, not URL-keyed (privacy regression)', () => {
  it('keeps provider.data_collection="deny" when base URL has a trailing slash', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openRouterEntry(), {
      // Non-canonical: trailing slash. normalizeBaseUrl must not change routing.
      provider: { baseUrl: 'https://openrouter.ai/api/v1/', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
      env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
      fetchImpl: fakeFetch(
        [sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')],
        captured,
      ),
    });

    await drain(client, baseInput, noTools);

    // The body the adapter actually POSTed to the fake fetch.
    const provider = asObject(captured[0]?.body?.provider);
    expect(provider).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(Object.hasOwn(provider, 'only')).toBe(false);
    // Trailing slash collapsed, but the path is still correct.
    expect(captured[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('keeps provider.data_collection="deny" through a custom proxy base URL', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openRouterEntry(), {
      // Custom proxy base URL (and a trailing slash for good measure): a URL the
      // canonical-host check would have missed. Identity keying must still fire.
      provider: { baseUrl: 'https://my-proxy.internal.test/openrouter/', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
      env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
      fetchImpl: fakeFetch(
        [sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')],
        captured,
      ),
    });

    await drain(client, baseInput, noTools);

    const provider = asObject(captured[0]?.body?.provider);
    expect(provider).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(Object.hasOwn(provider, 'only')).toBe(false);
    expect(captured[0]?.url).toBe('https://my-proxy.internal.test/openrouter/chat/completions');
    expect(captured[0]?.body?.model).toBe('anthropic/claude-sonnet-4');
  });

  it('openai provider sends NO provider block even when pointed at a custom base URL', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openAIEntry(), {
      // Even at a non-default base URL, a non-openrouter entry must not route.
      provider: { baseUrl: 'https://my-proxy.internal.test/openai/', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch(
        [sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')],
        captured,
      ),
    });

    await drain(client, baseInput, noTools);
    expect(captured[0]?.body?.provider).toBeUndefined();
    expect(Object.hasOwn(captured[0]?.body ?? {}, 'provider')).toBe(false);
  });
});

describe('effort-consumption seam: input.effort is LOAD-BEARING per backend', () => {
  // applyEffort is now real: each backend maps input.effort into the correct
  // request-body field. These tests assert that mapping for every effort level,
  // and that the raw effort value never leaks as a top-level body key. Removing
  // the applyEffort call (or reverting it to a no-op) turns these RED — exactly
  // the regression tripwire we want now that the hook is load-bearing.

  const openaiChunks = [sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }), sseData('[DONE]')];
  const anthropicChunks = [
    sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ];
  // DEFAULT_MAX_TOKENS in anthropicClient.ts; high/xhigh must rise above it.
  const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

  async function captureBody(
    entry: ModelEntry,
    providerDeps: { provider: { baseUrl: string; apiKeyEnv: string }; env: Record<string, string> },
    chunks: string[],
    effort: TurnInput['effort'],
  ): Promise<Record<string, unknown> | undefined> {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(entry, {
      provider: providerDeps.provider,
      env: providerDeps.env,
      fetchImpl: fakeFetch(chunks, captured),
    });
    await drain(client, { ...baseInput, effort }, noTools);
    return captured[0]?.body;
  }

  const openaiDeps = {
    provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
    env: { OPENAI_TEST_KEY: 'secret-openai-key' },
  };
  const openrouterDeps = {
    provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
    env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
  };
  const anthropicDeps = {
    provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
    env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
  };

  it('OpenAI: each effort level sets reasoning_effort to that level (and no top-level effort/mode key)', async () => {
    for (const level of ['medium', 'high', 'xhigh'] as const) {
      const body = await captureBody(openAIEntry(), openaiDeps, openaiChunks, level);
      expect(body?.reasoning_effort).toBe(level);
      // The raw effort value must never leak as a top-level effort/mode key.
      expect(Object.hasOwn(body ?? {}, 'effort')).toBe(false);
      expect(Object.hasOwn(body ?? {}, 'mode')).toBe(false);
    }
  });

  it('OpenAI: undefined effort sends no reasoning_effort (model default)', async () => {
    const body = await captureBody(openAIEntry(), openaiDeps, openaiChunks, undefined);
    expect(Object.hasOwn(body ?? {}, 'reasoning_effort')).toBe(false);
  });

  it('OpenRouter: each effort level sets reasoning.effort AND preserves the no-train provider block', async () => {
    for (const level of ['medium', 'high', 'xhigh'] as const) {
      const body = await captureBody(openRouterEntry(), openrouterDeps, openaiChunks, level);
      expect(asObject(body?.reasoning)).toEqual({ effort: level });
      // Regression: effort must NOT clobber the no-train provider block.
      expect(asObject(body?.provider)).toEqual({ data_collection: 'deny', allow_fallbacks: true });
      // OpenRouter uses reasoning.effort, NOT the OpenAI-style flat key.
      expect(Object.hasOwn(body ?? {}, 'reasoning_effort')).toBe(false);
      expect(Object.hasOwn(body ?? {}, 'effort')).toBe(false);
      expect(Object.hasOwn(body ?? {}, 'mode')).toBe(false);
    }
  });

  it('Anthropic: high/xhigh set adaptive thinking + output_config.effort AND raise max_tokens above the 4096 default', async () => {
    for (const level of ['high', 'xhigh'] as const) {
      const body = await captureBody(anthropicEntry(), anthropicDeps, anthropicChunks, level);
      expect(body?.thinking).toEqual({ type: 'adaptive' });
      expect(asObject(body?.output_config)).toEqual({ effort: level });
      // max_tokens must rise so high/xhigh reasoning does not truncate.
      const maxTokens = body?.max_tokens;
      expect(typeof maxTokens).toBe('number');
      expect(maxTokens as number).toBeGreaterThan(ANTHROPIC_DEFAULT_MAX_TOKENS);
      // Current-gen model: legacy budget_tokens must NOT be sent (would 400).
      expect(Object.hasOwn(body ?? {}, 'budget_tokens')).toBe(false);
      const thinking = asObject(body?.thinking);
      expect(Object.hasOwn(thinking, 'budget_tokens')).toBe(false);
      // The raw effort value must never leak as a top-level effort/mode key.
      expect(Object.hasOwn(body ?? {}, 'effort')).toBe(false);
      expect(Object.hasOwn(body ?? {}, 'mode')).toBe(false);
    }
  });

  it('Anthropic: medium sets adaptive thinking + output_config.effort and keeps the 4096 default max_tokens', async () => {
    const body = await captureBody(anthropicEntry(), anthropicDeps, anthropicChunks, 'medium');
    expect(body?.thinking).toEqual({ type: 'adaptive' });
    expect(asObject(body?.output_config)).toEqual({ effort: 'medium' });
    // medium has no truncation pressure, so the default ceiling is retained.
    expect(body?.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
  });

  it('Anthropic: undefined effort sends no thinking/output_config and keeps the default body', async () => {
    const body = await captureBody(anthropicEntry(), anthropicDeps, anthropicChunks, undefined);
    expect(Object.hasOwn(body ?? {}, 'thinking')).toBe(false);
    expect(Object.hasOwn(body ?? {}, 'output_config')).toBe(false);
    expect(body?.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
  });
});

describe('error-status robustness', () => {
  it('OpenAI: a 500 yields one error + assistant-done(error), no assistant-start', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeErrorFetch(500, 'Internal Server Error'),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    // No raw provider object leaks: only normalized AgentEvent shapes appear.
    for (const event of events) {
      expect(Object.hasOwn(event, 'choices')).toBe(false);
      expect(Object.hasOwn(event, 'provider')).toBe(false);
    }
  });

  it('OpenAI: a 429 with a token-like body never leaks the secret-shaped string', async () => {
    const leakyBody = JSON.stringify({ error: { message: 'rate limited', key: 'sk-leak-should-never-surface-99999' } });
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeErrorFetch(429, 'Too Many Requests', leakyBody),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-leak-should-never-surface-99999');
    expect(serialized).not.toContain('secret-openai-key');
  });

  it('Anthropic: a 503 yields one error + assistant-done(error), no assistant-start', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeErrorFetch(503, 'Service Unavailable'),
    });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});

describe('garbage SSE and malformed tool-args robustness', () => {
  it('OpenAI: a non-JSON data line is skipped and the stream still terminates normally', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([
        sseData('this is not json at all {{{'),
        sseData({ choices: [{ delta: { content: 'ok' } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        sseData('[DONE]'),
      ]),
    });

    const events = await drain(client, baseInput, noTools);

    // Garbage swallowed; valid chunk still produced its delta; clean terminal.
    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'ok' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('OpenAI: malformed accumulated tool args degrade to an error, never an unhandled throw', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeFetch([
        sseData({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-broken', type: 'function', function: { name: 'lookup', arguments: '{"q": ' } },
                ],
              },
            },
          ],
        }),
        // Args never close to valid JSON -> JSON.parse throws inside streamTurn.
        sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'not-json' } }] } }] }),
        sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        sseData('[DONE]'),
      ]),
    });

    // Must not throw out of streamTurn; it degrades to a normalized error.
    const events = await drain(client, baseInput, [lookupTool]);

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'tool-call')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });

  it('Anthropic: malformed accumulated tool args degrade to an error, never an unhandled throw', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-broken', name: 'lookup', input: {} },
        }),
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'not-json-at-all' },
        }),
        // content_block_stop triggers parseToolArgs -> JSON.parse throws.
        sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });

    const events = await drain(client, baseInput, [lookupTool]);

    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'tool-call')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});
