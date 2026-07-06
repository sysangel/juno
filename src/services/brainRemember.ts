// src/services/brainRemember.ts
// Durable-memory WRITE path into the personal "brain" — Phase 3 (writes).
//
// Where src/services/brain.ts is the read-only SessionStart port, this is its
// write twin: when `brain.enabled` is set, the `brain_remember` tool spawns the
// user's `brain-remember` CLI (lives in ~/src/brain) shell-free, writes the
// memory request as a single JSON object on stdin, drains stdout, and parses the
// CLI's JSON result. The CLI delegates to the SAME flock-guarded `remember()`
// the brain MCP tool uses, so a juno write is dedup-guarded, git-committed, and
// best-effort pushed to the private remote exactly like a Claude Code write.
//
// Unlike brain.ts this is NOT a silent fail-open into "no context": a write is an
// explicit tool call, so every failure (missing binary, non-zero exit, timeout,
// malformed JSON) resolves to a structured `{ ok:false, error }` outcome the tool
// surfaces to the model — it never throws and never crashes the session. Timeout
// + child-kill go through the same injectable spawn/timer deps as brain.ts and
// shellTool.ts so the failure paths are deterministic under test.

import { spawn as nodeSpawn } from 'node:child_process';
import type { BrainChildLike, BrainSpawn, TimerHandle } from './brain';

/** The write request sent to the CLI on stdin. Only `fact` is required; the rest
 * default CLI-side to exactly the brain MCP tool's defaults. */
export interface BrainRememberInput {
  fact: string;
  /** user|feedback|project|reference. Default (CLI-side): project. */
  type?: string;
  /** Optional kebab-slug filename override. */
  name?: string;
  /** Provenance trailer — a session id, when one is available. */
  session?: string;
  /** Provenance trailer — the workspace/project. */
  project?: string;
  /** Write even if a near-duplicate exists. Default: false. */
  force?: boolean;
}

export interface BrainRememberDeps {
  /** argv `[bin, ...args]`, spawned WITHOUT a shell. */
  command: readonly string[];
  /** Child cwd (also the natural provenance root). */
  cwd: string;
  /** Hard timeout (ms); on expiry the child is killed and an error is returned. */
  timeoutMs: number;
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  spawnImpl?: BrainSpawn;
  /** Injectable scheduler so the timeout is deterministic in tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

/** Structured outcome. `ok:true` carries the CLI's parsed result dict (which may
 * itself report `status:"created"` or `status:"duplicate"`); `ok:false` carries a
 * one-line error. Never throws. */
export type BrainRememberOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the brain-remember CLI once and return its parsed result, or a structured
 * error on ANY failure path. Never throws.
 */
export async function runBrainRemember(
  deps: BrainRememberDeps,
  input: BrainRememberInput,
): Promise<BrainRememberOutcome> {
  const spawnImpl: BrainSpawn =
    deps.spawnImpl ??
    ((command, args, options) => nodeSpawn(command, [...args], options) as unknown as BrainChildLike);
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });

  const [bin, ...args] = deps.command;
  if (bin === undefined || bin.length === 0) {
    return { ok: false, error: 'brain: no remember command configured' };
  }

  let child: BrainChildLike;
  try {
    child = spawnImpl(bin, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      cwd: deps.cwd,
    });
  } catch (err) {
    return { ok: false, error: `brain: failed to spawn remember (${errText(err)})` };
  }

  // Write the request JSON on stdin, then close it (the CLI reads one object).
  try {
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  } catch {
    // A fast-exiting child can EPIPE the write; the read path still settles.
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
    // exit code is populated (mirrors brain.ts's close-after-exit ordering).
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
    return { ok: false, error: `brain: remember timed out after ${deps.timeoutMs}ms and was killed` };
  }
  if (outcome instanceof Error) {
    return { ok: false, error: `brain: remember errored (${errText(outcome)})` };
  }

  const trimmed = stdout.trim();

  let parsed: unknown;
  if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'brain: remember returned malformed JSON' };
    }
  }

  // A non-zero exit is a usage/IO error; the CLI still prints an `{error}` JSON
  // whose message is the useful diagnostic. Prefer that message when present.
  if (exitCode !== null && exitCode !== 0) {
    const cliError = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : undefined;
    return { ok: false, error: cliError ?? `brain: remember exited ${exitCode}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'brain: remember returned no result' };
  }

  // A zero-exit result can still carry an `error` field (e.g. a bad `type` the
  // CLI validated after reading stdin) — surface it as an error, not a success.
  if (typeof parsed.error === 'string') {
    return { ok: false, error: parsed.error };
  }

  return { ok: true, result: parsed };
}
