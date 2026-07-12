// tests/openrouter.e2e.test.ts
// Opt-in, real-network end-to-end test for the OpenRouter provider. Skipped by
// default — it only runs when OPENROUTER_API_KEY is present in the environment,
// mirroring the JUNO_BRAIN_E2E gating idiom in brainMcp.integration.test.ts.
//
// WHY GATED: the openaiCompatClient openrouter path can only be validated
// hermetically up to the request-body shape (see modelClients.fake.test.ts).
// The real wire — whether the catalogued model slugs resolve on OpenRouter and
// whether the response streams the assistant-start → text → usage →
// assistant-done(end) shape juno expects — is not exercisable without a live
// key. This suite closes that gap on demand. It makes ~2 PAID calls (one per
// model) when it runs, so it stays off in the default hermetic suite.
//
// Run live with:
//   OPENROUTER_API_KEY=<key> npx vitest run tests/openrouter.e2e.test.ts
// Expect ~2 paid calls (z-ai/glm-5.2, qwen/qwen3-coder).
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/core/events';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { createModelClient } from '../src/providers/index';

/** Live only when a real key is present. Absent key ⇒ the whole block is skipped. */
const OR_E2E = (process.env.OPENROUTER_API_KEY ?? '').length > 0;

/** The two OpenRouter catalog entries this wave exercises live. */
const MODEL_IDS = ['z-ai/glm-5.2', 'qwen/qwen3-coder'] as const;

const noTools: ToolSpec[] = [];

/** Same drain idiom as modelClients.fake.test.ts: collect the full event stream. */
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

describe.runIf(OR_E2E)('openrouter live (opt-in, OPENROUTER_API_KEY)', () => {
  // Build the real catalog and resolve each entry the way the app does. No deps
  // overrides on createModelClient ⇒ the adapter uses the real global fetch and
  // reads OPENROUTER_API_KEY straight from process.env.
  const catalog = createModelCatalog(BUILTIN_MODELS);

  for (const id of MODEL_IDS) {
    it(
      `streams a clean end-turn from ${id} over the real OpenRouter wire`,
      async () => {
        const entry = catalog.resolve(id);
        if (entry === undefined) {
          throw new Error(`catalog is missing the expected openrouter entry: ${id}`);
        }
        expect(entry.provider).toBe('openrouter');

        const client = createModelClient(entry);
        const input: TurnInput = {
          id: `or-e2e-${id}`,
          messages: [{ role: 'user', content: 'reply with the single word ok' }],
        };

        const events = await drain(client, input, noTools);

        // No error surfaced on the real wire.
        const errors = events.filter((event) => event.type === 'error');
        expect(errors, JSON.stringify(errors)).toEqual([]);

        // The normalized turn envelope: assistant-start first, a clean end-turn last.
        expect(events[0]).toEqual({ type: 'assistant-start', id: input.id });
        expect(events.at(-1)).toEqual({
          type: 'assistant-done',
          id: input.id,
          stopReason: 'end',
        });

        // A usage event with real token counts came back.
        const usage = events.filter(
          (event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage',
        );
        expect(usage.length).toBeGreaterThan(0);
        const totalTokens = usage.reduce((sum, event) => sum + event.tokensIn + event.tokensOut, 0);
        expect(totalTokens).toBeGreaterThan(0);
      },
      60_000,
    );
  }
});
