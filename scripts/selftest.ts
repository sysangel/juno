#!/usr/bin/env -S tsx
// scripts/selftest.ts
// WAVE 8 — the automated render-feedback loop (lane selftest-harness). One place that
// drives the REAL juno CLI end-to-end under a pseudo-terminal, renders the raw pty
// bytes through a headless xterm into plain-text screen frames, and asserts machine-
// checkable presentation invariants on those frames — so a human (Aiden) no longer has
// to hand-report "the subagent card leaked raw JSON" or "scrollback got erased".
//
// WHY A PTY + A HEADLESS TERMINAL. ink-testing-library renders into a fake stdout with
// no rows and never exercises Ink's real terminal path (the tall-output full-repaint
// branch, real cursor moves, real scrollback). node-pty gives a real framebuffer of
// ANSI bytes; @xterm/headless is a full VT parser with a scrollback buffer, so we can
// reconstruct exactly what a user would SEE (the visible viewport) AND what scrolled
// into native terminal scrollback — the two halves of the Claude-Code scroll model.
//
// The same scenarios back TWO consumers, so the assertions can never drift:
//   • `npm run selftest`      → runs every scenario, writes frames + summary.json for
//                               agent critics, exits non-zero on any invariant failure.
//   • tests/selftest.pty.test → imports SCENARIOS + runScenario and asserts the same
//                               invariants under vitest, with HONEST pty skips.
//
// Honest availability: node-pty missing ⇒ a real SKIP (JUNO_REQUIRE_PTY=1 turns that
// into a FAILURE, for CI lanes that must prove the drive ran). The node-pty spawn-helper
// exec-bit issue is environmental and surfaces as a spawn throw ⇒ skip, never green.
//
// Determinism: FORCE_COLOR=0 + NO_COLOR=1 so frames are stable plain text; the scripted
// FakeModelClient (JUNO_PROVIDER=fake) supplies byte-reproducible turns with no network,
// keys, or clock. No fake timers anywhere near Ink — the clock is the real pty's.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// @xterm/headless is CJS: import the default (interop) and destructure the class, so
// this resolves under Node's native ESM loader (tsx) AND Vite (vitest). A type-only
// import gives the instance type without a second runtime binding.
import type { Terminal as XTermTerminal } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
import { INPUT_PLACEHOLDER } from '../src/app';

const { Terminal } = xtermHeadless;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root = the dir ABOVE scripts/. Derived from this module's own location so both
 *  `npm run selftest` (cwd = repo) and vitest (any cwd) resolve the SAME worktree. */
export const REPO_ROOT = path.resolve(HERE, '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');
// Invoke the LOCAL tsx binary directly (never npx): npx re-derives npm_* env vars.
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
// Held in a variable so TypeScript does not statically resolve the untyped native dep.
const NODE_PTY = 'node-pty';

/** When set, an unavailable/unspawnable pty is a FAILURE rather than a skip. */
export const REQUIRE_PTY = process.env.JUNO_REQUIRE_PTY === '1';

// ---------------------------------------------------------------------------
// node-pty load (mirrors tests/tui.smoke.test.ts — availability known at import).
// ---------------------------------------------------------------------------
interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
type SpawnFn = (file: string, args: readonly string[], opts: Record<string, unknown>) => PtyProcess;

function resolveSpawn(mod: unknown): SpawnFn | null {
  const pick = (m: unknown): SpawnFn | null => {
    if (m !== null && typeof m === 'object' && 'spawn' in m) {
      const s = (m as { spawn: unknown }).spawn;
      if (typeof s === 'function') return s as SpawnFn;
    }
    return null;
  };
  return pick(mod) ?? pick((mod as { default?: unknown } | null)?.default);
}

export let loadError: string | undefined;
export const spawnPty: SpawnFn | null = await (async (): Promise<SpawnFn | null> => {
  try {
    return resolveSpawn(await import(NODE_PTY));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    return null;
  }
})();
export const PTY_READY = spawnPty !== null;

const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Headless-terminal rendering: raw ANSI bytes → plain-text screen frames.
// ---------------------------------------------------------------------------

/** Resolve after xterm has parsed every byte queued so far (empty write's callback
 *  fires behind all preceding writes), so a frame read reflects the newest bytes. */
function flush(term: XTermTerminal): Promise<void> {
  return new Promise<void>((resolve) => term.write('', () => resolve()));
}

/** The VISIBLE viewport as plain text: the `rows` lines anchored at the buffer base
 *  (= what a user sees when scrolled to the bottom, which is where a live TUI sits). */
function renderVisible(term: XTermTerminal, rows: number): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

/** The ENTIRE buffer (native scrollback + visible screen) as plain text — the dump
 *  that proves earlier history is still reachable by scrolling up. */
function dumpScrollback(term: XTermTerminal): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------

/** The raw content-block signatures that must NEVER reach the screen — an Anthropic
 *  tool result (`[{"type":"text",…}]`), a raw tool arg object (`{"description":…}`), or
 *  juno's own spawn_subagent result object (`{"summary":…}`) leaking past the condense
 *  path is exactly the class of bug this loop guards. `{"summary":` is the result shape
 *  Aiden's R2 requirement names: subagentTool.ts emits `{ summary, model, agent? }`, which
 *  ToolCallCard.toDisplay's `{summary}` unwrap collapses to plain text ("done"); should that
 *  unwrap regress, the spawn card's inline tail would render a raw `{"summary":"done",…}`
 *  blob — the exact leak both new fixtures (MULTI_SUBAGENT / CODEX parent results) put on
 *  screen — and, without this signature, no invariant would fire. */
const RAW_JSON_SIGNATURES = ['{"description":', '[{"type":', '{"summary":'] as const;

/** Raw agent-arg objects rendered onto a SPAWN CARD, shape-agnostic across the three
 *  spawn tool names (juno's `spawn_subagent`, claude-cli's `Agent`/`Task`). A condensed
 *  spawn card reads `spawn_subagent(summarize the repo)`; these signatures catch the
 *  un-condensed leak — juno's `spawn_subagent({"task":…}` AND claude's `Task({"description":…}`
 *  alike, INCLUDING juno's own `{"task":…}` shape that `RAW_JSON_SIGNATURES` (keyed on
 *  `{"description":`) would otherwise miss. Main landed the arg condenser + `{summary}`-result
 *  unwrap, so these are now HARD `no-raw-json` failures, not a tolerated known gap. */
const SPAWN_CARD_SIGNATURES = ['spawn_subagent({"', 'Agent({"', 'Task({"'] as const;

/** True iff this single frame/scrollback line is a raw-agent-arg spawn-card leak. Folded
 *  POSITIVELY into the hard `no-raw-json` guard so the guard owns spawn-card lines: a
 *  condensed card (`spawn_subagent(summarize the repo)`) has no `({"`, so this never
 *  false-positives on the intended render — it only fires on a genuine raw-arg leak. */
function isSpawnCardRawArgLine(line: string): boolean {
  return SPAWN_CARD_SIGNATURES.some((sig) => line.includes(sig));
}

