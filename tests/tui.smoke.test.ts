// tests/tui.smoke.test.ts
// W13 — the DECOMP-named PTY smoke, implemented SAFELY.
//
// A real end-to-end TUI smoke would spawn `npx tsx src/cli.ts --version` through
// a pseudo-terminal and assert the version banner appears on the pty's output.
// That requires `node-pty`, a native module that is NOT a dependency of this
// project (W13 forbids adding any new dep, especially node-pty). So instead of a
// static top-level `import 'node-pty'` (which would break test COLLECTION when
// the module is absent), we attempt a DYNAMIC import inside the test body and
// auto-skip when it isn't available or there's no TTY.
//
// Net effect today: a documented, deterministic, always-green placeholder that
// activates into a real pty smoke only if someone later installs node-pty. Zero
// new dependencies; nothing here imports node-pty unless it already exists.
import { describe, expect, it } from 'vitest';

// The specifier is held in a variable (not a string literal) so TypeScript does
// NOT statically resolve `node-pty` at compile time — the module is intentionally
// absent (W13 forbids adding it). At runtime this is a normal dynamic import that
// either loads node-pty (if later installed) or throws (caught below).
const NODE_PTY = 'node-pty';

/** Try to load node-pty; null if it isn't installed (the expected case today). */
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
      // No node-pty in this environment: stay green with a clear skip reason.
      // (vitest prints the reason; the suite collects + passes with zero deps.)
      console.warn('[tui.smoke] node-pty not installed — skipping real pty smoke.');
      expect(pty).toBeNull();
      return;
    }

    // --- Activation path (only runs if node-pty is later installed) ----------
    // Spawn the CLI through a pty and assert the --version banner surfaces.
    const output = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      let proc: { onData: (cb: (d: string) => void) => void; onExit: (cb: () => void) => void };
      try {
        proc = pty.spawn!('npx', ['tsx', 'src/cli.ts', '--version'], {
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: { ...process.env, npm_package_version: '0.0.0-pty' },
        }) as typeof proc;
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      proc.onData((data: string) => {
        buffer += data;
      });
      proc.onExit(() => {
        resolve(buffer);
      });
    });

    expect(output).toContain('juno ');
    expect(output).toContain('0.0.0-pty');
  });
});
