// tests/shellSandbox.test.ts
// Pure unit suite for the macOS Seatbelt sandbox helpers: profile generation, the
// SBPL-injection guard (the security-critical bit), argv wrapping, and the startup
// self-test. No real sandbox-exec ever runs — spawn + platform + realpath are
// injected.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSeatbeltProfile,
  buildWrappedArgv,
  createSandboxProvider,
  DEFAULT_SENSITIVE_READ_PATTERNS,
  probeSandboxAvailable,
  type ProbeChildLike,
  type ProbeSpawn,
} from '../src/tools/shellSandbox';

const CWD = '/work/project';
const TMP = '/private/var/folders/tmp.abc';

// --- fake self-test spawn -----------------------------------------------------

interface ProbeBehavior {
  exitCode?: number;
  error?: Error;
  throwOnSpawn?: Error;
  /** Never fire exit/close/error — used to exercise the timeout path. */
  hang?: boolean;
}

function fakeProbeSpawn(behavior: ProbeBehavior): {
  spawn: ProbeSpawn;
  calls: () => number;
  kills: () => number;
  lastArgs: () => readonly string[] | undefined;
} {
  let calls = 0;
  let killCount = 0;
  let lastArgs: readonly string[] | undefined;

  const spawn: ProbeSpawn = (_command, args) => {
    calls += 1;
    lastArgs = args;
    if (behavior.throwOnSpawn !== undefined) {
      throw behavior.throwOnSpawn;
    }
    const exitListeners: Array<(code: number | null) => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];
    const child: ProbeChildLike = {
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): ProbeChildLike {
        if (event === 'error') {
          errorListeners.push(listener as (err: Error) => void);
        } else {
          exitListeners.push(listener as (code: number | null) => void);
        }
        return child;
      },
      kill(): boolean {
        killCount += 1;
        return true;
      },
    };
    // Settle asynchronously (as a real child would) unless told to hang.
    queueMicrotask(() => {
      if (behavior.hang === true) {
        return;
      }
      if (behavior.error !== undefined) {
        for (const l of errorListeners) l(behavior.error);
        return;
      }
      for (const l of exitListeners) l(behavior.exitCode ?? 0);
    });
    return child;
  };

  return { spawn, calls: () => calls, kills: () => killCount, lastArgs: () => lastArgs };
}

// --- buildSeatbeltProfile -----------------------------------------------------