// Erase-scrollback escape (inside Ink's clearTerminal). Its presence = the tall-output
// full-repaint branch = destroyed native scrollback. Must never appear.
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK = /\x1b\[3J/;

export interface Invariant {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  /** When true, a FAILING result is an ACKNOWLEDGED cross-lane gap: the harness REPORTS it
   *  as VIOLATED (`KNOWN-GAP`) in the printout + summary.json and it does NOT fail the run
   *  (exit 0) — but it is never silent green. Conversely a knownGap that PASSES is a surprise
   *  (the gap was fixed): it XPASSes and DOES fail the run, forcing the marker to be removed
   *  (promoted to a hard invariant). This is the anti-theater safeguard on the escape hatch. */
  readonly knownGap?: boolean;
}

/** Does this invariant's current state BLOCK the run (non-zero exit / vitest red)? A normal
 *  invariant blocks when it fails; a known-gap invariant blocks only when it UNEXPECTEDLY
 *  passes (xpass). A known-gap's expected failure is reported but tolerated. */
export function invariantBlocks(inv: Invariant): boolean {
  return inv.knownGap === true ? inv.pass : !inv.pass;
}

/** Printout/summary status label. */
export function invariantStatus(inv: Invariant): 'PASS' | 'FAIL' | 'KNOWN-GAP' | 'XPASS' {
  if (inv.knownGap === true) return inv.pass ? 'XPASS' : 'KNOWN-GAP';
  return inv.pass ? 'PASS' : 'FAIL';
}

export interface Frame {
  readonly label: string;
  readonly text: string;
}

export interface Capture {
  readonly scenario: string;
  readonly cols: number;
  readonly rows: number;
  readonly frames: Frame[];
  readonly scrollback: string;
  readonly raw: string;
}

/** True iff the composer prompt sits on the last rendered rows of a frame — the
 *  Claude-Code model pins the composer at the bottom of the content (a status line
 *  may sit just below it). Trailing blank rows are ignored. */
function composerAtBottom(frame: string): boolean {
  const lines = frame.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const tail = lines.slice(-6);
  return tail.some((line) => line.includes('❯') || line.includes(INPUT_PLACEHOLDER));
}

function frameByLabel(cap: Capture, label: string): string {
  return cap.frames.find((f) => f.label === label)?.text ?? '';
}

/** The expanded subagent-panel DROPDOWN row matching `descNeedle`, isolated from the identical
 *  transcript spawn-card row ABOVE the composer: we take the panel region (from the `▾ agents`
 *  header down) so an assertion about the dropdown row can't be satisfied by the card. Empty
 *  string when the panel isn't expanded or no row matches. */
function dropdownRowFor(frame: string, descNeedle: string): string {
  const header = frame.indexOf('▾ agents');
  if (header === -1) return '';
  return (
    frame
      .slice(header)
      .split('\n')
      .find((line) => line.includes(descNeedle)) ?? ''
  );
}

/** The four requirement-3 invariants, evaluated on every scenario's capture. `modelChip`
 *  is the status line's never-dropped model anchor for THIS scenario — 'claude-fable-5' for
 *  the default backend, but a codex-cli scenario runs under a codex model (so its tool cards
 *  are truthfully tagged `via codex cli`) and anchors on that model id instead. */
function coreInvariants(cap: Capture, modelChip = 'claude-fable-5'): Invariant[] {
  const finalFrame = cap.frames.length > 0 ? cap.frames[cap.frames.length - 1].text : '';
  const haystacks = [...cap.frames.map((f) => f.text), cap.scrollback];

  const has3J = ERASE_SCROLLBACK.test(cap.raw);
  const composerOk = composerAtBottom(finalFrame);
  // Global no-raw-json owns ALL raw JSON — off the spawn card (a `[{"type":` content-block
  // result leak) AND on it. Main landed the spawn-card arg condenser + `{summary}`-result
  // unwrap, so the previous spawn-card exemption (a documented R2 known gap) is retired:
  // raw agent args OR a content-block result on a spawn-card line are now hard failures too.
  // `isSpawnCardRawArgLine` is folded in POSITIVELY so juno's own `spawn_subagent({"task":…}`
  // shape (which `RAW_JSON_SIGNATURES` keyed on `{"description":` would miss) is still caught.
  const leakLine = haystacks
    .flatMap((h) => h.split('\n'))
    .find(
      (line) => RAW_JSON_SIGNATURES.some((sig) => line.includes(sig)) || isSpawnCardRawArgLine(line),
    );
  // Status chrome: the model chip is the status line's never-dropped anchor, so its
  // presence in the final frame proves the status line rendered intact.
  const statusOk = finalFrame.includes(modelChip);

  return [
    {
      name: 'no-erase-scrollback',
      pass: !has3J,
      detail: has3J
        ? '\\x1b[3J (erase-scrollback) was emitted — native scrollback destroyed'
        : 'no \\x1b[3J emitted across the whole drive',
    },
    {
      name: 'composer-pinned-bottom',
      pass: composerOk,
      detail: composerOk
        ? 'composer prompt visible on the last content rows of the final frame'
        : 'composer prompt (❯ / placeholder) not on the last rows of the final frame',
    },
    {
      name: 'no-raw-json',
      pass: leakLine === undefined,
      detail: leakLine === undefined
        ? 'no raw JSON fragments (spawn_subagent/Agent/Task({" args; {"description":, [{"type":, {"summary": results) on any line, spawn card or otherwise, in any frame or scrollback'
        : `raw JSON leaked onto a rendered line: ${JSON.stringify(leakLine.trim().slice(0, 120))}`,
    },
    {
      name: 'status-mode-chrome',
      pass: statusOk,
      detail: statusOk
        ? 'status/mode chrome intact (model chip present in final frame)'
        : 'status line / model chip missing from the final frame',
    },
  ];
}

/** The live composer's typed content — the text after the `❯` prompt on its line, trimmed.
 *  A clean/empty composer yields '' or the placeholder; stray text (a leaked chord char)
 *  yields that text. In the ctrl-o scenario nothing is submitted, so the only `❯` is the
 *  live composer. */
function composerContent(frame: string): string {
  const line = frame.split('\n').find((l) => l.includes('❯'));
  if (line === undefined) return '';
  return line.slice(line.indexOf('❯') + 1).trim();
}

/** True iff the composer shows nothing typed (empty or just the placeholder). */
function composerIsEmpty(frame: string): boolean {
  const content = composerContent(frame);
  return content === '' || content === INPUT_PLACEHOLDER.trim();
}

// ---------------------------------------------------------------------------
// Scenarios: each drives the real CLI and snapshots labelled frames.
// ---------------------------------------------------------------------------

interface DriveCtx {
  readonly proc: PtyProcess;
  readonly read: () => string;
  readonly cols: number;
  readonly rows: number;
  sleep(ms: number): Promise<void>;
  waitFor(predicate: (raw: string) => boolean, opts: { timeoutMs: number; label: string }): Promise<void>;
  /** Flush the terminal and push the current visible frame under `label`. */
  snap(label: string): Promise<void>;
  frame(): string;
}

export interface Scenario {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Record<string, string>;
  /**
   * The model id this scenario runs under (status-line anchor for `status-mode-chrome`).
   * Defaults to the catalog default `claude-fable-5`. A scenario that sets `JUNO_MODEL`
   * to a different backend (e.g. a codex-cli model, so its tool cards read `via codex
   * cli`) MUST set this to the SAME id so the model-chip invariant checks the right anchor.
   */
  readonly model?: string;
  /**
   * Core invariants (by name) this scenario opts OUT of. A HARD-CONSTRAINED seam, not a
   * free exemption: every name must be a key of `SKIPPABLE_CORE_INVARIANTS` (anything
   * else throws at import), and the scenario's own `checks` MUST return that entry's
   * compensating POSITIVE check (`assembleInvariants` throws otherwise) — a tolerated
   * gap is declared and re-asserted, never silently exempted. Today exactly ONE core
   * invariant is skippable: `no-erase-scrollback`, for the scenario that deliberately
   * drives the sanctioned transcript-replacement wipe. Absent ⇒ all four apply (the norm).
   */
  readonly skipCoreInvariants?: readonly string[];
  drive(ctx: DriveCtx): Promise<void>;
  checks?(cap: Capture): Invariant[];
}

/** The ONLY core invariants a scenario may skip, each mapped to the compensating
 *  positive check the scenario's `checks` MUST return in its place. Enforced in code
 *  (import-time allowlist throw below the SCENARIOS table + the `assembleInvariants`
 *  compensation throw), so widening the seam is a deliberate, reviewable edit to this
 *  map — a future scenario cannot casually exempt itself from composer-pinned-bottom,
 *  no-raw-json, or any other core guard. */
const SKIPPABLE_CORE_INVARIANTS: Readonly<Record<string, string>> = {
  // The sanctioned transcript-replacement wipe legitimately emits `\x1b[3J`; the skipping
  // scenario must pin it to EXACTLY once (0 = wipe missing → duplicated transcript;
  // >1 = double-fire — the second wipe lands after the <Static> reprint and erases it).
  'no-erase-scrollback': 'sanctioned-wipe-emitted',
};

/** Type + submit a prompt as SEPARATE writes: a single 'go\r' chunk is delivered to Ink
 *  as one event that parseKeypress never classifies as Return, so it would not submit. */
async function submit(ctx: DriveCtx, text: string): Promise<void> {
  ctx.proc.write(text);
  await ctx.sleep(80);
  ctx.proc.write('\r');
}

/** Best-effort clean teardown: double Ctrl-C (empty composer → first arms the hint,
 *  second exits). The runner's finally still kills the child, so this never blocks. */
async function teardown(ctx: DriveCtx): Promise<void> {
  ctx.proc.write('\x03');
  try {
    await ctx.waitFor((b) => b.includes('press ctrl+c again to exit'), {
      timeoutMs: 6000,
      label: 'ctrl+c exit hint',
    });
    ctx.proc.write('\x03');
  } catch {
    // Hint never armed — the finally kill handles it.
  }
  await ctx.sleep(250);
}

/** (Re)send an idempotent chord until `predicate` holds — hardens a chord drive against the
 *  startup raw-mode race: a keystroke written before Ink grabs the tty is echoed in canonical
 *  mode and never reaches useInput. `npm run selftest` runs scenarios sequentially so it sends
 *  once, but the vitest face (selftest.pty.test) runs alongside the other pty drives, where a
 *  lone Ctrl+O could land before raw mode engaged and the overlay never opened. Safe ONLY for
 *  open-only/idempotent chords: Ctrl+O opens the tool-detail overlay and is swallowed once it
 *  is up (useKeybinds), with the composer's useInput inactive behind the overlay — so a
 *  redundant send never toggles it closed nor leaks an extra chord char. */
async function sendChordUntil(
  ctx: DriveCtx,
  bytes: string,
  predicate: (raw: string) => boolean,
  opts: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (predicate(ctx.read())) return;
    ctx.proc.write(bytes);
    // Poll for ~500ms between resends so a slow raw-mode handoff still gets retried.
    for (let waited = 0; waited < 500 && Date.now() < deadline; waited += 40) {
      if (predicate(ctx.read())) return;
      await ctx.sleep(40);
    }
    if (Date.now() >= deadline) {
      throw new Error(`[selftest] timed out waiting for ${opts.label} after ${opts.timeoutMs}ms`);
    }
  }
}

