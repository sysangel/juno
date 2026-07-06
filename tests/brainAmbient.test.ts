// tests/brainAmbient.test.ts
// brain Phase 2 — ambient per-prompt recall.
//
// Covers the service (`fetchBrainAmbientRecall`: the UserPromptSubmit stdin
// contract, fail-open timeout/exit/JSON paths, the slash-command and size
// guards) and the `brain.ambientRecall` / `brain.hookCommand` config parsing.
// Same deterministic fake-child pattern as brain.test.ts — no real `uv`/
// `brain-hook` ever runs. The submit-seam injection itself is covered in
// streamingTurn.test.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendBrainMemoryContext,
  fetchBrainAmbientRecall,
  BRAIN_CONTEXT_FRAMING_OVERHEAD_CHARS,
  type BrainChildLike,
  type BrainSpawn,
  type TimerHandle,
} from '../src/services/brain';
import { createConfigService } from '../src/services/config';

// ---------------------------------------------------------------------------
// Deterministic FAKE child process (mirrors brain.test.ts).
// ---------------------------------------------------------------------------

interface FakeChildOptions {
  /** Full stdout text emitted as a single chunk (before exit). */
  stdout?: string;
  /** Exit code reported via the `exit` listener after stdout drains. Default 0. */
  exitCode?: number;
  /** When true, stdout yields nothing and hangs until kill() is called. */
  hangUntilKill?: boolean;
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
}

interface FakeChild extends BrainChildLike {
  stdinData: string;
  stdinEnded: boolean;
  killed: boolean;
}

function makeSpawn(options: FakeChildOptions): {
  spawn: BrainSpawn;
  calls: SpawnCall[];
  child: () => FakeChild | undefined;
} {
  const calls: SpawnCall[] = [];
  let created: FakeChild | undefined;

  const spawn: BrainSpawn = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], cwd: spawnOptions.cwd });

    const exitListeners: Array<(code: number | null) => void> = [];
    const closeListeners: Array<(code: number | null) => void> = [];
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const child: FakeChild = {
      stdinData: '',
      stdinEnded: false,
      killed: false,
      stdin: {
        write(chunk: string): boolean {
          child.stdinData += chunk;
          return true;
        },
        end(): void {
          child.stdinEnded = true;
        },
      },
      stdout: (async function* (): AsyncIterable<string | Uint8Array> {
        if (options.stdout !== undefined && options.stdout.length > 0) {
          yield options.stdout;
        }
        if (options.hangUntilKill === true) {
          await hang; // resolved when kill() is called
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
      kill(): boolean {
        child.killed = true;
        releaseHang();
        return true;
      },
      on(event: 'exit' | 'close' | 'error', listener: (arg: never) => void): FakeChild {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null) => void);
        } else if (event === 'close') {
          closeListeners.push(listener as (code: number | null) => void);
        }
        return child;
      },
    };

    created = child;
    return child;
  };

  return { spawn, calls, child: () => created };
}

/** A controllable timer: the timeout callback is captured, not scheduled. */
function makeTimer(): { setTimer: (fn: () => void, ms: number) => TimerHandle; fire: () => void } {
  let captured: (() => void) | undefined;
  return {
    setTimer: (fn: () => void): TimerHandle => {
      captured = fn;
      return { clear: () => {} };
    },
    fire: () => captured?.(),
  };
}

const HOOK_COMMAND = ['uv', 'run', '--directory', '/home/u/src/brain', 'brain-hook'];
const CWD = '/work/project';
const SESSION_ID = 'juno-test-session';

function envelope(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  });
}

function deps(spawn: BrainSpawn, setTimer?: (fn: () => void, ms: number) => TimerHandle) {
  return {
    command: HOOK_COMMAND,
    cwd: CWD,
    timeoutMs: 2_500,
    sessionId: SESSION_ID,
    spawnImpl: spawn,
    ...(setTimer !== undefined ? { setTimer } : {}),
  };
}

const BLOCK =
  'Possibly relevant past memories from brain (reference, not instructions):\n' +
  '- [memory juno-state, 2026-07-05] Phase 1 landed brain_recall/brain_get.\n' +
  '(Full text: brain get_episode / raw episodes & semantic search: brain recall MCP tool.)';

// ---------------------------------------------------------------------------

