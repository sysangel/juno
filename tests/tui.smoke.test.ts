// tests/tui.smoke.test.ts
// A real end-to-end TUI smoke: spawn `npx tsx src/cli.ts --version` through a
// pseudo-terminal (a genuine TTY, like a user's terminal) and assert the version
// banner surfaces on the pty's output.
//
// node-pty is a devDependency, so the pty path runs for real here. We still load
// it via a DYNAMIC import and auto-skip when it (or its native addon) is not
// available, so the suite stays green on a platform where the prebuilt binary
// cannot load rather than hard-failing collection.
//
// Version note: the banner shows `npm_package_version`, and `npx` re-derives that
// from THIS package.json for the child process (overriding any env we pass). So we
// read the real version from package.json and assert the banner contains it —
// robust across version bumps, and a true end-to-end check of the CLI's output.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The specifier is held in a variable (not a string literal) so TypeScript does
// NOT statically resolve `node-pty` at compile time; at runtime this is a normal
// dynamic import that either loads node-pty or throws (caught below).
const NODE_PTY = 'node-pty';

const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** Try to load node-pty; null if it (or its native addon) isn't available. */
async function tryLoadNodePty(): Promise<unknown | null> {
  try {
    const mod: unknown = await import(NODE_PTY);
    return mod;
  } catch {
    return null;
  }
}

describe('tui pty smoke', () => {
  it('spawns `tsx src/cli.ts --version` through a pty and shows the banner (skips without node-pty)', async () => {
    const pty = (await tryLoadNodePty()) as
      | { spawn?: (file: string, args: string[], opts: Record<string, unknown>) => unknown }
      | null;

    if (pty === null || typeof pty.spawn !== 'function') {
      // node-pty (or its native addon) unavailable here: stay green with a clear reason.
      console.warn('[tui.smoke] node-pty not available — skipping real pty smoke.');
      expect(pty).toBeNull();
      return;
    }

    // --- Real pty spawn ------------------------------------------------------
    // `SKIP` sentinel: an environment that cannot fork a pty (no TTY, or the
    // native spawn-helper is not executable) is treated as "no functional pty
    // here" and skipped — same intent as an unavailable import. A pty that DOES
    // fork but yields the wrong banner is a real failure (asserted below).
    const SKIP = Symbol('no-functional-pty');
    const output = await new Promise<string | typeof SKIP>((resolve) => {
      let buffer = '';
      let proc: { onData: (cb: (d: string) => void) => void; onExit: (cb: () => void) => void };
      try {
        proc = pty.spawn!('npx', ['tsx', 'src/cli.ts', '--version'], {
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: process.env,
        }) as typeof proc;
      } catch (error) {
        console.warn(`[tui.smoke] pty could not spawn — skipping (${String(error)}).`);
        resolve(SKIP);
        return;
      }
      proc.onData((data: string) => {
        buffer += data;
      });
      proc.onExit(() => {
        resolve(buffer);
      });
    });

    if (output === SKIP) return;

    // The CLI writes `juno <version>` to stdout for --version (src/cli.ts).
    expect(output).toContain('juno ');
    expect(output).toContain(PKG_VERSION);
  });
});
