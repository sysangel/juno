// tests/cli.test.ts
// W13 — coverage for main(argv, env) exported from src/cli.ts.
//
// We exercise the two pure, render-free branches: --help / -h writes the help
// banner and --version / -v writes the version derived from
// env.npm_package_version. Both branches `return` BEFORE building any real deps
// or calling render(...), so no Ink app mounts and no network/keys are touched.
//
// process.stdout/stderr.write are spied so we can assert the exact strings; the
// spies and process.exitCode are restored in afterEach so this file leaves no
// global residue for the rest of the suite.
//
// NOTE (no false-green): the brief's third case — an env that resolves NO model
// setting process.exitCode=1 + the "no model is configured" message — is NOT
// reachable through main(argv, env) today. main() always builds the catalog from
// the hardcoded, non-empty BUILTIN_MODELS, and `catalog.resolve(...) ??
// catalog.default()` always yields the default `gpt-4.1` entry regardless of env
// (a bogus JUNO_MODEL just falls through to default()). Triggering that branch
// would require a src change (e.g. an injectable/empty catalog), which W13
// forbids — so it is intentionally NOT asserted here rather than faked green.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initMcpWiring, main } from '../src/cli';
import type { McpServerConfig } from '../src/services/config';
import type { McpManager } from '../src/services/mcpManager';

/** A spy over a write()-shaped function whose first arg is the chunk. */
type WriteSpy = { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } };

function spyOnStdio(): { out: WriteSpy; err: WriteSpy } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { out: out as unknown as WriteSpy, err: err as unknown as WriteSpy };
}

/** Concatenate every string written through a spied write(). */
function written(spy: WriteSpy): string {
  return spy.mock.calls.map((call) => String(call[0])).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('cli main()', () => {
  it('--help writes the help banner and does NOT render the app', async () => {
    const { out, err } = spyOnStdio();

    await main(['--help'], { npm_package_version: '9.9.9' });

    const help = written(out);
    expect(help).toContain('juno — terminal agent UI');
    expect(help).toContain('Usage:');
    expect(help).toContain('--help');
    expect(help).toContain('--version');
    // Help is informational only: nothing on stderr, no exit code set.
    expect(written(err)).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('-h is an alias for --help', async () => {
    const { out } = spyOnStdio();
    await main(['-h'], {});
    expect(written(out)).toContain('juno — terminal agent UI');
  });

  it('--version writes the version from env.npm_package_version', async () => {
    const { out, err } = spyOnStdio();

    await main(['--version'], { npm_package_version: '1.2.3' });

    expect(written(out)).toBe('juno 1.2.3\n');
    expect(written(err)).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('-v is an alias and falls back to 0.0.0 when npm_package_version is absent', async () => {
    const { out } = spyOnStdio();
    await main(['-v'], {});
    expect(written(out)).toBe('juno 0.0.0\n');
  });

  it('--help takes precedence over --version when both are present', async () => {
    const { out } = spyOnStdio();
    await main(['--help', '--version'], { npm_package_version: '5.5.5' });
    const text = written(out);
    expect(text).toContain('juno — terminal agent UI');
    expect(text).not.toContain('juno 5.5.5');
  });
});

// Wave 4 — the MCP startup wiring extracted from main(). Hermetic: a fake
// manager factory records construction/start/shutdown; no real connections.
describe('cli initMcpWiring()', () => {
  const SERVERS: Record<string, McpServerConfig> = { weather: { command: ['srv'] } };

  interface FakeManagerLog {
    constructedWith?: { servers: Record<string, McpServerConfig>; cwd: string };
    started: number;
    shutdowns: number;
  }

  function fakeFactory(
    warnings: string[],
    log: FakeManagerLog,
    shutdownError?: Error,
  ): (servers: Record<string, McpServerConfig>, cwd: string) => McpManager {
    return (servers, cwd) => {
      log.constructedWith = { servers, cwd };
      return {
        start: async () => {
          log.started += 1;
          return { connected: Object.keys(servers), warnings };
        },
        listTools: () => [],
        callTool: async () => ({ ok: false, error: 'unused' }),
        shutdownAll: async () => {
          log.shutdowns += 1;
          if (shutdownError !== undefined) {
            throw shutdownError;
          }
        },
      };
    };
  }

  it('returns mcp:undefined and a no-op shutdown when no servers are configured', async () => {
    const log: FakeManagerLog = { started: 0, shutdowns: 0 };
    const warned: string[] = [];
    for (const servers of [undefined, {}]) {
      const wiring = await initMcpWiring(servers, '/cwd', (m) => warned.push(m), fakeFactory([], log));
      expect(wiring.mcp).toBeUndefined();
      await expect(wiring.shutdown()).resolves.toBeUndefined();
    }
    // No manager was ever constructed or started; nothing was warned.
    expect(log.constructedWith).toBeUndefined();
    expect(log.started).toBe(0);
    expect(warned).toEqual([]);
  });

  it('builds + starts the manager over the configured servers and returns the registry option', async () => {
    const log: FakeManagerLog = { started: 0, shutdowns: 0 };
    const wiring = await initMcpWiring(SERVERS, '/work/ws', () => {}, fakeFactory([], log));

    expect(log.constructedWith).toEqual({ servers: SERVERS, cwd: '/work/ws' });
    expect(log.started).toBe(1);
    expect(wiring.mcp).toBeDefined();
    expect(wiring.mcp?.servers).toBe(SERVERS);
  });

  it('forwards every start() warning through onWarn (pre-render reporting)', async () => {
    const log: FakeManagerLog = { started: 0, shutdowns: 0 };
    const warned: string[] = [];
    await initMcpWiring(
      SERVERS,
      '/cwd',
      (m) => warned.push(m),
      fakeFactory(['mcp: server "a" failed', 'mcp: server "b" timed out'], log),
    );
    expect(warned).toEqual(['mcp: server "a" failed', 'mcp: server "b" timed out']);
  });

  it('shutdown() calls shutdownAll and swallows its failure (never blocks exit)', async () => {
    const okLog: FakeManagerLog = { started: 0, shutdowns: 0 };
    const ok = await initMcpWiring(SERVERS, '/cwd', () => {}, fakeFactory([], okLog));
    await expect(ok.shutdown()).resolves.toBeUndefined();
    expect(okLog.shutdowns).toBe(1);

    const failLog: FakeManagerLog = { started: 0, shutdowns: 0 };
    const failing = await initMcpWiring(
      SERVERS,
      '/cwd',
      () => {},
      fakeFactory([], failLog, new Error('teardown exploded')),
    );
    await expect(failing.shutdown()).resolves.toBeUndefined();
    expect(failLog.shutdowns).toBe(1);
  });
});
