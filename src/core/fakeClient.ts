// src/core/fakeClient.ts
// W3 — deterministic fake ModelClient. No keys, no network, no filesystem, no randomness.
// Yields a FIXED, byte-reproducible AgentEvent script so W4/W6/W13 can run with no providers.
//
// The script exercises the full seam: text streaming, a non-gated tool (running→result),
// a gated tool (tool-call → permission-open(risky) → running → result), usage, done.
// NOTE: `permission-resolved` is the coordinator's (W6) responsibility — the fake only
// emits `permission-open` and proceeds as if granted, so the round-trip is driven externally.
import type { AgentEvent } from './events';
import type { ModelClient, ToolSpec, TurnInput } from './contracts';

const TURN_ID = 'fake-assistant-1';

/** The fixed event script. Pure data — no ids/timestamps generated at runtime. */
const SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  // Extended-thinking stream before the visible answer.
  { type: 'reasoning-delta', id: TURN_ID, delta: 'Let me ' },
  { type: 'reasoning-delta', id: TURN_ID, delta: 'think.' },
  { type: 'text-delta', id: TURN_ID, delta: 'Hello ' },
  { type: 'text-delta', id: TURN_ID, delta: 'from ' },
  { type: 'text-delta', id: TURN_ID, delta: 'Juno.' },

  // Non-gated (safe) tool. Args stream in as partial JSON before the parsed call.
  { type: 'tool-call-delta', toolCallId: 'tc-safe-1', argsDelta: '{"dir":' },
  { type: 'tool-call-delta', toolCallId: 'tc-safe-1', argsDelta: '"."}' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'tc-safe-1', name: 'list_files', args: { dir: '.' } },
  { type: 'tool-status', toolCallId: 'tc-safe-1', status: 'running' },
  { type: 'tool-status', toolCallId: 'tc-safe-1', status: 'result', result: ['a.txt', 'b.txt'] },

  { type: 'text-delta', id: TURN_ID, delta: ' Now a gated action.' },

  // Gated (risky) tool. Coordinator (W6) resolves the permission externally.
  { type: 'tool-call', id: TURN_ID, toolCallId: 'tc-risky-1', name: 'write_file', args: { path: 'x.txt', content: 'hi' } },
  { type: 'permission-open', toolCallId: 'tc-risky-1', name: 'write_file', args: { path: 'x.txt', content: 'hi' }, risk: 'risky' },
  { type: 'tool-status', toolCallId: 'tc-risky-1', status: 'running' },
  { type: 'tool-status', toolCallId: 'tc-risky-1', status: 'result', result: { ok: true, skippedRealIo: true } },

  { type: 'usage', tokensIn: 120, tokensOut: 48 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/** Fixed-duration tick that resolves early (and cleans up) if aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Build a LONG single-assistant-turn script: `lines` text-delta events, each a
 * full line ending in `\n`, framed by assistant-start/usage/done. Used only by
 * the autoscroll pty regression (a turn taller than the viewport is the exact
 * condition under which Ink stops terminal-following) — see
 * tests/autoscroll.pty.test.ts. Pure data, deterministic.
 */
function buildLongScript(lines: number): readonly AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'assistant-start', id: TURN_ID }];
  for (let i = 1; i <= lines; i++) {
    events.push({ type: 'text-delta', id: TURN_ID, delta: `line ${i} of ${lines}\n` });
  }
  events.push({ type: 'usage', tokensIn: 10, tokensOut: lines });
  events.push({ type: 'assistant-done', id: TURN_ID, stopReason: 'end' });
  return events;
}

/** The deterministic stand-in `ModelClient`. */
export class FakeModelClient implements ModelClient {
  private readonly tickMs: number;
  private readonly script: readonly AgentEvent[];

  constructor(opts: { tickMs?: number; longLines?: number } = {}) {
    this.tickMs = opts.tickMs ?? 1;
    this.script =
      opts.longLines && opts.longLines > 0 ? buildLongScript(opts.longLines) : SCRIPT;
  }

  async *streamTurn(
    _input: TurnInput,
    _tools: ToolSpec[],
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    for (const event of this.script) {
      if (signal.aborted) return;
      await delay(this.tickMs, signal);
      if (signal.aborted) return;
      yield event;
    }
  }
}

/** Factory form, for callers that prefer not to `new`. */
export function createFakeModelClient(opts?: { tickMs?: number; longLines?: number }): ModelClient {
  return new FakeModelClient(opts);
}
