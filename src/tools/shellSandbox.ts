// src/tools/shellSandbox.ts
// Wave 12 — macOS OS-level confinement for `run_shell`.
//
// On darwin ONLY, the shell child is wrapped in `sandbox-exec -p <profile>` with
// a generated Seatbelt (SBPL) profile that:
//   - confines file WRITES to the canonicalized workspace cwd + TMPDIR + the
//     std devices (/dev/null, /dev/stdout, /dev/stderr, /dev/tty), and
//   - DENIES both reads AND writes of a sensitive-path set (.env/.envrc, *.pem,
//     ssh keys, .ssh/**, .gnupg, .npmrc, .netrc, cloud/registry creds —
//     .aws/credentials, .git-credentials, ~/.config/gh, ~/.config/gcloud, .kube,
//     .docker — and juno's own ~/.config/juno). This Seatbelt deny is the ONLY
//     thing that can stop a shell command from reading those files (e.g. `cat .env`):
//     a file-level tool guard inspects the tool's arguments, not the text a shell
//     interprets, so it cannot see what a command actually reads.
//
//     The deny covers WRITES as well as reads for the SAME patterns on purpose: a
//     read-deny alone is trivially bypassed by renaming the file out of the pattern
//     inside the writable cwd (`mv .env leak && cat leak` — the rename is a metadata
//     write in the allowed subpath, and the renamed path no longer matches the
//     read-deny regex). Denying file-write* over the sensitive patterns makes the
//     rename/hardlink itself EPERM, so the secret can never be moved into a readable
//     name. Symlink reads are already covered because Seatbelt evaluates the
//     resolved canonical path against the read-deny.
//
// This module is PURE and INJECTABLE: no globals, no direct fs/clock/spawn — the
// caller passes platform + spawn + env so the profile builder and the startup
// self-test are unit-testable. Everything here fails CLOSED: if a safe profile
// cannot be built (a cwd/TMPDIR that cannot be embedded as a literal without
// SBPL injection), the builder returns `undefined` and the shell tool refuses to
// run rather than spawning an unconfined child.
//
// Linux (bwrap/landlock) is explicitly OUT of scope: on non-darwin the provider
// is never `available`, so run_shell keeps its always-prompt behavior.
import { spawn as nodeSpawn } from 'node:child_process';

/**
 * The confinement contract the shell tool depends on. `available` is decided
 * ONCE at startup (see probeSandboxAvailable) and single-sources BOTH the
 * wrapping decision AND run_shell's risk classification, so a tool that reports
 * `risk:'sandboxed'` (auto-allow) is provably the same one that wraps its child.
 */
export interface SandboxProvider {
  /** True only when confinement is genuinely enforceable on this host. */
  readonly available: boolean;
  /**
   * Build the wrapped argv for one command, or `undefined` when a safe profile
   * cannot be built for `canonicalCwd` (SBPL-injection guard) — in which case the
   * caller MUST fail closed and NOT spawn. `canonicalCwd` must already be
   * realpath-canonicalized (Seatbelt matches canonical paths).
   */
  buildWrappedArgv(
    canonicalCwd: string,
    shell: string,
    command: string,
  ): { command: string; args: string[] } | undefined;
}

export interface SeatbeltProfileOptions {
  /** Canonicalized TMPDIR to grant writes to. Omitted ⇒ no TMPDIR write rule
   * (most builds break, but never a security hole). A TMPDIR that fails the
   * injection guard makes the whole profile build fail closed. */
  tmpdir?: string;
  /** Grant `(allow network*)`. Default true — git/npm need it and the child env
   * is already secret-stripped, so residual exfil risk is bounded. A config knob. */
  allowNetwork?: boolean;
  /** SBPL regex fragments (matched against the absolute canonical path) whose
   * READS **and WRITES** are denied. Defaults to DEFAULT_SENSITIVE_READ_PATTERNS.
   * The write-deny (over the same patterns) is what closes the `mv .env leak`
   * rename bypass — see buildSeatbeltProfile. These are STATIC, caller-controlled
   * constants — never interpolated user input — so they carry no injection surface
   * (unlike the cwd/TMPDIR literals). */
  denyReadPatterns?: readonly string[];
}

/**
 * Sensitive paths whose READS and WRITES the sandbox denies. Mirrors rank-9's
 * file-tool deny set (any .env, .pem, id_rsa, the .ssh tree, .npmrc, credentials)
 * and widens it with the credential stores that `(allow file-read*)` would otherwise
 * leave world-readable to a shell command: GitHub CLI / git / gcloud / kube /
 * docker / GnuPG creds, plus direnv `.envrc` (which the `.env` regex does NOT
 * match). Because run_shell auto-allows when sandboxed, this Seatbelt deny — not a
 * human prompt — is the sole barrier against `cat ~/.config/gh/hosts.yml`,
 * `cat .git-credentials`, etc., so the set must be broad. Expressed as SBPL regex
 * fragments matched against the absolute canonical path, so no personal absolute
 * path is ever embedded (home-relative dotfiles match wherever HOME lives).
 * Overridable via SeatbeltProfileOptions.
 */
