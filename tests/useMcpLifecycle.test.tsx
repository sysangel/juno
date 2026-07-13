// tests/useMcpLifecycle.test.tsx
// W9 app-decompose — the MCP fleet wiring seam (useMcpLifecycle), tested DIRECTLY.
// tests/asyncMcp.test.tsx pins the same contract end-to-end at the mounted-<App>
// level; this file is the hook's own unit surface (the flaky-connect seam had no
// direct tests before the extraction):
//   - no servers configured → no chip, base tools pass through, start() no-ops
//   - chip seeds 'connecting' BEFORE the connect resolves (paint not gated)
//   - resolution maps {connected,total} → ready / partial / failed
//   - discovered tools/specs APPEND after the base set (late-bind, base first)
//   - warnings collapse to ONE formatted `mcp: …` notify line (none when clean)
//   - start() is once-only across re-kicks (the caller's effect refires per
//     render; manager.start must still be invoked exactly once)
//
// Patterns reused: a probe component captures the hook's return (as
// ctrlcExit.test drives its hook through a mount); the controlled manager whose
// start() resolves on demand mirrors tests/asyncMcp.test.tsx; flushInk-based
// synchronization, no fake timers (they stall Ink's effect scheduler).
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { useMcpLifecycle } from '../src/hooks/useMcpLifecycle';
import type { McpLifecycle, McpLifecycleDeps } from '../src/hooks/useMcpLifecycle';
import type { Tool } from '../src/core/contracts';
import type { McpCallToolOutcome } from '../src/services/mcpClient';
import type {
  McpDiscoveredTool,
  McpManager,
  McpManagerStartResult,
} from '../src/services/mcpManager';
import type { McpServerConfig } from '../src/services/config';
import { flushInk, waitFor } from './helpers/ink';

// ---------------------------------------------------------------------------
// Fixtures — one brain server exposing two tools (mirrors asyncMcp.test.tsx).
// ---------------------------------------------------------------------------
const DISCOVERED: McpDiscoveredTool[] = [
  { server: 'brain', tool: { name: 'recall', description: 'read', inputSchema: { type: 'object' } } },
  { server: 'brain', tool: { name: 'remember', description: 'write', inputSchema: { type: 'object' } } },
];
const SERVERS: Record<string, McpServerConfig> = { brain: { command: ['brain-mcp'] } };

/** A manager whose `start()` resolves only when the test calls `resolveStart` —
 * so a test can hold the connect PENDING (seeded-chip proof) or resolve it with a
 * chosen {connected, warnings} (mapping / late-bind / warnings proofs). */
function createControlledManager(discovered: McpDiscoveredTool[] = DISCOVERED): {
  manager: McpManager;
  started: { count: number };
  resolveStart: (result: McpManagerStartResult) => void;
} {
  const started = { count: 0 };
  let resolve!: (result: McpManagerStartResult) => void;
  const startPromise = new Promise<McpManagerStartResult>((r) => {
    resolve = r;
  });
  const manager: McpManager = {
    start: () => {
      started.count += 1;
      return startPromise;
    },
    listTools: () => discovered,
    status: () => [],
    callTool: async (): Promise<McpCallToolOutcome> => ({ ok: false, error: 'unused' }),
    shutdownAll: async () => {},
  };
  return { manager, started, resolveStart: resolve };
}

/** A minimal base tool (the hook never executes it — identity is the assert). */
function baseTool(name: string): Tool {
  return {
    name,
    risk: 'safe',
    spec: { name, description: name, inputSchema: { type: 'object' } },
    run: async () => ({ ok: true }),
  };
}

/** Mount the hook in a probe component and capture its live return value. */
function mountLifecycle(deps: McpLifecycleDeps): {
  out: () => McpLifecycle;
  rerender: () => void;
} {
  const holder: { current: McpLifecycle | null } = { current: null };
  function Probe(): ReturnType<typeof Text> {
    holder.current = useMcpLifecycle(deps);
    return <Text>probe:{holder.current.status?.state ?? 'none'}</Text>;
  }
  const instance = render(<Probe />);
  return {
    out: () => {
      if (holder.current === null) {
        throw new Error('hook return was not captured');
      }
      return holder.current;
    },
    rerender: () => instance.rerender(<Probe />),
  };
}

