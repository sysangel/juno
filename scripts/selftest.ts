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
 *  tool result (`[{"type":"text",…}]`) or a raw tool arg object (`{"description":…}`)
 *  leaking past the condense path is exactly the class of bug this loop guards. */
const RAW_JSON_SIGNATURES = ['{"description":', '[{"type":'] as const;

// Erase-scrollback escape (inside Ink's clearTerminal). Its presence = the tall-output
// full-repaint branch = destroyed native scrollback. Must never appear.
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK = /\x1b\[3J/;

export interface Invariant {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
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

/** The four requirement-3 invariants, evaluated on every scenario's capture. */
function coreInvariants(cap: Capture): Invariant[] {
  const finalFrame = cap.frames.length > 0 ? cap.frames[cap.frames.length - 1].text : '';
  const haystacks = [...cap.frames.map((f) => f.text), cap.scrollback];

  const has3J = ERASE_SCROLLBACK.test(cap.raw);
  const composerOk = composerAtBottom(finalFrame);
  const leak = RAW_JSON_SIGNATURES.find((sig) => haystacks.some((h) => h.includes(sig)));
  // Status chrome: the model chip is the status line's never-dropped anchor, so its
  // presence in the final frame proves the status line rendered intact.
  const statusOk = finalFrame.includes('claude-fable-5');

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
      pass: leak === undefined,
      detail: leak === undefined
        ? 'no raw JSON fragments ({"description": / [{"type":) in any frame or scrollback'
        : `raw JSON fragment ${JSON.stringify(leak)} leaked onto a frame/scrollback`,
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
  drive(ctx: DriveCtx): Promise<void>;
  checks?(cap: Capture): Invariant[];
}

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
      ctx.proc.write('\x0f'); // Ctrl+O
      await ctx.waitFor((b) => b.includes('No tool calls') || b.includes('tool calls'), {
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
      ];
    },
  },
  {
    // 5. Agents dropdown expand/collapse — Down hands focus into the panel (it expands
    //    with a browse hint + task labels); Esc collapses it back to the one-liner.
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
      ctx.proc.write('\x1b[B'); // Down → focus into the panel, expanding it
      await ctx.waitFor((b) => b.includes('enter open') && b.includes('summarize the repo'), {
        timeoutMs: 8000,
        label: 'the panel to expand + focus after Down',
      });
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
      const expandOk = expanded.includes('enter open') && expanded.includes('summarize the repo');
      const collapseOk = recollapsed.includes('▾ agents') && !recollapsed.includes('enter open');
      return [
        {
          name: 'dropdown-expands',
          pass: expandOk,
          detail: expandOk
            ? 'Down expanded the agents dropdown with the browse hint + task labels'
            : 'agents dropdown did not expand on Down',
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
];

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
    const invariants = [...coreInvariants(cap), ...(scenario.checks?.(cap) ?? [])];
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
    const skippedSummary: Summary = { ok: true, ptyReady: false, generatedAt: new Date().toISOString(), scenarios: [] };
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
      pass: !result.skipped && result.invariants.every((i) => i.pass),
      skipped: result.skipped,
      ...(result.skipReason !== undefined ? { skipReason: result.skipReason } : {}),
      invariants: result.invariants,
    });
  }

  const summary: Summary = {
    ok: summaryScenarios.every((s) => s.pass || s.skipped),
    ptyReady: true,
    generatedAt: new Date().toISOString(),
    scenarios: summaryScenarios,
  };
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  for (const s of summaryScenarios) {
    if (s.skipped) {
      process.stdout.write(`SKIP  ${s.name} — ${s.skipReason ?? 'skipped'}\n`);
      continue;
    }
    for (const inv of s.invariants) {
      process.stdout.write(`${inv.pass ? 'PASS' : 'FAIL'}  ${s.name}/${inv.name}${inv.pass ? '' : ` — ${inv.detail}`}\n`);
    }
  }
  process.stdout.write(
    `\n[selftest] ${summary.ok ? 'ALL PASS' : 'FAILURES'} — frames + summary in ${path.relative(REPO_ROOT, outDir)}/\n`,
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
