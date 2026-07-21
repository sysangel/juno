// tests/autoscroll.pty.test.ts
// LANE D (wave 7) — real-pty regression for terminal-follow ("autoscroll") on a
// streaming turn TALLER than the viewport.
//
// WHY A PTY. Simulated stdin / ink-testing-library render into a fake stdout with
// no rows and never exercise Ink's real renderer branch that this bug lives in:
//   node_modules/ink/build/ink.js onRender →
//     if (outputHeight >= stdout.rows)
//         stdout.write(clearTerminal + fullStaticOutput + output)
// i.e. once the DYNAMIC redraw region (the live turn + composer chrome) grows past
// the viewport, Ink stops in-place log-update and full-screen repaints EVERY frame,
// emitting clearTerminal (which contains \x1b[3J — ERASE SCROLLBACK). That is the
// reported bug: the terminal no longer scroll-follows new text and earlier
// scrollback is destroyed. Only a real pty (rows set) reproduces it.
//
// THE SIGNATURE. Correct terminal-follow ⇔ Ink NEVER takes that branch ⇔ the
// scrollback-erasing \x1b[3J is NEVER written while a long turn streams. The fix
// (src/ui/liveWindow.ts) bounds the live turn's height so the dynamic region always
// stays shorter than the viewport → in-place log-update → native bottom-follow.
// Before the fix this same drive emits \x1b[3J repeatedly (a hard failure here).
//
// Availability is honest: node-pty missing ⇒ a real vitest SKIP, or a FAILURE when
// JUNO_REQUIRE_PTY=1 (mirrors tui.smoke.test.ts).
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { INPUT_PLACEHOLDER } from '../src/app';
import { EXIT_ALTERNATE_SCREEN } from '../src/ui/alternateScreen';

const REQUIRE_PTY = process.env.JUNO_REQUIRE_PTY === '1';
const NODE_PTY = 'node-pty';
const REPO_ROOT = process.cwd();
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

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

let loadError: string | undefined;
const spawnPty: SpawnFn | null = await (async (): Promise<SpawnFn | null> => {
  try {
    return resolveSpawn(await import(NODE_PTY));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    return null;
  }
})();
const PTY_READY = spawnPty !== null;
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function bufferOf(proc: PtyProcess): () => string {
  let output = '';
  proc.onData((data) => {
    output += data;
  });
  return () => output;
}

