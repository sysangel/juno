// src/tools/hookDispatcher.ts
// Wave 12 — the config-driven PreToolUse/PostToolUse gate around the executor's
// policy seam. NOT in src/hooks/* (that directory is React hooks only).
//
// TWO-TIER POSTURE (load-bearing):
//   - Matcher compilation is FAIL-CLOSED: a matcher that fails to compile is NOT
//     silently skipped — for PreToolUse it becomes a hard deny (blocks the tool).
//     A broken matcher must never silently disable a security gate.
//   - Hook execution is FAIL-OPEN with a per-hook timeout: spawn failure /
//     nonzero-with-no-decision / timeout / oversized output ⇒ proceed as if the
//     hook produced no decision. A wedged hook must never wedge the turn.
//   - JSON decision WINS over exit code: stdout is parsed as JSON first; a
//     `{decision:'block'|'deny', reason}` (or Claude's `{permissionDecision:'deny',
//     permissionDecisionReason}` alias) governs. Only with NO parseable JSON
//     decision does the exit code govern (exit 2 = block, Claude convention). A
//     JSON `reason` becomes the model-facing tool-error text.
//
// DELIBERATE DIVERGENCE from Claude Code hooks: Claude's hook `command` is a
// shell STRING; running it faithfully needs a shell, which violates juno's
// shell-free spawn invariant (see services/brain.ts, every MCP/brain argv). So
// juno hooks are argv ARRAYS spawned WITHOUT a shell (config.json only). A
// ~/.claude/settings.json importer/adapter is an explicitly-deferred follow-on.
//
// The spawn/drain/timeout runner mirrors services/brain.ts's proven runBrainHook
// shape (shell-free spawn, JSON payload on stdin, hard per-hook timeout + stdout
// size cap, injectable spawn + scheduler for deterministic tests).
import { spawn as nodeSpawn } from 'node:child_process';
import type { BrainChildLike, BrainSpawn, TimerHandle } from '../services/brain';
import type { HookCommand, HookGroup, HooksSettings } from '../services/config';

/** Default per-hook wall-clock timeout (ms) when a hook omits `timeoutMs`. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** Hard ceiling on a hook's stdout; past this the child is killed and the run
 * fails OPEN (no decision). Mirrors brain.ts's MAX_HOOK_OUTPUT_CHARS. */
const MAX_HOOK_OUTPUT_CHARS = 100_000;

/** Generic block reason for the exit-code path (no JSON reason available). */
const EXIT_BLOCK_REASON = 'PreToolUse hook blocked the tool call (exit 2).';

/** Injectable dependencies for deterministic tests. */
export interface HookDispatcherOptions {
  /** Injectable spawn (shell-free). Defaults to node:child_process.spawn. */
  spawnImpl?: BrainSpawn;
  /** Injectable scheduler so the per-hook timeout is deterministic in tests. */
  scheduler?: (fn: () => void, ms: number) => TimerHandle;
  /** Turn-level abort signal; the dispatcher kills a running child on abort and
   * stops iterating hooks. */
  signal?: AbortSignal;
}

/** PreToolUse outcome: block (with a model-facing reason) or proceed. */
export type PreToolUseOutcome = { block: true; reason: string } | { block: false };

export interface HookDispatcher {
  /**
   * Run the PreToolUse groups for `name`. Returns `{block:true,reason}` on the
   * first matching hook that blocks OR on a matcher that fails to compile
   * (fail-CLOSED); otherwise `{block:false}`. `approve`/no-decision never
   * auto-bypasses juno's own policy — a hook can only OBJECT, not grant.
   */
  preToolUse(name: string, args: unknown): Promise<PreToolUseOutcome>;
  /**
   * Run the PostToolUse groups for `name` against the settled OK result. Returns
   * any `appendText` reminder (concatenated across matching hooks) to fold into
   * the model-facing promptText. Advisory only — it never blocks.
   */
  postToolUse(name: string, args: unknown, result: unknown): Promise<{ appendText?: string }>;
}

/** A compiled matcher. `all` matches every tool; `fail` means the source pattern
 * did not compile (fail-CLOSED for PreToolUse). */
type CompiledMatcher = { kind: 'all' } | { kind: 're'; re: RegExp } | { kind: 'fail' };