async function awaitComposer(ctx: DriveCtx): Promise<void> {
  await ctx.waitFor((b) => b.includes(INPUT_PLACEHOLDER), {
    timeoutMs: 15_000,
    label: 'composer to paint',
  });
  await ctx.snap('composer');
}

export const SCENARIOS: readonly Scenario[] = [
  {
    // 1. Basic exchange — text + two condensed tool cards. Proves the condense path
    //    (list_files(.) / write_file(x.txt), never {"dir": / {"path":).
    name: 'basic-exchange',
    cols: 80,
    rows: 24,
    env: {},
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('gated action'), {
        timeoutMs: 12_000,
        label: 'the tool turn to settle',
      });
      await ctx.sleep(500);
      await ctx.snap('after-turn');
      await teardown(ctx);
    },
    checks(cap) {
      const after = frameByLabel(cap, 'after-turn');
      const condensed =
        after.includes('list_files(.)') && !after.includes('{"dir":') && !after.includes('{"path":');
      return [
        {
          name: 'tool-args-condensed',
          pass: condensed,
          detail: condensed
            ? 'tool cards condensed (list_files(.)) with no raw arg JSON on screen'
            : 'expected condensed list_files(.) and NO {"dir": / {"path": in the after-turn frame',
        },
      ];
    },
  },
  {
    // 2. Long streaming turn overflowing a small terminal — the committed transcript
    //    flows into NATIVE scrollback (retrievable) while the composer stays pinned.
    // rows=16 is deliberately SMALL — 40 committed lines overflow it ~2.5x so the top
    // flows into native scrollback — but stays above app.tsx's LIVE_TURN_CHROME_RESERVE
    // (12) so the live window still fits under the viewport (no erase-scrollback repaint,
    // the exact regime tests/autoscroll.pty.test.ts proves safe at rows=24).
    name: 'long-overflow',
    cols: 80,
    rows: 16,
    env: { JUNO_FAKE_LONG_LINES: '40' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('line 40 of 40'), {
        timeoutMs: 15_000,
        label: 'the final streamed line to render',
      });
      await ctx.sleep(600);
      await ctx.snap('after-long');
      await teardown(ctx);
    },
    checks(cap) {
      const sb = cap.scrollback;
      const fin = frameByLabel(cap, 'after-long');
      const inScrollback = sb.includes('line 1 of 40') && sb.includes('line 40 of 40');
      const scrolledOff = !fin.includes('line 1 of 40');
      const pass = inScrollback && scrolledOff;
      return [
        {
          name: 'history-in-native-scrollback',
          pass,
          detail: pass
            ? 'the early line 1 sits in native scrollback (off the visible screen) while the last line is on screen'
            : `expected line 1 in scrollback but not on the visible screen (inScrollback=${inScrollback}, scrolledOff=${scrolledOff})`,
        },
      ];
    },
  },
  {
    // 3. Two concurrent subagent spawns — both parents run before either settles; the
    //    agents dropdown must show BOTH (2 done) with no raw JSON from the child cards.
    name: 'two-subagents',
    cols: 100,
    rows: 30,
    env: { JUNO_FAKE_SUBAGENTS: '2' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint',
      });
      await ctx.sleep(600); // let both parents settle to done
      await ctx.snap('agents-collapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const strip = frameByLabel(cap, 'agents-collapsed');
      const pass = strip.includes('▾ agents') && strip.includes('2 done');
      return [
        {
          name: 'two-subagents-in-dropdown',
          pass,
          detail: pass
            ? 'both spawned subagents appear in the collapsed agents dropdown (2 done)'
            : 'expected "▾ agents" carrying "2 done" in the collapsed strip',
        },
      ];
    },
  },
  {
    // 4. Ctrl+O overlay open/close — the tool-detail overlay opens on the chord and Esc
    //    returns to the composer (a fresh session shows the empty state).
    name: 'ctrl-o-overlay',
    cols: 100,
    rows: 30,
    env: {},
    async drive(ctx) {
      await awaitComposer(ctx);
      // Ctrl+O (0x0f) opens the tool-detail overlay. RE-SEND it until the overlay paints:
      // the placeholder can paint a beat before Ink engages raw mode, and under pty
      // contention (the vitest face runs beside the other pty drives) a lone chord lands in
      // canonical mode and is lost. Ctrl+O is open-only and idempotent, so re-sending is safe.
      await sendChordUntil(ctx, '\x0f', (b) => b.includes('No tool calls') || b.includes('tool calls'), {
        timeoutMs: 8000,
        label: 'the tool-detail overlay to open',
      });
      await ctx.sleep(200);
      await ctx.snap('overlay-open');
      ctx.proc.write('\x1b'); // Esc
      await ctx.sleep(300);
      await ctx.snap('overlay-closed');
      await teardown(ctx);
    },
    checks(cap) {
      const open = frameByLabel(cap, 'overlay-open');
      const closed = frameByLabel(cap, 'overlay-closed');
      const openOk = open.includes('No tool calls') || open.includes('tool calls');
      const closeOk = !closed.includes('No tool calls') && closed.includes('❯');
      const openComposerClean = composerIsEmpty(open);
      const closedComposerClean = composerIsEmpty(closed);
      return [
        {
          name: 'overlay-opens',
          pass: openOk,
          detail: openOk ? 'Ctrl+O opened the tool-detail overlay' : 'Ctrl+O did not open the overlay',
        },
        {
          name: 'overlay-closes',
          pass: closeOk,
          detail: closeOk
            ? 'Esc closed the overlay back to the composer'
            : 'overlay did not close / composer not restored after Esc',
        },
        // KNOWN GAP (composer/app lane): the Ctrl+O chord leaks a literal `o` into the
        // composer while the overlay is open (`❯ o`). Reported VIOLATED, not silent green;
        // XPASSes (→ run red, remove marker) once the composer stops echoing the chord.
        {
          name: 'chord-char-not-leaked-open',
          knownGap: true,
          pass: openComposerClean,
          detail: openComposerClean
            ? 'Ctrl+O left the composer empty while the overlay was open (no stray chord char)'
            : `Ctrl+O leaked a stray character into the composer while the overlay was open (composer shows ${JSON.stringify(composerContent(open))}) — owned by the composer/app lane`,
        },
        // Hard guard: whatever the open-frame state, the composer must be clean once the
        // overlay closes (the stray char must not persist into the restored composer).
        {
          name: 'chord-char-cleared-after-close',
          pass: closedComposerClean,
          detail: closedComposerClean
            ? 'composer is empty/placeholder after the overlay closes (no stray chord char left behind)'
            : `composer still shows stray text after the overlay closed: ${JSON.stringify(composerContent(closed))}`,
        },
      ];
    },
  },
  {
    // 5. Agents dropdown expand/collapse — Down hands focus into the panel, which expands
    //    into one row per subagent (status glyph + task label) capped by an `↑/esc collapse`
    //    hint; Esc collapses it back to the dim one-liner. The panel is expand/collapse ONLY
    //    (main commit 56f544e removed the `enter open` browse overlay — the per-subagent
    //    record still lives on disk, the UI just no longer opens it), so the scenario
    //    inspects the expanded ROWS and the collapse hint, not a browse affordance.
    name: 'agents-dropdown',
    cols: 100,
    rows: 30,
    env: { JUNO_FAKE_SUBAGENTS: '2' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint',
      });
      await ctx.sleep(500);
      await ctx.snap('collapsed');
      ctx.proc.write('\x1b[B'); // Down → focus into the panel, expanding it into rows
      await ctx.waitFor(
        (b) => b.includes('↑/esc collapse') && b.includes('summarize the repo'),
        {
          timeoutMs: 8000,
          label: 'the panel to expand into rows after Down',
        },
      );
      await ctx.sleep(200);
      await ctx.snap('expanded');
      ctx.proc.write('\x1b'); // Esc → collapse back to the one-liner
      await ctx.sleep(300);
      await ctx.snap('recollapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const expanded = frameByLabel(cap, 'expanded');
      const recollapsed = frameByLabel(cap, 'recollapsed');
      // Expanded ⇒ the `↑/esc collapse` hint (rendered ONLY by the expanded panel) plus BOTH
      // subagents' task labels as inspectable rows (parent-1 `{ task: 'summarize the repo' }`,
      // parent-2 `{ description: 'audit dependencies' }`).
      const expandOk =
        expanded.includes('↑/esc collapse') &&
        expanded.includes('summarize the repo') &&
        expanded.includes('audit dependencies');
      // Collapsed ⇒ back to the dim `▾ agents (2 done)` one-liner with NO expanded chrome.
      // The task labels still appear in the TRANSCRIPT spawn cards above the composer, so the
      // collapse discriminator is the expanded-only `↑/esc collapse` hint, not the labels.
      const collapseOk =
        recollapsed.includes('▾ agents (2 done)') && !recollapsed.includes('↑/esc collapse');
      return [
        {
          name: 'dropdown-expands',
          pass: expandOk,
          detail: expandOk
            ? 'Down expanded the agents dropdown into inspectable rows under the ↑/esc collapse hint'
            : 'agents dropdown did not expand into task rows on Down',
        },
        {
          name: 'dropdown-collapses',
          pass: collapseOk,
          detail: collapseOk
            ? 'Esc collapsed the dropdown back to the dim one-liner'
            : 'agents dropdown did not collapse back on Esc',
        },
      ];
    },
  },
  {
    // 6. Codex-parent subagents (UX-SPEC R3) — a codex-shaped parent (`Task` tool, claude-cli
    //    arg shape) spawns two subagents; the provider-agnostic subagent surface must render
    //    it identically to a claude/juno parent: `▾ agents (2 done)`, and the hard no-raw-json
    //    guard (which now owns spawn-card lines) holds over the `Task({"description":…}` card.
    //    Proves R3.1 (`selectSubagents` derives purely from the parentToolUseId chain).
    //
    //    Runs under a CODEX-CLI model (JUNO_MODEL=gpt-5.6-sol) so the parent runtime is
    //    honestly codex: `providerKind` derives from the selected catalog entry's provider,
    //    so the tool cards are truthfully tagged `· via codex cli`, not `via claude cli`.
    //    A codex parent credited to `claude cli` was a fixture bug (the scenario ran under
    //    the default claude-fable-5 model), not a product one — the render is provider-honest,
    //    it was just being fed the wrong runtime. Anchoring `status-mode-chrome` on the codex
    //    model id keeps that invariant meaningful.
    name: 'codex-parent-subagents',
    cols: 100,
    rows: 30,
    model: 'gpt-5.6-sol',
    env: { JUNO_FAKE_SUBAGENTS: 'codex', JUNO_MODEL: 'gpt-5.6-sol' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint (codex parent)',
      });
      await ctx.sleep(600); // let both parents settle to done
      await ctx.snap('agents-collapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const strip = frameByLabel(cap, 'agents-collapsed');
      const dropdownOk = strip.includes('▾ agents') && strip.includes('2 done');
      // The codex parent's tool cards must be tagged with the TRUTHFUL runtime — `via codex
      // cli`, never `via claude cli`. The spawn cards carry the suffix (`Task(...) · via codex
      // cli`), so the agents-collapsed frame (which still shows the settled cards above the
      // composer) is where we assert it.
      const runtimeHonest =
        strip.includes('via codex cli') && !strip.includes('via claude cli');
      return [
        {
          name: 'codex-parent-in-dropdown',
          pass: dropdownOk,
          detail: dropdownOk
            ? 'a codex-shaped (non-juno `Task`) parent surfaces identically: ▾ agents (2 done)'
            : 'expected "▾ agents" carrying "2 done" for the codex-shaped parent',
        },
        {
          name: 'codex-parent-runtime-honest',
          pass: runtimeHonest,
          detail: runtimeHonest
            ? 'codex-parent tool cards are tagged `· via codex cli` (never misattributed to claude cli)'
            : 'expected the codex parent tool cards to read `via codex cli`, not `via claude cli`',
        },
      ];
    },
  },
  {
    // 6b. Codex-parent FAILURE parity (UX-SPEC R3 error surface). Mirrors `errored-subagent`
    //     but under a CODEX-shaped parent (`Task` tool, codex-cli model): two spawns, one
    //     settles done, one errors. Closes the round-3 coverage gap — no earlier frame
    //     exercised a codex parent's ERROR surface or its EXPANDED dropdown rows, so R3 error
    //     parity (a failed codex parent must render identically to a failed claude/juno one)
    //     was unverifiable from the frame set. Down expands the panel so the codex dropdown
    //     rows (including the ✗ row carrying the exit reason) are captured, and the cards read
    //     the truthful `· via codex cli` runtime.
    name: 'codex-parent-errored',
    cols: 100,
    rows: 30,
    model: 'gpt-5.6-sol',
    env: { JUNO_FAKE_SUBAGENTS: 'codex-error', JUNO_MODEL: 'gpt-5.6-sol' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint (codex error)',
      });
      await ctx.sleep(600); // parent-1 → done, parent-2 → error
      await ctx.snap('collapsed');
      ctx.proc.write('\x1b[B'); // Down → expand into per-agent rows
      await ctx.waitFor((b) => b.includes('↑/esc collapse'), {
        timeoutMs: 8000,
        label: 'the panel to expand (codex error)',
      });
      await ctx.sleep(200);
      await ctx.snap('expanded');
      ctx.proc.write('\x1b'); // Esc → collapse, return focus to the composer
      await ctx.sleep(300);
      await ctx.snap('recollapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const collapsed = frameByLabel(cap, 'collapsed');
      const expanded = frameByLabel(cap, 'expanded');
      // Collapsed strip counts the failed bucket, just like the claude/juno failure surface.
      const failedBucketOk = collapsed.includes('1 failed');
      // The codex parent's tool cards are tagged with the truthful runtime — `via codex cli`,
      // never `via claude cli` — even on the failing card.
      const runtimeHonest = collapsed.includes('via codex cli') && !collapsed.includes('via claude cli');
      // The failed DROPDOWN row carries the exit reason (not a bare step count), proving the
      // finding-1 fix holds under a codex parent too.
      const dropdownRow = dropdownRowFor(expanded, 'audit dependencies');
      const dropdownReasonOk =
        expanded.includes('✗') &&
        dropdownRow.includes('worker exited (code 1)') &&
        !dropdownRow.includes('1 step');
      const pass = failedBucketOk && runtimeHonest && dropdownReasonOk;
      return [
        {
          name: 'codex-parent-error-parity',
          pass,
          detail: pass
            ? 'a FAILED codex-shaped parent surfaces identically: strip "1 failed"; ✗ dropdown row with the exit reason; cards tagged `via codex cli`'
            : `expected codex-parent failure parity (failedBucketOk=${failedBucketOk}, runtimeHonest=${runtimeHonest}, dropdownReasonOk=${dropdownReasonOk}, row=${JSON.stringify(dropdownRow)})`,
        },
      ];
    },
  },
  {
    // 7. NARROW terminal (32 cols) with the agents dropdown EXPANDED over a long streaming
    //    turn (UX-SPEC R1.2 + R4.2 at an ultra-narrow width). The combined long+subagent
    //    mode prepends 3 RUNNING subagents to a 48-line stream (slow 25ms tick), so the
    //    collapsed strip paints early and Down expands it into per-agent rows WHILE the tall
    //    live region is still streaming. At 32 cols each expanded row + chrome line must clip
    //    to one terminal row (SubagentPanel clips to width-1); a code-unit clip or a wrap
    //    would grow the dynamic region past the viewport and re-open Ink's \x1b[3J
    //    erase-scrollback repaint — exactly the narrow/split-pane regime the panel's
    //    chrome-clipping guards. The global no-erase-scrollback + composer-pinned invariants
    //    carry the real assertion; this scenario's own check proves the panel actually
    //    expanded at narrow width mid-stream.
    name: 'narrow-agents-streaming',
    cols: 32,
    rows: 24,
    env: {
      JUNO_FAKE_LONG_LINES: '48',
      JUNO_FAKE_SUBAGENT: '1',
      JUNO_FAKE_SUBAGENT_COUNT: '3',
      JUNO_FAKE_TICK_MS: '25',
    },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      // The 3 running subagents stream FIRST, so the collapsed strip paints while the
      // 48-line turn is still streaming.
      await ctx.waitFor((b) => b.includes('▾ agents ('), {
        timeoutMs: 15_000,
        label: 'the collapsed agents strip to paint mid-stream (narrow)',
      });
      ctx.proc.write('\x1b[B'); // Down → focus into the panel, expanding it over the live turn
      await ctx.waitFor((b) => b.includes('↑/esc collapse'), {
        timeoutMs: 8000,
        label: 'the agents dropdown to expand over the streaming turn (narrow)',
      });
      await ctx.sleep(150);
      await ctx.snap('expanded-streaming');
      // Let the tall turn finish so the final frame proves bottom-follow held at 32 cols.
      await ctx.waitFor((b) => b.includes('line 48 of 48'), {
        timeoutMs: 15_000,
        label: 'the final streamed line to render (narrow)',
      });
      await ctx.sleep(300);
      ctx.proc.write('\x1b'); // Esc → collapse, return focus to the composer
      await ctx.sleep(250);
      await ctx.snap('after');
      await teardown(ctx);
    },
    checks(cap) {
      const expanded = frameByLabel(cap, 'expanded-streaming');
      // The `↑/esc collapse` hint is rendered ONLY by the expanded panel, so its presence at
      // 32 cols proves the dropdown expanded into clipped one-row entries mid-stream. Any wrap
      // it caused would surface as a \x1b[3J the global no-erase-scrollback invariant fails on.
      const expandOk = expanded.includes('↑/esc collapse');
      return [
        {
          name: 'narrow-dropdown-expands-streaming',
          pass: expandOk,
          detail: expandOk
            ? 'the agents dropdown expanded into clipped one-row entries at 32 cols while the tall turn streamed'
            : 'agents dropdown did not expand over the streaming turn at 32 cols',
        },
      ];
    },
  },
  {
    // 8. CJK + emoji subagent descriptions (UX-SPEC R1.2 + R2 on multibyte input). Two
    //    concurrent spawns carry double-width CJK glyphs + astral emoji in their
    //    descriptions; the panel row + spawn-card clips (clipCells/stringWidth) measure
    //    DISPLAY CELLS, so each renders on exactly one row with the label intact — a
    //    code-unit clip would slice a surrogate pair or overflow the row. Both settle done,
    //    so the collapsed strip reads `▾ agents (2 done)` and the expanded rows show the
    //    CJK/emoji descriptions; the args stay condensed on the spawn card, so the global
    //    no-raw-json guard holds over multibyte args too.
    name: 'cjk-emoji-subagents',
    cols: 100,
    rows: 30,
    env: { JUNO_FAKE_SUBAGENTS: 'cjk' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint (cjk)',
      });
      await ctx.sleep(500); // let both parents settle to done
      await ctx.snap('collapsed');
      ctx.proc.write('\x1b[B'); // Down → expand into per-agent rows
      await ctx.waitFor((b) => b.includes('↑/esc collapse') && b.includes('要約'), {
        timeoutMs: 8000,
        label: 'the panel to expand into CJK rows',
      });
      await ctx.sleep(200);
      await ctx.snap('expanded');
      ctx.proc.write('\x1b'); // Esc → collapse
      await ctx.sleep(300);
      await ctx.snap('recollapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const collapsed = frameByLabel(cap, 'collapsed');
      const expanded = frameByLabel(cap, 'expanded');
      const haystack = [...cap.frames.map((f) => f.text), cap.scrollback].join('\n');
      const collapsedOk = collapsed.includes('▾ agents (2 done)');
      // The double-width CJK descriptions survive the cell-clip intact in the expanded rows.
      const cjkOk = expanded.includes('要約') && expanded.includes('依存');
      // The astral emoji rendered somewhere on screen (spawn card and/or expanded row).
      const emojiOk = haystack.includes('📦') && haystack.includes('🔍');
      const pass = collapsedOk && cjkOk && emojiOk;
      return [
        {
          name: 'cjk-emoji-dropdown',
          pass,
          detail: pass
            ? 'CJK + emoji subagent descriptions render intact on one row each (collapsed 2 done; expanded CJK rows; emoji on screen)'
            : `expected CJK/emoji labels to render cleanly (collapsedOk=${collapsedOk}, cjkOk=${cjkOk}, emojiOk=${emojiOk})`,
        },
      ];
    },
  },
  {
    // 9. A subagent that ERRORS (UX-SPEC R1.1/R1.2 failure surface). Two concurrent spawns;
    //    parent-1 settles done, parent-2 takes a `tool-status` error carrying a plain-text
    //    message. The failure must present cleanly on BOTH surfaces: the collapsed strip
    //    counts the failed bucket (`▾ agents (1 done, 1 failed)`), the expanded row shows the
    //    `✗` error glyph, and the transcript spawn card renders `✗ spawn_subagent(audit
    //    dependencies)  worker exited (code 1)…` — the first error line inline, never raw
    //    JSON (the error is a string, so the global no-raw-json guard still holds).
    name: 'errored-subagent',
    cols: 100,
    rows: 30,
    env: { JUNO_FAKE_SUBAGENTS: 'error' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      await ctx.waitFor((b) => b.includes('▾ agents'), {
        timeoutMs: 12_000,
        label: 'the agents strip to paint (error)',
      });
      await ctx.sleep(600); // parent-1 → done, parent-2 → error
      await ctx.snap('collapsed');
      ctx.proc.write('\x1b[B'); // Down → expand into per-agent rows
      await ctx.waitFor((b) => b.includes('↑/esc collapse'), {
        timeoutMs: 8000,
        label: 'the panel to expand (error)',
      });
      await ctx.sleep(200);
      await ctx.snap('expanded');
      ctx.proc.write('\x1b'); // Esc → collapse, return focus to the composer
      await ctx.sleep(300);
      await ctx.snap('recollapsed');
      await teardown(ctx);
    },
    checks(cap) {
      const collapsed = frameByLabel(cap, 'collapsed');
      const expanded = frameByLabel(cap, 'expanded');
      // Collapsed strip counts the failed bucket.
      const failedBucketOk = collapsed.includes('1 failed');
      // The transcript spawn card surfaces the plain-text error inline (clean, no JSON — the
      // global no-raw-json guard owns that).
      const cardOk = collapsed.includes('worker exited (code 1)');
      // The expanded dropdown row shows the ✗ error glyph beside the failed subagent.
      const rowGlyphOk = expanded.includes('✗');
      const pass = failedBucketOk && cardOk && rowGlyphOk;
      // The failed DROPDOWN row (in the panel region below the composer) must carry the exit
      // reason, NOT the step count that reads like a clean finish (`fake · 1 step`). The exit
      // reason must be on BOTH surfaces — the transcript spawn card AND the dropdown row.
      const dropdownRow = dropdownRowFor(expanded, 'audit dependencies');
      const dropdownReasonOk =
        dropdownRow.includes('worker exited (code 1)') && !dropdownRow.includes('1 step');
      return [
        {
          name: 'errored-subagent-surfaces',
          pass,
          detail: pass
            ? 'the failed subagent surfaces cleanly (strip "1 failed"; ✗ expanded row; inline error tail on the spawn card)'
            : `expected the failure on both surfaces (failedBucketOk=${failedBucketOk}, cardOk=${cardOk}, rowGlyphOk=${rowGlyphOk})`,
        },
        {
          name: 'errored-subagent-dropdown-reason',
          pass: dropdownReasonOk,
          detail: dropdownReasonOk
            ? 'the failed dropdown row carries the exit reason (not a bare "1 step" that reads clean)'
            : `expected the ✗ dropdown row to show the exit reason, not a step count (row=${JSON.stringify(dropdownRow)})`,
        },
      ];
    },
  },
  {
    // 10. THREE concurrent spawns with expand → collapse MID-RUN (UX-SPEC R1.1/R1.2/R1.3
    //     under concurrency > 2 while still streaming). The combined long+subagent mode
    //     prepends 3 RUNNING subagents to a 48-line stream (slow 25ms tick); all three go
    //     running before any settles, so the collapsed strip reads `▾ agents (3 running)`
    //     mid-stream. Down expands it into 3 rows over the tall live turn, then Esc collapses
    //     it back — the full expand/collapse cycle exercised WHILE the turn streams (not on a
    //     settled turn like scenario `agents-dropdown`). The global no-erase-scrollback
    //     invariant proves the mid-run toggle never grew the dynamic region past the viewport.
    name: 'three-subagents-expand-collapse',
    cols: 100,
    rows: 24,
    env: {
      JUNO_FAKE_LONG_LINES: '48',
      JUNO_FAKE_SUBAGENT: '1',
      JUNO_FAKE_SUBAGENT_COUNT: '3',
      JUNO_FAKE_TICK_MS: '25',
    },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      // All 3 subagents stream first → the collapsed strip shows `3 running` while the tall
      // 48-line turn is still streaming (combined-mode subagents never settle).
      await ctx.waitFor((b) => b.includes('▾ agents (3 running'), {
        timeoutMs: 15_000,
        label: 'the collapsed strip to show 3 running',
      });
      await ctx.snap('collapsed-running');
      ctx.proc.write('\x1b[B'); // Down → expand mid-run
      await ctx.waitFor((b) => b.includes('↑/esc collapse') && b.includes('subagent task 3'), {
        timeoutMs: 8000,
        label: 'the panel to expand into 3 rows mid-run',
      });
      await ctx.sleep(150);
      await ctx.snap('expanded-midrun');
      ctx.proc.write('\x1b'); // Esc → collapse mid-run
      await ctx.sleep(300);
      await ctx.snap('recollapsed-midrun');
      // Let the tall turn finish (proves the mid-run toggling didn't disturb bottom-follow).
      await ctx.waitFor((b) => b.includes('line 48 of 48'), {
        timeoutMs: 15_000,
        label: 'the final streamed line to render (three-subagents)',
      });
      await ctx.sleep(300);
      await ctx.snap('after');
      await teardown(ctx);
    },
    checks(cap) {
      const collapsedRunning = frameByLabel(cap, 'collapsed-running');
      const expanded = frameByLabel(cap, 'expanded-midrun');
      const recollapsed = frameByLabel(cap, 'recollapsed-midrun');
      // 3 concurrent spawns: all three running in ONE turn before any settles.
      const threeConcurrent = collapsedRunning.includes('▾ agents (3 running)');
      // Expanded mid-run: the collapse hint + all 3 task rows (task 1 is the OLDEST; its
      // presence proves the panel windowed to fit all three rather than hiding it behind an
      // `↑ N earlier` head).
      const expandOk =
        expanded.includes('↑/esc collapse') &&
        expanded.includes('subagent task 1') &&
        expanded.includes('subagent task 3');
      // Collapsed back mid-run: the one-liner returns and the expanded-only hint is gone.
      const collapseOk =
        recollapsed.includes('▾ agents (3 running)') && !recollapsed.includes('↑/esc collapse');
      return [
        {
          name: 'three-concurrent-spawns',
          pass: threeConcurrent,
          detail: threeConcurrent
            ? 'three subagents ran concurrently in one turn (▾ agents (3 running))'
            : 'expected "▾ agents (3 running)" for three concurrent spawns',
        },
        {
          name: 'expand-collapse-midrun',
          pass: expandOk && collapseOk,
          detail: expandOk && collapseOk
            ? 'Down expanded the 3-row panel and Esc collapsed it back, both mid-stream'
            : `expected a mid-run expand→collapse cycle (expandOk=${expandOk}, collapseOk=${collapseOk})`,
        },
      ];
    },
  },
  {
    // 12. Spinner row stability across the thinking → streaming transition. Regression guard
    //     for the "text presses enter" jump: while `live` is null (optimistic `thinking…`)
    //     StreamingMessage renders nothing, so ITS leading turn-separator blank line is absent
    //     and the spinner butts the committed transcript; the instant `live` goes non-null at
    //     assistant-start the separator materializes and the spinner hops down one row — before
    //     any text. The fix draws that same separator during the pre-stream window. A slow fake
    //     tick widens the optimistic window so `pre-text` lands there (live still null).
    name: 'spinner-thinking-to-text',
    cols: 80,
    rows: 24,
    env: { JUNO_FAKE_TICK_MS: '400' },
    async drive(ctx) {
      await awaitComposer(ctx);
      await submit(ctx, 'go');
      // Optimistic `thinking…` paints synchronously on submit, BEFORE assistant-start — snap
      // while `live` is still null (the exact frame the bug mis-rendered a row too high).
      await ctx.waitFor((b) => b.includes('thinking…'), {
        timeoutMs: 12_000,
        label: 'the optimistic thinking line',
      });
      await ctx.snap('pre-text');
      // First streamed text: `live` is now long non-null so the turn separator is unquestionably
      // present. The spinner must be no closer to the committed transcript than it was pre-text.
      await ctx.waitFor((b) => b.includes('Hello'), {
        timeoutMs: 12_000,
        label: 'the first streamed text',
      });
      await ctx.snap('streaming');
      await teardown(ctx);
    },
    checks(cap) {
      // `❯ go` (committed user turn) tops the dynamic region; the spinner row carries
      // `esc to abort`. The rows between them are the turn separator (+ any streamed
      // reasoning/text). The bug dropped the separator ONLY in the pre-text frame, leaving the
      // spinner flush against `❯ go` (gap 1); with the separator the gap is ≥ 2. Equal spinner
      // ROWS pre-text vs streaming is NOT the invariant (reasoning + text legitimately grow
      // ABOVE the spinner) — the invariant that actually moved is that the separator sits
      // between the transcript and the spinner in BOTH states, so the spinner never hops.
      const gap = (label: string): number => {
        const lines = frameByLabel(cap, label).split('\n');
        const userRow = lines.findIndex((l) => l.includes('❯ go'));
        const spinnerRow = lines.findIndex((l) => l.includes('esc to abort'));
        return userRow >= 0 && spinnerRow > userRow ? spinnerRow - userRow : -1;
      };
      const preGap = gap('pre-text');
      const streamGap = gap('streaming');
      const stable = preGap >= 2 && streamGap >= 2;
      return [
        {
          name: 'spinner-row-stable-thinking-to-text',
          pass: stable,
          detail: stable
            ? 'turn separator present in both pre-text and streaming — the spinner never hops onto the transcript'
            : `spinner jumped: rows from ❯ go to the spinner pre-text=${preGap} streaming=${streamGap} (expected ≥ 2 in both)`,
        },
      ];
    },
  },
  {
    // 13. Auto-compaction must NOT duplicate the transcript (the reported bug). A compact
    //     replaces `committed` wholesale and bumps `transcriptEpoch`, remounting <Static>
    //     to REPRINT the whole new transcript; pre-fix, the stale copy still in native
    //     scrollback stacked a SECOND copy above it. This forces IDLE auto-compaction with
    //     NO user /compact — a tiny threshold over pure-text fake turns — and asserts the
    //     kept-tail prompt appears EXACTLY ONCE in screen+scrollback after the wipe. It is
    //     the sole scenario that legitimately emits `\x1b[3J` (the sanctioned wipe), so it
    //     opts out of `no-erase-scrollback` and re-asserts that wipe positively instead.
    name: 'compaction-dedupe',
    cols: 80,
    rows: 24,
    // JUNO_FAKE_LONG_LINES ⇒ pure-text turns that settle cleanly to idle (the base fake
    // script parks on a permission prompt, which would stall a multi-turn drive). The tiny
    // threshold makes idle auto-compaction fire once committed crosses MIN_MESSAGES_TO_COMPACT
    // (>4) — i.e. after the third turn — with a wide pressure margin.
    env: { JUNO_FAKE_LONG_LINES: '2', JUNO_COMPACTION_THRESHOLD: '0.000001' },
    skipCoreInvariants: ['no-erase-scrollback'],
    async drive(ctx) {
      await awaitComposer(ctx);
      // Three turns → 6 committed messages (each fake turn commits 1 user + 1 assistant).
      // tickMs=1 settles a turn in ms; the generous gap guarantees idle before the next
      // submit (a submit mid-turn silently no-ops).
      await submit(ctx, 'go');
      await ctx.sleep(1200);
      await submit(ctx, 'go');
      await ctx.sleep(1200);
      // The LAST prompt is the dedup marker: chooseKeepCount keeps the tail back to the
      // last user boundary, so this prompt SURVIVES compaction (the elided prefix folds
      // into the summary) and is exactly what the pre-fix bug reprinted a second time.
      await submit(ctx, 'COMPACTONCEMARKER');
      // Idle auto-compaction (NOT /compact) fires after the third turn; wait for its
      // `compacted:` feedback notice, then snapshot the settled, wiped transcript.
      await ctx.waitFor((b) => b.includes('compacted:'), {
        timeoutMs: 20_000,
        label: 'auto-compaction to fire and summarize',
      });
      await ctx.sleep(500);
      await ctx.snap('after-compaction');
      await teardown(ctx);
    },
    checks(cap) {
      const buffer = cap.scrollback;
      const markerCount = buffer.split('COMPACTONCEMARKER').length - 1;
      const compacted = /compacted: \d+ messages/.test(buffer) || buffer.includes('cmp:1');
      // EXACTLY once — not presence. 0 = the wipe never fired (the duplication bug);
      // >1 = a double-fire (e.g. a reintroduced inline wipe on top of the funnel's):
      // the SECOND wipe lands after the <Static> reprint and erases the freshly
      // reprinted transcript — blanked scrollback that a presence check would wave
      // through. Counted on the raw byte stream, where every escape is visible.
      const wipeCount = cap.raw.split('\x1b[3J').length - 1;
      return [
        {
          name: 'auto-compaction-fired',
          pass: compacted,
          detail: compacted
            ? 'idle auto-compaction produced its summary + `compacted:` feedback'
            : 'expected idle auto-compaction to fire (a `compacted:` notice / cmp chip) — it did not, so the dedup assertion would be vacuous',
        },
        {
          name: 'sanctioned-wipe-emitted',
          pass: wipeCount === 1,
          detail:
            wipeCount === 1
              ? 'the sanctioned transcript-replacement wipe (\\x1b[3J) fired exactly once on compaction'
              : `expected exactly ONE sanctioned \\x1b[3J wipe on compaction; found ${wipeCount} (0 = wipe missing → duplicate transcript; >1 = double-fire erasing the fresh reprint)`,
        },
        {
          name: 'compaction-dedupe',
          pass: markerCount === 1,
          detail:
            markerCount === 1
              ? 'the kept-tail prompt appears EXACTLY once after compaction — no duplicate stacked above'
              : `expected the kept-tail prompt exactly once after compaction; found ${markerCount} (pre-fix bug: the un-wiped copy lingered in scrollback)`,
        },
      ];
    },
  },
];

