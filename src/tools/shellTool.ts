// src/tools/shellTool.ts
// The `run_shell` tool — the single most powerful (and dangerous) capability in
// the registry. It runs a command line in the workspace root via `sh -c` and
// returns stdout / stderr / exit code.
//
// Guarantees (mirrors the file-tool + brain-service conventions):
//   - risk:'dangerous' → the executor ALWAYS prompts (both `default` and
//     `acceptEdits` modes); it is NEVER auto-allowed by risk alone. Only an
//     explicit remembered `dangerous-bypass` rule can pre-grant it.
//   - Spawned WITHOUT an interactive/login shell profile: argv is
//     `['sh', '-c', <command>]`, `shell:false`, so no `-l`/`-i` startup files
//     run and there is no `shell:true` argument-injection surface.
//   - cwd STARTS at the workspace root (`ctx.cwd`); stdin is closed (`ignore`).
//   - OS confinement (macOS Seatbelt), opt-in via a SandboxProvider dep: when the
//     provider is `available`, the child is wrapped in `sandbox-exec -p <profile>`
//     that confines WRITES to the canonicalized cwd + TMPDIR and DENIES reads of a
//     sensitive-path set, and the tool reports `risk:'sandboxed'` so the policy
//     AUTO-ALLOWS it (the OS, not the prompt, is the control). FAIL-CLOSED is the
//     load-bearing invariant: risk 'sandboxed' auto-allows BEFORE run() executes,
//     so if the per-command profile cannot be built (SBPL-injection guard) or the
//     cwd cannot be canonicalized, run() returns an error WITHOUT spawning — it
//     NEVER falls back to a bare, auto-allowed `sh -c`. A vanished sandbox-exec
//     (ENOENT after the startup probe) likewise surfaces as an error, never a
//     bare-sh fallback. With NO provider (the default) the child is a bare
//     `sh -c`, risk stays 'dangerous', and the permission prompt is the only
//     control — there is NO path jail, a command can `cd` anywhere.
//   - Child env is SANITIZED: only SHELL_ENV_ALLOWLIST + LC_* pass through, so
//     juno's API keys / secrets are never visible to the command.
//   - Hard timeout (default 120s) → SIGTERM, then SIGKILL after a grace window
//     if the child ignores the term. Aborting the turn (`ctx.signal`) does the
//     same. Timers are INJECTED so both paths are deterministic under test.
//   - stdout/stderr each capped (default 100 KiB) with an explicit truncation
//     marker; excess is drained-and-dropped so the pipe never blocks.
//   - A non-zero exit is returned as a tool ERROR result ({ ok:false }), never a
//     throw; the executor's catch is a backstop, not the primary path.
//
// This tool is deliberately juno-INTERNAL: it has no entry in the claude-cli
// backend's JUNO_TO_CLI_TOOL map, so it is never projected onto that backend's
// `--allowedTools`, and that backend's own `Bash` stays unconditionally denied.
import { Buffer } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir as nodeMkdir, realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import { atomicWriteFile } from '../services/atomicWrite';
import type { SandboxProvider } from './shellSandbox';

/**
 * Minimal child-process surface this tool depends on, so tests inject a fake
 * without Node's real `ChildProcess`. The real `node:child_process.spawn` return
 * value structurally satisfies this. stdin is `ignore`d (closed), so — unlike the
 * brain service — there is no writable stdin here.
 */
