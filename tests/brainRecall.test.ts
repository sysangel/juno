import { describe, expect, it } from 'vitest';
import { runBrainRecall, type BrainRecallRequest } from '../src/services/brainRecall';
import type { BrainChildLike, BrainSpawn, TimerHandle } from '../src/services/brain';
import { createBrainRecallTool, createBrainGetTool } from '../src/tools/brainReadTools';
import { createDefaultTools } from '../src/tools/registry';
import type { ToolCtx } from '../src/core/contracts';

// ---------------------------------------------------------------------------
// These tools are READ-ONLY (they never write/push), but every test still uses a
// scripted FAKE spawn — the real `uv`/`brain-recall` binary is NEVER invoked, so
// the suite is hermetic and independent of any local brain state.
// ---------------------------------------------------------------------------

interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  stdoutBytes?: boolean;
  exitCode?: number;
  spawnThrows?: Error;
  emitError?: Error;
  hangUntilKill?: boolean;
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
  stdio: readonly string[];
}

interface FakeChild extends BrainChildLike {
  stdinEnded: boolean;
  killCount: number;
}

function makeSpawn(options: FakeChildOptions): {
  spawn: BrainSpawn;
  calls: SpawnCall[];
  child: () => FakeChild | undefined;
} {
  const calls: SpawnCall[] = [];
  let created: FakeChild | undefined;

  const spawn: BrainSpawn = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd, stdio: spawnOptions.stdio });
    if (options.spawnThrows !== undefined) {
      throw options.spawnThrows;
    }

    const exitListeners: Array<(code: number | null) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const child: FakeChild = {
      stdinEnded: false,
      killCount: 0,
      stdin: {
        write(): boolean {
          return true;
        },
        end(): void {
          child.stdinEnded = true;
        },
      },
      stdout: (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.emitError !== undefined) {
          await new Promise<never>(() => {});
          return;
        }
        if (options.stdout !== undefined && options.stdout.length > 0) {
          yield options.stdoutBytes === true
            ? new TextEncoder().encode(options.stdout)
            : options.stdout;
        }
        if (options.hangUntilKill === true) {
          await hang;
          return;
        }
        const code = options.exitCode ?? 0;
        for (const listener of exitListeners) {
          listener(code);
        }
        for (const listener of closeListeners) {
          listener(code);
        }
      })(),
      stderr: (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.stderr !== undefined && options.stderr.length > 0) {
          yield options.stderr;
        }
      })(),
      kill(): boolean {
        child.killCount += 1;
        releaseHang();
        queueMicrotask(() => {
          for (const listener of closeListeners) {
            listener(null);
          }
        });
        return true;
      },
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null) => void);
        } else if (event === 'close') {
          closeListeners.push(listener as (code: number | null) => void);
        } else if (event === 'error' && options.emitError !== undefined) {
          queueMicrotask(() => (listener as (err: Error) => void)(options.emitError as Error));
        }
        return child;
      },
    };
    created = child;
    return child;
  };

  return { spawn, calls, child: () => created };
}

// A no-op timer that never auto-fires (deterministic; timeout tests fire manually).
function makeManualTimer(): {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  fire: () => void;
  cleared: () => boolean;
} {
  let pending: (() => void) | undefined;
  let wasCleared = false;
  return {
    setTimer: (fn) => {
      pending = fn;
      return {
        clear: () => {
          wasCleared = true;
          pending = undefined;
        },
      };
    },
    fire: () => pending?.(),
    cleared: () => wasCleared,
  };
}

const CMD = ['brain-recall'] as const;
const CWD = '/tmp/ws';
const RECALL: BrainRecallRequest = { query: 'job search', k: 6 };