// Import-time guard on the skip seam (BOTH faces run this — `npm run selftest` and the
// vitest import of SCENARIOS): a scenario skipping anything outside the allowlist is a
// harness misconfiguration and fails LOUDLY at load, never a silent exemption.
for (const scenario of SCENARIOS) {
  for (const name of scenario.skipCoreInvariants ?? []) {
    if (SKIPPABLE_CORE_INVARIANTS[name] === undefined) {
      throw new Error(
        `[selftest] scenario "${scenario.name}" skips non-skippable core invariant "${name}" — skippable: ${Object.keys(SKIPPABLE_CORE_INVARIANTS).join(', ')}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Runner — spawn the CLI, drive one scenario, capture frames, evaluate invariants.
// ---------------------------------------------------------------------------

export interface ScenarioResult extends Capture {
  readonly invariants: Invariant[];
  readonly skipped: boolean;
  readonly skipReason?: string;
}

const BASE_ENV = {
  JUNO_PROVIDER: 'fake',
  JUNO_BRAIN_ENABLED: '0',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
} as const;

/** Assemble a scenario's final invariant list: the four core invariants minus DECLARED
 *  skips, plus the scenario's own checks. Enforces the skip contract IN CODE: a skip
 *  outside `SKIPPABLE_CORE_INVARIANTS` throws (defense in depth over the import-time
 *  guard), and a skip whose compensating positive check is absent from the scenario's
 *  own checks throws — so an opted-out core invariant is always REPLACED by a stronger
 *  scenario-local assertion, never dropped. Exported (pure) so the throw paths are
 *  unit-testable without a pty. */
export function assembleInvariants(scenario: Scenario, cap: Capture): Invariant[] {
  const skip = new Set(scenario.skipCoreInvariants ?? []);
  const core = coreInvariants(cap, scenario.model).filter((inv) => !skip.has(inv.name));
  const own = scenario.checks?.(cap) ?? [];
  for (const name of skip) {
    const required = SKIPPABLE_CORE_INVARIANTS[name];
    if (required === undefined) {
      throw new Error(
        `[selftest] scenario "${scenario.name}" skips non-skippable core invariant "${name}" — skippable: ${Object.keys(SKIPPABLE_CORE_INVARIANTS).join(', ')}`,
      );
    }
    if (!own.some((inv) => inv.name === required)) {
      throw new Error(
        `[selftest] scenario "${scenario.name}" skips "${name}" without declaring its compensating check "${required}" — a skipped core invariant must be re-asserted, not exempted`,
      );
    }
  }
  return [...core, ...own];
}

/**
 * Drive one scenario end-to-end and return its capture + evaluated invariants. When the
 * pty cannot be spawned it returns a `skipped` result (honest skip) — unless
 * `requirePty`, in which case the spawn throw propagates.
 */
export async function runScenario(
  scenario: Scenario,
  requirePty: boolean = REQUIRE_PTY,
): Promise<ScenarioResult> {
  const empty: ScenarioResult = {
    scenario: scenario.name,
    cols: scenario.cols,
    rows: scenario.rows,
    frames: [],
    scrollback: '',
    raw: '',
    invariants: [],
    skipped: true,
    skipReason: loadError ?? 'node-pty unavailable',
  };
  if (spawnPty === null) return empty;

  const home = mkdtempSync(path.join(tmpdir(), `juno-selftest-${scenario.name}-`));
  const term = new Terminal({ cols: scenario.cols, rows: scenario.rows, scrollback: 10_000, allowProposedApi: true });
  let raw = '';
  let proc: PtyProcess | undefined;
  try {
    try {
      proc = spawnPty(TSX_BIN, [CLI_ENTRY], {
        name: 'xterm-color',
        cols: scenario.cols,
        rows: scenario.rows,
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home, ...BASE_ENV, ...scenario.env },
      });
    } catch (error) {
      if (requirePty) throw error instanceof Error ? error : new Error(String(error));
      return { ...empty, skipReason: `pty.spawn threw: ${msg(error)}` };
    }

    const child = proc;
    child.onData((data) => {
      raw += data;
      term.write(data);
    });

    const frames: Frame[] = [];
    const ctx: DriveCtx = {
      proc: child,
      read: () => raw,
      cols: scenario.cols,
      rows: scenario.rows,
      sleep,
      async waitFor(predicate, opts) {
        const deadline = Date.now() + opts.timeoutMs;
        for (;;) {
          if (predicate(raw)) return;
          if (Date.now() >= deadline) {
            throw new Error(
              `[selftest:${scenario.name}] timed out waiting for ${opts.label} after ${opts.timeoutMs}ms; ` +
                `last 300 chars: ${JSON.stringify(raw.slice(-300))}`,
            );
          }
          await sleep(40);
        }
      },
      frame: () => renderVisible(term, scenario.rows),
      async snap(label) {
        await flush(term);
        frames.push({ label, text: renderVisible(term, scenario.rows) });
      },
    };

    await scenario.drive(ctx);
    await flush(term);

    const cap: Capture = {
      scenario: scenario.name,
      cols: scenario.cols,
      rows: scenario.rows,
      frames,
      scrollback: dumpScrollback(term),
      raw,
    };
    // Core invariants minus DECLARED skips, plus the scenario's own checks — with the
    // skip contract (allowlist + compensating check) enforced inside assembleInvariants.
    const invariants = assembleInvariants(scenario, cap);
    return { ...cap, invariants, skipped: false };
  } finally {
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    term.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// `npm run selftest` entry — run all, write frames + summary.json, exit by result.
// ---------------------------------------------------------------------------

interface SummaryScenario {
  name: string;
  cols: number;
  rows: number;
  framesDir: string;
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
  invariants: Invariant[];
}
interface Summary {
  ok: boolean;
  ptyReady: boolean;
  generatedAt: string;
  /** Acknowledged cross-lane gaps that are VIOLATED but tolerated (exit 0) — `scenario/invariant`
   *  per entry. Non-empty means the summary is NOT "all clean": it explicitly surfaces the
   *  leak (the Ctrl+O chord echo) that a naive all-PASS printout would hide. The spawn-card
   *  raw-args gap was promoted to a hard invariant in c972c52, so only the chord echo remains. */
  knownGaps: string[];
  scenarios: SummaryScenario[];
}

async function main(): Promise<void> {
  const outDir = process.env.JUNO_SELFTEST_OUT ?? path.join(REPO_ROOT, '.selftest');
  const framesRoot = path.join(outDir, 'frames');

  if (!PTY_READY) {
    if (REQUIRE_PTY) {
      process.stderr.write(`[selftest] JUNO_REQUIRE_PTY=1 but node-pty is unavailable: ${loadError}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[selftest] node-pty unavailable — skipping (set JUNO_REQUIRE_PTY=1 to fail): ${loadError}\n`,
    );
    mkdirSync(outDir, { recursive: true });
    const skippedSummary: Summary = { ok: true, ptyReady: false, generatedAt: new Date().toISOString(), knownGaps: [], scenarios: [] };
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(skippedSummary, null, 2));
    process.exit(0);
  }

  mkdirSync(framesRoot, { recursive: true });
  const summaryScenarios: SummaryScenario[] = [];

  for (const scenario of SCENARIOS) {
    process.stdout.write(`[selftest] running ${scenario.name} (${scenario.cols}x${scenario.rows}) …\n`);
    const result = await runScenario(scenario);

    const scenarioDir = path.join(framesRoot, scenario.name);
    mkdirSync(scenarioDir, { recursive: true });
    result.frames.forEach((f, i) => {
      writeFileSync(path.join(scenarioDir, `${String(i).padStart(2, '0')}-${f.label}.txt`), `${f.text}\n`);
    });
    writeFileSync(path.join(scenarioDir, 'scrollback.txt'), `${result.scrollback}\n`);

    summaryScenarios.push({
      name: result.scenario,
      cols: result.cols,
      rows: result.rows,
      framesDir: path.relative(REPO_ROOT, scenarioDir),
      // A scenario "passes" when nothing BLOCKS the run: every normal invariant passed AND
      // every known-gap invariant is (still) in its expected-failing state (an xpass blocks).
      pass: !result.skipped && !result.invariants.some(invariantBlocks),
      skipped: result.skipped,
      ...(result.skipReason !== undefined ? { skipReason: result.skipReason } : {}),
      invariants: result.invariants,
    });
  }

  const knownGaps = summaryScenarios.flatMap((s) =>
    s.invariants.filter((i) => i.knownGap === true && !i.pass).map((i) => `${s.name}/${i.name}`),
  );
  const summary: Summary = {
    ok: summaryScenarios.every((s) => s.pass || s.skipped),
    ptyReady: true,
    generatedAt: new Date().toISOString(),
    knownGaps,
    scenarios: summaryScenarios,
  };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  for (const s of summaryScenarios) {
    if (s.skipped) {
      process.stdout.write(`SKIP       ${s.name} — ${s.skipReason ?? 'skipped'}\n`);
      continue;
    }
    for (const inv of s.invariants) {
      const status = invariantStatus(inv);
      // Everything but a clean PASS carries its detail (KNOWN-GAP = reported-but-tolerated
      // violation; XPASS = a known gap that unexpectedly passed → remove its marker).
      process.stdout.write(
        `${status.padEnd(10)} ${s.name}/${inv.name}${status === 'PASS' ? '' : ` — ${inv.detail}`}\n`,
      );
    }
  }
  const gapNote =
    knownGaps.length > 0
      ? ` (${knownGaps.length} known gap${knownGaps.length === 1 ? '' : 's'} VIOLATED, tolerated: ${knownGaps.join(', ')})`
      : '';
  process.stdout.write(
    `\n[selftest] ${summary.ok ? `PASS${gapNote}` : 'FAILURES'} — frames + summary in ${path.relative(REPO_ROOT, outDir)}/\n`,
  );
  process.exit(summary.ok ? 0 : 1);
}

// Auto-run ONLY when invoked directly (tsx sets argv[1] to this file); importing under
// vitest leaves argv[1] pointing at the test runner, so main() never fires there.
const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath !== undefined && /(?:^|\/)selftest\.ts$/.test(invokedPath)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[selftest] ${msg(error)}\n`);
    process.exit(1);
  });
}