/** Compile a matcher as a regex anchored to the FULL tool name (Claude-compatible).
 * Empty or `'*'` ⇒ match-all; a pattern that throws ⇒ `fail` (never silently
 * treated as a non-match). */
function compileMatcher(matcher: string): CompiledMatcher {
  const trimmed = matcher.trim();
  if (trimmed.length === 0 || trimmed === '*') {
    return { kind: 'all' };
  }
  try {
    return { kind: 're', re: new RegExp(`^(?:${trimmed})$`) };
  } catch {
    return { kind: 'fail' };
  }
}

function matcherMatches(matcher: CompiledMatcher, name: string): boolean {
  if (matcher.kind === 'all') {
    return true;
  }
  if (matcher.kind === 're') {
    return matcher.re.test(name);
  }
  return false; // 'fail' is handled by the caller before this point
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A group with its matcher compiled once (per dispatcher, i.e. per turn). */
interface CompiledGroup {
  readonly matcher: CompiledMatcher;
  readonly raw: string;
  readonly hooks: readonly HookCommand[];
}

function compileGroups(groups: readonly HookGroup[] | undefined): CompiledGroup[] {
  return (groups ?? []).map((group) => ({
    matcher: compileMatcher(group.matcher),
    raw: group.matcher,
    hooks: group.hooks,
  }));
}

/** Outcome of running one hook child: its raw stdout + exit code, or a fail-open
 * signal (spawn error / timeout / oversized / abort ⇒ proceed as no-decision). */
type RunOutcome = { stdout: string; exitCode: number | null } | 'failopen';

/** Read a PreToolUse block/approve decision off the parsed JSON. Accepts both the
 * generic `{decision,reason}` shape and Claude's `{permissionDecision,
 * permissionDecisionReason}` alias. Returns undefined when there is no decision
 * field (⇒ the exit code governs). `approve`/`allow`/`ask` ⇒ no objection. */
function readPreDecision(parsed: unknown): { block: boolean; reason: string } | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const permissionDecision = parsed.permissionDecision;
  if (permissionDecision === 'deny') {
    return { block: true, reason: optionalString(parsed.permissionDecisionReason) ?? EXIT_BLOCK_REASON };
  }
  if (permissionDecision === 'allow' || permissionDecision === 'ask') {
    return { block: false, reason: '' };
  }
  const decision = parsed.decision;
  if (decision === 'block' || decision === 'deny') {
    return { block: true, reason: optionalString(parsed.reason) ?? EXIT_BLOCK_REASON };
  }
  if (decision === 'approve' || decision === 'allow') {
    return { block: false, reason: '' };
  }
  return undefined;
}

/** Read PostToolUse append text off the parsed JSON: Claude's
 * `hookSpecificOutput.additionalContext`, else a top-level `additionalContext`.
 * Anything else ⇒ undefined (nothing to append). */
function readAppendText(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (isRecord(hookSpecificOutput)) {
    const context = hookSpecificOutput.additionalContext;
    if (typeof context === 'string' && context.trim().length > 0) {
      return context;
    }
  }
  const top = parsed.additionalContext;
  if (typeof top === 'string' && top.trim().length > 0) {
    return top;
  }
  return undefined;
}