describe('runBrainRecall (fake spawn only)', () => {
  it('builds the RECALL argv (query, --json, --k, --scope) and returns the parsed hits map', async () => {
    const payload = JSON.stringify({
      fts_only: false,
      hits: [{ kind: 'memory', id: 'mem_abc', date: '2026-07-03', project: 'ws', snippet: 's', name: 'n', score: 0.99 }],
    });
    const { spawn, calls, child } = makeSpawn({ stdout: payload });
    const outcome = await runBrainRecall(
      { command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn },
      { query: 'job search', k: 6, scope: 'memories' },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.fts_only).toBe(false);
      expect(Array.isArray(outcome.result.hits)).toBe(true);
    }
    expect(calls[0]?.command).toBe('brain-recall');
    expect(calls[0]?.cwd).toBe(CWD);
    expect(calls[0]?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(calls[0]?.args).toEqual(['--json', '--k', '6', '--scope', 'memories', '--', 'job search']);
    expect(child()?.stdinEnded).toBe(true);
  });

  it('builds the GET argv (--json --get <id>) with no query positional', async () => {
    const payload = JSON.stringify({ kind: 'memory', id: 'mem_abc', text: 'the full body' });
    const { spawn, calls } = makeSpawn({ stdout: payload });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, { getId: 'mem_abc' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.text).toBe('the full body');
    }
    expect(calls[0]?.args).toEqual(['--json', '--get', 'mem_abc']);
  });

  it('omits --scope when not requested', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ hits: [] }) });
    await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, { query: 'x', k: 3 });
    expect(calls[0]?.args).toEqual(['--json', '--k', '3', '--', 'x']);
  });

  it('inserts a `--` sentinel before the query positional, after the options', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ hits: [] }) });
    await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, { query: 'q', k: 3, scope: 'all' });
    const args = calls[0]?.args ?? [];
    const sentinel = args.indexOf('--');
    expect(sentinel).toBeGreaterThanOrEqual(0);
    // Everything after the sentinel is positional; the query is the last token.
    expect(args[sentinel + 1]).toBe('q');
    expect(sentinel).toBe(args.length - 2);
    // Options precede the sentinel.
    expect(args.indexOf('--json')).toBeLessThan(sentinel);
    expect(args.indexOf('--k')).toBeLessThan(sentinel);
  });

  it('keeps a dash-leading query in RECALL mode (never flips to GET)', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ hits: [] }) });
    const outcome = await runBrainRecall(
      { command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn },
      { query: '--get=mem_deadbeef', k: 2 },
    );
    expect(outcome.ok).toBe(true);
    const args = calls[0]?.args ?? [];
    // The dash-leading query rides after `--` as a positional, not as `--get`.
    expect(args).not.toContain('--get');
    expect(args[args.indexOf('--') + 1]).toBe('--get=mem_deadbeef');
  });

  it('maps a non-zero exit (unknown id — message goes to ignored stderr) to ok:false', async () => {
    const { spawn } = makeSpawn({ stdout: '', exitCode: 1 });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, { getId: 'mem_missing' });
    expect(outcome).toEqual({ ok: false, error: 'brain: recall exited 1' });
  });

  it('folds a stderr tail into the non-zero-exit error message', async () => {
    const { spawn } = makeSpawn({ stdout: '', stderr: 'brain-recall: no memory with id mem_x', exitCode: 1 });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, { getId: 'mem_x' });
    expect(outcome).toEqual({ ok: false, error: 'brain: recall exited 1: brain-recall: no memory with id mem_x' });
  });

  it('caps runaway stdout: kills the child and fails soft', async () => {
    const { spawn, child } = makeSpawn({ stdout: 'x'.repeat(100_001) });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('output exceeded');
    }
    expect(child()?.killCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed JSON on stdout', async () => {
    const { spawn } = makeSpawn({ stdout: 'not json{' });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome).toEqual({ ok: false, error: 'brain: recall returned malformed JSON' });
  });

  it('decodes byte-chunk stdout', async () => {
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ hits: [] }), stdoutBytes: true });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome.ok).toBe(true);
  });

  it('times out, kills the child, and reports it', async () => {
    const { spawn, child } = makeSpawn({ hangUntilKill: true });
    const timer = makeManualTimer();
    const promise = runBrainRecall(
      { command: CMD, cwd: CWD, timeoutMs: 1000, spawnImpl: spawn, setTimer: timer.setTimer },
      RECALL,
    );
    timer.fire();
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, error: 'brain: recall timed out after 1000ms and was killed' });
    expect(child()?.killCount).toBeGreaterThanOrEqual(1);
  });

  it('fails soft when spawn throws', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('failed to spawn recall');
    }
  });

  it('fails soft on an async spawn error event', async () => {
    const { spawn } = makeSpawn({ emitError: new Error('boom') });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('errored');
    }
  });

  it('errors when the command is empty', async () => {
    const { spawn } = makeSpawn({ stdout: '{}' });
    const outcome = await runBrainRecall({ command: [], cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome).toEqual({ ok: false, error: 'brain: no recall command configured' });
  });

  it('errors when a zero-exit produces no output', async () => {
    const { spawn } = makeSpawn({ stdout: '' });
    const outcome = await runBrainRecall({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn }, RECALL);
    expect(outcome).toEqual({ ok: false, error: 'brain: recall returned no result' });
  });
});

function createCtx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => {},
    awaitPermission: async () => 'allow-once',
    state: {} as ToolCtx['state'],
  };
}

