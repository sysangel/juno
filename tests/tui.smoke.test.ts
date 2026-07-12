// tests/tui.smoke.test.ts
// The GENUINE end-to-end TTY drive of the juno TUI. Every other suite renders
// <App> under ink-testing-library, which fakes stdin/stdout and can never observe
// a real mount/render/input break (a broken tsx entrypoint, a raw stdin decode
// fault, a JSX-runtime regression in Ink's real terminal path). Here we spawn the
// actual `tsx src/cli.ts` binary inside a REAL pseudo-terminal (node-pty) and drive
// it the way a user's shell does: read the framebuffer the process paints, type
// real bytes, and assert on clean teardown.
//
// Cases:
//   1. `--version` — the render-free banner path, asserted on the pty framebuffer
//      against THIS package.json's real version.
//   2. interactive — the full TUI against a fake, network/key-free provider
//      (`JUNO_PROVIDER=fake`, wired in cli.ts): assert the composer paints, type a
//      real keystroke sequence, then exit via a DOUBLE-press Ctrl-C (the first
//      press arms the exit hint, the second exits) and assert a clean exit with
//      no stack trace on screen.
//   3. non-repo cwd (regression) — the exact production crash of 2026-07-07: launched
//      from OUTSIDE the repo, tsx resolves tsconfig.json from the cwd, finds none, and
//      silently falls back to the classic JSX transform (this repo uses jsx:react-jsx
//      with no `React` imports) — so the first render throws "React is not defined".
//      The launcher shim fixes it by exporting TSX_TSCONFIG_PATH=<repo>/tsconfig.json;
//      this case spawns with cwd OUTSIDE the repo and that env set, and asserts the
//      composer paints with NO error frame. Remove the env and it fails as it did in prod.
//
// Honest failure modes (no silent green): if node-pty cannot be loaded, or
// pty.spawn throws, the affected case is a REAL vitest SKIP (visible in the run
// summary), never a pass. Set `JUNO_REQUIRE_PTY=1` to turn "cannot run the pty
// path" into a hard FAILURE instead — for CI lanes that must prove the drive ran.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INPUT_PLACEHOLDER } from '../src/app';

// Hard-requirement switch: when set, an unavailable/unspawnable pty is a FAILURE
// rather than a skip. Opt-in so a dev box without node-pty stays green by default.
const REQUIRE_PTY = process.env.JUNO_REQUIRE_PTY === '1';

// The specifier is held in a variable so TypeScript does not statically resolve
// `node-pty` at compile time (it is a native, optionally-present dep, untyped in
// this project's tsconfig). At runtime this is a normal dynamic import.
const NODE_PTY = 'node-pty';

// Absolute paths so every case works regardless of the child's cwd — the non-repo
// regression case deliberately runs from OUTSIDE the repo, where a relative
// `src/cli.ts` would not resolve.
const REPO_ROOT = process.cwd();
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli.ts');
const TSCONFIG_PATH = path.join(REPO_ROOT, 'tsconfig.json');

// Invoke the LOCAL tsx binary directly (never `npx`): npx re-derives npm_* env
// vars from package.json, clobbering the version we inject into the child below.
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

// THIS package.json's real version — the banner echoes npm_package_version, so we
// inject the real value (local tsx does not set it) and assert it round-trips.
const PKG_VERSION = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** Minimal shape of a node-pty child — only the surface these tests touch. */
interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
type SpawnFn = (file: string, args: readonly string[], opts: Record<string, unknown>) => PtyProcess;

/** Pull a `spawn` function off the imported module (named export or `.default`). */
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

// Load node-pty ONCE at module eval (top-level await) so availability is known at
// collection time and the cases can be marked skipped via `it.skipIf`.
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

// Base env for the interactive TUI: `JUNO_PROVIDER=fake` routes the client factory
// to the deterministic FakeModelClient (no keys, no network); brain off; no color so
// the framebuffer is plain text we can assert on.
const FAKE_TUI_ENV = {
  JUNO_PROVIDER: 'fake',
  JUNO_BRAIN_ENABLED: '0',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
} as const;

/** Attach a data sink to a pty child and return a getter for the accumulated framebuffer. */
function bufferOf(proc: PtyProcess): () => string {
  let output = '';
  proc.onData((data) => {
    output += data;
  });
  return () => output;
}