export interface ShellChildLike {
  readonly stdout: AsyncIterable<string | Uint8Array> | null;
  readonly stderr: AsyncIterable<string | Uint8Array> | null;
  /** Terminate the child. Mirrors ChildProcess.kill's boolean return. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Lifecycle listeners. `exit`/`close` carry the exit code; `error` a spawn failure. */
  on(event: 'exit' | 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type ShellSpawn = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: boolean;
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => ShellChildLike;

/** Injectable timer handle so the timeout + kill-grace are deterministic in tests. */
export interface TimerHandle {
  clear: () => void;
}

export interface ShellToolDeps {
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  spawnImpl?: ShellSpawn;
  /** Injectable scheduler so the timers are deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** Hard timeout (ms) before the child is killed. Default 120_000. */
  timeoutMs?: number;
  /** Grace window (ms) between SIGTERM and SIGKILL. Default 2_000. */
  killGraceMs?: number;
  /** Max chars captured PER STREAM before truncation. Default 100_000. */
  maxOutputChars?: number;
  /** Shell binary. Default 'sh' (non-login, non-interactive: `sh -c <command>`). */
  shell?: string;
  /** Source env the SANITIZED child env is built from. Default process.env.
   * Only allowlisted variables (SHELL_ENV_ALLOWLIST + LC_*) pass through, so
   * API keys and other secrets in juno's own env never reach the child.
   * Injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** OPT-IN OS confinement (macOS Seatbelt). When `available`, the child is
   * wrapped in sandbox-exec and the tool's risk flips to 'sandboxed' (auto-allow).
   * Absent/unavailable ⇒ today's bare `sh -c`, risk:'dangerous', always prompt.
   * The SAME `available` flag single-sources BOTH the risk and the wrapping. */
  sandbox?: SandboxProvider;
  /** Canonicalize ctx.cwd before embedding it in the Seatbelt profile (Seatbelt
   * matches canonical paths — a symlinked cwd would not match its own subpath
   * rule). Default: node:fs/promises.realpath. Injected for tests. Only consulted
   * on the sandboxed path. */
  realpath?: (p: string) => Promise<string>;
  /**
   * Wave 14 (b8-compaction-resilience): OPT-IN spill of oversized stream output to a
   * session-scoped artifact file. When set, a stream capture whose length exceeds
   * `thresholdChars` is best-effort atomic-written to a file under `dir`, and the
   * tool result carries a TAIL-BIASED head+tail preview plus a pointer to the artifact
   * (byte count included) IN PLACE of the inline truncation marker. While spill is ON
   * the in-memory capture cap is raised to `maxCaptureChars` (still bounded) so far more
   * than 100KB is captured before the artifact write. Any spill failure falls back to
   * the ordinary inline truncation-marker render — it never throws. Absent ⇒ zero
   * behavior change (all existing callers + tests). */
  spill?: {
    /** Session-scoped artifacts dir (caller supplies; created on demand). */
    dir: string;
    /** Spill when a stream capture exceeds this many chars. Default = maxOutputChars (100_000). */
    thresholdChars?: number;
    /** Hard in-memory capture ceiling while spill is ON. Default 1_000_000. */
    maxCaptureChars?: number;
    /** Chars of the head kept in the inline preview. Default 2_000. */
    previewHeadChars?: number;
    /** Chars of the tail kept in the inline preview (build/test signal buries at the end). Default 2_000. */
    previewTailChars?: number;
    /** Injectable atomic write (defaults to the real atomicWriteFile). */
    atomicWrite?: typeof atomicWriteFile;
    /** Injectable recursive mkdir (defaults to fs.mkdir(recursive)). */
    mkdir?: (dir: string) => Promise<void>;
    /** Filename-uniqueness clock. Default Date.now. */
    now?: () => number;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
/** In-memory capture ceiling while spill is ON (still bounded — memory safety). */
const DEFAULT_SPILL_CAPTURE_CHARS = 1_000_000;
/** Head/tail chars retained in the inline preview when a stream is spilled. */
const DEFAULT_SPILL_PREVIEW_CHARS = 2_000;

/**
 * The ONLY environment variables passed through to the child (plus any `LC_*`
 * locale variables). Everything else — API keys (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, OPENROUTER_API_KEY, …), tokens, juno's own JUNO_* config —
 * is withheld so a shell command can never read juno's secrets from its env.
 */
export const SHELL_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TMPDIR',
  'TERM',
  'COLORTERM',
];

/** Build the sanitized child env: allowlisted names + LC_* passthrough. */
function sanitizeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith('LC_') && source[key] !== undefined) {
      env[key] = source[key];
    }
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Capture {
  text: string;
  truncated: boolean;
}

/** Drain a stream into `into`, stopping capture at `cap` chars but continuing to
 * consume (drop) the rest so the child's pipe never blocks on a full buffer. */
async function drainInto(
  stream: AsyncIterable<string | Uint8Array> | null,
  cap: number,
  into: Capture,
): Promise<void> {
  if (stream === null) {
    return;
  }
  for await (const chunk of stream) {
    if (into.truncated) {
      continue; // already at the cap — keep draining, drop the bytes.
    }
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (into.text.length + s.length > cap) {
      into.text += s.slice(0, cap - into.text.length);
      into.truncated = true;
    } else {
      into.text += s;
    }
  }
}

/** Render a capture with an explicit truncation marker when it was clipped. */
function render(cap: Capture, maxChars: number): string {
  return cap.truncated ? `${cap.text}\n… [output truncated at ${maxChars} chars]` : cap.text;
}

/** Sanitize a tool-use id into a safe single filename segment (mirrors subagentRecorder). */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * When run_shell is OS-sandboxed, a denied read/write surfaces as an ordinary
 * command failure — most often `Operation not permitted` (EPERM) from the kernel,
 * with no mention of the sandbox. Append a hint on a non-zero exit so the model
 * attributes such a failure to the confinement (write outside cwd/TMPDIR, read of
 * a sensitive path) rather than treating it as a bug in the command itself.
 */
function sandboxHint(stdout: string, stderr: string): string {
  const base =
    'note: run_shell is OS-sandboxed — file WRITES are confined to the workspace root + TMPDIR, ' +
    'and both reads AND writes/renames of sensitive paths (e.g. .env, .envrc, .ssh, .git-credentials, ' +
    '~/.config/gh, .kube, .docker, cloud creds) are denied.';
  const denied = /operation not permitted/i.test(stderr) || /operation not permitted/i.test(stdout);
  return denied
    ? `${base} The "Operation not permitted" above is most likely a sandbox denial, not a fault in the command — write inside the workspace/TMPDIR or avoid the blocked path.`
    : `${base} If this failure was a blocked write or read, it came from the sandbox rather than the command.`;
}

const shellToolSpec: ToolSpec = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace root and return its stdout, stderr, and exit code. ' +
    'The command runs via `sh -c` with no interactive/login profile, stdin closed, cwd pinned to ' +
    'the workspace root. This is the most powerful and dangerous tool — it can modify files, install ' +
    'packages, or reach the network — so it ALWAYS requires explicit permission and is never ' +
    'auto-approved. A non-zero exit is returned as an error. Output is capped and the command is ' +
    'killed if it exceeds the timeout.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: {
        type: 'string',
        description: 'The shell command line to execute, e.g. "npm test" or "git status".',
      },
    },
    required: ['command'],
  },
};