async function waitForOutput(
  read: () => string,
  predicate: (buffer: string) => boolean,
  opts: { timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (predicate(read())) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `[autoscroll.pty] timed out waiting for ${opts.label} after ${opts.timeoutMs}ms; ` +
          `last 300 chars: ${JSON.stringify(read().slice(-300))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

// Erase-scrollback escape emitted inside Ink's clearTerminal (ansi-escapes
// clearTerminal = "\x1b[2J\x1b[3J\x1b[H"). Its presence during a streaming turn is
// exactly the tall-output full-repaint branch = the autoscroll bug.
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK = /\x1b\[3J/g;

interface DriveOpts {
  rows: number;
  cols: number;
  lines: number;
  /** 0 ⇒ short newline-dense lines; >0 ⇒ pad each line to this display width so a
   * single source line WRAPS to several rendered rows (the wide-prose shape). */
  lineWidth: number;
  /** >0 ⇒ prepend this many RUNNING subagents so the Observatory has entries while the
   * tall parent turn is still streaming. */
  subagents?: number;
  /** >0 ⇒ slow the fake stream to this per-event tick (ms) so the drive can open the
   * workspace mid-turn deterministically instead of racing a 1ms/line stream. */
  tickMs?: number;
  /** When true (with `subagents` > 0), press Down mid-stream to enter the Observatory. */
  openWorkspace?: boolean;
  /** When true, the fake opens a (small, non-diff) permission prompt EARLY and holds it open for
   *  the whole tall stream, so the overlay coexists with the bounded live turn (overlay-budget
   *  scrollback lane). The reducer drains the stranded prompt at assistant-done. */
  permission?: boolean;
}

/**
 * Spawn the app in a real pty, drive one long streaming turn, and return the raw
 * framebuffer plus the erase-scrollback count. Returns null when the pty cannot be
 * spawned (honest skip, unless JUNO_REQUIRE_PTY=1). Shared by both regression
 * cases so the narrow and wide shapes exercise the identical drive.
 */
async function driveLongTurn(
  opts: DriveOpts,
  requirePty: boolean,
): Promise<{ buffer: string; eraseScrollbackCount: number } | null> {
  const spawn = spawnPty as SpawnFn;
  const home = mkdtempSync(path.join(tmpdir(), 'juno-autoscroll-'));
  const { rows, cols, lines, lineWidth, subagents = 0, tickMs = 0, openWorkspace = false, permission = false } = opts;
  let proc: PtyProcess | undefined;
  try {
    try {
      proc = spawn(TSX_BIN, [CLI_ENTRY], {
        name: 'xterm-color',
        cols,
        rows,
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          JUNO_PROVIDER: 'fake',
          JUNO_BRAIN_ENABLED: '0',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          // Pin the palette so the startup OSC 11 probe is skipped: otherwise every
          // drive here eats a 150ms probe timeout and the probe's raw-mode grab +
          // OSC query bytes would perturb the @xterm/headless framebuffer this suite
          // asserts on. An explicit theme short-circuits the probe (see cli.ts gate).
          JUNO_THEME: 'dark',
          // Drive one long single-turn stream (N text lines) — the exact tall-turn
          // condition. Wired in cli.ts → fakeClient.buildLongScript.
          JUNO_FAKE_LONG_LINES: String(lines),
          ...(lineWidth > 0 ? { JUNO_FAKE_LINE_WIDTH: String(lineWidth) } : {}),
          // Combined mode: prepend running subagents so the Observatory can be opened
          // during the tall turn, and slow the tick so the drive can act mid-stream.
          ...(subagents > 0 ? { JUNO_FAKE_SUBAGENT: '1', JUNO_FAKE_SUBAGENT_COUNT: String(subagents) } : {}),
          // Overlay lane: hold a small permission prompt open over the whole tall stream so the
          // overlay-reserved live budget (src/ui/liveBudget.ts overlayRows) is exercised.
          ...(permission ? { JUNO_FAKE_LONG_PERMISSION: '1' } : {}),
          ...(tickMs > 0 ? { JUNO_FAKE_TICK_MS: String(tickMs) } : {}),
        },
      });
    } catch (error) {
      if (requirePty) throw error instanceof Error ? error : new Error(String(error));
      console.warn(`[autoscroll.pty] pty.spawn threw — skipping: ${msg(error)}`);
      return null;
    }

    const read = bufferOf(proc);

    // Composer paints → app mounted.
    await waitForOutput(read, (b) => b.includes(INPUT_PLACEHOLDER), {
      timeoutMs: 15_000,
      label: 'composer to paint',
    });

    // Submit a prompt to kick off the long streaming turn.
    proc.write('go');
    await new Promise((r) => setTimeout(r, 80));
    proc.write('\r');

    if (openWorkspace) {
      // The prepended subagents stream first, so the collapsed agents strip paints while
      // the parent is still active. Down enters the alternate-screen Observatory without
      // interrupting that parent turn.
      await waitForOutput(read, (b) => b.includes('▾ agents ('), {
        timeoutMs: 15_000,
        label: 'the collapsed agents strip to paint mid-stream',
      });
      proc.write('\x1b[B');
      await waitForOutput(read, (b) => b.includes('Observatory'), {
        timeoutMs: 8_000,
        label: 'the Observatory to open over the streaming turn',
      });
      // Let the hidden parent finish, then restore chat before asserting its final line.
      await new Promise((r) => setTimeout(r, Math.max(900, lines * tickMs * 2)));
      proc.write('\x1b');
    }

    // Wait for the LAST streamed line's marker to reach the framebuffer — proof the
    // newest content followed all the way to the bottom (never stranded off-screen).
    // The `line N of N` marker is kept contiguous even when padded/wrapped.
    await waitForOutput(read, (b) => b.includes(`line ${lines} of ${lines}`), {
      // The permission-overlay lane streams 60 events while the complete suite is also
      // driving several PTYs. Give that deliberately heavier case scheduler headroom;
      // isolated runs normally finish in under three seconds.
      timeoutMs: permission ? 30_000 : 15_000,
      label: 'the final streamed line to render',
    });
    // Let the turn commit + settle.
    await new Promise((r) => setTimeout(r, 600));

    const buffer = read();
    const eraseScrollbackCount = (buffer.match(ERASE_SCROLLBACK) ?? []).length;

    // Clean teardown (best-effort — the assertion data is already captured above, so a
    // teardown hiccup must not fail the regression). The workspace drive already returns
    // to chat before the double Ctrl-C arms + exits.
    try {
      proc.write('\x03');
      await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
        timeoutMs: 8_000,
        label: 'the ctrl+c exit hint to arm',
      });
      proc.write('\x03');
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      // Best-effort — proc.kill() in finally guarantees the child is reaped.
    }

    return { buffer, eraseScrollbackCount };
  } finally {
    try {
      proc?.kill();
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true });
  }
}

describe('autoscroll pty regression', () => {
  it.skipIf(!PTY_READY)(
    'a streaming turn taller than the viewport terminal-follows without erasing scrollback',
    async (ctx) => {
      const result = await driveLongTurn(
        { rows: 24, cols: 80, lines: 60 /* 2.5× the viewport → the pre-fix bug fires hard */, lineWidth: 0 },
        REQUIRE_PTY,
      );
      if (result === null) return ctx.skip();

      // THE REGRESSION ASSERTION: the scrollback-erasing full-repaint branch must
      // NEVER have fired. Non-zero here = Ink is clear-and-repainting each frame =
      // the "does not autoscroll, must scroll manually" bug.
      expect(result.eraseScrollbackCount).toBe(0);
      // Bottom-follow proof: composer pinned + newest line on screen, no crash frame.
      expect(result.buffer).toContain('line 60 of 60');
      expect(result.buffer).toContain(INPUT_PLACEHOLDER);
      expect(result.buffer).not.toContain('React is not defined');
    },
    45_000,
  );

  it.skipIf(!PTY_READY)(
    'a streaming turn of WIDE prose lines (each wrapping to many rows) still terminal-follows',
    async (ctx) => {
      // Each source line is ~253 cols ≈ 3× the 80-col viewport, so ONE source line
      // wraps to ~4 rendered rows. A source-line height budget counts each as 1 and
      // lets the windowed tail overflow the viewport → Ink re-enters the scrollback-
      // erasing full-repaint branch (the confirmed wide-prose regression). A wrap-
      // aware budget windows by rendered rows and keeps zero erase-scrollback.
      const result = await driveLongTurn(
        { rows: 24, cols: 80, lines: 30, lineWidth: 253 },
        REQUIRE_PTY,
      );
      if (result === null) return ctx.skip();

      expect(result.eraseScrollbackCount).toBe(0);
      expect(result.buffer).toContain('line 30 of 30');
      expect(result.buffer).toContain(INPUT_PLACEHOLDER);
      expect(result.buffer).not.toContain('React is not defined');
    },
    45_000,
  );

  it.skipIf(!PTY_READY)(
    'a long streaming turn survives an Observatory round-trip without erasing scrollback',
    async (ctx) => {
      // Enter the dedicated alternate-screen workspace while a tall parent response is
      // streaming, let it finish off-screen, then return to the primary chat buffer. This
      // covers buffer switching, continued execution, transcript restoration, and terminal
      // following in one real-PTY drive.
      const result = await driveLongTurn(
        { rows: 24, cols: 80, lines: 30, lineWidth: 0, subagents: 6, tickMs: 15, openWorkspace: true },
        REQUIRE_PTY,
      );
      if (result === null) return ctx.skip();

      // Neither the buffer transition nor the restored tall turn may invoke Ink's
      // scrollback-erasing repaint branch.
      expect(result.eraseScrollbackCount).toBe(0);
      // The dedicated workspace really was entered during the drive…
      expect(result.buffer).toContain('Observatory');
      // …the newest line followed all the way to the bottom…
      expect(result.buffer).toContain('line 30 of 30');
      // …and the FULL history flushed after returning to the primary buffer. Assert that
      // restored line 1 appears after the alternate-screen exit, followed by restored line
      // 30; mere presence could be satisfied by the early live window before the switch.
      const restoredAt = result.buffer.lastIndexOf(EXIT_ALTERNATE_SCREEN);
      const restoredFirst = result.buffer.lastIndexOf('line 1 of 30');
      const restoredLast = result.buffer.lastIndexOf('line 30 of 30');
      expect(restoredFirst).toBeGreaterThan(restoredAt);
      expect(restoredLast).toBeGreaterThan(restoredFirst);
      expect(result.buffer).toContain(INPUT_PLACEHOLDER);
      expect(result.buffer).not.toContain('React is not defined');
    },
    45_000,
  );

  it.skipIf(!PTY_READY)(
    'a long streaming turn with a permission prompt OPEN over it terminal-follows without erasing scrollback',
    async (ctx) => {
      // LANE overlay-scrollback (W3 item 3): OverlayHost renders INSIDE the dynamic region between
      // the live turn and the composer (app.tsx). The fixed budget IGNORED an open overlay, so a
      // permission prompt opened mid-turn added UNBUDGETED rows: at rows=30 the pre-fix live turn
      // (rows − 12 = 18) + a ~6-row prompt + composer/status chrome reaches `stdout.rows` and
      // re-enters Ink's scrollback-erasing full-repaint branch. computeLiveBudget now reserves the
      // overlay's rows one-for-one (and relaxes the live floor to 1 so it can), keeping the region
      // < rows. The fake opens a SMALL non-diff Read prompt EARLY and holds it open for the whole
      // 60-line stream (drained at assistant-done), so the prompt and the bounded live turn coexist
      // for the entire tall span.
      const result = await driveLongTurn(
        { rows: 30, cols: 80, lines: 60, lineWidth: 0, permission: true },
        REQUIRE_PTY,
      );
      if (result === null) return ctx.skip();

      // THE REGRESSION ASSERTION: even with the prompt open over a tall turn, the scrollback-erasing
      // repaint branch must NEVER fire.
      expect(result.eraseScrollbackCount).toBe(0);
      // The permission prompt actually painted over the streaming turn…
      expect(result.buffer.toLowerCase()).toContain('permission required');
      // …the newest line followed all the way to the bottom…
      expect(result.buffer).toContain('line 60 of 60');
      // …the composer is still pinned, and no crash frame.
      expect(result.buffer).toContain(INPUT_PLACEHOLDER);
      expect(result.buffer).not.toContain('React is not defined');
    },
    60_000,
  );
});
