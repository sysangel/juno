// src/services/brainRecall.ts
// Read-only RECALL path into the personal "brain" — Phase 1 (reads).
//
// The write twin lives in brainRemember.ts; this is the read side. When
// `brain.enabled` is set, the `brain_recall` / `brain_get` tools spawn the user's
// `brain-recall` CLI (lives in ~/src/brain) shell-free and parse its `--json`
// output. Unlike the session-start port (brain.ts) these are explicit tool calls,
// so every failure (missing binary, non-zero exit, timeout, malformed JSON)
// resolves to a structured `{ ok:false, error }` outcome the tool surfaces — it
// never throws and never crashes the session.
//
// The CLI has two mutually-exclusive modes (its argparse forbids combining them):
//   - RECALL: `brain-recall [--k N] [--scope S] --json -- "<query>"` → `{fts_only, hits:[…]}`
//   - GET:    `brain-recall --json --get <id>`                       → a single record with `text`
// The RECALL query is passed after a `--` sentinel so a dash-leading query (e.g.
// "--get=mem_…") can never be re-parsed as an option (which would flip the CLI
// into GET mode, or error). A `--get` for a missing id exits non-zero with the
// message on stderr; we capture a short stderr tail and fold it into the error so
// an unknown id is diagnosable rather than an opaque `recall exited N`.
//
// Timeout + child-kill go through the SAME injectable spawn/timer deps as
// brain.ts / brainRemember.ts so the failure paths are deterministic under test.

import { spawn as nodeSpawn } from 'node:child_process';
import type { BrainChildLike, BrainSpawn, TimerHandle } from './brain';

/** A recall query OR a by-id get. `getId` set ⇒ GET mode (query/k/scope ignored);
 * otherwise RECALL mode over `query`. The tools build these; the service never
 * validates them (that is the tool's job). */
export interface BrainRecallRequest {
  /** Free-text query (RECALL mode). */
  query?: string;
  /** Max hits (RECALL mode). The tool caps this; passed through verbatim. */
  k?: number;
  /** all|episodes|memories|summaries (RECALL mode). Omitted ⇒ CLI default. */
  scope?: string;
  /** An `ep_`/`mem_`/`sum_` id (GET mode). */
  getId?: string;
}