describe('useMcpLifecycle — app-side MCP fleet wiring', () => {
  it('no servers configured: no chip, base tools/specs pass through, start() no-ops', async () => {
    const base = [baseTool('read_file'), baseTool('shell')];
    const notify = vi.fn();
    const { out } = mountLifecycle({
      mcp: undefined,
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    expect(out().status).toBeUndefined();
    expect(out().tools).toEqual(base);
    expect(out().specs).toEqual(base.map((tool) => tool.spec));

    out().start(notify);
    await flushInk();
    expect(notify).not.toHaveBeenCalled();
    expect(out().status).toBeUndefined();
  });

  it('seeds the connecting chip while start() is still pending (paint not gated)', async () => {
    const { manager } = createControlledManager();
    const base = [baseTool('read_file')];
    const { out } = mountLifecycle({
      mcp: { manager, servers: SERVERS },
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    // Chip is seeded BEFORE anyone calls start() — first paint shows it.
    expect(out().status).toEqual({ state: 'connecting', connected: 0, total: 1 });

    out().start(vi.fn());
    await flushInk();
    // Connect never resolves in this test: the chip stays connecting, the tool
    // set stays the base set — nothing blocks on the pending promise.
    expect(out().status).toEqual({ state: 'connecting', connected: 0, total: 1 });
    expect(out().tools).toEqual(base);
  });

  it('full connect → ready chip, discovered tools/specs appended AFTER the base set', async () => {
    const { manager, resolveStart } = createControlledManager();
    const base = [baseTool('read_file')];
    const { out } = mountLifecycle({
      mcp: { manager, servers: SERVERS },
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    const notify = vi.fn();
    out().start(notify);
    resolveStart({ connected: ['brain'], warnings: [] });
    await waitFor(() => out().status?.state === 'ready', { label: 'ready chip' });

    expect(out().status).toEqual({ state: 'ready', connected: 1, total: 1 });
    const names = out().tools.map((tool) => tool.spec.name);
    expect(names).toEqual(['read_file', 'mcp__brain__recall', 'mcp__brain__remember']);
    expect(out().specs.map((spec) => spec.name)).toEqual(names);
    expect(notify).not.toHaveBeenCalled(); // clean connect → no notice line
  });

  it('partial connect → partial chip; warnings collapse to ONE mcp: line', async () => {
    const { manager, resolveStart } = createControlledManager();
    const servers: Record<string, McpServerConfig> = {
      brain: { command: ['brain-mcp'] },
      dead: { command: ['dead-mcp'] },
    };
    const base = [baseTool('read_file')];
    const { out } = mountLifecycle({
      mcp: { manager, servers },
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    const notify = vi.fn();
    out().start(notify);
    resolveStart({ connected: ['brain'], warnings: ['dead: connect failed', 'x: tool dropped'] });
    await waitFor(() => out().status?.state === 'partial', { label: 'partial chip' });

    expect(out().status).toEqual({ state: 'partial', connected: 1, total: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('mcp: dead: connect failed; x: tool dropped');
  });

  it('zero servers connect → failed chip, tool set stays the base set', async () => {
    const { manager, resolveStart } = createControlledManager([]);
    const base = [baseTool('read_file')];
    const { out } = mountLifecycle({
      mcp: { manager, servers: SERVERS },
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    out().start(vi.fn());
    resolveStart({ connected: [], warnings: ['brain: connect failed'] });
    await waitFor(() => out().status?.state === 'failed', { label: 'failed chip' });

    expect(out().status).toEqual({ state: 'failed', connected: 0, total: 1 });
    expect(out().tools).toEqual(base);
  });

  it('start() is once-only: re-kicks across re-renders never restart the fleet', async () => {
    const { manager, started, resolveStart } = createControlledManager();
    const base = [baseTool('read_file')];
    const { out, rerender } = mountLifecycle({
      mcp: { manager, servers: SERVERS },
      baseTools: base,
      baseSpecs: base.map((tool) => tool.spec),
    });
    await flushInk();

    // The caller's effect refires each render (turn re-identifies) — model that
    // by re-kicking start() around re-renders, before AND after resolution.
    out().start(vi.fn());
    out().start(vi.fn());
    rerender();
    await flushInk();
    out().start(vi.fn());
    resolveStart({ connected: ['brain'], warnings: [] });
    await waitFor(() => out().status?.state === 'ready', { label: 'ready chip' });
    out().start(vi.fn());
    await flushInk();

    expect(started.count).toBe(1);
    // And the late-bind appended exactly once.
    expect(out().tools.map((tool) => tool.spec.name)).toEqual([
      'read_file',
      'mcp__brain__recall',
      'mcp__brain__remember',
    ]);
  });
});