describe('createBrainRecallTool', () => {
  it('is risk:safe and named brain_recall', () => {
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000 });
    expect(tool.name).toBe('brain_recall');
    expect(tool.risk).toBe('safe');
  });

  it('rejects a missing/empty query without spawning', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '{}' });
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    expect(await tool.run({}, createCtx(CWD))).toEqual({ ok: false, error: 'invalid args: query must be a non-empty string' });
    expect(await tool.run({ query: '  ' }, createCtx(CWD))).toEqual({ ok: false, error: 'invalid args: query must be a non-empty string' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid scope without spawning', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '{}' });
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ query: 'x', scope: 'bogus' }, createCtx(CWD));
    expect(result).toEqual({ ok: false, error: 'invalid args: scope must be all|episodes|memories|summaries' });
    expect(calls).toHaveLength(0);
  });

  it('caps k at 20 and defaults to 6', async () => {
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify({ hits: [] }) });
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });

    await tool.run({ query: 'x', k: 500 }, createCtx(CWD));
    expect(calls[0]?.args).toContain('20');

    await tool.run({ query: 'x' }, createCtx(CWD));
    expect(calls[1]?.args).toEqual(['--json', '--k', '6', '--', 'x']);
  });

  it('returns the compact hits array as the tool data', async () => {
    const hits = [{ kind: 'memory', id: 'mem_1', snippet: 's' }];
    const { spawn } = makeSpawn({ stdout: JSON.stringify({ fts_only: false, hits }) });
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ query: 'x' }, createCtx(CWD));
    expect(result).toEqual({ ok: true, data: hits });
  });

  it('fails soft (never throws) when the read path fails', async () => {
    const { spawn } = makeSpawn({ spawnThrows: new Error('ENOENT') });
    const tool = createBrainRecallTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ query: 'x' }, createCtx(CWD));
    expect(result.ok).toBe(false);
  });
});

describe('createBrainGetTool', () => {
  it('is risk:safe and named brain_get', () => {
    const tool = createBrainGetTool({ command: CMD, cwd: CWD, timeoutMs: 5000 });
    expect(tool.name).toBe('brain_get');
    expect(tool.risk).toBe('safe');
  });

  it('rejects an id that does not match ^(ep_|mem_|sum_)... without spawning', async () => {
    const { spawn, calls } = makeSpawn({ stdout: '{}' });
    const tool = createBrainGetTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    for (const bad of ['', 'foo_123', 'mem_', 'mem_bad-id', 'ep_ x', '../etc']) {
      const result = await tool.run({ id: bad }, createCtx(CWD));
      expect(result).toEqual({ ok: false, error: 'invalid args: id must match ^(ep_|mem_|sum_)[A-Za-z0-9]+$' });
    }
    expect(calls).toHaveLength(0);
  });

  it('accepts a well-formed id and returns the full record', async () => {
    const record = { kind: 'summary', id: 'sum_2', text: 'full text body' };
    const { spawn, calls } = makeSpawn({ stdout: JSON.stringify(record) });
    const tool = createBrainGetTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ id: 'sum_2' }, createCtx(CWD));
    expect(result).toEqual({ ok: true, data: record });
    expect(calls[0]?.args).toEqual(['--json', '--get', 'sum_2']);
  });

  it('fails soft when the CLI errors', async () => {
    const { spawn } = makeSpawn({ stdout: '', exitCode: 1 });
    const tool = createBrainGetTool({ command: CMD, cwd: CWD, timeoutMs: 5000, spawnImpl: spawn });
    const result = await tool.run({ id: 'mem_missing' }, createCtx(CWD));
    expect(result).toEqual({ ok: false, error: 'brain: recall exited 1' });
  });
});

describe('registry gating for the read-only brain tools', () => {
  const stubDeps = { command: CMD, cwd: CWD, timeoutMs: 5000 };

  it('are ABSENT unless brainRead is provided', () => {
    const names = createDefaultTools({ memory: undefined }).map((t) => t.name);
    expect(names).not.toContain('brain_recall');
    expect(names).not.toContain('brain_get');
  });

  it('are registered when brainRead is provided', () => {
    const names = createDefaultTools({ brainRead: stubDeps }).map((t) => t.name);
    expect(names).toContain('brain_recall');
    expect(names).toContain('brain_get');
  });

  it('are parent-agent-only: pushed AFTER spawn_subagent, so out of the childTools snapshot', () => {
    const names = createDefaultTools({
      brainRead: stubDeps,
      subagent: {
        createClient: () => ({ streamTurn: async function* () {} }),
        catalog: {} as never,
        policy: {} as never,
        defaultModel: 'm',
      },
    }).map((t) => t.name);
    expect(names.indexOf('brain_recall')).toBeGreaterThan(names.indexOf('spawn_subagent'));
    expect(names.indexOf('brain_get')).toBeGreaterThan(names.indexOf('spawn_subagent'));
  });
});
