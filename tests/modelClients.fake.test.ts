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

/**
 * One scripted fetch outcome: either a Response spec (status + optional
 * statusText/headers + SSE `chunks` for the streamed body) or an Error to throw
 * (simulating a network fault).
 */
type FetchStep =
  | { status: number; statusText?: string; headers?: Record<string, string>; chunks?: string[] }
  | Error;

/**
 * Fetch that returns each `steps` outcome on successive calls (the last step
 * repeats if called more often), capturing every request. Errors are thrown; specs
 * become a streaming Response so retryFetch can drain a non-ok body and the client
 * can parse a 200's SSE. Drives the retry/backoff cases deterministically.
 */
function sequencedFetch(steps: FetchStep[], captured: CapturedRequest[] = []): typeof fetch {
  let call = 0;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      const parsed: unknown = JSON.parse(init.body);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    }
    captured.push({ url: String(input), body });

    const step = steps[call] ?? steps[steps.length - 1];
    call += 1;

    if (step instanceof Error) {
      throw step;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of step.chunks ?? []) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: step.status,
      statusText: step.statusText ?? '',
      headers: { 'content-type': 'text/event-stream', ...(step.headers ?? {}) },
    });
  }) as typeof fetch;
}

/**
 * A deterministic backoff clock: fires the scheduled callback SYNCHRONOUSLY (no real
 * sleep) and records every delay it was asked to wait, so a test can both drive the
 * retry loop instantly and assert the exact backoff/Retry-After values scheduled.
 */
/** A backoff timer that fires immediately and records nothing — for cases that
 * exercise the retry path but don't assert delays (e.g. exhaustion-terminal). */
const immediateTimer = (fn: () => void, _ms: number): { clear: () => void } => {
  fn();
  return { clear: (): void => {} };
};

function syncTimer(): { setTimer: (fn: () => void, ms: number) => { clear: () => void }; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    setTimer: (fn: () => void, ms: number): { clear: () => void } => {
      delays.push(ms);
      fn();
      return { clear: (): void => {} };
    },
  };
}

