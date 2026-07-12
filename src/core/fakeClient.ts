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

/**
 * TWO concurrent subagent turns: the model spawns two subagents (`spawn_subagent`)
 * in the SAME turn — both parents go `running` before either child completes, then
 * both settle — so the subagent panel shows `▾ agents (2 done)`. Used ONLY by the
 * selftest harness's concurrent-subagent scenario (JUNO_FAKE_SUBAGENTS=2).
 *
 * DELIBERATELY MIXED ARG SHAPES so the harness's spawn-card guard is a REAL assertion,
 * not a fixture-relative tautology (wave-8 fixer): parent-1 uses juno's portable
 * `spawn_subagent` shape (`{ task, model }`), parent-2 uses the claude-cli `Agent`/`Task`
 * shape (`{ description, prompt, subagent_type }`) — the EXACT args a real claude parent
 * emits. Because the spawn card has no arg condenser yet (the R2 presentation-lane gap),
 * parent-1 renders the literal `spawn_subagent({"task":…}` and parent-2 renders the literal
 * `{"description":…}` on screen. The harness's `spawn-card-args-condensed` invariant (a
 * documented known-gap) now genuinely VIOLATES on both shapes instead of green-lighting the
 * leak. The child/parent RESULT values stay free of the content-block signature `[{"type":`
 * so the global `no-raw-json` guard still catches a real off-card result leak. stopReason
 * 'end' ends the turn without a re-entry, so the scripted tool-status events ARE the tool
 * lifecycle (executor never invoked).
 */
