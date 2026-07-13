// src/hooks/useMcpLifecycle.ts
// W9 app-decompose — the app-side MCP fleet wiring (Wave 2 async-mcp), extracted
// verbatim from app.tsx. Owns the late-bindable tools/specs state, the connection
// chip state, and the once-only background `start()` — the seam behind the
// flaky-connect complaints, now unit-testable without mounting the whole App.
//
// Contract (unchanged from the in-app version):
//   - `tools`/`specs` initialize to the non-MCP base set built by cli.ts; on
//     `start()` resolution the discovered MCP tools are APPENDED (after the base
//     tools, whose subagent tool already froze an MCP-free childTools snapshot,
//     so subagents never gain MCP tools) and the submit closure re-forms with the
//     full set for the NEXT turn.
//   - `status` seeds to `connecting` when servers are configured so the very
//     first paint already shows the state chip — proof the render is not gated
//     on the connect. It maps {connected, total} → ready/partial/failed when the
//     connect resolves. Mid-session drops surface through `manager.status()`
//     (read at render by the /mcp panel), not through this chip.
//   - `start(notify)` is idempotent (ref-guarded) and kicked by App from an
//     effect AFTER first paint — keeping the render off the connect's critical
//     path. `manager.start()` is itself fail-soft and time-bounded per server;
//     callTool fails soft when a server is not yet live, so a first turn fired
//     mid-connect degrades gracefully rather than blocking. Skipped-server /
//     dropped-tool warnings surface through `notify` as ONE line (App routes it
//     to a dim transcript notice — post-render stderr writes corrupt the ink TUI).
import { useCallback, useRef, useState } from 'react';
import type { Tool, ToolSpec } from '../core/contracts';
import type { McpConnectionState } from '../core/selectors';
import type { McpServerConfig } from '../services/config';
import type { McpManager } from '../services/mcpManager';
import { createMcpTools } from '../tools/mcpTools';

export interface McpLifecycleDeps {
  /** The built-but-not-started fleet (absent when no servers are configured). */
  readonly mcp?: {
    readonly manager: McpManager;
    readonly servers: Record<string, McpServerConfig>;
  };
  /** The non-MCP tool set built by cli.ts — the pre-connect baseline. */
  readonly baseTools: ReadonlyArray<Tool>;
  /** Specs matching `baseTools` (already defaulted by the caller). */
  readonly baseSpecs: ReadonlyArray<ToolSpec>;
}

export interface McpLifecycle {
  /** Active tool set: base tools, plus the discovered MCP tools once connected. */
  readonly tools: ReadonlyArray<Tool>;
  /** Active specs, kept in lockstep with `tools`. */
  readonly specs: ReadonlyArray<ToolSpec>;
  /** Connection chip state; undefined when no MCP servers are configured. */
  readonly status: McpConnectionState | undefined;
  /**
   * Kick the background connect (once — later calls no-op). `notify` receives
   * the single formatted warning line when any server/tool was skipped.
   */
  readonly start: (notify: (text: string) => void) => void;
}

export function useMcpLifecycle(deps: McpLifecycleDeps): McpLifecycle {
  const { mcp, baseTools, baseSpecs } = deps;

  const [tools, setTools] = useState<ReadonlyArray<Tool>>(baseTools);
  const [specs, setSpecs] = useState<ReadonlyArray<ToolSpec>>(baseSpecs);
  const [status, setStatus] = useState<McpConnectionState | undefined>(() =>
    mcp !== undefined
      ? { state: 'connecting', connected: 0, total: Object.keys(mcp.servers).length }
      : undefined,
  );
  const startedRef = useRef(false);

  // Guarded by a ref so it fires exactly once even though the caller's effect
  // re-runs each render. start() is idempotent and never throws across its
  // boundary. On resolution: map {connected, total} to the chip state, append
  // the discovered MCP tools (createMcpTools) to the base set, and hand any
  // skipped-server / dropped-tool warnings to `notify` as ONE line.
  const start = useCallback(
    (notify: (text: string) => void): void => {
      if (startedRef.current || mcp === undefined) {
        return;
      }
      startedRef.current = true;
      const total = Object.keys(mcp.servers).length;
      void (async (): Promise<void> => {
        const result = await mcp.manager.start();
        const connected = result.connected.length;
        const state: McpConnectionState['state'] =
          connected === 0 ? 'failed' : connected < total ? 'partial' : 'ready';
        setStatus({ state, connected, total });
        const mcpTools = createMcpTools({ manager: mcp.manager, servers: mcp.servers });
        if (mcpTools.length > 0) {
          setTools((current) => [...current, ...mcpTools]);
          setSpecs((current) => [...current, ...mcpTools.map((tool) => tool.spec)]);
        }
        if (result.warnings.length > 0) {
          notify(`mcp: ${result.warnings.join('; ')}`);
        }
      })();
    },
    [mcp],
  );

  return { tools, specs, status, start };
}
