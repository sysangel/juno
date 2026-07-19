// tests/sseIdleGuard.test.ts
// Wave 14 (a5-stream-resilience) Item B + Item C (SSE) — the raw-API inactivity guard.
//
// The anthropic/openai clients previously read their SSE body in a bare loop that
// blocked FOREVER on a zero-byte stall. `readWithIdleTimeout` now races each read
// against an idle timer + abort. These tests drive the REAL clients with an injected
// `fetchImpl` (a controllable ReadableStream) and a manual `setTimer` clock — proving
// the WIRING (a stall surfaces as a retryable `timeout` error event), the happy path
// (no false positive), abort handling, and host-sleep detection (Item C).
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/core/events';
import type { ModelClient, TurnInput } from '../src/core/contracts';
import type { ModelEntry } from '../src/services/catalog';
import { createAnthropicClient } from '../src/providers/anthropicClient';
import { createOpenAICompatClient } from '../src/providers/openaiCompatClient';
import { detectedSleepGap, readWithIdleTimeout, StreamStallError } from '../src/providers/sseIdleGuard';

const anthropicEntry: ModelEntry = {
  id: 'claude-sonnet-4-6',
  provider: 'anthropic',
  label: 'Claude',
  contextWindow: 200_000,
};
const openaiEntry: ModelEntry = {
  id: 'gpt-4.1',
  provider: 'openai',
  label: 'GPT',
  contextWindow: 128_000,
};

const baseInput: TurnInput = { id: 'turn-1', messages: [{ role: 'user', content: 'hi' }] };

/** A ReadableStream whose bytes the test pushes/closes on demand. */
function makeControllable(): {
  body: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    body,
    push: (s: string): void => controller.enqueue(enc.encode(s)),
    close: (): void => controller.close(),
  };
}

/** A minimal ok Response exposing only what the clients read on the success path. */
function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, statusText: 'OK', body, headers: new Headers() } as unknown as Response;
}

// Deterministic fake clock (records callbacks; the test fires one by predicate).
interface FakeTimer {
  ms: number;
  fn: () => void;
  cleared: boolean;
}
function makeClock(): {
  setTimer: (fn: () => void, ms: number) => { clear: () => void };
  fire: (pred: (t: FakeTimer) => boolean) => void;
  pending: () => FakeTimer[];
} {
  const timers: FakeTimer[] = [];
  return {
    setTimer: (fn: () => void, ms: number): { clear: () => void } => {
      const t: FakeTimer = { ms, fn, cleared: false };
      timers.push(t);
      return { clear: (): void => void (t.cleared = true) };
    },
    fire(pred: (t: FakeTimer) => boolean): void {
      const t = timers.find((x) => !x.cleared && pred(x));
      if (t !== undefined) {
        t.cleared = true;
        t.fn();
      }
    },
    pending: (): FakeTimer[] => timers.filter((t) => !t.cleared),
  };
}

/** Drain macrotasks so the client fully parks on the pending read before firing. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wrap a real AbortSignal, counting add/removeEventListener calls while delegating to
 * the underlying signal (so `aborted` + real dispatch still work). Lets a test prove the
 * guard's abort listener is REMOVED on every non-abort exit (no accumulation across the
 * many streamTurn attempts that share one turn-lifetime signal).
 */
function spySignal(real: AbortSignal): { signal: AbortSignal; counts: { added: number; removed: number } } {
  const counts = { added: 0, removed: 0 };
  const fake = {
    get aborted(): boolean {
      return real.aborted;
    },
    addEventListener(...args: Parameters<AbortSignal['addEventListener']>): void {
      counts.added += 1;
      real.addEventListener(...args);
    },
    removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>): void {
      counts.removed += 1;
      real.removeEventListener(...args);
    },
  };
  return { signal: fake as unknown as AbortSignal, counts };
}

async function drain(
  client: ModelClient,
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of client.streamTurn(baseInput, [], signal)) {
    events.push(event);
  }
  return events;
}