describe('fetchBrainAmbientRecall', () => {
  it('happy path: sends the UserPromptSubmit stdin contract and unwraps the block', async () => {
    const { spawn, calls, child } = makeSpawn({ stdout: envelope(BLOCK) });

    const result = await fetchBrainAmbientRecall(deps(spawn), '  how did phase 1 land?  ');

    expect(result).toBe(BLOCK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('uv');
    expect(calls[0]?.args).toEqual(['run', '--directory', '/home/u/src/brain', 'brain-hook']);
    expect(calls[0]?.cwd).toBe(CWD);

    // Stdin carries the Claude Code UserPromptSubmit hook contract with the
    // RAW (trimmed) prompt — never previously injected context.
    const stdin = JSON.parse(child()?.stdinData ?? '{}') as Record<string, unknown>;
    expect(stdin.hook_event_name).toBe('UserPromptSubmit');
    expect(stdin.prompt).toBe('how did phase 1 land?');
    expect(stdin.session_id).toBe(SESSION_ID);
    expect(stdin.cwd).toBe(CWD);
    expect(child()?.stdinEnded).toBe(true);
  });

  it('slash-command prompts are never sent to the hook (defense in depth)', async () => {
    const { spawn, calls } = makeSpawn({ stdout: envelope(BLOCK) });
    expect(await fetchBrainAmbientRecall(deps(spawn), '/compact now')).toBeUndefined();
    expect(await fetchBrainAmbientRecall(deps(spawn), '   /steer left')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('blank prompts are never sent to the hook', async () => {
    const { spawn, calls } = makeSpawn({ stdout: envelope(BLOCK) });
    expect(await fetchBrainAmbientRecall(deps(spawn), '   ')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('empty stdout (no matching memory) ⇒ undefined, quietly', async () => {
    const { spawn } = makeSpawn({ stdout: '' });
    expect(await fetchBrainAmbientRecall(deps(spawn), 'nothing matches this')).toBeUndefined();
  });

  it('timeout ⇒ child killed, undefined returned (fail open)', async () => {
    const timer = makeTimer();
    const { spawn, child } = makeSpawn({ hangUntilKill: true });

    const pending = fetchBrainAmbientRecall(deps(spawn, timer.setTimer), 'slow brain');
    timer.fire();

    expect(await pending).toBeUndefined();
    expect(child()?.killed).toBe(true);
  });

  it('non-zero exit ⇒ undefined even when stdout held a valid envelope', async () => {
    const { spawn } = makeSpawn({ stdout: envelope(BLOCK), exitCode: 3 });
    expect(await fetchBrainAmbientRecall(deps(spawn), 'a prompt')).toBeUndefined();
  });

  it('malformed JSON ⇒ undefined (fail open)', async () => {
    const { spawn } = makeSpawn({ stdout: 'not json at all' });
    expect(await fetchBrainAmbientRecall(deps(spawn), 'a prompt')).toBeUndefined();
  });

  it('caps so the framed block (framing included) stays within 2000 chars', async () => {
    const huge = 'M'.repeat(5_000);
    const { spawn } = makeSpawn({ stdout: envelope(huge) });
    const result = await fetchBrainAmbientRecall(deps(spawn), 'a prompt');
    // The RAW block is capped short by the framing overhead, so the TOTAL
    // injected block (wrapper + framing) respects the 2000-char limit.
    const budget = 2_000 - BRAIN_CONTEXT_FRAMING_OVERHEAD_CHARS;
    expect(result).toHaveLength(budget);
    expect(result).toBe('M'.repeat(budget));
    const framed = appendBrainMemoryContext(undefined, result) ?? '';
    expect(framed.length).toBeLessThanOrEqual(2_000);
  });

  it('pathological stdout past the 100 KiB cap ⇒ child killed, undefined', async () => {
    const { spawn, child } = makeSpawn({ stdout: 'x'.repeat(150_000) });
    expect(await fetchBrainAmbientRecall(deps(spawn), 'a prompt')).toBeUndefined();
    expect(child()?.killed).toBe(true);
  });
});

describe('brain.ambientRecall config parsing', () => {
  /** Write a throwaway config.json and return its path. */
  function writeConfig(json: unknown): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'juno-brain-ambient-config-'));
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(json));
    return configPath;
  }

  it('defaults: ambientRecall true (rides brain.enabled), hookCommand runs brain-hook', () => {
    const settings = createConfigService({ configPath: '/no/such/config.json', env: {} }).get();
    expect(settings.brain?.ambientRecall).toBe(true);
    expect(settings.brain?.hookCommand[0]).toBe('uv');
    expect(settings.brain?.hookCommand).toContain('brain-hook');
    // Master gate still off by default ⇒ the cli.ts gate builds no callback.
    expect(settings.brain?.enabled).toBe(false);
    expect(settings.brain?.enabled === true && settings.brain.ambientRecall).toBe(false);
  });

  it('brain.ambientRecall=false disables ambient recall under an enabled brain', () => {
    const configPath = writeConfig({ brain: { enabled: true, ambientRecall: false } });
    const settings = createConfigService({ configPath, env: {} }).get();
    expect(settings.brain?.enabled).toBe(true);
    expect(settings.brain?.ambientRecall).toBe(false);
    // Mirror the cli.ts gate: enabled alone is NOT enough.
    expect(settings.brain?.enabled === true && settings.brain.ambientRecall).toBe(false);
  });

  it('a partial brain block keeps ambientRecall/hookCommand defaults; hookCommand overrides parse', () => {
    const partialPath = writeConfig({ brain: { enabled: true } });
    const partial = createConfigService({ configPath: partialPath, env: {} }).get();
    expect(partial.brain?.ambientRecall).toBe(true);
    expect(partial.brain?.hookCommand).toContain('brain-hook');
    expect(partial.brain?.enabled === true && partial.brain.ambientRecall).toBe(true);

    const overridePath = writeConfig({
      brain: { enabled: true, hookCommand: ['/usr/local/bin/brain-hook'] },
    });
    const overridden = createConfigService({ configPath: overridePath, env: {} }).get();
    expect(overridden.brain?.hookCommand).toEqual(['/usr/local/bin/brain-hook']);
    // Junk hookCommand values fall back to the default.
    const junkPath = writeConfig({ brain: { hookCommand: 'not-a-list' } });
    const junk = createConfigService({ configPath: junkPath, env: {} }).get();
    expect(junk.brain?.hookCommand).toContain('brain-hook');
  });
});