function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function createHookDispatcher(
  cfg: HooksSettings,
  options?: HookDispatcherOptions,
): HookDispatcher {
  const spawnImpl: BrainSpawn =
    options?.spawnImpl ??
    ((command, args, opts) => nodeSpawn(command, [...args], opts) as unknown as BrainChildLike);
  const setTimer =
    options?.scheduler ??
    ((fn: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(fn, ms);
      return { clear: () => clearTimeout(handle) };
    });
  const signal = options?.signal;

  // Matchers compiled ONCE per dispatcher (per turn), reused across every tool
  // call in that turn.
  const preGroups = compileGroups(cfg.PreToolUse);
  const postGroups = compileGroups(cfg.PostToolUse);

  /** Spawn one hook, write the JSON payload on stdin, drain stdout under a hard
   * timeout + size cap, kill the child on timeout/oversize/abort. Never throws;
   * any failure resolves 'failopen' (proceed as no decision). Mirrors brain.ts. */
  async function runHook(
    command: readonly string[],
    timeoutMs: number,
    payload: Record<string, unknown>,
  ): Promise<RunOutcome> {
    const [bin, ...args] = command;
    if (bin === undefined || bin.length === 0 || signal?.aborted) {
      return 'failopen';
    }

    let child: BrainChildLike;
    try {
      child = spawnImpl(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return 'failopen';
    }

    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // A fast-exiting child can EPIPE the stdin write; the read path still settles.
    }

    let stdout = '';
    let exitCode: number | null = null;
    let onAbort: (() => void) | undefined;

    const outcome = await new Promise<'ok' | 'failopen'>((resolve) => {
      let settled = false;
      const settle = (value: 'ok' | 'failopen'): void => {
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
        settle('failopen');
      }, timeoutMs);

      onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // best-effort termination
        }
        timer.clear();
        settle('failopen');
      };
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // ok-settle waits for BOTH the full stdout drain and `close` (same ordering
      // guard as brain.ts: settling on drain alone races `exit`, so a nonzero-exit
      // child could be accepted before its code was recorded).
      let stdoutDrained = false;
      let closed = false;
      const maybeOk = (): void => {
        if (stdoutDrained && closed) {
          timer.clear();
          settle('ok');
        }
      };

      child.on('error', () => {
        timer.clear();
        settle('failopen');
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
              if (stdout.length > MAX_HOOK_OUTPUT_CHARS) {
                try {
                  child.kill();
                } catch {
                  // best-effort termination
                }
                timer.clear();
                settle('failopen');
                return;
              }
            }
          }
        } catch {
          timer.clear();
          settle('failopen');
          return;
        }
        stdoutDrained = true;
        maybeOk();
      })();
    });

    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }

    return outcome === 'failopen' ? 'failopen' : { stdout, exitCode };
  }

  async function preToolUse(name: string, args: unknown): Promise<PreToolUseOutcome> {
    for (const group of preGroups) {
      if (signal?.aborted) {
        return { block: false };
      }
      // FAIL-CLOSED: a matcher that did not compile blocks the tool. We cannot know
      // whether it would have matched, so a broken security gate blocks rather than
      // silently letting the call through.
      if (group.matcher.kind === 'fail') {
        return { block: true, reason: `PreToolUse hook matcher failed to compile: ${group.raw}` };
      }
      if (!matcherMatches(group.matcher, name)) {
        continue;
      }
      for (const hook of group.hooks) {
        if (signal?.aborted) {
          return { block: false };
        }
        const outcome = await runHook(
          hook.command,
          hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
          { hook_event_name: 'PreToolUse', tool_name: name, tool_input: args },
        );
        if (outcome === 'failopen') {
          continue; // fail OPEN — proceed as no decision
        }
        const decision = readPreDecision(parseJsonStdout(outcome.stdout));
        if (decision !== undefined) {
          // JSON decision WINS over the exit code.
          if (decision.block) {
            return { block: true, reason: decision.reason };
          }
          continue; // explicit no-objection
        }
        // No parseable JSON decision ⇒ exit code governs (exit 2 = block).
        if (outcome.exitCode === 2) {
          return { block: true, reason: EXIT_BLOCK_REASON };
        }
      }
    }
    return { block: false };
  }

  async function postToolUse(
    name: string,
    args: unknown,
    result: unknown,
  ): Promise<{ appendText?: string }> {
    const parts: string[] = [];
    for (const group of postGroups) {
      if (signal?.aborted) {
        break;
      }
      // PostToolUse is advisory: an uncompilable matcher simply appends nothing
      // (there is no gate to fail closed on).
      if (group.matcher.kind === 'fail' || !matcherMatches(group.matcher, name)) {
        continue;
      }
      for (const hook of group.hooks) {
        if (signal?.aborted) {
          break;
        }
        const outcome = await runHook(
          hook.command,
          hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
          { hook_event_name: 'PostToolUse', tool_name: name, tool_input: args, tool_response: result },
        );
        if (outcome === 'failopen') {
          continue;
        }
        const text = readAppendText(parseJsonStdout(outcome.stdout));
        if (text !== undefined && text.trim().length > 0) {
          parts.push(text.trim());
        }
      }
    }
    return parts.length > 0 ? { appendText: parts.join('\n\n') } : {};
  }

  return { preToolUse, postToolUse };
}
