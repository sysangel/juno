// tests/hooksPipeline.e2e.test.ts
// Wave 13 — the FULL Wave-12 tool-hook pipeline against REAL spawned hermetic
// fixtures. Every other hook test cuts the pipeline at a seam with a fake:
// hookDispatcher.test.ts injects a synthetic makeSpawn (no real child),
// config.hooks.test.ts is parse-only, and tools.test.ts drives the executor with a
// hand-built fakeHooks stub. NONE of them spawns a real hook process or joins the
// three stages. This suite closes that gap end to end:
//
//   config parse (createConfigService)                           [stage 1]
//     -> matcher compile + REAL hook exec (createHookDispatcher   [stage 2]
//        with the DEFAULT spawnImpl => genuine child processes)
//     -> decision merge (createToolExecutor terminal events)      [stage 3]
//
// HERMETICITY: hooks are tiny node scripts under tests/fixtures/hooks/, spawned as
// `[process.execPath, <fixture>]` — node's own binary, NO shell, NO PATH/uv/python
// dependency (juno's established convention, see brainMcp.integration.test.ts). Each
// test gets a fresh mkdtemp for its config.json and any sentinel file, removed in
// afterEach. Nothing reads ~/.claude or any personal path. The dispatcher runs with
// the DEFAULT scheduler too, so the genuine setTimeout drives the real timeout.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigService, type HooksSettings } from '../src/services/config';
import {
  createHookDispatcher,
  type HookDispatcher,
  type HookDispatcherOptions,
} from '../src/tools/hookDispatcher';
import { createToolExecutor, type ToolExecutorDeps } from '../src/tools/executor';
import type { PermissionPolicy, Tool, ToolResult } from '../src/core/contracts';
import type { AgentEvent, PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';

// --- fixture resolution -------------------------------------------------------

/** Absolute path to a spawnable hook fixture, resolved from THIS file (so tsx /
 * vitest locate the .mjs regardless of cwd). */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/hooks/${name}`, import.meta.url));
}

/** A shell-free hook argv: node's own binary + the fixture + optional extra args
 * (e.g. a tempdir sentinel path). */
function cmd(name: string, ...extra: string[]): string[] {
  return [process.execPath, fixture(name), ...extra];
}

// --- executor test scaffolding (mirrors tests/tools.test.ts) ------------------

/** A minimal, real Readonly<State> for the executor — no `any`, no unsafe cast. */
function fakeState(): Readonly<State> {
  return {
    committed: [],
    live: null,
    tools: {},
    phase: 'idle',
    overlay: 'none',
    effort: 'medium',
    permissionMode: 'default',
    tokens: { in: 0, out: 0 },
    pendingPermission: null,
    errorMessage: null,
  };
}

class FakePolicy implements PermissionPolicy {
  public constructor(private readonly decision: 'auto-allow' | 'auto-deny' | 'prompt') {}
  public evaluate(): 'auto-allow' | 'auto-deny' | 'prompt' {
    return this.decision;
  }
  public remember(): void {
    return undefined;
  }
  public setMode(): void {
    return undefined;
  }
}

function statusEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tool-status' }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> => event.type === 'tool-status',
  );
}

function makeDeps(opts: {
  tools: ReadonlyArray<Tool>;
  policy: PermissionPolicy;
  hooks: HookDispatcher;
}): ToolExecutorDeps {
  return {
    tools: opts.tools,
    policy: opts.policy,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    getState: () => fakeState(),
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    hooks: opts.hooks,
  };
}

// --- suite --------------------------------------------------------------------

describe('hooks pipeline e2e (parse -> compile+spawn -> merge, real children)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-hooks-e2e-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Stage 1 + the entry to stage 2: write a real config.json with the given
   * `hooks` block, parse it through createConfigService (proving the block
   * survived parse), then build a dispatcher on the DEFAULT spawnImpl/scheduler so
   * hooks run as genuine child processes under the real setTimeout.
   */
  async function buildPipeline(
    hooksBlock: unknown,
    dispatcherOptions?: HookDispatcherOptions,
  ): Promise<{ parsed: HooksSettings; dispatcher: HookDispatcher }> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify({ hooks: hooksBlock }), 'utf8');
    const svc = createConfigService({ configPath, env: {} });
    const parsed = svc.getValue('hooks');
    expect(parsed, 'stage 1: config parse produced a hooks block').toBeDefined();
    const dispatcher = createHookDispatcher(parsed as HooksSettings, dispatcherOptions);
    return { parsed: parsed as HooksSettings, dispatcher };
  }

  // 1. CONTEXT-INJECTING (models brain-hook ambient recall injection) -----------
  it('PostToolUse context inject: appendText reaches the executor promptText, and the real stdin payload reached the child', async () => {
    const sentinel = path.join(tempDir, 'post-payload.json');
    const command = cmd('injectContext.mjs', sentinel);
    const hooksBlock = { PostToolUse: [{ matcher: '*', hooks: [{ command }] }] };

    const { parsed, dispatcher } = await buildPipeline(hooksBlock);
    // Stage 1 fidelity: the whole block round-trips through parse unchanged.
    expect(parsed).toEqual({ PostToolUse: [{ matcher: '*', hooks: [{ command }] }] });

    const toolName = 'edit_file';
    const args = { path: 'notes/x.txt' };
    const data = { written: true };

    // Stage 2 (dispatcher against a REAL spawned child): the additionalContext the
    // child emitted, echoing the tool_name it read off stdin, comes back as append.
    const appended = await dispatcher.postToolUse(toolName, args, data);
    expect(appended).toEqual({ appendText: `[recall] ${toolName}` });

    // stdin-contract proof: the sentinel the child dropped IS the exact PostToolUse
    // payload — hook_event_name + tool_name + tool_input + tool_response all crossed
    // the pipe into the real process.
    const received = JSON.parse(await readFile(sentinel, 'utf8'));
    expect(received).toEqual({
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: args,
      tool_response: data,
    });

    // Stage 3 (decision MERGE in the executor): a tool with NO own promptText, so
    // the merged promptText is JSON.stringify(data) + the hook append (executor.ts).
    const tool: Tool = {
      name: toolName,
      risk: 'safe',
      spec: { name: toolName, description: '', inputSchema: {} },
      run: async (): Promise<ToolResult> => ({ ok: true, data }),
    };
    const events: AgentEvent[] = [];
    const executor = createToolExecutor(
      makeDeps({ tools: [tool], policy: new FakePolicy('auto-allow'), hooks: dispatcher }),
    );
    await executor.execute('call-ctx', toolName, args, (event) => events.push(event));

    const terminal = statusEvents(events).at(-1);
    expect(terminal?.status).toBe('result');
    expect(terminal?.result).toEqual(data); // UI-card payload untouched by the append
    expect(terminal?.promptText).toBe(`${JSON.stringify(data)}\n\n[recall] ${toolName}`);
  });

  // 2. DENYING (models a sensitive-path guard) ---------------------------------
  it('PreToolUse deny: dispatcher blocks with the reason, and the executor emits the terminal error BEFORE tool.run or policy.evaluate', async () => {
    const command = cmd('denyPre.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    const toolName = 'run_shell';
    const args = { cmd: 'rm -rf /etc' };

    // Stage 2: real child returns {decision:'block', reason} echoing the tool_name.
    const outcome = await dispatcher.preToolUse(toolName, args);
    expect(outcome).toEqual({ block: true, reason: `blocked: ${toolName}` });

    // Stage 3 (decision MERGE): the block is the cheapest terminal path — it fires
    // BEFORE policy.evaluate and BEFORE tool.run (executor gates pre-hook first).
    const run = vi.fn(async (): Promise<ToolResult> => ({ ok: true, data: 'ran' }));
    const evaluate = vi.fn((): 'auto-allow' => 'auto-allow');
    const tool: Tool = { name: toolName, risk: 'safe', spec: { name: toolName, description: '', inputSchema: {} }, run };
    const policy: PermissionPolicy = { evaluate, remember: () => {}, setMode: () => {} };

    const events: AgentEvent[] = [];
    const executor = createToolExecutor(makeDeps({ tools: [tool], policy, hooks: dispatcher }));
    await executor.execute('call-deny', toolName, args, (event) => events.push(event));

    expect(statusEvents(events)).toEqual([
      { type: 'tool-status', toolCallId: 'call-deny', status: 'error', error: `blocked: ${toolName}` },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  // 3. TIMING-OUT (fail OPEN) ---------------------------------------------------
  it('PreToolUse timeout: a hook that never responds is killed by the real per-hook timeout and fails OPEN', async () => {
    const command = cmd('sleepForever.mjs');
    // Real setTimeout at 200ms trips well under vitest's 5s default; the it() gets a
    // 10s belt-and-suspenders bound below.
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command, timeoutMs: 200 }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    const outcome = await dispatcher.preToolUse('read_file', {});
    expect(outcome).toEqual({ block: false });
  }, 10_000);

  // 4. MALFORMED MATCHER (fail CLOSED) -----------------------------------------
  it('PreToolUse malformed matcher: parse ACCEPTS the invalid regex but compile FAILS CLOSED — a hard block with NO spawn', async () => {
    const sentinel = path.join(tempDir, 'never-ran.sentinel');
    const command = cmd('neverRun.mjs', sentinel);
    // `(` is a valid string (parse keeps it) but an invalid regex (compile fails).
    const hooksBlock = { PreToolUse: [{ matcher: '(', hooks: [{ command }] }] };

    const { parsed, dispatcher } = await buildPipeline(hooksBlock);
    // Stage 1: the parser only checks typeof matcher === 'string', so the broken
    // pattern survives parse verbatim — the failure is deferred to compile.
    expect(parsed).toEqual({ PreToolUse: [{ matcher: '(', hooks: [{ command }] }] });

    const outcome = await dispatcher.preToolUse('read_file', {});
    expect(outcome.block).toBe(true);
    if (outcome.block) {
      expect(outcome.reason).toContain('failed to compile');
    }
    // No-spawn proof: the child never ran, so its sentinel was never written.
    expect(existsSync(sentinel)).toBe(false);
  });

  // 5. CRASHING (fail OPEN) — nonzero-but-NOT-2 --------------------------------
  it('PreToolUse crash: exit 1 with non-JSON output fails OPEN (distinct from the exit-2 governance path)', async () => {
    const command = cmd('crash.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });

  // 6. JSON-DECISION-BEATS-EXIT-CODE + the exit-code converse -------------------
  it('PreToolUse: a JSON approve WINS over exit 2 (fails open)', async () => {
    const command = cmd('approveOverExit2.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  });

  it('PreToolUse: exit 2 governs when there is NO parseable JSON decision (blocks)', async () => {
    const command = cmd('blockByExit2.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    const outcome = await dispatcher.preToolUse('read_file', {});
    expect(outcome.block).toBe(true);
  });

  // OPTIONAL: oversized stdout — the real drain-cap path -----------------------
  it('PreToolUse oversized stdout: a child that floods past the size cap is killed and fails OPEN', async () => {
    const command = cmd('oversized.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const { dispatcher } = await buildPipeline(hooksBlock);

    expect(await dispatcher.preToolUse('read_file', {})).toEqual({ block: false });
  }, 10_000);

  // OPTIONAL: abort mid-flight over a REAL child -------------------------------
  it('PreToolUse abort: aborting mid-flight against a live child fails OPEN (parity with the unit abort test, over a real process)', async () => {
    const command = cmd('sleepForever.mjs');
    const hooksBlock = { PreToolUse: [{ matcher: '*', hooks: [{ command }] }] };
    const controller = new AbortController();
    const { dispatcher } = await buildPipeline(hooksBlock, { signal: controller.signal });

    const pending = dispatcher.preToolUse('read_file', {});
    // Give the real child time to spawn and the abort listener to attach, then abort
    // the turn mid-hook. Real timer only — no fake clock (TUI/testing rule).
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    expect(await pending).toEqual({ block: false });
  }, 10_000);
});