export const DEFAULT_SENSITIVE_READ_PATTERNS: readonly string[] = [
  '/\\.env($|\\.[^/]*$)', // .env, .env.local, .env.production, …
  '/\\.envrc$', // direnv — secrets live here too (not matched by the .env regex)
  '\\.pem$', // TLS/cert private keys
  '/id_(rsa|dsa|ecdsa|ed25519)$', // ssh private keys
  '/\\.ssh($|/)', // the whole ~/.ssh tree
  '/\\.gnupg($|/)', // GnuPG keyring / private keys
  '/\\.npmrc$', // npm auth token
  '/\\.netrc$', // netrc creds
  '/\\.aws/credentials$', // AWS static creds
  '/\\.git-credentials$', // git store — plaintext tokens
  '/\\.config/gh($|/)', // GitHub CLI OAuth token (hosts.yml)
  '/\\.config/gcloud($|/)', // gcloud application-default creds
  '/\\.kube($|/)', // kubeconfig — cluster tokens/certs
  '/\\.docker($|/)', // docker registry auth (config.json)
  '/\\.config/juno($|/)', // juno's own config/secret dir
];

/**
 * Characters that cannot appear inside an SBPL `(subpath "…")` / `(literal "…")`
 * double-quoted string literal without risking a breakout that neuters the
 * confinement (this exact bug class hit Codex): a double-quote closes the string,
 * a backslash starts an escape, parens are list delimiters, and any control char
 * (newline/CR/tab/NUL/…) can terminate or corrupt the s-expression. A path
 * containing ANY of these is REJECTED (the profile builder returns undefined and
 * the caller fails closed) rather than escaped — provably safe over cleverness.
 */