describe('buildSeatbeltProfile', () => {
  it('confines writes to cwd + TMPDIR + std devices and denies every sensitive read', () => {
    const profile = buildSeatbeltProfile(CWD, { tmpdir: TMP });
    expect(profile).toBeDefined();
    const p = profile as string;

    // Structural bones, in the security-relevant order.
    expect(p).toContain('(version 1)');
    expect(p).toContain('(deny default)');
    expect(p.indexOf('(allow file-read*)')).toBeGreaterThan(p.indexOf('(deny default)'));
    // The read-deny block comes AFTER the blanket allow so it wins for those paths.
    expect(p.indexOf('(deny file-read*')).toBeGreaterThan(p.indexOf('(allow file-read*)'));

    // Writes: cwd + TMPDIR + std devices, and NOWHERE else.
    expect(p).toContain('(allow file-write*');
    expect(p).toContain(`(subpath "${CWD}")`);
    expect(p).toContain(`(subpath "${TMP}")`);
    expect(p).toContain('(literal "/dev/null")');
    expect(p).toContain('(literal "/dev/stdout")');
    expect(p).toContain('(literal "/dev/stderr")');
    expect(p).toContain('(literal "/dev/tty")');

    // Every sensitive-read pattern is present as a deny regex.
    for (const pattern of DEFAULT_SENSITIVE_READ_PATTERNS) {
      expect(p).toContain(`(regex #"${pattern}")`);
    }
    // Spot-check the human-meaningful ones are actually covered.
    expect(p).toMatch(/\.env/);
    expect(p).toMatch(/\.pem/);
    expect(p).toMatch(/id_\(rsa/);
    expect(p).toMatch(/\.ssh/);
    expect(p).toMatch(/\.npmrc/);
    expect(p).toMatch(/credentials/);
    expect(p).toMatch(/\.config\/juno/);
  });

  it('denies WRITES over the same sensitive patterns, AFTER the write-allow (closes the mv bypass)', () => {
    const p = buildSeatbeltProfile(CWD, { tmpdir: TMP }) as string;
    // A read-deny alone is bypassable by `mv .env leak && cat leak` (the rename is a
    // metadata write in the allowed cwd, and `leak` no longer matches the read regex).
    // The fix re-denies file-write* over the sensitive patterns; last-match-wins in
    // SBPL means that deny MUST come AFTER the (allow file-write* …) that opens cwd.
    const allowWriteIdx = p.indexOf('(allow file-write*');
    const denyWriteIdx = p.indexOf('(deny file-write*');
    expect(allowWriteIdx).toBeGreaterThan(-1);
    expect(denyWriteIdx).toBeGreaterThan(allowWriteIdx);
    // Every sensitive pattern is denied for BOTH read and write (appears twice).
    for (const pattern of DEFAULT_SENSITIVE_READ_PATTERNS) {
      const occurrences = p.split(`(regex #"${pattern}")`).length - 1;
      expect(occurrences).toBe(2);
    }
  });

  it('covers the widened credential set the critic flagged (gh / git / kube / docker / gcloud / gnupg / .envrc)', () => {
    // `(allow file-read*)` opens everything else, so anything NOT in this set is a
    // plaintext-token leak to the shell. These were live-verified readable before
    // the widening. Assert the human-meaningful ones are covered as deny patterns.
    const p = buildSeatbeltProfile(CWD, { tmpdir: TMP }) as string;
    expect(p).toMatch(/\.envrc/); // direnv — not matched by the .env regex
    expect(p).toMatch(/\.git-credentials/); // git plaintext token store
    expect(p).toMatch(/\.config\/gh/); // GitHub CLI OAuth token
    expect(p).toMatch(/\.config\/gcloud/); // gcloud creds
    expect(p).toMatch(/\.kube/); // kubeconfig
    expect(p).toMatch(/\.docker/); // docker registry auth
    expect(p).toMatch(/\.gnupg/); // GnuPG keyring
  });

  it('allows signalling own children within the same sandbox (job control / kill $!)', () => {
    // Without this, kill(2) inside the sandbox fails EPERM and breaks shell job
    // control, test runners, and `concurrently`-style wrappers. Scoped to
    // same-sandbox so it stays confinement-neutral (cannot reach outside procs).
    const p = buildSeatbeltProfile(CWD, { tmpdir: TMP }) as string;
    expect(p).toContain('(allow signal (target same-sandbox))');
  });

  it('defaults network to ALLOW but honors an explicit deny', () => {
    expect(buildSeatbeltProfile(CWD, { tmpdir: TMP })).toContain('(allow network*)');
    expect(buildSeatbeltProfile(CWD, { tmpdir: TMP, allowNetwork: true })).toContain(
      '(allow network*)',
    );
    expect(buildSeatbeltProfile(CWD, { tmpdir: TMP, allowNetwork: false })).not.toContain(
      '(allow network*)',
    );
  });

  it('omits the TMPDIR write rule when no TMPDIR is given (still a valid profile)', () => {
    const p = buildSeatbeltProfile(CWD) as string;
    expect(p).toBeDefined();
    expect(p).toContain(`(subpath "${CWD}")`);
    // Only the cwd subpath — no second subpath line.
    expect(p.match(/\(subpath /g)).toHaveLength(1);
  });

  it('allows ordinary paths with spaces and hyphens (not an injection)', () => {
    const p = buildSeatbeltProfile('/Users/x/My Project-2020');
    expect(p).toBeDefined();
    expect(p as string).toContain('(subpath "/Users/x/My Project-2020")');
  });

  // --- THE injection guard (this exact bug class hit Codex) --------------------
  it('REJECTS a cwd that could break out of the SBPL string literal', () => {
    expect(buildSeatbeltProfile('/work/e"vil')).toBeUndefined(); // double-quote
    expect(buildSeatbeltProfile('/work/evil)')).toBeUndefined(); // close paren
    expect(buildSeatbeltProfile('/work/evil(')).toBeUndefined(); // open paren
    expect(buildSeatbeltProfile('/work/ev\\il')).toBeUndefined(); // backslash
    expect(buildSeatbeltProfile('/work/ev\nil')).toBeUndefined(); // newline
    expect(buildSeatbeltProfile('/work/ev\ril')).toBeUndefined(); // carriage return
    expect(buildSeatbeltProfile('/work/ev\til')).toBeUndefined(); // tab (control)
    expect(buildSeatbeltProfile('')).toBeUndefined(); // empty
  });

  it('REJECTS an injecting TMPDIR too (env-controlled literal)', () => {
    expect(buildSeatbeltProfile(CWD, { tmpdir: '/tmp/") (allow file-write* (subpath "/' })).toBeUndefined();
    expect(buildSeatbeltProfile(CWD, { tmpdir: '/tmp/ev\nil' })).toBeUndefined();
  });
});

// --- buildWrappedArgv ---------------------------------------------------------

describe('buildWrappedArgv', () => {
  it('wraps as sandbox-exec -p <profile> <shell> -c <command>', () => {
    const wrapped = buildWrappedArgv(CWD, 'sh', 'npm test', { tmpdir: TMP });
    expect(wrapped).toBeDefined();
    const w = wrapped as { command: string; args: string[] };
    expect(w.command).toBe('sandbox-exec');
    expect(w.args[0]).toBe('-p');
    expect(w.args[1]).toBe(buildSeatbeltProfile(CWD, { tmpdir: TMP }));
    expect(w.args[2]).toBe('sh');
    expect(w.args[3]).toBe('-c');
    expect(w.args[4]).toBe('npm test');
    expect(w.args).toHaveLength(5);
    // Uses inline -p, never a temp-file -f (no TOCTOU on a profile file).
    expect(w.args).not.toContain('-f');
  });

  it('returns undefined (fail-closed) when the profile cannot be built', () => {
    expect(buildWrappedArgv('/work/e"vil', 'sh', 'ls')).toBeUndefined();
  });
});

// --- probeSandboxAvailable ----------------------------------------------------

describe('probeSandboxAvailable', () => {
  it('is false on non-darwin WITHOUT spawning', async () => {
    const probe = fakeProbeSpawn({ exitCode: 0 });
    expect(await probeSandboxAvailable({ platform: 'linux', spawn: probe.spawn })).toBe(false);
    expect(await probeSandboxAvailable({ platform: 'win32', spawn: probe.spawn })).toBe(false);
    expect(probe.calls()).toBe(0);
  });

  it('is true when the self-test exits 0 on darwin', async () => {
    const probe = fakeProbeSpawn({ exitCode: 0 });
    expect(await probeSandboxAvailable({ platform: 'darwin', spawn: probe.spawn })).toBe(true);
    expect(probe.calls()).toBe(1);
    // Self-test uses the minimal allow-all profile against /usr/bin/true.
    expect(probe.lastArgs()).toEqual(['-p', '(version 1)(allow default)', '/usr/bin/true']);
  });

  it('is false when the self-test exits non-zero', async () => {
    const probe = fakeProbeSpawn({ exitCode: 1 });
    expect(await probeSandboxAvailable({ platform: 'darwin', spawn: probe.spawn })).toBe(false);
  });

  it('is false when the self-test errors (e.g. sandbox-exec missing)', async () => {
    const probe = fakeProbeSpawn({ error: new Error('ENOENT') });
    expect(await probeSandboxAvailable({ platform: 'darwin', spawn: probe.spawn })).toBe(false);
  });

  it('is false when spawn throws synchronously', async () => {
    const probe = fakeProbeSpawn({ throwOnSpawn: new Error('spawn EACCES') });
    expect(await probeSandboxAvailable({ platform: 'darwin', spawn: probe.spawn })).toBe(false);
  });

  it('is false on timeout and kills the wedged child', async () => {
    const probe = fakeProbeSpawn({ hang: true });
    let fireTimeout: (() => void) | undefined;
    const setTimer = (fn: () => void): { clear: () => void } => {
      fireTimeout = fn;
      return { clear: () => (fireTimeout = undefined) };
    };
    const resultP = probeSandboxAvailable({
      platform: 'darwin',
      spawn: probe.spawn,
      setTimer,
      timeoutMs: 2_000,
    });
    // Let the spawn microtask (which does nothing, hang:true) drain, then time out.
    await Promise.resolve();
    expect(fireTimeout).toBeDefined();
    fireTimeout?.();
    expect(await resultP).toBe(false);
    expect(probe.kills()).toBe(1);
  });
});

// --- createSandboxProvider ----------------------------------------------------

describe('createSandboxProvider', () => {
  it('unavailable on non-darwin ⇒ buildWrappedArgv always returns undefined', async () => {
    const probe = fakeProbeSpawn({ exitCode: 0 });
    const provider = await createSandboxProvider({
      platform: 'linux',
      spawn: probe.spawn,
      env: { TMPDIR: TMP },
    });
    expect(provider.available).toBe(false);
    expect(provider.buildWrappedArgv(CWD, 'sh', 'ls')).toBeUndefined();
  });

  it('available on darwin ⇒ wraps with the canonicalized TMPDIR from env', async () => {
    const probe = fakeProbeSpawn({ exitCode: 0 });
    const provider = await createSandboxProvider({
      platform: 'darwin',
      spawn: probe.spawn,
      env: { TMPDIR: '/tmp/link' },
      realpath: async (p) => (p === '/tmp/link' ? '/private/tmp/real' : p),
    });
    expect(provider.available).toBe(true);
    const wrapped = provider.buildWrappedArgv(CWD, 'sh', 'ls');
    expect(wrapped).toBeDefined();
    expect((wrapped as { args: string[] }).args[1]).toContain('(subpath "/private/tmp/real")');
  });
});

// --- live sandbox-exec integration (darwin only) ------------------------------
// The pure tests prove the profile TEXT; this proves the KERNEL actually enforces
// it — the only way to be sure the `mv .env leak` bypass is really closed. Skipped
// off darwin and when sandbox-exec cannot self-test (CI Linux, or Apple removing
// the deprecated binary), which is exactly the fail-closed condition elsewhere.
function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  const r = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return r.status === 0;
}

describe.skipIf(!sandboxExecUsable())('live sandbox-exec enforcement', () => {
  function runConfined(dir: string, command: string): { status: number | null; out: string } {
    const wrapped = buildWrappedArgv(dir, '/bin/sh', command, {
      tmpdir: realpathSync(tmpdir()),
    });
    expect(wrapped).toBeDefined();
    const w = wrapped as { command: string; args: string[] };
    const r = spawnSync(w.command, w.args, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  let dir = '';
  const secret = 'SECRET=topsecret_do_not_leak';
  // Fresh sensitive files per test — writes/renames may be attempted.
  const setup = (): void => {
    dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'juno-sbx-')));
    writeFileSync(join(dir, '.env'), `${secret}\n`);
    writeFileSync(join(dir, 'normal.txt'), 'PLAIN=ok\n');
  };

  it('denies `cat .env` (read-deny works)', () => {
    setup();
    try {
      const r = runConfined(dir, 'cat .env');
      expect(r.status).not.toBe(0);
      expect(r.out).not.toContain('topsecret');
      expect(r.out.toLowerCase()).toContain('operation not permitted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies `mv .env leak && cat leak` — the rename bypass is closed', () => {
    setup();
    try {
      const r = runConfined(dir, 'mv .env leak && cat leak');
      // The mv itself must be EPERM; the secret must never reach a readable name.
      expect(r.status).not.toBe(0);
      expect(r.out).not.toContain('topsecret');
      expect(r.out.toLowerCase()).toContain('operation not permitted');
      // .env untouched, no leaked copy created.
      expect(existsSync(join(dir, '.env'))).toBe(true);
      expect(existsSync(join(dir, 'leak'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still allows ordinary read/write inside the workspace cwd', () => {
    setup();
    try {
      const r = runConfined(dir, 'cat normal.txt && echo more >> normal.txt && echo DONE_OK');
      expect(r.status).toBe(0);
      expect(r.out).toContain('PLAIN=ok');
      expect(r.out).toContain('DONE_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
