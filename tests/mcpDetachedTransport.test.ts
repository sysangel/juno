import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { createMcpClientConnection } from '../src/services/mcpClient';

// ---------------------------------------------------------------------------
// Direct coverage for the DEFAULT stdio transport (DetachedStdioTransport). The
// rest of the MCP suite injects transports and never exercises the real spawn
// path, so this file mocks `node:child_process` spawn (preserving every other
// export) to drive the real transport through a fake child: it pins that the child
// is spawned `detached` (own process group) and — the ordering regression the
// critic flagged — that on an UNEXPECTED child exit the transport still exposes its
// `_process`, so the connection's drop handler captures the child and reaps the
// whole group (killpg) rather than no-op'ing. The SDK spawns via `cross-spawn`, not
// `node:child_process`, so this mock never touches the SDK's own machinery.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

// Imported AFTER the mock declaration; vitest hoists vi.mock so this is the mock.
import { spawn } from 'node:child_process';

/** A stand-in for the spawned server child: enough of a Node `ChildProcess` for the
 * real DetachedStdioTransport + the SDK Client to complete the `initialize` handshake
 * over stdin/stdout, plus destroyable pipes / kill / unref / pid so the teardown is
 * observable. Its stdin auto-answers the `initialize` request on stdout (newline-framed
 * JSON-RPC), so connect() goes fully live; 'spawn'/'close' are fired on demand. */
function makeFakeChild(pid: number): {
  child: unknown;
  fireSpawn: () => void;
  fireClose: () => void;
  state: () => {
    destroyed: { stdin: boolean; stdout: boolean; stderr: boolean };
    killSignal: NodeJS.Signals | string | undefined;
    unrefed: boolean;
  };
} {
  const events = new EventEmitter();
  const destroyed = { stdin: false, stdout: false, stderr: false };
  let killSignal: NodeJS.Signals | string | undefined;
  let unrefed = false;
  let stdoutData: ((chunk: Buffer) => void) | undefined;

  const emitFramed = (msg: unknown): void => {
    const line = `${JSON.stringify(msg)}\n`;
    // Deliver on a later microtask so the SDK's response handler (registered before it
    // awaits send) is in place — mirrors a real child answering asynchronously.
    queueMicrotask(() => stdoutData?.(Buffer.from(line, 'utf8')));
  };

  const stdin = {
    on: (): void => {},
    once: (): void => {},
    write: (chunk: Buffer | string): boolean => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') {
          continue;
        }
        let parsed: { id?: unknown; method?: unknown };
        try {
          parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
        } catch {
          continue;
        }
        if (parsed.method === 'initialize' && parsed.id !== undefined) {
          emitFramed({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'fake', version: '1.0.0' },
            },
          });
        }
        // notifications/initialized (method, no id) and anything else: swallow.
      }
      return true;
    },
    destroy: (): void => {
      destroyed.stdin = true;
    },
  };

  const stdout = {
    on: (event: string, cb: (chunk: Buffer) => void): void => {
      if (event === 'data') {
        stdoutData = cb;
      }
    },
    destroy: (): void => {
      destroyed.stdout = true;
    },
  };

  const child = Object.assign(events, {
    pid,
    stdin,
    stdout,
    // stdio is ['pipe','pipe','ignore'] → the real child's stderr is null.
    stderr: null,
    kill: (signal?: NodeJS.Signals): boolean => {
      killSignal = signal;
      return true;
    },
    unref: (): void => {
      unrefed = true;
    },
  });

  return {
    child,
    // 'spawn' fires on a microtask so start()'s listener is attached first (as in Node).
    fireSpawn: () => queueMicrotask(() => events.emit('spawn')),
    fireClose: () => events.emit('close'),
    state: () => ({ destroyed, killSignal, unrefed }),
  };
}

describe('DetachedStdioTransport (default stdio transport, mocked spawn)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('spawns the child detached (own process group) and reaps the group on an unexpected drop', async () => {
    const fake = makeFakeChild(4242);
    let capturedOpts: Record<string, unknown> | undefined;
    vi.mocked(spawn).mockImplementation(((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
      capturedOpts = opts;
      fake.fireSpawn();
      return fake.child;
    }) as unknown as typeof spawn);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      let drops = 0;
      const conn = createMcpClientConnection(
        'srv',
        { command: ['server-bin', '--flag'] },
        '/tmp/ws',
        {}, // no injected factory → the real defaultStdioTransportFactory (DetachedStdioTransport)
        () => {
          drops += 1;
        },
      );

      // The real transport spawns via the mocked node:child_process spawn and the SDK
      // completes the handshake over the fake child's pipes.
      expect(await conn.connect()).toEqual({ ok: true });

      expect(spawn).toHaveBeenCalledTimes(1);
      // Spawned in its OWN process group (POSIX detached) and shell-free.
      expect(capturedOpts?.detached).toBe(true);
      expect(capturedOpts?.shell).toBe(false);

      // Healthy: nothing torn down.
      expect(fake.state().destroyed).toEqual({ stdin: false, stdout: false, stderr: false });

      // The child exits unexpectedly → the transport's 'close' handler fires. The FIX fires
      // onclose while `_process` is still set, so the connection's drop handler captures the
      // child and reaps the WHOLE group. Pre-fix `_process` was nulled first, captureChild
      // returned undefined, and releaseChild no-op'd — no killpg, no kill, no unref.
      fake.fireClose();

      expect(drops).toBe(1);
      // The negative-pid group kill (killpg) reaps grandchildren/workers, plus the direct kill.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      const st = fake.state();
      expect(st.killSignal).toBe('SIGKILL');
      // stderr is 'ignore' (null), so only our stdin/stdout pipe ends are destroyed.
      expect(st.destroyed).toEqual({ stdin: true, stdout: true, stderr: false });
      expect(st.unrefed).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('spawns non-detached on win32 and skips the negative-pid group kill on drop', async () => {
    const fake = makeFakeChild(6464);
    let capturedOpts: Record<string, unknown> | undefined;
    vi.mocked(spawn).mockImplementation(((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
      capturedOpts = opts;
      fake.fireSpawn();
      return fake.child;
    }) as unknown as typeof spawn);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      let drops = 0;
      const conn = createMcpClientConnection(
        'srv',
        { command: ['server.exe'] },
        '/tmp/ws',
        {},
        () => {
          drops += 1;
        },
      );

      expect(await conn.connect()).toEqual({ ok: true });

      // Windows has no process groups: not detached, windows-hidden instead.
      expect(capturedOpts?.detached).toBe(false);
      expect(capturedOpts?.windowsHide).toBe(true);

      fake.fireClose();

      expect(drops).toBe(1);
      // No negative-pid group kill on Windows...
      expect(killSpy).not.toHaveBeenCalled();
      // ...but the direct child kill + pipe destroy + unref still run on the drop path.
      const st = fake.state();
      expect(st.killSignal).toBe('SIGKILL');
      expect(st.destroyed).toEqual({ stdin: true, stdout: true, stderr: false });
      expect(st.unrefed).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      killSpy.mockRestore();
    }
  });
});