/** A minimal well-formed Anthropic success stream: a text delta then end_turn. */
function anthropicHelloChunks(): string[] {
  return [
    sseEvent('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
    sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
    ...anthropicEndTurnChunks(),
  ];
}

/** A minimal well-formed OpenAI success stream: a content delta then finish. */
function openAIOkChunks(): string[] {
  return [
    sseData({ choices: [{ delta: { content: 'ok' } }] }),
    sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sseData('[DONE]'),
  ];
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

describe('OpenRouter tool-call round-trip (offline contract)', () => {
  // Provider deps for the OpenRouter (openai-compat, isOpenRouter=true) path.
  const openrouterDeps = {
    provider: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_TEST_KEY' },
    env: { OPENROUTER_TEST_KEY: 'secret-openrouter-key' },
  };

  // The response-side tool_calls stream shared by both legs: two arg-fragment
  // deltas that accumulate to {"q":"books"}, then a tool_calls finish. Mirrors the
  // OPENAI response-parse fixture (see 'normalizes tool-call deltas ...') but on
  // the OpenRouter entry so the openai-compat openrouter path is exercised.
  const toolCallStreamChunks = [
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
  ];

  it('streams tool-call deltas and emits a completed tool-call (stopReason tool_use)', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openRouterEntry(), {
      ...openrouterDeps,
      fetchImpl: fakeFetch(toolCallStreamChunks, captured),
    });

    const events = await drain(client, baseInput, [lookupTool]);

    // Two arg-fragment deltas, correlated to the streamed tool-call id.
    expect(events.filter((event) => event.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', toolCallId: 'call-1', argsDelta: '{"q"' },
      { type: 'tool-call-delta', toolCallId: 'call-1', argsDelta: ':"books"}' },
    ]);
    // The completed tool-call with the accumulated, parsed args.
    expect(events).toContainEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'call-1',
      name: 'lookup',
      args: { q: 'books' },
    });
    // A tool_calls finish maps to stopReason 'tool_use'.
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'tool_use' });

    // The no-train provider block rides the tool request too (unconditional for OpenRouter).
    expect(asObject(captured[0]?.body?.provider)).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(JSON.stringify(events)).not.toContain('secret-openrouter-key');
  });

  it('serializes assistant.toolCalls + tool result on the follow-up request and completes', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(openRouterEntry(), {
      ...openrouterDeps,
      fetchImpl: sequencedFetch(
        [
          // Leg 1: the model elects to call `lookup`.
          { status: 200, chunks: toolCallStreamChunks },
          // Leg 2: given the tool result, the model produces text and ends the turn.
          {
            status: 200,
            chunks: [
              sseData({ choices: [{ delta: { content: 'done' } }] }),
              sseData({
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 1 },
              }),
              sseData('[DONE]'),
            ],
          },
        ],
        captured,
      ),
    });

    // Leg 1: capture the emitted tool-call so leg 2 can echo it back verbatim.
    const leg1 = await drain(client, baseInput, [lookupTool]);
    expect(leg1.find((event) => event.type === 'tool-call')).toEqual({
      type: 'tool-call',
      id: 'turn-1',
      toolCallId: 'call-1',
      name: 'lookup',
      args: { q: 'books' },
    });

    // Leg 2: re-enter the assistant's tool call plus the tool result. This is the
    // REQUEST-serialization leg the offline suite had never exercised for openai-compat.
    const leg2 = await drain(
      client,
      {
        id: 'turn-2',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: '', toolCalls: [{ toolCallId: 'call-1', name: 'lookup', args: { q: 'books' } }] },
          { role: 'tool', toolCallId: 'call-1', content: '["a","b"]' },
        ],
      },
      [lookupTool],
    );

    // The follow-up streams the text delta and a clean end-turn.
    expect(leg2).toContainEqual({ type: 'text-delta', id: 'turn-2', delta: 'done' });
    expect(leg2.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-2', stopReason: 'end' });

    // The serialized follow-up request carries the assistant tool_calls[] (args
    // JSON.stringify'd) and the role:'tool' result, per toOpenAIMessage.
    const leg2Messages = captured[1]?.body?.messages as unknown[] | undefined;
    expect(leg2Messages).toContainEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"books"}' } }],
    });
    expect(leg2Messages).toContainEqual({ role: 'tool', tool_call_id: 'call-1', content: '["a","b"]' });

    // No-train rides leg 2 as well.
    expect(asObject(captured[1]?.body?.provider)).toEqual({ data_collection: 'deny', allow_fallbacks: true });
    expect(JSON.stringify(leg2)).not.toContain('secret-openrouter-key');
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
    // message_start emits output 0 (NOT the non-zero 2 it carried) to avoid double-count,
    // plus `contextTokens` (full window: input + cache; no cache here → == input_tokens).
    expect(events).toContainEqual({ type: 'usage', tokensIn: 9, tokensOut: 0, contextTokens: 9 });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 0, tokensOut: 4 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(JSON.stringify(events)).not.toContain('secret-anthropic-key');
  });

  it('contextTokens sums input + cache-read + cache-creation (the live window, not just billable input)', async () => {
    // With prompt caching, `input_tokens` is only the uncached slice. The context-window
    // monitor needs the FULL occupancy, so the adapter folds the cache fields in.
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([
        sseEvent('message_start', {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 1_000,
              cache_read_input_tokens: 140_000,
              cache_creation_input_tokens: 5_000,
              output_tokens: 0,
            },
          },
        }),
        sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
        sseEvent('message_stop', { type: 'message_stop' }),
      ]),
    });

    const events = await drain(client, baseInput, noTools);

    // Billable input is unchanged (cost meter), but contextTokens reflects the full window.
    expect(events).toContainEqual({
      type: 'usage',
      tokensIn: 1_000,
      tokensOut: 0,
      contextTokens: 146_000, // 1_000 + 140_000 + 5_000
    });
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
    // The system transcript entry lands in the user-role channel (not body.system),
    // but the three resulting consecutive user-role entries are merged into ONE
    // user message so the wire stays strictly user/assistant-alternating — the
    // Anthropic Messages API returns 400 on consecutive same-role entries.
    expect(captured[0]?.body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'volatile transcript note' },
          // §3c: the LAST block of the LAST (here: only) merged message carries the
          // trailing cache breakpoint. Earlier blocks do NOT.
          { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('keeps wire roles alternating: assistant breaks the user run; tool-result blocks merge', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(
      client,
      {
        id: 'alternation-turn',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          // Post-error / post-compaction shape: a system entry followed by a tool
          // result and a user submission — three consecutive user-role wire entries
          // that must collapse into one.
          { role: 'system', content: 'note' },
          { role: 'tool', toolCallId: 'call-1', content: 'tool output' },
          { role: 'user', content: 'second' },
        ],
      },
      noTools,
    );

    expect(captured[0]?.body?.messages).toEqual([
      // Lone user entry passes through unmerged — content stays a string (it is NOT
      // the last entry, so §3c does not touch it).
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'note' },
          { type: 'tool_result', tool_use_id: 'call-1', content: 'tool output' },
          // §3c: trailing breakpoint on the final block of the final entry only.
          { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
        ],
      },
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

  it('marks the last content block of the final merged message with an ephemeral cache breakpoint', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(
      client,
      {
        id: 'merged-trailing-user-run',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'system', content: 'note' },
          { role: 'tool', toolCallId: 'call-1', content: 'tool output' },
          { role: 'user', content: 'second' },
        ],
      },
      noTools,
    );

    const messages = captured[0]?.body?.messages;
    if (!Array.isArray(messages)) {
      throw new Error('expected messages array');
    }
    const lastMessage = asObject(messages[messages.length - 1]);
    const content = lastMessage.content;
    if (!Array.isArray(content)) {
      throw new Error('expected trailing content array');
    }

    // Earlier blocks of the final entry stay unmarked; only the final block gains it.
    expect(content.slice(0, -1)).toEqual([
      { type: 'text', text: 'note' },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'tool output' },
    ]);
    expect(content[content.length - 1]).toEqual({
      type: 'text',
      text: 'second',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('normalizes a trailing string-content message into a marked text block', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(client, { id: 'string-trailing-message', messages: [{ role: 'user', content: 'only' }] }, noTools);

    // A lone string-content entry is normalized into a single marked text block —
    // a bare string cannot carry a per-block cache_control marker.
    expect(captured[0]?.body?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'only', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('normalizes a trailing lone empty-string message to [] with no marker', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(client, { id: 'empty-string-trailing-message', messages: [{ role: 'user', content: '' }] }, noTools);

    // §3c edge: a final lone empty-string entry has no block to mark (a marked
    // empty text block would 400). It is normalized to the SAME `content: []`
    // shape as a trailing empty assistant turn — not left as a bare '' string —
    // and emits NO trailing breakpoint.
    const messages = captured[0]?.body?.messages;
    expect(messages).toEqual([{ role: 'user', content: [] }]);
    expect((JSON.stringify(messages ?? null).match(/"cache_control"/g) ?? []).length).toBe(0);
  });

  it('does not mark the system prefix', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(client, { ...baseInput, systemPrompt: 'stable prompt' }, noTools);

    // §3a regression guard: the system block keeps its OWN single ephemeral marker,
    // unaffected by the §3c trailing-message breakpoint.
    expect(captured[0]?.body?.system).toEqual([
      { type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves a trailing assistant entry with empty content unmarked (no crash)', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(
      client,
      {
        id: 'empty-assistant-trailing-message',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '' },
        ],
      },
      noTools,
    );

    // A trailing assistant turn with no text/toolCalls maps to content: [] — there
    // is no block to mark, so §3c is a no-op and the request still posts.
    expect(captured).toHaveLength(1);
    const messages = captured[0]?.body?.messages;
    if (!Array.isArray(messages)) {
      throw new Error('expected messages array');
    }
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: [] });
  });

  it('applies exactly one trailing breakpoint', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch(anthropicEndTurnChunks(), captured),
    });

    await drain(
      client,
      {
        id: 'one-trailing-breakpoint',
        systemPrompt: 'stable prefix',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'system', content: 'note' },
          { role: 'tool', toolCallId: 'call-1', content: 'tool output' },
          { role: 'user', content: 'second' },
        ],
      },
      noTools,
    );

    const body = captured[0]?.body;
    // Exactly one breakpoint in messages (the trailing marker — no interior/double
    // marking), plus one in the system block = two total in the body.
    expect((JSON.stringify(body?.messages ?? null).match(/"cache_control"/g) ?? []).length).toBe(1);
    expect((JSON.stringify(body ?? null).match(/"cache_control"/g) ?? []).length).toBe(2);
  });

  it('trailing marker moves with the conversation (volatile by design)', async () => {
    const captured: CapturedRequest[] = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeFetch([...anthropicEndTurnChunks(), ...anthropicEndTurnChunks()], captured),
    });

    await drain(client, { id: 'turn-1', messages: [{ role: 'user', content: 'first' }] }, noTools);
    await drain(
      client,
      {
        id: 'turn-2',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
      },
      noTools,
    );

    expect(captured).toHaveLength(2);

    const secondMessages = captured[1]?.body?.messages;
    if (!Array.isArray(secondMessages)) {
      throw new Error('expected messages array');
    }
    // Turn 2's marker is on turn 2's LAST entry, not turn 1's first entry — the
    // breakpoint moves with the conversation (incremental cache pattern).
    expect(secondMessages[0]).toEqual({ role: 'user', content: 'first' });
    const lastMessage = asObject(secondMessages[secondMessages.length - 1]);
    expect(lastMessage).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }],
    });
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

    // Message string BYTE-IDENTICAL; the additive `envelope` classifies it as `auth`.
    expect(events).toEqual([
      { type: 'error', message: 'missing API key for openai (OPENAI_TEST_KEY)', envelope: { kind: 'auth', retryable: false } },
    ]);
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
    expect(evt.envelope).toEqual({ kind: 'auth', retryable: false });
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

  it('Anthropic: an abort DURING a backoff sleep yields only "aborted" and issues no further fetch', async () => {
    const controller = new AbortController();
    const captured: CapturedRequest[] = [];
    // A scheduler that, instead of firing the timer, lands the abort mid-wait — the
    // abortable sleep must resolve at once and the next loop iteration must surface
    // the abort BEFORE any second fetch. The 200 second step must never be reached.
    const abortDuringBackoff = (_fn: () => void, _ms: number): { clear: () => void } => {
      controller.abort();
      return { clear: (): void => {} };
    };
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch(
        [
          { status: 503, statusText: 'Service Unavailable' },
          { status: 200, chunks: anthropicHelloChunks() },
        ],
        captured,
      ),
      retry: { setTimer: abortDuringBackoff },
    });

    const events = await drain(client, baseInput, noTools, controller.signal);

    expect(events).toEqual([{ type: 'aborted' }]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    // only the first (503) fetch happened; the abort blocked the retry fetch
    expect(captured).toHaveLength(1);
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
      // 500 is retryable — drive the default retry budget instantly (no real sleep)
      // and assert exhaustion still lands on a single terminal error.
      retry: { setTimer: immediateTimer },
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
      retry: { setTimer: immediateTimer },
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
      retry: { setTimer: immediateTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});