const UNSAFE_LITERAL = /["\\()\u0000-\u001f\u007f]/;

/** True when `p` is a non-empty path safe to embed verbatim in an SBPL string literal. */
function safeLiteral(p: string): boolean {
  return p.length > 0 && !UNSAFE_LITERAL.test(p);
}

/**
 * Build the Seatbelt (SBPL) profile text for `canonicalCwd`, or `undefined` when
 * `canonicalCwd` (or a provided TMPDIR) cannot be safely embedded as a string
 * literal — the injection guard that makes the whole feature fail closed.
 *
 * Shape (modeled on Codex/Claude Code's macOS Seatbelt profile): deny-by-default,
 * allow process/signal-within-same-sandbox/sysctl-read/mach-lookup, allow-all-reads
 * then subtract the sensitive set, confine writes to cwd+TMPDIR+std-devices then
 * subtract the SAME sensitive set from writes (rules are last-match-wins, so the
 * write-deny must follow the write-allow to override it inside the cwd subpath),
 * and a network decision. Denying writes over the sensitive patterns is what closes
 * the `mv .env leak && cat leak` rename bypass — the rename/hardlink of a sensitive
 * file becomes EPERM, so it can never be moved into a name the read-deny misses.
 * The `signal` allowance is scoped to `same-sandbox` so a command can signal its OWN
 * children (job control, test runners, `concurrently`-style wrappers) without being
 * able to reach processes outside the sandbox.
 */
export function buildSeatbeltProfile(
  canonicalCwd: string,
  opts: SeatbeltProfileOptions = {},
): string | undefined {
  if (!safeLiteral(canonicalCwd)) {
    return undefined;
  }
  const { tmpdir } = opts;
  if (tmpdir !== undefined && !safeLiteral(tmpdir)) {
    return undefined;
  }
  const allowNetwork = opts.allowNetwork ?? true;
  const denyPatterns = opts.denyReadPatterns ?? DEFAULT_SENSITIVE_READ_PATTERNS;

  const denyLines = denyPatterns.map((p) => `  (regex #"${p}")`).join('\n');
  const writeLines = [
    `  (subpath "${canonicalCwd}")`,
    ...(tmpdir !== undefined ? [`  (subpath "${tmpdir}")`] : []),
    '  (literal "/dev/null")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty")',
  ].join('\n');

  const blocks = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    // Confined to the same sandbox: a command must be able to signal its own
    // children (job control, `kill $!`, test runners) — without this, kill(2)
    // fails EPERM and breaks those wrappers. Neutral to confinement: it cannot
    // reach processes outside this sandbox.
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(deny file-read*\n${denyLines}\n)`,
    `(allow file-write*\n${writeLines}\n)`,
    // The write-deny MUST come after the write-allow (last-match-wins): it re-denies
    // the sensitive patterns inside the otherwise-writable cwd/TMPDIR so a rename or
    // hardlink of `.env` (etc.) into a read-allowed name is itself EPERM. This is the
    // repair that closes the `mv .env leak && cat leak` bypass of the read-deny.
    `(deny file-write*\n${denyLines}\n)`,
  ];
  if (allowNetwork) {
    blocks.push('(allow network*)');
  }
  return `${blocks.join('\n')}\n`;
}

/**
 * Build the `sandbox-exec` argv wrapping `shell -c command`, or `undefined` when a
 * safe profile cannot be built (⇒ caller fails closed). Uses `-p` (inline profile)
 * NOT `-f` (temp file) to avoid a TOCTOU/cleanup race on a profile file.
 */
export function buildWrappedArgv(
  canonicalCwd: string,
  shell: string,
  command: string,
  opts: SeatbeltProfileOptions = {},
): { command: string; args: string[] } | undefined {
  const profile = buildSeatbeltProfile(canonicalCwd, opts);
  if (profile === undefined) {
    return undefined;
  }
  return { command: 'sandbox-exec', args: ['-p', profile, shell, '-c', command] };
}

// --- startup self-test --------------------------------------------------------

/** Minimal child surface the self-test needs; the real spawn structurally fits. */
export interface ProbeChildLike {
  on(event: 'exit' | 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ProbeSpawn = (command: string, args: readonly string[]) => ProbeChildLike;

interface ProbeTimerHandle {
  clear: () => void;
}

export interface ProbeSandboxDeps {
  /** `process.platform`. Anything but 'darwin' ⇒ immediately unavailable. */
  platform: NodeJS.Platform;
  /** Injectable spawn (default node:child_process.spawn, stdio ignored). */
  spawn: ProbeSpawn;
  /** Injectable scheduler so the timeout is deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => ProbeTimerHandle;
  /** Self-test timeout (ms). Default 2000. */
  timeoutMs?: number;
}

const SELF_TEST_PROFILE = '(version 1)(allow default)';
const SELF_TEST_TARGET = '/usr/bin/true';
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

const defaultProbeTimer = (fn: () => void, ms: number): ProbeTimerHandle => {
  const handle = setTimeout(fn, ms);
  // Never let the self-test timer keep the process alive.
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return { clear: () => clearTimeout(handle) };
};

/**
 * Async startup self-test proving sandbox-exec actually works on THIS host.
 * Returns false unless: platform is 'darwin' AND `sandbox-exec` resolves AND
 * `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` exits 0 within the
 * timeout. Any error/timeout/nonzero ⇒ false. This is what closes the hole if
 * Apple ever removes the deprecated-but-present sandbox-exec: self-test fails ⇒
 * provider unavailable ⇒ run_shell keeps prompting.
 */
export async function probeSandboxAvailable(deps: ProbeSandboxDeps): Promise<boolean> {
  if (deps.platform !== 'darwin') {
    return false;
  }
  const setTimer = deps.setTimer ?? defaultProbeTimer;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let child: ProbeChildLike | undefined;
    let timer: ProbeTimerHandle | undefined;
    const done = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      timer?.clear();
      resolve(value);
    };

    try {
      child = deps.spawn('sandbox-exec', ['-p', SELF_TEST_PROFILE, SELF_TEST_TARGET]);
    } catch {
      done(false);
      return;
    }

    timer = setTimer(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // best-effort
      }
      done(false);
    }, timeoutMs);

    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
    child.on('close', (code) => done(code === 0));
  });
}

// --- production wiring --------------------------------------------------------

/** Default self-test spawn: node:child_process.spawn with stdio fully ignored. */
export const defaultProbeSpawn: ProbeSpawn = (command, args) =>
  nodeSpawn(command, [...args], { stdio: 'ignore' }) as unknown as ProbeChildLike;

export interface CreateSandboxProviderDeps {
  platform: NodeJS.Platform;
  spawn: ProbeSpawn;
  env: NodeJS.ProcessEnv;
  /** Canonicalize TMPDIR once at construction (Seatbelt matches canonical paths).
   * Best-effort: a realpath failure keeps the raw TMPDIR. Default: node realpath. */
  realpath?: (p: string) => Promise<string>;
  allowNetwork?: boolean;
  denyReadPatterns?: readonly string[];
  timeoutMs?: number;
}

/**
 * Probe once, then return a SandboxProvider whose `available` and `buildWrappedArgv`
 * are single-sourced from that probe result. When unavailable, `buildWrappedArgv`
 * always returns undefined so nothing can be auto-allowed-yet-unwrapped. TMPDIR is
 * canonicalized here so the write-subpath rule matches a symlinked temp dir.
 */
export async function createSandboxProvider(
  deps: CreateSandboxProviderDeps,
): Promise<SandboxProvider> {
  const available = await probeSandboxAvailable({
    platform: deps.platform,
    spawn: deps.spawn,
    timeoutMs: deps.timeoutMs,
  });

  let tmpdir = deps.env.TMPDIR;
  if (available && tmpdir !== undefined && deps.realpath !== undefined) {
    try {
      tmpdir = await deps.realpath(tmpdir);
    } catch {
      // Keep the raw TMPDIR — still subject to the injection guard in the builder.
    }
  }

  const opts: SeatbeltProfileOptions = {
    tmpdir,
    allowNetwork: deps.allowNetwork,
    denyReadPatterns: deps.denyReadPatterns,
  };

  return {
    available,
    buildWrappedArgv: (canonicalCwd, shell, command) =>
      available ? buildWrappedArgv(canonicalCwd, shell, command, opts) : undefined,
  };
}
