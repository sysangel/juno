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
 * DELIBERATELY MIXED ARG SHAPES so the harness's hard `no-raw-json` guard is a REAL
 * assertion, not a fixture-relative tautology (wave-8 fixer): parent-1 uses juno's portable
 * `spawn_subagent` shape (`{ task, model }`), parent-2 uses the claude-cli `Agent`/`Task`
 * shape (`{ description, prompt, subagent_type }`) — the EXACT args a real claude parent
 * emits. Main landed the spawn-card arg condenser, so both now render CONDENSED
 * (`spawn_subagent(summarize the repo)` / `spawn_subagent(audit dependencies)`); the fixture
 * proves the condenser handles BOTH shapes, and any regression back to a raw `{"task":` /
 * `{"description":` arg on the card fails the hard `no-raw-json` guard (which now owns
 * spawn-card lines). The child/parent RESULT values are plain `{ summary }` / string shapes
 * the `{summary}` unwrap renders as text (never the content-block signature `[{"type":`).
 * stopReason 'end' ends the turn without a re-entry, so the scripted tool-status events ARE
 * the tool lifecycle (executor never invoked).
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
 * and its args + result are subject to the same hard `no-raw-json` spawn-card guard.
 *
 * RESULT-SIDE COVERAGE (wave-8 fixer): parent-1's result is an Anthropic content-block
 * (`[{ type: 'text', text: 'done' }]`) — the EXACT shape a real Anthropic tool result
 * carries — so the hard `no-raw-json` guard is exercised on the RESULT side, not just the arg
 * side (without it the `[{"type":` result signature could never fire against realistic
 * input). Main landed the result unwrap, so parent-1's card renders the unwrapped text
 * (`done`) rather than the raw `[{"type":`; any regression that leaked the content-block back
 * onto the (now-condensed) `Task(...)` spawn-card line fails `no-raw-json`, which owns
 * spawn-card lines directly (the former arg-prefix exemption is retired). parent-2 keeps a
 * plain `{ summary, model }` result so a non-content-block result shape is covered too.
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
  // Anthropic content-block result (`[{"type":"text",…}]`) — exercises the RESULT-side of the
  // hard `no-raw-json` spawn-card guard: main's unwrap must render `done`, not the raw `[{"type":`.
  { type: 'tool-status', toolCallId: 'cx-parent-1', status: 'result', result: [{ type: 'text', text: 'done' }] },
  { type: 'tool-status', toolCallId: 'cx-parent-2', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A CODEX-parent variant of the ERRORED concurrent-subagent turn
 * (JUNO_FAKE_SUBAGENTS=codex-error), for UX-SPEC R3 failure-surface parity. Same shape as
 * CODEX_SUBAGENT_SCRIPT (a non-juno `Task` parent, `{ description, prompt, subagent_type }`
 * args, children chained by `parentToolUseId`) but parent-2's card takes a `tool-status`
 * error carrying a plain-text reason — mirroring ERROR_SUBAGENT_SCRIPT under a codex-shaped
 * parent. It proves the subagent surface renders a FAILED codex parent identically to a
 * failed claude/juno one: the collapsed strip counts the failed bucket, the transcript spawn
 * card carries `✗ … · via codex cli · worker exited (code 1)…`, and the expanded dropdown row
 * shows the `✗` glyph WITH the exit reason (never a bare step count). Runs under a codex-cli
 * model so `providerKind` tags the cards `· via codex cli`, honestly. Combined, this closes
 * the round-3 coverage gap: no earlier frame exercised a codex parent's error surface or its
 * expanded dropdown rows, so R3 error parity was previously unverifiable from the frame set.
 */
const CODEX_ERROR_SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Codex parent delegating to two subagents; one will fail.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cxe-parent-1', name: 'Task', args: { description: 'summarize the repo', prompt: 'Summarize the repository layout.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'cxe-parent-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cxe-parent-2', name: 'Task', args: { description: 'audit dependencies', prompt: 'Audit the dependency tree.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'cxe-parent-2', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cxe-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'cxe-parent-1' },
  { type: 'tool-status', toolCallId: 'cxe-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cxe-child-2', name: 'read_file', args: { path: 'package.json' }, parentToolUseId: 'cxe-parent-2' },
  { type: 'tool-status', toolCallId: 'cxe-child-2', status: 'result', result: 'name: juno, private: true' },
  // Anthropic content-block result on the success parent — exercises the RESULT-side no-raw-json
  // guard under the codex parent too (main's unwrap renders `done`, never the raw `[{"type":`).
  { type: 'tool-status', toolCallId: 'cxe-parent-1', status: 'result', result: [{ type: 'text', text: 'done' }] },
  // parent-2 FAILS with a plain-text error — surfaced on the spawn card's inline tail AND the
  // dropdown's failed bucket + `✗` row carrying the reason. A string error trips no raw-JSON signature.
  { type: 'tool-status', toolCallId: 'cxe-parent-2', status: 'error', error: 'worker exited (code 1): dependency audit crashed' },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A CONCURRENT two-subagent turn whose descriptions carry CJK + emoji
 * (JUNO_FAKE_SUBAGENTS=cjk), for the selftest harness's multibyte-width edge case. The
 * panel row + spawn-card clips (`clipCells`/`stringWidth`) measure DISPLAY CELLS, not
 * UTF-16 code units, so a description of double-width CJK glyphs and astral emoji must
 * still render on exactly ONE terminal row — a code-unit-based clip would either overflow
 * the row (wrapping it to two rows → the \x1b[3J erase branch on a narrow strip) or slice
 * a surrogate pair mid-codepoint. Both parents settle `done` so the collapsed strip reads
 * `▾ agents (2 done)` and the expanded rows show the CJK/emoji descriptions intact. Args
 * are still condensed on the spawn card (`spawn_subagent(要約する: リポジトリ 📦)`), so the
 * hard `no-raw-json` guard holds over multibyte args too.
 */
const CJK_SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Delegating to two subagents (CJK + emoji labels).' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cjk-parent-1', name: 'spawn_subagent', args: { task: '要約する: リポジトリ 📦', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'cjk-parent-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cjk-parent-2', name: 'spawn_subagent', args: { description: '依存関係を監査する 🔍', prompt: '依存関係ツリーを監査する。', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'cjk-parent-2', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cjk-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'cjk-parent-1' },
  { type: 'tool-status', toolCallId: 'cjk-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'cjk-child-2', name: 'read_file', args: { path: 'package.json' }, parentToolUseId: 'cjk-parent-2' },
  { type: 'tool-status', toolCallId: 'cjk-child-2', status: 'result', result: 'name: juno, private: true' },
  { type: 'tool-status', toolCallId: 'cjk-parent-1', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'cjk-parent-2', status: 'result', result: { summary: 'done', model: 'fake' } },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A concurrent two-subagent turn where ONE subagent ERRORS (JUNO_FAKE_SUBAGENTS=error),
 * for the selftest harness's failure edge case. parent-1 settles `done`; parent-2 runs a
 * successful child then its parent card takes a `tool-status` with `status: 'error'`
 * carrying a plain-text error string. The subagent surface must present the failure
 * cleanly: the collapsed strip counts the failed bucket (`▾ agents (1 done, 1 failed)`),
 * the expanded row shows the `✗` error glyph beside the description, and the transcript
 * spawn card renders `✗ spawn_subagent(audit dependencies)  worker exited (code 1)…` —
 * the first error line inline, NEVER a raw JSON blob (the error is a string, so
 * `no-raw-json` still holds). stopReason 'end' ends the turn without a re-entry, so the
 * scripted tool-status events ARE the tool lifecycle (executor never invoked).
 */
const ERROR_SUBAGENT_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Delegating to two subagents; one will fail.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'err-parent-1', name: 'spawn_subagent', args: { task: 'summarize the repo', model: 'fake' } },
  { type: 'tool-status', toolCallId: 'err-parent-1', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'err-parent-2', name: 'spawn_subagent', args: { description: 'audit dependencies', prompt: 'Audit the dependency tree.', subagent_type: 'fake' } },
  { type: 'tool-status', toolCallId: 'err-parent-2', status: 'running' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'err-child-1', name: 'list_files', args: { dir: 'src' }, parentToolUseId: 'err-parent-1' },
  { type: 'tool-status', toolCallId: 'err-child-1', status: 'result', result: ['app.tsx', 'cli.ts'] },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'err-child-2', name: 'read_file', args: { path: 'package.json' }, parentToolUseId: 'err-parent-2' },
  { type: 'tool-status', toolCallId: 'err-child-2', status: 'result', result: 'name: juno, private: true' },
  { type: 'tool-status', toolCallId: 'err-parent-1', status: 'result', result: { summary: 'done', model: 'fake' } },
  // parent-2's spawn FAILS — a plain-text error string, surfaced on the spawn card's inline
  // tail (`✗ spawn_subagent(audit dependencies)  worker exited (code 1)…`) and the dropdown's
  // failed bucket + `✗` row glyph. A string error never trips the raw-JSON signatures.
  { type: 'tool-status', toolCallId: 'err-parent-2', status: 'error', error: 'worker exited (code 1): dependency audit crashed' },
  { type: 'usage', tokensIn: 80, tokensOut: 30 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A CONCURRENT PLAIN-TOOL burst (JUNO_FAKE_TOOLS=concurrent) for the grouped-tool-rows selftest.
 * The model issues THREE top-level tool calls together — the reducer stamps them one concurrency
 * batch because each later call lands `pending` while its siblings are still non-terminal (the
 * honest "in flight together" shape; see docs/UX-SPEC.md R5) — so the UI renders ONE live grouped
 * unit (spinner header + a status row per tool), then condenses to a single committed line
 * (`✓ 3 tools · Grep, Glob, Read`) on completion rather than flooding scrollback with three cards.
 *
 * Two honesty edges ride the same burst:
 *   - ct-1/ct-2 go `running` while ct-3 is GATED behind a permission prompt (`permission-open`,
 *     exactly like the base SCRIPT's gated write_file) — during the snap window the header must
 *     read `2 running, 1 waiting on permission` (truthful buckets, never a folded "3 running")
 *     and ct-3's row must show the amber `◌ … · waiting on permission`. The fake then proceeds
 *     as if granted (running → result), and the turn-end drain clears the stranded prompt.
 *   - The run of text-deltas between the runnings and the first result holds the EXPANDED window
 *     open (~5 deltas ≈ 650ms at the scenario's 130ms tick) so the pty snap can never race it.
 *
 * Uses claude-cli PascalCase tool names on purpose (Grep/Glob/Read) — args condense to their
 * salient field, never a raw JSON blob. stopReason 'end' ends the turn without a re-entry, so the
 * scripted tool-status events ARE the tool lifecycle (the executor is never invoked).
 */
const CONCURRENT_TOOLS_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Searching the codebase in parallel.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ct-1', name: 'Grep', args: { pattern: 'concurrencyGroupId' } },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ct-2', name: 'Glob', args: { pattern: 'src/ui' } },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ct-3', name: 'Read', args: { file_path: 'src/ui/Message.tsx' } },
  { type: 'tool-status', toolCallId: 'ct-1', status: 'running' },
  { type: 'tool-status', toolCallId: 'ct-2', status: 'running' },
  // ct-3 is GATED mid-burst: its permission prompt opens while its siblings run, so the grouped
  // unit must present it honestly — `◌ Read(…) · waiting on permission` (amber), counted in the
  // header's `waiting on permission` bucket, never as running/queued.
  { type: 'permission-open', toolCallId: 'ct-3', name: 'Read', args: { file_path: 'src/ui/Message.tsx' }, risk: 'risky' },
  // Live window: prose streams while 2 run + 1 waits (the grouped unit stays EXPANDED — spinner
  // header + status rows — for this whole span, which is what the harness snaps).
  { type: 'text-delta', id: TURN_ID, delta: ' Correlating' },
  { type: 'text-delta', id: TURN_ID, delta: ' the' },
  { type: 'text-delta', id: TURN_ID, delta: ' matches' },
  { type: 'text-delta', id: TURN_ID, delta: ' now' },
  { type: 'text-delta', id: TURN_ID, delta: '…' },
  { type: 'tool-status', toolCallId: 'ct-1', status: 'result', result: 'src/core/reducer.ts:47 concurrencyGroupId' },
  { type: 'tool-status', toolCallId: 'ct-2', status: 'result', result: 'src/ui/Message.tsx and two more' },
  // Proceed-as-granted (the fake never waits for the keypress — base-SCRIPT convention); the
  // assistant-done drain below clears the stranded prompt exactly like the gated write_file.
  { type: 'tool-status', toolCallId: 'ct-3', status: 'running' },
  { type: 'tool-status', toolCallId: 'ct-3', status: 'result', result: 'export function Message' },
  { type: 'text-delta', id: TURN_ID, delta: ' Found the seam.' },
  { type: 'usage', tokensIn: 90, tokensOut: 36 },
  { type: 'assistant-done', id: TURN_ID, stopReason: 'end' },
];

/**
 * A concurrent plain-tool burst where ONE call FAILS (JUNO_FAKE_TOOLS=concurrent-error), for the
 * grouped-tool-rows failure edge. Same shape as CONCURRENT_TOOLS_SCRIPT (three top-level calls, one
 * batch), but the brain-recall takes a `tool-status` `error` with a plain-text reason. The failure
 * must be presented cleanly at BOTH lifecycle stages: the expanded live row carries `✗ … · <reason>`
 * (the agents-panel error idiom), and the condensed committed line reads `✗ 3 tools · 1 failed ·
 * mcp__brain__recall: <reason>` — the reason is NEVER dropped to a bare count that would read like a
 * clean finish. A string error never trips the raw-JSON signatures.
 */
const CONCURRENT_TOOLS_ERROR_SCRIPT: readonly AgentEvent[] = [
  { type: 'assistant-start', id: TURN_ID },
  { type: 'text-delta', id: TURN_ID, delta: 'Gathering context in parallel.' },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ce-1', name: 'Grep', args: { pattern: 'liveBudget' } },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ce-2', name: 'Read', args: { file_path: 'src/ui/liveBudget.ts' } },
  { type: 'tool-call', id: TURN_ID, toolCallId: 'ce-3', name: 'mcp__brain__recall', args: { query: 'grouped tool rows' } },
  { type: 'tool-status', toolCallId: 'ce-1', status: 'running' },
  { type: 'tool-status', toolCallId: 'ce-2', status: 'running' },
  { type: 'tool-status', toolCallId: 'ce-3', status: 'running' },
  // The recall FAILS while its two siblings still run — so the EXPANDED live group shows the
  // `✗ … · <reason>` row (agents-panel error idiom) before the batch settles to the condensed
  // line. The delta run after it holds the expanded window open (~4 deltas ≈ 520ms at the
  // scenario's 130ms tick) so the pty snap can never race the first result.
  { type: 'tool-status', toolCallId: 'ce-3', status: 'error', error: 'brain server unreachable (ECONNREFUSED)' },
  { type: 'text-delta', id: TURN_ID, delta: ' Correlating' },
  { type: 'text-delta', id: TURN_ID, delta: ' the' },
  { type: 'text-delta', id: TURN_ID, delta: ' gathered' },
  { type: 'text-delta', id: TURN_ID, delta: ' results…' },
  { type: 'tool-status', toolCallId: 'ce-1', status: 'result', result: 'src/ui/liveBudget.ts:120' },
  { type: 'tool-status', toolCallId: 'ce-2', status: 'result', result: 'export function computeLiveBudget' },
  { type: 'text-delta', id: TURN_ID, delta: ' Two landed; recall failed.' },
  { type: 'usage', tokensIn: 84, tokensOut: 30 },
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
      /** CODEX-parent ERRORED concurrent-subagent turn (JUNO_FAKE_SUBAGENTS=codex-error) for
       *  UX-SPEC R3 failure-surface parity. Ignored under `longLines`. */
      codexErrorSubagent?: boolean;
      /** Concurrent two-subagent turn with CJK + emoji descriptions (JUNO_FAKE_SUBAGENTS=cjk)
       *  for the selftest harness's multibyte-width edge case. Ignored under `longLines`. */
      cjkSubagent?: boolean;
      /** Concurrent two-subagent turn where one subagent ERRORS (JUNO_FAKE_SUBAGENTS=error)
       *  for the selftest harness's failure edge case. Ignored under `longLines`. */
      errorSubagent?: boolean;
      /** Concurrent PLAIN-TOOL burst (JUNO_FAKE_TOOLS=concurrent) for the grouped-tool-rows
       *  selftest — three top-level tools in one batch, all ok. Ignored under `longLines`. */
      concurrentTools?: boolean;
      /** Concurrent plain-tool burst where one call FAILS (JUNO_FAKE_TOOLS=concurrent-error).
       *  Ignored under `longLines`. */
      concurrentToolsError?: boolean;
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
        : opts.concurrentToolsError === true
          ? CONCURRENT_TOOLS_ERROR_SCRIPT
          : opts.concurrentTools === true
            ? CONCURRENT_TOOLS_SCRIPT
            : opts.codexErrorSubagent === true
              ? CODEX_ERROR_SUBAGENT_SCRIPT
              : opts.codexSubagent === true
                ? CODEX_SUBAGENT_SCRIPT
                : opts.cjkSubagent === true
                  ? CJK_SUBAGENT_SCRIPT
                  : opts.errorSubagent === true
                    ? ERROR_SUBAGENT_SCRIPT
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
  codexErrorSubagent?: boolean;
  cjkSubagent?: boolean;
  errorSubagent?: boolean;
  concurrentTools?: boolean;
  concurrentToolsError?: boolean;
}): ModelClient {
  return new FakeModelClient(opts);
}
