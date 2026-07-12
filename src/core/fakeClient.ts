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

/**
 * A subagent turn: the model spawns one subagent (`spawn_subagent`) that runs two child
 * tool calls, then settles. Populates `state.tools` with a parent spawn card + two children
 * carrying `parentToolUseId`, so the subagent-browser panel (LANE B) has a real subagent to
 * browse — used ONLY by the subagent-panel pty smoke (JUNO_FAKE_SUBAGENT=1). stopReason
 * 'end' ends the turn without a re-entry, so the scripted tool-status events ARE the tool
 * lifecycle (the executor is never invoked, exactly like the base SCRIPT).
 */
const SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Delegating to a subagent.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa-parent-1', name: 'spawn_subagent', args: { task: 'summarize the repo', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'sa-parent-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'sa-parent-1' },
  { type: 'tool-status', toolCallId: 'sa-child-1', status: 'running' },
  { type: 'tool-status', toolCallId: 'sa-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa-child-2', name: 'read_file', args: { path: 'src/app.tsx' }, parentToolUseId: 'sa-parent-1' },
  { type: 'tool-status', toolCallId: 'sa-child-2', status: 'result', result: 'export function App() {}' },
  { type: 'tool-status', toolCallId: 'sa-parent-1', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'usage', tokensIn: 50, tokensOut: 20 },
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
 *
 * When `width > 0`, each source line is padded (with the `line N of N` marker kept
 * intact at the start) to ≈`width` display columns. Wider than the terminal, one
 * source line then WRAPS to several rendered rows — the exact shape that a
 * source-line height budget mis-counts and a wrap-aware one must handle (the wide-
 * prose regression). The `line N of N` marker stays contiguous for the test probe.
 */
function buildLongScript(lines: number, width = 0): readonly AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'assistant-start', id: TURN_ID }];
  for (let i = 1; i <= lines; i++) {
    const marker = `line ${i} of ${lines}`;
    let body = marker;
    if (width > 0 && marker.length < width) {
      // Pad with a deterministic ASCII filler (1 col/char) to the target width.
      body = marker + ' ' + 'x'.repeat(Math.max(0, width - marker.length - 1));
    }
    events.push({ type: 'text-delta', id: TURN_ID, delta: `${body}\n` });
  }
  events.push({ type: 'usage', tokensIn: 10, tokensOut: lines });
  events.push({ type: 'assistant-done', id: TURN_ID, stopReason: 'end' });
  return events;
}

/** The deterministic stand-in `ModelClient`. */
export class FakeModelClient implements ModelClient {
  private readonly tickMs: number;
  private readonly script: readonly AgentEvent[];

  constructor(opts: { tickMs?: number; longLines?: number; lineWidth?: number; subagent?: boolean } = {}) {
    this.tickMs = opts.tickMs ?? 1;
    this.script =
      opts.longLines && opts.longLines > 0
        ? buildLongScript(opts.longLines, opts.lineWidth ?? 0)
        : opts.subagent === true
          ? SUBAGENT_SCRIPT
          : SCRIPT;
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
export function createFakeModelClient(opts?: {
  tickMs?: number;
  longLines?: number;
  lineWidth?: number;
  subagent?: boolean;
}): ModelClient {
  return new FakeModelClient(opts);
}
