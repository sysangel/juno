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
//   - RECALL: `brain-recall "<query>" --json [--k N] [--scope S]` → `{fts_only, hits:[…]}`
//   - GET:    `brain-recall --json --get <id>`                     → a single record with `text`
// A `--get` for a missing id exits non-zero with the message on stderr (which we
// ignore), leaving stdout empty → this surfaces as `brain: recall exited N`.
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
    return ['--json', '--get', request.getId];
  }
  const args = [request.query ?? '', '--json'];
  if (request.k !== undefined) {
    args.push('--k', String(request.k));
  }
  if (request.scope !== undefined) {
    args.push('--scope', request.scope);
  }
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
      stdio: ['pipe', 'pipe', 'ignore'],
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
  let exitCode: number | null = null;

  const outcome = await new Promise<'ok' | 'timeout' | Error>((resolve) => {
    let settled = false;
    const settle = (value: 'ok' | 'timeout' | Error): void => {
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

    // Settle 'ok' only once BOTH stdout has drained AND the child closed, so the
    // exit code is populated (mirrors brainRemember.ts's close-after-exit ordering).
    let stdoutDrained = false;
    let closed = false;
    const maybeOk = (): void => {
      if (stdoutDrained && closed) {
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
  });

  if (outcome === 'timeout') {
    return { ok: false, error: `brain: recall timed out after ${deps.timeoutMs}ms and was killed` };
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
  // goes to stderr, which we do not capture, so surface the exit code. Prefer a
  // JSON `{error}` message if the CLI happened to print one.
  if (exitCode !== null && exitCode !== 0) {
    const cliError = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined;
    return { ok: false, error: cliError ?? `brain: recall exited ${exitCode}` };
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