const ANTHROPIC_START =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n';
const ANTHROPIC_TEXT =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';
const ANTHROPIC_STOP =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe('sseIdleGuard — anthropic wiring (Item B)', () => {
  it('chunks then a zero-byte stall yields a retryable timeout error + assistant-done(error)', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    ctl.push(ANTHROPIC_START);
    ctl.push(ANTHROPIC_TEXT);

    const client = createAnthropicClient(anthropicEntry, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client);
    await flush(); // consume both chunks, park on the pending read with the idle timer armed
    clock.fire((t) => t.ms === 50);
    const events = await eventsPromise;

    // The text streamed before the stall; then a retryable timeout error surfaces.
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'hi' });
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect((err as { envelope?: { kind: string; retryable: boolean } }).envelope).toEqual({
      kind: 'timeout',
      retryable: true,
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(clock.pending()).toHaveLength(0); // guard timer cleared on the stall exit
  });

  it('a normal stream that keeps arriving and closes never stalls (no false positive)', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    ctl.push(ANTHROPIC_START);
    ctl.push(ANTHROPIC_TEXT);
    ctl.push(ANTHROPIC_STOP);
    ctl.close();

    const client = createAnthropicClient(anthropicEntry, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
    });

    const events = await drain(client);

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'hi' });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
    expect(clock.pending()).toHaveLength(0); // no leaked timers
  });

  it('an abort mid-read yields {aborted}, not a stall error', async () => {
    const clock = makeClock();
    const controller = new AbortController();
    const ctl = makeControllable();
    ctl.push(ANTHROPIC_START);

    const client = createAnthropicClient(anthropicEntry, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client, controller.signal);
    await flush();
    controller.abort();
    const events = await eventsPromise;

    expect(events.some((e) => e.type === 'aborted')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('sseIdleGuard — openai wiring (Item B parity)', () => {
  it('chunks then a stall yields a retryable timeout error + assistant-done(error)', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    ctl.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');

    const client = createOpenAICompatClient(openaiEntry, {
      env: { OPENAI_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
    });

    const eventsPromise = drain(client);
    await flush();
    clock.fire((t) => t.ms === 50);
    const events = await eventsPromise;

    expect(events).toContainEqual({ type: 'text-delta', id: 'turn-1', delta: 'hi' });
    const err = events.find((e) => e.type === 'error');
    expect((err as { envelope?: { kind: string; retryable: boolean } }).envelope).toEqual({
      kind: 'timeout',
      retryable: true,
    });
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'error' });
  });
});

describe('sseIdleGuard — host-sleep detection (Item C)', () => {
  it('a fired idle timer with wall ≫ mono is a suspend: re-armed, stream continues (no stall)', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    let wallMs = 1000;
    let monoNs = 0n;
    ctl.push(ANTHROPIC_START);

    const client = createAnthropicClient(anthropicEntry, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
      now: () => wallMs,
      mono: () => monoNs,
    });

    const eventsPromise = drain(client, new AbortController().signal);
    await flush(); // park on the pending read; lastActivity stamped at wall 1000 / mono 0

    // Simulate a 60s host suspend: wall jumped, monotonic clock barely moved.
    wallMs = 1000 + 60_000;
    monoNs = 100_000_000n; // 100ms
    clock.fire((t) => t.ms === 50); // the idle timer comes due immediately on wake
    await flush();

    // The guard re-armed instead of stalling; finish the stream cleanly.
    ctl.push(ANTHROPIC_STOP);
    ctl.close();
    const events = await eventsPromise;

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'assistant-done', id: 'turn-1', stopReason: 'end' });
  });

  it('a genuine stall (wall ≈ mono) still fires — sleep detection cannot swallow it', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    let wallMs = 1000;
    let monoNs = 0n;
    ctl.push(ANTHROPIC_START);

    const client = createAnthropicClient(anthropicEntry, {
      env: { ANTHROPIC_API_KEY: 'k' },
      fetchImpl: (async () => okResponse(ctl.body)) as unknown as typeof fetch,
      idleTimeoutMs: 50,
      setTimer: clock.setTimer,
      now: () => wallMs,
      mono: () => monoNs,
    });

    const eventsPromise = drain(client, new AbortController().signal);
    await flush();

    // Both clocks advanced together (no suspend) → real stall.
    wallMs = 1000 + 50;
    monoNs = 50_000_000n; // 50ms
    clock.fire((t) => t.ms === 50);
    const events = await eventsPromise;

    const err = events.find((e) => e.type === 'error');
    expect((err as { envelope?: { kind: string; retryable: boolean } }).envelope).toEqual({
      kind: 'timeout',
      retryable: true,
    });
  });
});