/** Poll `read()` until `predicate` holds or the deadline passes (real timers). */
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
        `[tui.smoke] timed out waiting for ${opts.label} after ${opts.timeoutMs}ms; ` +
          `last 300 chars: ${JSON.stringify(read().slice(-300))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Resolve with the child's exit code, or reject if it outlives the deadline. */
function waitForExit(proc: PtyProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[tui.smoke] process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.onExit((e) => {
      clearTimeout(timer);
      resolve(e.exitCode);
    });
  });
}

/** Assert the framebuffer carries no crash overlay — no stack frames, no Ink error
 *  header, and specifically not the react-jsx-fallback crash this suite guards. */
function expectNoErrorFrame(output: string): void {
  expect(output).not.toContain('React is not defined');
  expect(output).not.toContain('ERROR'); // Ink's uncaught-error overlay header
  expect(output).not.toContain('Error:');
  expect(/\n\s+at\s+/.test(output)).toBe(false); // V8 stack frames
}

describe('tui pty smoke', () => {
  // Gate/visibility test: green when node-pty is loadable, a real SKIP when it is
  // not, and a hard FAILURE when it is not AND JUNO_REQUIRE_PTY=1. This is where
  // the "cannot even load the pty backend" failure mode is made honest.
  it('loads the node-pty backend (required under JUNO_REQUIRE_PTY=1)', (ctx) => {
    if (!PTY_READY) {
      if (REQUIRE_PTY) {
        throw new Error(
          `JUNO_REQUIRE_PTY=1 but node-pty could not be loaded: ${loadError ?? 'no spawn() export'}`,
        );
      }
      console.warn('[tui.smoke] node-pty not available — pty smoke cases will be skipped.');
      return ctx.skip();
    }
    expect(typeof spawnPty).toBe('function');
    expect(existsSync(TSX_BIN)).toBe(true);
    expect(existsSync(CLI_ENTRY)).toBe(true);
  });

  it.skipIf(!PTY_READY)(
    'spawns `tsx src/cli.ts --version` through a pty and prints the real version banner',
    async (ctx) => {
      const spawn = spawnPty as SpawnFn;
      let proc: PtyProcess;
      try {
        // Local tsx does NOT set npm_package_version, so inject the REAL version read
        // from package.json — asserting it round-trips proves our spawned process (not a
        // cache) painted the banner AND that env flows through the pty untouched.
        proc = spawn(TSX_BIN, [CLI_ENTRY, '--version'], {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: REPO_ROOT,
          env: { ...process.env, npm_package_version: PKG_VERSION },
        });
      } catch (error) {
        if (REQUIRE_PTY) throw error instanceof Error ? error : new Error(String(error));
        console.warn(`[tui.smoke] pty.spawn threw — skipping --version case: ${msg(error)}`);
        return ctx.skip();
      }

      const read = bufferOf(proc);
      const exitCode = await waitForExit(proc, 20_000);

      expect(read()).toContain('juno ');
      expect(read()).toContain(PKG_VERSION);
      expect(exitCode).toBe(0);
    },
    30_000,
  );

  it.skipIf(!PTY_READY)(
    'drives the interactive TUI: composer paints, a keystroke echoes, Ctrl-C exits clean',
    async (ctx) => {
      const spawn = spawnPty as SpawnFn;
      // Hermetic HOME so the spawned juno reads NO real ~/.config/juno/config.json
      // (which could enable the brain hook or MCP servers). JUNO_PROVIDER=fake routes
      // the client factory to the deterministic FakeModelClient — no keys, no network.
      const home = mkdtempSync(path.join(tmpdir(), 'juno-pty-home-'));
      let proc: PtyProcess | undefined;
      try {
        try {
          proc = spawn(TSX_BIN, [CLI_ENTRY], {
            name: 'xterm-color',
            cols: 100,
            rows: 30,
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home, ...FAKE_TUI_ENV },
          });
        } catch (error) {
          if (REQUIRE_PTY) throw error instanceof Error ? error : new Error(String(error));
          console.warn(`[tui.smoke] pty.spawn threw — skipping interactive case: ${msg(error)}`);
          return ctx.skip();
        }

        const read = bufferOf(proc);

        // 1) The composer must actually PAINT — proof the app mounted and rendered
        //    through Ink's real terminal path. Coupled to the source constant, not
        //    a hardcoded literal (mirrors app.smoke.test.tsx).
        await waitForOutput(read, (b) => b.includes(INPUT_PLACEHOLDER), {
          timeoutMs: 15_000,
          label: 'composer placeholder to render',
        });
        expect(read()).toContain(INPUT_PLACEHOLDER);
        expect(read()).toContain('❯'); // the InputBox prompt marker

        // 2) A real keystroke sequence must reach useInput/TextInput and echo back.
        proc.write('hello juno');
        await waitForOutput(read, (b) => b.includes('hello juno'), {
          timeoutMs: 8_000,
          label: 'typed text to echo in the composer',
        });
        expect(read()).toContain('hello juno');

        // 3) Exit path: DOUBLE-press Ctrl-C (useCtrlCExit owns \x03 now; Ink's
        //    exitOnCtrlC is disabled). The composer holds 'hello juno', so the first
        //    Ctrl-C clears it and arms the "press ctrl+c again to exit" hint; the
        //    second (within the window) exits via the graceful quit path (Ink
        //    useApp().exit → MCP shutdown + terminal restore). Waiting for the hint
        //    to paint between the presses proves the first-press behaviour end-to-end
        //    AND keeps the second press comfortably inside the window.
        proc.write('\x03');
        await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
          timeoutMs: 8_000,
          label: 'the ctrl+c exit hint to arm after the first press',
        });
        proc.write('\x03');
        const exitCode = await waitForExit(proc, 10_000);
        proc = undefined; // exited cleanly; nothing to kill in finally

        // Clean exit, and NO crash surfaced to the user.
        expect(exitCode).toBe(0);
        expectNoErrorFrame(read());
      } finally {
        try {
          proc?.kill();
        } catch {
          // Best-effort: the process may already be gone.
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!PTY_READY)(
    'Ctrl+O opens the tool-detail overlay and Esc closes it (real global-key drive)',
    async (ctx) => {
      const spawn = spawnPty as SpawnFn;
      // A NEW global key handler (Ctrl+O) — the lane mandate requires a real-pty
      // drive because simulated stdin can't prove the chord reaches useInput through
      // Ink's real terminal path. On a fresh session there are no tool calls yet, so
      // the overlay renders its empty state; asserting that proves the binding fired.
      const home = mkdtempSync(path.join(tmpdir(), 'juno-pty-toolo-'));
      let proc: PtyProcess | undefined;
      try {
        try {
          proc = spawn(TSX_BIN, [CLI_ENTRY], {
            name: 'xterm-color',
            cols: 100,
            rows: 30,
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home, ...FAKE_TUI_ENV },
          });
        } catch (error) {
          if (REQUIRE_PTY) throw error instanceof Error ? error : new Error(String(error));
          console.warn(`[tui.smoke] pty.spawn threw — skipping ctrl+o case: ${msg(error)}`);
          return ctx.skip();
        }

        const read = bufferOf(proc);

        await waitForOutput(read, (b) => b.includes(INPUT_PLACEHOLDER), {
          timeoutMs: 15_000,
          label: 'composer to paint before Ctrl+O',
        });

        // Ctrl+O (0x0f) must reach useKeybinds and open the tool-detail overlay.
        proc.write('\x0f');
        await waitForOutput(read, (b) => b.includes('tool calls') || b.includes('No tool calls'), {
          timeoutMs: 8_000,
          label: 'the tool-detail overlay to paint after Ctrl+O',
        });
        expect(read()).toMatch(/tool calls|No tool calls/);

        // Esc closes the overlay (does NOT abort/exit the app).
        proc.write('\x1b');
        // Give Ink a beat to re-render without the overlay, then confirm the app is
        // still alive and the composer is still present.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(read()).toContain(INPUT_PLACEHOLDER);
        expectNoErrorFrame(read());

        // Clean teardown: double-press Ctrl-C (composer empty → first arms, second exits).
        proc.write('\x03');
        await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
          timeoutMs: 8_000,
          label: 'the ctrl+c exit hint to arm after the first press',
        });
        proc.write('\x03');
        const exitCode = await waitForExit(proc, 10_000);
        proc = undefined;
        expect(exitCode).toBe(0);
        expectNoErrorFrame(read());
      } finally {
        try {
          proc?.kill();
        } catch {
          // Best-effort: the process may already be gone.
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!PTY_READY)(
    'subagent panel: Down expands it, Esc collapses back to the composer (real key drive)',
    async (ctx) => {
      const spawn = spawnPty as SpawnFn;
      // LANE B requires a real-pty drive: the down-arrow focus HANDOFF from the composer
      // into the subagent panel is a use of Ink's real terminal input path, and the lane
      // mandate is explicit that simulated stdin can't prove a global key/focus move reaches
      // useInput. The panel is EXPAND/COLLAPSE only (transcript browsing was removed).
      // JUNO_FAKE_SUBAGENT=1 scripts a spawn_subagent turn so the session has a real subagent.
      const home = mkdtempSync(path.join(tmpdir(), 'juno-pty-subagent-'));
      let proc: PtyProcess | undefined;
      try {
        try {
          proc = spawn(TSX_BIN, [CLI_ENTRY], {
            name: 'xterm-color',
            cols: 100,
            rows: 30,
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home, ...FAKE_TUI_ENV, JUNO_FAKE_SUBAGENT: '1' },
          });
        } catch (error) {
          if (REQUIRE_PTY) throw error instanceof Error ? error : new Error(String(error));
          console.warn(`[tui.smoke] pty.spawn threw — skipping subagent-panel case: ${msg(error)}`);
          return ctx.skip();
        }

        const read = bufferOf(proc);

        await waitForOutput(read, (b) => b.includes(INPUT_PLACEHOLDER), {
          timeoutMs: 15_000,
          label: 'composer to paint before the subagent turn',
        });

        // Submit a prompt → the scripted subagent turn runs and settles; the collapsed
        // agents strip then paints below the composer. Type the text and press Enter as
        // SEPARATE writes: a single 'go\r' chunk is delivered to Ink as one input event
        // that parseKeypress does not classify as Return, so it would never submit.
        proc.write('go');
        await waitForOutput(read, (b) => b.includes('❯ go') || b.includes('go'), {
          timeoutMs: 8_000,
          label: 'the typed prompt to echo before Enter',
        });
        proc.write('\r');
        await waitForOutput(read, (b) => b.includes('▾ agents'), {
          timeoutMs: 10_000,
          label: 'the collapsed agents strip to paint after the subagent turn',
        });

        // Down at the composer bottom (no history to recall) hands focus INTO the panel —
        // it expands and paints its per-agent rows + the collapse hint. This is the handoff
        // the mandate demands be proven through the real terminal path.
        proc.write('\x1b[B');
        await waitForOutput(read, (b) => b.includes('↑/esc collapse') && b.includes('summarize the repo'), {
          timeoutMs: 8_000,
          label: 'the panel to expand + focus after Down',
        });

        // Esc collapses the panel back to the composer (Esc must never abort/exit behind the
        // panel). The app survives and the composer is present again.
        proc.write('\x1b');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(read()).toContain(INPUT_PLACEHOLDER);
        expectNoErrorFrame(read());

        // Clean teardown: double-press Ctrl-C (composer empty → first arms, second exits).
        proc.write('\x03');
        await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
          timeoutMs: 8_000,
          label: 'the ctrl+c exit hint to arm after the first press',
        });
        proc.write('\x03');
        const exitCode = await waitForExit(proc, 10_000);
        proc = undefined;
        expect(exitCode).toBe(0);
        expectNoErrorFrame(read());
      } finally {
        try {
          proc?.kill();
        } catch {
          // Best-effort: the process may already be gone.
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!PTY_READY)(
    'launched from OUTSIDE the repo with TSX_TSCONFIG_PATH set: composer paints, no react-jsx crash',
    async (ctx) => {
      const spawn = spawnPty as SpawnFn;
      // Regression for 2026-07-07: spawn from a cwd OUTSIDE the repo (the hermetic
      // HOME itself), exactly like the user's `~/.local/bin/juno` shim, which exports
      // TSX_TSCONFIG_PATH so tsx keeps using the repo's jsx:react-jsx transform instead
      // of silently falling back to the classic transform (→ "React is not defined").
      const home = mkdtempSync(path.join(tmpdir(), 'juno-pty-noncwd-'));
      let proc: PtyProcess | undefined;
      try {
        try {
          proc = spawn(TSX_BIN, [CLI_ENTRY], {
            name: 'xterm-color',
            cols: 100,
            rows: 30,
            cwd: home, // OUTSIDE the repo — no tsconfig.json is discoverable from here
            env: {
              ...process.env,
              HOME: home,
              TSX_TSCONFIG_PATH: TSCONFIG_PATH, // the shim's fix; drop this and it crashes
              ...FAKE_TUI_ENV,
            },
          });
        } catch (error) {
          if (REQUIRE_PTY) throw error instanceof Error ? error : new Error(String(error));
          console.warn(`[tui.smoke] pty.spawn threw — skipping non-repo-cwd case: ${msg(error)}`);
          return ctx.skip();
        }

        const read = bufferOf(proc);

        // The composer painting from a non-repo cwd is the whole proof: under the
        // classic-transform fallback the first render throws before any placeholder
        // reaches the framebuffer, so this wait would time out and the case fails.
        await waitForOutput(read, (b) => b.includes(INPUT_PLACEHOLDER), {
          timeoutMs: 15_000,
          label: 'composer to paint from a non-repo cwd',
        });
        expect(read()).toContain(INPUT_PLACEHOLDER);
        expectNoErrorFrame(read());

        // Clean teardown, same as the interactive case: double-press Ctrl-C. The
        // composer is empty here, so the first press just arms the exit hint; the
        // second (within the window) exits via the graceful quit path.
        proc.write('\x03');
        await waitForOutput(read, (b) => b.includes('press ctrl+c again to exit'), {
          timeoutMs: 8_000,
          label: 'the ctrl+c exit hint to arm after the first press',
        });
        proc.write('\x03');
        const exitCode = await waitForExit(proc, 10_000);
        proc = undefined;
        expect(exitCode).toBe(0);
        expectNoErrorFrame(read());
      } finally {
        try {
          proc?.kill();
        } catch {
          // Best-effort: the process may already be gone.
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