/**
 * Wave 14 (a5-error-envelope): the normalized `envelope` rides the SAME error event.
 * Every assertion pins the `message` string BYTE-IDENTICAL to today (regression
 * contract) and additionally checks the new `envelope` classification.
 */
function errorEnvelopeOf(events: AgentEvent[]): { kind: string; retryable: boolean; stderrTail?: string } {
  const err = events.find((e) => e.type === 'error');
  if (err === undefined || err.type !== 'error' || err.envelope === undefined) {
    throw new Error('expected an error event carrying an envelope');
  }
  return err.envelope;
}

function errorMessageOf(events: AgentEvent[]): string {
  const err = events.find((e) => e.type === 'error');
  if (err === undefined || err.type !== 'error') {
    throw new Error('expected an error event');
  }
  return err.message;
}

describe('error envelope classification (message byte-identity preserved)', () => {
  it('OpenAI: a 429 → envelope rate-limit(retryable); message unchanged', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeErrorFetch(429, 'Too Many Requests'),
      retry: { setTimer: immediateTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(errorMessageOf(events)).toBe('provider request failed: 429 Too Many Requests');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'rate-limit', retryable: true });
  });

  it('Anthropic: a 429 → envelope rate-limit(retryable); message unchanged', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeErrorFetch(429, 'Too Many Requests'),
      retry: { setTimer: immediateTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(errorMessageOf(events)).toBe('provider request failed: 429 Too Many Requests');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'rate-limit', retryable: true });
  });

  it('OpenAI: a 400 with a context-overflow body → envelope context-overflow; message still the 400 string', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: fakeErrorFetch(400, 'Bad Request', JSON.stringify({ error: { message: 'prompt is too long: 200000 tokens' } })),
    });

    const events = await drain(client, baseInput, noTools);

    // message byte-identical (the body feeds classification ONLY, never the message).
    expect(errorMessageOf(events)).toBe('provider request failed: 400 Bad Request');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'context-overflow', retryable: false });
    // The body text (with the context marker) never leaks into any emitted event.
    expect(JSON.stringify(events)).not.toContain('200000 tokens');
  });

  it('Anthropic: a 400 with a context-overflow body → envelope context-overflow; message still the 400 string', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: fakeErrorFetch(400, 'Bad Request', JSON.stringify({ error: { message: 'input length exceeds the maximum context' } })),
    });

    const events = await drain(client, baseInput, noTools);

    expect(errorMessageOf(events)).toBe('provider request failed: 400 Bad Request');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'context-overflow', retryable: false });
  });

  it('OpenAI: a fetch reject (network throw, retries exhausted) → envelope network; message unchanged', async () => {
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      // A single Error step repeats on every attempt, so retries exhaust and rethrow.
      fetchImpl: sequencedFetch([new TypeError('fetch failed')]),
      retry: { setTimer: immediateTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(errorMessageOf(events)).toBe('fetch failed');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'network', retryable: true });
  });

  it('Anthropic: a fetch reject (network throw, retries exhausted) → envelope network; message unchanged', async () => {
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([new TypeError('fetch failed')]),
      retry: { setTimer: immediateTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(errorMessageOf(events)).toBe('fetch failed');
    expect(errorEnvelopeOf(events)).toEqual({ kind: 'network', retryable: true });
  });
});