describe('detectedSleepGap — shared decision (Item C)', () => {
  it('true only when wall exceeds mono past the threshold', () => {
    expect(detectedSleepGap(60_000, 100)).toBe(true); // 60s suspend
    expect(detectedSleepGap(5_000, 0)).toBe(true); // 5s divergence
    expect(detectedSleepGap(50, 50)).toBe(false); // genuine stall (no divergence)
    expect(detectedSleepGap(4_000, 0)).toBe(false); // exactly the threshold is NOT past it
    expect(detectedSleepGap(100, 0, 50)).toBe(true); // custom threshold
  });
});

describe('readWithIdleTimeout — direct (module API lock)', () => {
  it('throws a StreamStallError when the stream goes silent past the idle window', async () => {
    const clock = makeClock();
    const ctl = makeControllable();
    ctl.push('chunk-1');

    const consume = (async () => {
      const chunks: string[] = [];
      const dec = new TextDecoder();
      for await (const c of readWithIdleTimeout(ctl.body, new AbortController().signal, {
        idleTimeoutMs: 50,
        label: 'anthropic',
        setTimer: clock.setTimer,
      })) {
        chunks.push(dec.decode(c));
      }
      return chunks;
    })();

    await flush();
    clock.fire((t) => t.ms === 50);

    await expect(consume).rejects.toBeInstanceOf(StreamStallError);
  });

  it('drains sequentially against the SAME signal without accumulating listeners', async () => {
    // The turn-lifetime signal is reused across every streamTurn attempt (raw-API
    // tool-loop iterations + Item-A stream retries). Twelve sequential drains crosses
    // Node's 10-listener warning threshold — with the leak fixed each drain removes its
    // own listener, so this completes cleanly (no MaxListenersExceededWarning).
    const controller = new AbortController();
    const dec = new TextDecoder();
    const drainOnce = async (): Promise<string[]> => {
      const clock = makeClock();
      const ctl = makeControllable();
      ctl.push('a');
      ctl.push('b');
      ctl.close();
      const chunks: string[] = [];
      for await (const c of readWithIdleTimeout(ctl.body, controller.signal, {
        idleTimeoutMs: 50,
        label: 'anthropic',
        setTimer: clock.setTimer,
      })) {
        chunks.push(dec.decode(c));
      }
      return chunks;
    };
    for (let i = 0; i < 12; i += 1) {
      await expect(drainOnce()).resolves.toEqual(['a', 'b']);
    }
  });

  it('removes every abort listener it adds on the non-abort exits (done-close + stall)', async () => {
    const dec = new TextDecoder();

    // done-close path: chunk then EOF → generator returns; the listener must be removed.
    {
      const { signal, counts } = spySignal(new AbortController().signal);
      const clock = makeClock();
      const ctl = makeControllable();
      ctl.push('x');
      ctl.close();
      for await (const c of readWithIdleTimeout(ctl.body, signal, {
        idleTimeoutMs: 50,
        label: 'anthropic',
        setTimer: clock.setTimer,
      })) {
        dec.decode(c);
      }
      expect(counts.added).toBe(1);
      expect(counts.removed).toBe(1);
    }

    // stall path: chunk then silence → StreamStallError; the listener must be removed.
    {
      const { signal, counts } = spySignal(new AbortController().signal);
      const clock = makeClock();
      const ctl = makeControllable();
      ctl.push('x');
      const consume = (async (): Promise<void> => {
        for await (const c of readWithIdleTimeout(ctl.body, signal, {
          idleTimeoutMs: 50,
          label: 'anthropic',
          setTimer: clock.setTimer,
        })) {
          dec.decode(c);
        }
      })();
      await flush();
      clock.fire((t) => t.ms === 50);
      await expect(consume).rejects.toBeInstanceOf(StreamStallError);
      expect(counts.added).toBe(1);
      expect(counts.removed).toBe(1);
    }
  });
});