const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => {
  const handle = setTimeout(fn, ms);
  return { clear: () => clearTimeout(handle) };
};

const defaultSpawn: ShellSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as ShellChildLike;

/** Build the `run_shell` tool over injectable process/clock deps. */
export function createShellTool(deps: ShellToolDeps = {}): Tool {
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const spill = deps.spill;
  // While spill is ON, capture far more than 100KB (still bounded for memory safety) so
  // the spilled artifact holds the FULL output; when spill is unset, the historical
  // drainInto cap (and drop-overflow behavior) is byte-for-byte unchanged.
  const captureCap = spill !== undefined ? (spill.maxCaptureChars ?? DEFAULT_SPILL_CAPTURE_CHARS) : maxOutputChars;
  const shell = deps.shell ?? 'sh';
  const sourceEnv = deps.env ?? process.env;
  const realpathImpl = deps.realpath ?? nodeRealpath;
  // Single source of truth: the SAME flag decides risk (below) AND wrapping (in
  // run). A tool that reports 'sandboxed' therefore provably wraps its child.
  const sandboxed = deps.sandbox?.available === true;

  return {
    name: 'run_shell',
    risk: sandboxed ? 'sandboxed' : 'dangerous',
    spec: shellToolSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const command = stringProp(args, 'command');
      if (command === undefined || command.trim().length === 0) {
        return { ok: false, error: 'invalid args' };
      }
      if (ctx.signal.aborted) {
        return { ok: false, error: 'aborted' };
      }

      // Default (unsandboxed) argv — BYTE-FOR-BYTE the historical bare `sh -c`.
      let spawnCommand = shell;
      let spawnArgs: readonly string[] = ['-c', command];

      // Sandboxed path: this tool reported risk:'sandboxed' and was AUTO-ALLOWED
      // by the policy BEFORE we got here. That makes wrapping mandatory — every
      // failure below returns an error WITHOUT spawning, closing the auto-allow
      // window rather than running an unconfined, pre-approved command.
      if (sandboxed) {
        let canonicalCwd: string;
        try {
          canonicalCwd = await realpathImpl(ctx.cwd);
        } catch (err) {
          return {
            ok: false,
            error: `sandbox active: workspace path could not be canonicalized; refusing to run unsandboxed (${errText(err)})`,
          };
        }
        const wrapped = deps.sandbox!.buildWrappedArgv(canonicalCwd, shell, command);
        if (wrapped === undefined) {
          return {
            ok: false,
            error: 'sandbox active: profile could not be built for this workspace; refusing to run unsandboxed',
          };
        }
        spawnCommand = wrapped.command;
        spawnArgs = wrapped.args;
      }

      let child: ShellChildLike;
      try {
        child = spawnImpl(spawnCommand, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          cwd: ctx.cwd,
          env: sanitizeEnv(sourceEnv),
        });
      } catch (err) {
        // A sync spawn failure (incl. sandbox-exec ENOENT if it vanished after the
        // probe) is an error result — NEVER a silent fallback to a bare shell.
        return { ok: false, error: `failed to spawn shell: ${errText(err)}` };
      }

      const stdoutCap: Capture = { text: '', truncated: false };
      const stderrCap: Capture = { text: '', truncated: false };
      let exitCode: number | null = null;

      // Hoisted so it can be detached after the run settles.
      let onAbort: () => void = () => {};

      const outcome = await new Promise<'ok' | 'timeout' | 'aborted' | Error>((resolve) => {
        let settled = false;
        const settle = (value: 'ok' | 'timeout' | 'aborted' | Error): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };

        // SIGTERM now; escalate to SIGKILL if the child is still alive after the
        // grace window (a shell child can ignore SIGTERM — the case that warrants
        // escalation). IDEMPOTENT: a second invocation (e.g. timeout then abort)
        // must not re-signal or overwrite the grace handle. The grace timer stays
        // armed past a timeout/abort settle ON PURPOSE — it is the only thing
        // guaranteeing a SIGTERM-ignoring child eventually dies — and is cleared
        // the moment the child actually closes.
        let killGraceTimer: TimerHandle | undefined;
        let killRequested = false;
        const killChild = (): void => {
          if (killRequested) {
            return;
          }
          killRequested = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // best-effort
          }
          killGraceTimer = setTimer(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // best-effort
            }
          }, killGraceMs);
        };

        const hardTimer = setTimer(() => {
          killChild();
          settle('timeout');
        }, timeoutMs);

        onAbort = (): void => {
          hardTimer.clear(); // the run is over — never fire a stale timeout later.
          killChild();
          settle('aborted');
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });

        // Settle 'ok' only once BOTH streams have drained AND the child closed,
        // so the exit code is populated and no output is lost to a drain/close race.
        let stdoutDrained = false;
        let stderrDrained = false;
        let closed = false;
        const maybeOk = (): void => {
          if (stdoutDrained && stderrDrained && closed) {
            settle('ok');
          }
        };

        child.on('error', (err) => {
          hardTimer.clear();
          killGraceTimer?.clear();
          settle(err);
        });
        child.on('exit', (code) => {
          exitCode ??= code;
        });
        child.on('close', (code) => {
          // The child is dead: every pending timer is now moot. Clearing here
          // (not only on the 'ok' settle) also covers the timeout/abort paths,
          // so no timer outlives the process it guards.
          hardTimer.clear();
          killGraceTimer?.clear();
          exitCode ??= code;
          closed = true;
          maybeOk();
        });

        void (async () => {
          try {
            await drainInto(child.stdout, captureCap, stdoutCap);
          } catch {
            // A read error still lets close/error settle the outcome.
          }
          stdoutDrained = true;
          maybeOk();
        })();
        void (async () => {
          try {
            await drainInto(child.stderr, captureCap, stderrCap);
          } catch {
            // ditto
          }
          stderrDrained = true;
          maybeOk();
        })();
      });

      ctx.signal.removeEventListener('abort', onAbort);

      // Best-effort spill of an oversized stream capture to a session-scoped artifact,
      // returning a tail-biased head+tail preview + pointer IN PLACE of the inline
      // truncation marker. Any failure (mkdir/write/anything) falls back to the ordinary
      // `render` truncation path — never throws, never crashes the tool. Unset spill ⇒
      // this is exactly `render(cap, maxOutputChars)` with no artifact written.
      const renderStream = async (
        cap: Capture,
        stream: 'stdout' | 'stderr',
      ): Promise<{ text: string; spilled: boolean }> => {
        if (spill !== undefined) {
          const thresholdChars = spill.thresholdChars ?? maxOutputChars;
          if (cap.text.length > thresholdChars) {
            try {
              const ensureDir = spill.mkdir ?? ((d: string) => nodeMkdir(d, { recursive: true }).then(() => undefined));
              await ensureDir(spill.dir);
              const base = safeSegment(ctx.toolCallId ?? 'run');
              const ts = spill.now?.() ?? Date.now();
              const filePath = path.join(spill.dir, `${base}-${ts}.${stream}.txt`);
              const write = spill.atomicWrite ?? atomicWriteFile;
              await write(filePath, cap.text);
              const headChars = spill.previewHeadChars ?? DEFAULT_SPILL_PREVIEW_CHARS;
              const tailChars = spill.previewTailChars ?? DEFAULT_SPILL_PREVIEW_CHARS;
              const head = cap.text.slice(0, headChars);
              const tail = cap.text.slice(-tailChars);
              const bytes = Buffer.byteLength(cap.text);
              const preview = `${head}\n… [${bytes} bytes total — full output spilled to ${filePath}] …\n${tail}`;
              return { text: preview, spilled: true };
            } catch {
              // Fall through to the inline truncation-marker render below.
            }
          }
        }
        return { text: render(cap, maxOutputChars), spilled: false };
      };

      const stdoutRendered = await renderStream(stdoutCap, 'stdout');
      const stderrRendered = await renderStream(stderrCap, 'stderr');
      const stdout = stdoutRendered.text;
      const stderr = stderrRendered.text;
      const truncated =
        stdoutCap.truncated || stderrCap.truncated || stdoutRendered.spilled || stderrRendered.spilled;

      if (outcome instanceof Error) {
        return { ok: false, error: `shell error: ${errText(outcome)}` };
      }
      if (outcome === 'aborted') {
        return { ok: false, error: 'aborted' };
      }
      if (outcome === 'timeout') {
        const tail = stderr.length > 0 ? `\nstderr:\n${stderr}` : '';
        return {
          ok: false,
          error: `command timed out after ${timeoutMs}ms and was killed${tail}`,
        };
      }

      // Clean exit path.
      if (exitCode === 0) {
        return {
          ok: true,
          data: { command, exitCode: 0, stdout, stderr, truncated },
        };
      }

      // Non-zero exit → tool error result (NOT a throw). Fold captured output into
      // the message so the model can see why the command failed.
      const parts = [`command exited with status ${exitCode ?? 'unknown'}`];
      if (stdout.length > 0) {
        parts.push(`stdout:\n${stdout}`);
      }
      if (stderr.length > 0) {
        parts.push(`stderr:\n${stderr}`);
      }
      // Usability: under confinement a denied read/write reads as a plain failure,
      // so tell the model the denial may have come from the sandbox, not the command.
      if (sandboxed) {
        parts.push(sandboxHint(stdout, stderr));
      }
      return { ok: false, error: parts.join('\n') };
    },
  };
}