export interface BrainRecallDeps {
  /** Base argv `[bin, ...args]` for the recall CLI, spawned WITHOUT a shell. */
  command: readonly string[];
  /** Child cwd. */
  cwd: string;
  /** Hard timeout (ms); on expiry the child is killed and an error is returned. */
  timeoutMs: number;
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  spawnImpl?: BrainSpawn;
  /** Injectable scheduler so the timeout is deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

/** Structured outcome. `ok:true` carries the CLI's parsed result record (a
 * `{fts_only, hits}` map in RECALL mode, or a single memory/episode/summary record
 * in GET mode); `ok:false` carries a one-line error. Never throws. */
export type BrainRecallOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

/** Cap on captured stdout before the child is killed. Mirrors the 100 KiB per-
 * stream cap in src/tools/shellTool.ts: `recallCommand` is user config, so a
 * misbehaving CLI must not be able to stream into memory forever. */
const MAX_RECALL_OUTPUT_CHARS = 100_000;
/** How much of the CLI's stderr tail to fold into a non-zero-exit error message. */
const STDERR_TAIL_CHARS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the extra argv (after the base command) for one request. GET and RECALL
 * are mutually exclusive — the CLI's argparse rejects `--get` alongside a query. */
function buildArgs(request: BrainRecallRequest): string[] {
  if (request.getId !== undefined) {
    // GET needs no `--` sentinel: the tool validates the id to
    // ^(ep_|mem_|sum_)[A-Za-z0-9]+$ upstream, so it can never be dash-leading.
    return ['--json', '--get', request.getId];
  }
  // RECALL: emit ALL options first, then a `--` sentinel, then the query as the
  // final positional. `--` MUST follow the options (everything after it is
  // positional), and it protects a dash-leading query from being parsed as an
  // option — proven live: a bare "--get=mem_…" query otherwise flips into GET mode.
  const args = ['--json'];
  if (request.k !== undefined) {
    args.push('--k', String(request.k));
  }
  if (request.scope !== undefined) {
    args.push('--scope', request.scope);
  }
  args.push('--', request.query ?? '');
  return args;
}

/**
 * Run the brain-recall CLI once and return its parsed result, or a structured
 * error on ANY failure path. Never throws.
 */
export async function runBrainRecall(
  deps: BrainRecallDeps,
  request: BrainRecallRequest,
): Promise<BrainRecallOutcome> {
  const spawnImpl: BrainSpawn =
    deps.spawnImpl ??
    ((command, args, options) => nodeSpawn(command, [...args], options) as unknown as BrainChildLike);
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });

  const [bin, ...base] = deps.command;
  if (bin === undefined || bin.length === 0) {
    return { ok: false, error: 'brain: no recall command configured' };
  }
  const args = [...base, ...buildArgs(request)];

  let child: BrainChildLike;
  try {
    child = spawnImpl(bin, args, {
      // stderr is PIPED (not ignored) so a non-zero exit's diagnostic tail can be
      // folded into the error message, matching brain_remember's error surfacing.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      cwd: deps.cwd,
    });
  } catch (err) {
    return { ok: false, error: `brain: failed to spawn recall (${errText(err)})` };
  }

  // The recall CLI reads its query from argv, not stdin; close stdin so a fast
  // child never blocks on it.
  try {
    child.stdin?.end();
  } catch {
    // best-effort
  }

  let stdout = '';
  // stderr is retained as a bounded rolling TAIL (never grows past
  // STDERR_TAIL_CHARS) so it cannot itself become an unbounded buffer.
  let stderrTail = '';
  let exitCode: number | null = null;

  const outcome = await new Promise<'ok' | 'timeout' | 'overflow' | Error>((resolve) => {
    let settled = false;
    const settle = (value: 'ok' | 'timeout' | 'overflow' | Error): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const timer = setTimer(() => {
      try {
        child.kill();
      } catch {
        // best-effort termination
      }
      settle('timeout');
    }, deps.timeoutMs);

    // Settle 'ok' only once stdout AND stderr have drained AND the child closed,
    // so the exit code is populated and the stderr tail is complete (mirrors
    // brainRemember.ts's close-after-exit ordering; stderr gate mirrors shellTool).
    let stdoutDrained = false;
    // No piped stderr ⇒ nothing to wait for.
    let stderrDrained = child.stderr === undefined || child.stderr === null;
    let closed = false;
    const maybeOk = (): void => {
      if (stdoutDrained && stderrDrained && closed) {
        timer.clear();
        settle('ok');
      }
    };

    child.on('error', (err) => {
      timer.clear();
      settle(err);
    });
    child.on('exit', (code) => {
      exitCode ??= code;
    });
    child.on('close', (code) => {
      exitCode ??= code;
      closed = true;
      maybeOk();
    });

    void (async () => {
      try {
        if (child.stdout !== null) {
          for await (const chunk of child.stdout) {
            stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            // Cap accumulated stdout: kill a CLI that streams past the limit and
            // fail soft, rather than letting a misbehaving binary exhaust memory.
            if (stdout.length > MAX_RECALL_OUTPUT_CHARS) {
              try {
                child.kill();
              } catch {
                // best-effort termination
              }
              timer.clear();
              settle('overflow');
              return;
            }
          }
        }
      } catch (err) {
        timer.clear();
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      stdoutDrained = true;
      maybeOk();
    })();

    void (async () => {
      try {
        if (child.stderr !== undefined && child.stderr !== null) {
          for await (const chunk of child.stderr) {
            const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            stderrTail = (stderrTail + s).slice(-STDERR_TAIL_CHARS);
          }
        }
      } catch {
        // A stderr read error is non-fatal — the outcome is decided by stdout/close.
      }
      stderrDrained = true;
      maybeOk();
    })();
  });

  if (outcome === 'timeout') {
    return { ok: false, error: `brain: recall timed out after ${deps.timeoutMs}ms and was killed` };
  }
  if (outcome === 'overflow') {
    return {
      ok: false,
      error: `brain: recall output exceeded ${MAX_RECALL_OUTPUT_CHARS} chars and was killed`,
    };
  }
  if (outcome instanceof Error) {
    return { ok: false, error: `brain: recall errored (${errText(outcome)})` };
  }

  const trimmed = stdout.trim();

  let parsed: unknown;
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'brain: recall returned malformed JSON' };
    }
  }

  // A non-zero exit is a usage/lookup error (e.g. an unknown id): the diagnostic
  // goes to stderr. Prefer a JSON `{error}` message if the CLI printed one; else
  // fold in the captured stderr tail so the failure is diagnosable rather than an
  // opaque `recall exited N` (consistent with brain_remember's error surfacing).
  if (exitCode !== null && exitCode !== 0) {
    const cliError = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined;
    if (cliError !== undefined) {
      return { ok: false, error: cliError };
    }
    const tail = stderrTail.trim();
    return {
      ok: false,
      error: tail.length > 0 ? `brain: recall exited ${exitCode}: ${tail}` : `brain: recall exited ${exitCode}`,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'brain: recall returned no result' };
  }

  // A zero-exit result can still carry an `error` field — surface it as an error.
  if (typeof parsed.error === 'string') {
    return { ok: false, error: parsed.error };
  }

  return { ok: true, result: parsed };
}