describe('retry-with-backoff (pre-first-byte)', () => {
  it('Anthropic: a 503 then 200 retries once, then streams normally (2 fetches)', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch(
        [
          { status: 503, statusText: 'Service Unavailable' },
          { status: 200, chunks: anthropicHelloChunks() },
        ],
        captured,
      ),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hi' });
    expect(events).toContainEqual({ type: 'usage', tokensIn: 5, tokensOut: 0, contextTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    // exactly one backoff, at the default base delay
    expect(timer.delays).toEqual([500]);
  });

  it('OpenAI: a 429 with Retry-After:0 is retried and the header is honored', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch(
        [
          { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } },
          { status: 200, chunks: openAIOkChunks() },
        ],
        captured,
      ),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'ok' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    // Retry-After:0 honored (scheduled with 0, not the computed backoff of 500)
    expect(timer.delays).toEqual([0]);
  });

  it('OpenAI: retries exhausted (500 x4) emits a single error + done(error) after maxRetries+1 fetches', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const fail: FetchStep = { status: 500, statusText: 'Internal Server Error' };
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([fail, fail, fail, fail], captured),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    // 1 initial + 3 retries == maxRetries + 1
    expect(captured).toHaveLength(4);
    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    // three backoffs between the four attempts: 500, 1000, 2000 (base * 2**attempt)
    expect(timer.delays).toEqual([500, 1000, 2000]);
  });

  it('OpenAI: a non-retryable 400 is NOT retried (exactly one fetch, immediate error)', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([{ status: 400, statusText: 'Bad Request' }], captured),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(1);
    expect(events.some((event) => event.type === 'assistant-start')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    expect(timer.delays).toEqual([]);
  });

  it('Anthropic: a network throw then 200 is retried to success', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch(
        [new TypeError('network down'), { status: 200, chunks: anthropicHelloChunks() }],
        captured,
      ),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'Hi' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(timer.delays).toEqual([500]);
  });

  it('OpenAI: a huge Retry-After is clamped to maxDelayMs (not scheduled as 9999s)', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch(
        [
          { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '9999' } },
          { status: 200, chunks: openAIOkChunks() },
        ],
        captured,
      ),
      retry: { maxDelayMs: 8000, setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(2);
    // 9999s would be 9_999_000ms; the clamp caps it at maxDelayMs
    expect(timer.delays).toEqual([8000]);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('happy path: a first-call 200 schedules no retry timer (regression guard)', async () => {
    const captured: CapturedRequest[] = [];
    const timer = syncTimer();
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([{ status: 200, chunks: anthropicHelloChunks() }], captured),
      retry: { setTimer: timer.setTimer },
    });

    const events = await drain(client, baseInput, noTools);

    expect(captured).toHaveLength(1);
    expect(timer.delays).toEqual([]);
    expect(events[0]).toEqual({ type: 'assistant-start', id: 'turn-1' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });
});