const MULTI_SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Delegating to two subagents in parallel.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa-parent-1', name: 'spawn_subagent', args: { task: 'summarize the repo', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'sa-parent-1', status: 'running' },
  // Claude-cli arg shape ({ description, prompt, subagent_type }) — what a REAL claude
  // parent emits; renders the literal `{"description":` on the un-condensed spawn card.
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa-parent-2', name: 'spawn_subagent', args: { description: 'audit dependencies', prompt: 'Audit the dependency tree.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'sa-parent-2', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa2-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'sa-parent-1' },
  { type: 'tool-status', toolCallId: 'sa2-child-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'sa2-child-2', name: 'read_file', args: { path: 'package.json' }, parentToolUseId: 'sa-parent-2' },
  { type: 'tool-status', toolCallId: 'sa2-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-status', toolCallId: 'sa2-child-2', status: 'result', result: 'name: juno, private: true' },
  { type: 'tool-status', toolCallId: 'sa-parent-1', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'sa-parent-2', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A CODEX-PARENT variant of the concurrent-subagent turn (JUNO_FAKE_SUBAGENTS=codex),
 * for UX-SPEC R3 machine coverage. The parent tool is named `Task` (a non-juno,
 * claude-cli/codex-style spawn name) with the `{ description, prompt, subagent_type }`
 * arg shape, and its children chain via `parentToolUseId` — exactly the state.tools shape
 * the subagent surface (`selectSubagents`) derives from, independent of which provider
 * produced the parent. It proves R3.1's "provider-agnostic subagent surface" claim
 * end-to-end: a parent NOT named `spawn_subagent` still surfaces as `▾ agents (2 done)`
 * and its args are subject to the same (currently-gapped) spawn-card condense guard.
 *
 * RESULT-SIDE COVERAGE (wave-8 fixer): parent-1's result is an Anthropic content-block
 * (`[{ type: 'text', text: 'done' }]`) — the EXACT shape a real Anthropic tool result
 * carries — so the R2.3 spawn-card gap is exercised on the RESULT side, not just the arg
 * side (without it the `[{"type":` result signature could never fire against realistic
 * input). Its `[{"type":` renders on the SAME condensed spawn-card line as the raw
 * `Task({"description":…}` args, so `no-raw-json`'s line-based exemption keeps the run green
 * while `spawn-card-args-condensed` REPORTS it as the known gap (which now owns spawn-card
 * RESULT leaks, not just args). The day the presentation condenser removes the `Task({"`
 * exemption prefix, `no-raw-json` auto-hardens on the surviving `[{"type":` result. parent-2
 * keeps a plain `{ summary, model }` result so a non-content-block result shape is covered too.
 *
 * HONEST CAVEAT: `codexCliClient` currently GATES a codex PARENT spawning children (see its
 * `codexToolArgs` doc — codex-parent spawns are deferred behind an MCP seam), so no real
 * codex client emits this today. This fake stands in for the provider-agnostic SELECTION
 * path only, which is all R3.1 asserts; it needs no codexCliClient.ts changes.
 */
const CODEX_SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Codex parent delegating to two subagents.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cx-parent-1', name: 'Task', args: { description: 'summarize the repo', prompt: 'Summarize the repository layout.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'cx-parent-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cx-parent-2', name: 'Task', args: { description: 'audit dependencies', prompt: 'Audit the dependency tree.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'cx-parent-2', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cx-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'cx-parent-1' },
  { type: 'tool-status', toolCallId: 'cx-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cx-child-2', name: 'read_file', args: { path: 'package.json' }, parentToolUseId: 'cx-parent-2' },
  { type: 'tool-status', toolCallId: 'cx-child-2', status: 'result', result: 'name: juno, private: true' },
  // Anthropic content-block result (`[{"type":"text",…}]`) — exercises the R2.3 RESULT-side
  // leak path; renders on parent-1's spawn-card line, owned by `spawn-card-args-condensed`.
  { type: 'tool-status', toolCallId: 'cx-parent-1', status: 'result', result: [{ type: 'text', text: 'done' }] },
  { type: 'tool-status', toolCallId: 'cx-parent-2', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
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
function buildLongScript(lines: number, width = 0, subagents = 0): readonly AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'assistant-start', id: TURN_ID }];
  // Optional lead-in: spawn `subagents` running subagents BEFORE the long text stream, so
  // the below-composer agents dropdown has real entries to EXPAND while the tall turn is
  // still streaming — the exact scrollback lane condition (dropdown expanded + tall live
  // region). Left running (no result) so they persist in the panel across the whole turn.
  // See tests/autoscroll.pty.test.ts (JUNO_FAKE_SUBAGENT=1 + JUNO_FAKE_LONG_LINES).
  if (subagents > 0) {
    events.push({ type: 'text-delta', id: TURN_ID, delta: `Spawning ${subagents} subagents.\n` });
    for (let s = 1; s <= subagents; s++) {
      events.push({
        type: 'tool-call',
        id: TURN_ID,
        toolCallId: `sa-${s}`,
        name: 'spawn_subagent',
        args: { task: `subagent task ${s}`, model: 'fake' },
      });
      events.push({ type: 'tool-status', toolCallId: `sa-${s}`, status: 'running' });
    }
  }
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

  constructor(
    opts: {
      tickMs?: number;
      longLines?: number;
      lineWidth?: number;
      subagent?: boolean;
      /** With `longLines`, prepend this many running subagents to the long stream so the
       *  agents dropdown can be expanded over a tall live turn (scrollback lane pty test).
       *  Ignored without `longLines` (the standalone SUBAGENT_SCRIPT path is unchanged). */
      subagentCount?: number;
      /** Concurrent TWO-subagent turn (JUNO_FAKE_SUBAGENTS=2) for the selftest harness's
       *  concurrent-spawn scenario. Ignored under `longLines` (that path uses subagentCount). */
      multiSubagent?: boolean;
      /** CODEX-parent concurrent-subagent turn (JUNO_FAKE_SUBAGENTS=codex) for UX-SPEC R3
       *  provider-agnostic subagent-surface coverage. Ignored under `longLines`. */
      codexSubagent?: boolean;
    } = {},
  ) {
    this.tickMs = opts.tickMs ?? 1;
    this.script =
      opts.longLines && opts.longLines > 0
        ? buildLongScript(
            opts.longLines,
            opts.lineWidth ?? 0,
            opts.subagent === true ? Math.max(1, opts.subagentCount ?? 1) : 0,
          )
        : opts.codexSubagent === true
          ? CODEX_SUBAGENT_SCRIPT
          : opts.multiSubagent === true
            ? MULTI_SUBAGENT_SCRIPT
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
  subagentCount?: number;
  multiSubagent?: boolean;
  codexSubagent?: boolean;
}): ModelClient {
  return new FakeModelClient(opts);
}
