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
  const { rows, cols, lines, lineWidth } = opts;
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
          // Drive one long single-turn stream (N text lines) — the exact tall-turn
          // condition. Wired in cli.ts → fakeClient.buildLongScript.
          JUNO_FAKE_LONG_LINES: String(lines),
          ...(lineWidth > 0 ? { JUNO_FAKE_LINE_WIDTH: String(lineWidth) } : {}),
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

    // Wait for the LAST streamed line's marker to reach the framebuffer — proof the
    // newest content followed all the way to the bottom (never stranded off-screen).
    // The `line N of N` marker is kept contiguous even when padded/wrapped.
    await waitForOutput(read, (b) => b.includes(`line ${lines} of ${lines}`), {
      timeoutMs: 15_000,
      label: 'the final streamed line to render',
    });
    // Let the turn commit + settle.
    await new Promise((r) => setTimeout(r, 600));

    const buffer = read();
    const eraseScrollbackCount = (buffer.match(ERASE_SCROLLBACK) ?? []).length;

    // Clean teardown: double Ctrl-C (composer holds "go" → first clears + arms hint).
    proc.write('\x03');
    await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
      timeoutMs: 8_000,
      label: 'the ctrl+c exit hint to arm',
    });
    proc.write('\x03');
    await new Promise((r) => setTimeout(r, 400));

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
});