describe('retry-with-backoff onRetry observer (wave-13 retry-ui)', () => {
  it('Anthropic: a 503 then 200 invokes onRetry exactly once with (1, 3, 500)', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([
        { status: 503, statusText: 'Service Unavailable' },
        { status: 200, chunks: anthropicHelloChunks() },
      ]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(retries).toEqual([[1, 3, 500]]);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('OpenAI: a 503 then 200 invokes onRetry exactly once with (1, 3, 500)', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([
        { status: 503, statusText: 'Service Unavailable' },
        { status: 200, chunks: openAIOkChunks() },
      ]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    const events = await drain(client, baseInput, noTools);

    expect(retries).toEqual([[1, 3, 500]]);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('Anthropic: a multi-retry (503, 503, 200) invokes onRetry per attempt with monotonic attempt and doubling delay', async () => {
    const retries: Array<[number, number, number]> = [];
    const fail: FetchStep = { status: 503, statusText: 'Service Unavailable' };
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([fail, fail, { status: 200, chunks: anthropicHelloChunks() }]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    const events = await drain(client, baseInput, noTools);

    // attempt monotonic 1,2; delay doubles 500,1000; max constant at the default 3.
    expect(retries).toEqual([
      [1, 3, 500],
      [2, 3, 1000],
    ]);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('OpenAI: a 429 with Retry-After:0 passes the honored delay (0) to onRetry', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([
        { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } },
        { status: 200, chunks: openAIOkChunks() },
      ]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    await drain(client, baseInput, noTools);

    expect(retries).toEqual([[1, 3, 0]]);
  });

  it('OpenAI: a huge Retry-After is clamped, and the clamped delay is what onRetry receives', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([
        { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '9999' } },
        { status: 200, chunks: openAIOkChunks() },
      ]),
      retry: { maxDelayMs: 8000, setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    await drain(client, baseInput, noTools);

    // onRetry sees the SAME clamped value the scheduler does (not 9_999_000ms).
    expect(retries).toEqual([[1, 3, 8000]]);
  });

  it('Anthropic: a first-call 200 NEVER invokes onRetry (regression guard)', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([{ status: 200, chunks: anthropicHelloChunks() }]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    await drain(client, baseInput, noTools);

    expect(retries).toEqual([]);
  });

  it('OpenAI: a non-retryable 400 NEVER invokes onRetry', async () => {
    const retries: Array<[number, number, number]> = [];
    const client = createModelClient(openAIEntry(), {
      provider: { baseUrl: 'https://api.openai.test/v1', apiKeyEnv: 'OPENAI_TEST_KEY' },
      env: { OPENAI_TEST_KEY: 'secret-openai-key' },
      fetchImpl: sequencedFetch([{ status: 400, statusText: 'Bad Request' }]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    await drain(client, baseInput, noTools);

    expect(retries).toEqual([]);
  });

  it('Anthropic: a pre-aborted signal NEVER invokes onRetry', async () => {
    const retries: Array<[number, number, number]> = [];
    const controller = new AbortController();
    controller.abort();
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch([{ status: 200, chunks: anthropicHelloChunks() }]),
      retry: { setTimer: syncTimer().setTimer },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    const events = await drain(client, baseInput, noTools, controller.signal);

    expect(retries).toEqual([]);
    expect(events).toEqual([{ type: 'aborted' }]);
  });

  it('Anthropic: an abort DURING a backoff invokes onRetry only for the attempt already begun and never after abort', async () => {
    const retries: Array<[number, number, number]> = [];
    const captured: CapturedRequest[] = [];
    const controller = new AbortController();
    // Abort mid-wait: onRetry has already fired (it runs BEFORE the sleep), then the
    // abort lands so no second fetch and no second onRetry can occur.
    const abortDuringBackoff = (_fn: () => void, _ms: number): { clear: () => void } => {
      controller.abort();
      return { clear: (): void => {} };
    };
    const client = createModelClient(anthropicEntry(), {
      provider: { baseUrl: 'https://api.anthropic.test', apiKeyEnv: 'ANTHROPIC_TEST_KEY' },
      env: { ANTHROPIC_TEST_KEY: 'secret-anthropic-key' },
      fetchImpl: sequencedFetch(
        [
          { status: 503, statusText: 'Service Unavailable' },
          { status: 200, chunks: anthropicHelloChunks() },
        ],
        captured,
      ),
      retry: { setTimer: abortDuringBackoff },
      onRetry: (attempt, max, delayMs) => retries.push([attempt, max, delayMs]),
    });

    const events = await drain(client, baseInput, noTools, controller.signal);

    // onRetry fired exactly once (the attempt already begun before the abort); never after.
    expect(retries).toEqual([[1, 3, 500]]);
    expect(captured).toHaveLength(1);
    expect(events).toEqual([{ type: 'aborted' }]);
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
