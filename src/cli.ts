#!/usr/bin/env -S tsx
// src/cli.ts
// W6 — the `juno` entry point. Parses --help/--version (preserving the W1
// behavior), else builds the real deps (config, catalog, client, policy, tools)
// and renders <App deps=... />.
//
// Windows note: npm's global bin shim invokes `node`, which cannot run .ts
// directly. Use `npm start` / `tsx src/cli.ts`. See docs/DECISIONS.md.
import { realpath as fsRealpath } from 'node:fs/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app';
import type { AppDeps } from './app';
import { createPermissionPolicy } from './permissions/policy';
import { createModelClient } from './providers';
import type { ModelClient, PermissionPolicy, Tool } from './core/contracts';
import type { SpawnImpl } from './providers/claudeCliClient';
import { createCodexSpawnBridge, type CodexSpawnBridge } from './providers/codexSpawnBridge';
import type { CodexMcpConfig } from './providers/codexCliClient';
import { createCodexBridgeHost } from './services/codexBridgeHost';
import { createFakeModelClient } from './core/fakeClient';
import { createConfigService, withBrainReadonlyMcpServer } from './services/config';
import type { BrainSettings, McpServerConfig, Settings } from './services/config';
import { createMcpManager, type McpManager } from './services/mcpManager';
import { BUILTIN_MODELS, createModelCatalog, type ModelEntry } from './services/catalog';
import { createDefaultTools } from './tools/registry';
import { createSubagentTool, type SubagentDeps } from './tools/subagentTool';
import {
  createSandboxProvider,
  defaultProbeSpawn,
  type SandboxProvider,
} from './tools/shellSandbox';
import { assembleSystemPrompt, createSkillsService } from './services/skills';
import {
  AMBIENT_RECALL_TIMEOUT_MS,
  appendBrainMemoryContext,
  fetchBrainAmbientRecall,
  fetchBrainSessionContext,
} from './services/brain';
import { loadAgentDefinitions } from './services/agents';
import { createMemoryStore } from './services/memory';
import { createSessionStore } from './services/sessions';
import { createBackgroundAgentRunner } from './services/backgroundAgents';
import { createSubagentRecorder } from './services/subagentRecorder';
import { readSubagentTools } from './services/subagentReader';
import { detectBackground, setActiveTheme } from './ui/theme';

const HELP = `juno — terminal agent UI

Usage:
  juno              launch the TUI
  juno --help       show this help
  juno --version    print version
`;

function versionFromEnv(env: NodeJS.ProcessEnv): string {
  return env.npm_package_version ?? '0.0.0';
}

/** What `initMcpWiring` hands back to main(): the App wiring (the built-but-not-
 * started manager + its configured servers, or `undefined` when none) and a
 * never-throwing teardown over the SAME manager instance. */
export interface McpWiring {
  mcp: AppDeps['mcp'];
  shutdown: () => Promise<void>;
}

/**
 * MCP startup wiring (Wave 4; async-connect in Wave 2), extracted from main() so
 * it is testable without a TTY. When servers are configured it BUILDS the manager
 * but deliberately does NOT `start()` it: App kicks the connect in a mount effect
 * (after first paint) so the render is never gated on the ~569ms brain spawn (up
 * to 30s for a dead server), then late-binds the discovered tools and surfaces the
 * connect state in the status strip. Connect warnings therefore no longer route
 * through here to stderr — App folds them into a transcript notice, since a stderr
 * write after render corrupts the ink TUI. `shutdown` is best-effort teardown for
 * exit paths over the same manager instance: it swallows any error so a failed
 * shutdown can never block the process from exiting.
 */
export function initMcpWiring(
  servers: Record<string, McpServerConfig> | undefined,
  cwd: string,
  createManager: (
    servers: Record<string, McpServerConfig>,
    fallbackCwd: string,
  ) => McpManager = (servers, fallbackCwd) =>
    // Enable bounded-backoff reconnect in production (the empty reconnect object opts
    // in with defaults: base 1s → …16s, cap 30s, hard cap 5 retries → terminal failed).
    // Tests inject their own createManager to control (or disable) it.
    createMcpManager(servers, fallbackCwd, {}, {}),
): McpWiring {
  const configured = servers ?? {};
  if (Object.keys(configured).length === 0) {
    return { mcp: undefined, shutdown: async () => {} };
  }
  const manager = createManager(configured, cwd);
  return {
    mcp: { manager, servers: configured },
    shutdown: async (): Promise<void> => {
      try {
        await manager.shutdownAll();
      } catch {
        // Best-effort: teardown failures must never block exit.
      }
    },
  };
}

/** The in-process codex spawn-bridge wiring: the bridge (emits the spawn card +
 * nested child events into the active codex turn) plus the MCP config that points
 * codex at juno's in-process `spawn_subagent` server. Populated once the tool set
 * exists (see main()), so factory reads it LAZILY. */
export interface CodexBridgeWiring {
  readonly bridge: CodexSpawnBridge;
  readonly mcpConfig: CodexMcpConfig;
}

/** Wave 13 (retry-ui): transport-retry observer the PARENT factory forwards into the
 * HTTP adapters so a pre-first-byte backoff surfaces on the busy line. Matches
 * `retryFetch`'s `onRetry` shape. */
export type RetryObserver = (attempt: number, max: number, delayMs: number) => void;

/** The two client factories the app threads apart. */
export interface ClientFactories {
  /** PARENT (App) client factory — MAY carry the codex spawn bridge, so a codex
   * PARENT hosts juno's `spawn_subagent` MCP server and attributes nested child
   * cards into its own turn (the headline codex-parent scenario). `onRetry` (optional)
   * is the App's transport-retry observer; omit for children (a subagent's internal
   * retries are intentionally NOT surfaced on the parent status line). */
  readonly createClient: (entry: ModelEntry, onRetry?: RetryObserver) => ModelClient;
  /** SUB-AGENT client factory — NEVER carries the bridge. A codex CHILD must not be
   * launched with the `-c mcp_servers.…` flags (that would hand a sub-agent
   * spawn_subagent over MCP → unbounded grandchildren, breaking the depth-1
   * invariant subagentTool enforces), nor call `bridge.beginTurn` (which would
   * REPLACE the parent turn's registration and clear `active` when the child turn
   * ends — wedging every later spawn in the parent turn with 'no active codex
   * turn'). Codex children still render fine via subagentTool's own
   * dispatch/surfaceChildEvent path (Wave 7); they never need the bridge. */
  readonly createChildClient: (entry: ModelEntry) => ModelClient;
}

export interface ClientFactoryDeps {
  readonly useFakeProvider: boolean;
  readonly fakeLongLines: number;
  readonly fakeLineWidth: number;
  readonly fakeSubagent: boolean;
  /** With `fakeLongLines`, prepend this many running subagents to the long stream so the
   *  agents dropdown can be expanded over a tall live turn (scrollback pty test). */
  readonly fakeSubagentCount: number;
  /** Per-event tick for the fake stream (ms). Lets a pty test SLOW the stream so it can act
   *  (e.g. expand the agents dropdown) mid-turn deterministically. NaN ⇒ the default 1ms. */
  readonly fakeTickMs: number;
  /** Test-only: drive the concurrent TWO-subagent turn (JUNO_FAKE_SUBAGENTS=2) so the
   *  selftest harness can exercise concurrent spawns. Ignored under `fakeLongLines`. */
  readonly fakeMultiSubagent: boolean;
  /** Test-only: drive the CODEX-shaped concurrent-subagent turn (JUNO_FAKE_SUBAGENTS=codex)
   *  so the harness can prove the subagent surface is provider-agnostic (UX-SPEC R3).
   *  Ignored under `fakeLongLines`. */
  readonly fakeCodexSubagents: boolean;
  /** Test-only: drive the CODEX-shaped ERRORED concurrent-subagent turn
   *  (JUNO_FAKE_SUBAGENTS=codex-error) so the harness can prove a failed codex parent
   *  surfaces identically to a claude/juno one (UX-SPEC R3 failure parity). Ignored under
   *  `fakeLongLines`. */
  readonly fakeCodexErrorSubagent: boolean;
  /** Test-only: drive the concurrent-subagent turn with CJK + emoji descriptions
   *  (JUNO_FAKE_SUBAGENTS=cjk) so the harness can exercise multibyte-width clipping.
   *  Ignored under `fakeLongLines`. */
  readonly fakeCjkSubagents: boolean;
  /** Test-only: drive the concurrent-subagent turn where one subagent ERRORS
   *  (JUNO_FAKE_SUBAGENTS=error) so the harness can exercise the failure surface.
   *  Ignored under `fakeLongLines`. */
  readonly fakeErrorSubagent: boolean;
  /** Test-only: drive a CONCURRENT PLAIN-TOOL burst (JUNO_FAKE_TOOLS=concurrent) so the
   *  grouped-tool-rows selftest can exercise the live grouped unit + condensed committed form.
   *  Ignored under `fakeLongLines`. */
  readonly fakeConcurrentTools: boolean;
  /** Test-only: drive a concurrent plain-tool burst with one FAILING call
   *  (JUNO_FAKE_TOOLS=concurrent-error) for the grouped-tool-rows failure surface. Ignored
   *  under `fakeLongLines`. */
  readonly fakeConcurrentToolsError: boolean;
  readonly providers: Settings['providers'];
  readonly env: NodeJS.ProcessEnv;
  /** Read LAZILY — the codex bridge host is stood up AFTER the tool set exists, so
   * this closes over the mutable wiring rather than snapshotting it. Only the PARENT
   * factory consults it; the child factory ignores it by construction. */
  readonly getCodexBridge: () => CodexBridgeWiring | undefined;
  /** Test-only: injected child-process spawner threaded into the codex adapter so a
   * codex client can be driven without launching real codex. Undefined in production
   * (the adapter falls back to the real node:child_process.spawn). */
  readonly spawnImpl?: SpawnImpl;
  /** Defaults to the global `fetch` (production); injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Wave 9 MCP passthrough: juno's configured servers + live policy, threaded to
   * the claude-cli backend so its render-only child reaches them under juno's gate.
   * Parent factory only (MCP tools are parent-agent-only). */
  readonly mcpServers?: Settings['mcpServers'];
  readonly policy?: PermissionPolicy;
}

/**
 * Build the app's PARENT and CHILD client factories. They differ in ONE respect:
 * the parent factory may spread the codex spawn bridge + MCP config onto a codex-cli
 * client; the child factory never does. Keeping them distinct is load-bearing — see
 * `ClientFactories.createChildClient` for the depth-1 escape and parent-turn
 * mis-registration a shared (bridge-injecting) factory causes when a sub-agent's
 * child model resolves to codex.
 */
export function createClientFactories(deps: ClientFactoryDeps): ClientFactories {
  const tick =
    Number.isFinite(deps.fakeTickMs) && deps.fakeTickMs > 0 ? { tickMs: deps.fakeTickMs } : {};
  const buildFake = (): ModelClient =>
    createFakeModelClient(
      Number.isFinite(deps.fakeLongLines) && deps.fakeLongLines > 0
        ? {
            longLines: deps.fakeLongLines,
            ...(Number.isFinite(deps.fakeLineWidth) && deps.fakeLineWidth > 0
              ? { lineWidth: deps.fakeLineWidth }
              : {}),
            // Combined mode: a long stream that ALSO spawns subagents, so the agents
            // dropdown can be expanded over a tall live turn (scrollback pty regression).
            ...(deps.fakeSubagent
              ? {
                  subagent: true,
                  ...(Number.isFinite(deps.fakeSubagentCount) && deps.fakeSubagentCount > 0
                    ? { subagentCount: deps.fakeSubagentCount }
                    : {}),
                }
              : {}),
            ...tick,
          }
        : deps.fakeConcurrentToolsError
          ? { concurrentToolsError: true, ...tick }
          : deps.fakeConcurrentTools
            ? { concurrentTools: true, ...tick }
            : deps.fakeCodexErrorSubagent
              ? { codexErrorSubagent: true, ...tick }
              : deps.fakeCodexSubagents
                ? { codexSubagent: true, ...tick }
                : deps.fakeCjkSubagents
                  ? { cjkSubagent: true, ...tick }
                  : deps.fakeErrorSubagent
                    ? { errorSubagent: true, ...tick }
                    : deps.fakeMultiSubagent
                      ? { multiSubagent: true, ...tick }
                      : deps.fakeSubagent
                        ? { subagent: true, ...tick }
                        : Object.keys(tick).length > 0
                          ? tick
                          : undefined,
    );
  const buildReal = (entry: ModelEntry, withBridge: boolean, onRetry?: RetryObserver): ModelClient => {
    // Only the parent factory consults the bridge wiring; the child never does.
    const wiring = withBridge ? deps.getCodexBridge() : undefined;
    return createModelClient(entry, {
      provider: deps.providers?.[entry.provider],
      env: deps.env,
      fetchImpl: deps.fetchImpl ?? fetch,
      // Wave 13 (retry-ui): forward the App's transport-retry observer (parent only;
      // children pass none so a subagent's retries stay off the parent status line).
      ...(onRetry !== undefined ? { onRetry } : {}),
      ...(deps.spawnImpl !== undefined ? { spawnImpl: deps.spawnImpl } : {}),
      ...(wiring !== undefined
        ? { codexSpawnBridge: wiring.bridge, codexMcpConfig: wiring.mcpConfig }
        : {}),
      // MCP passthrough is parent-only (MCP tools are a parent-agent capability),
      // so gate it on the same parent flag (`withBridge`) as the codex bridge.
      ...(withBridge && deps.mcpServers !== undefined && deps.policy !== undefined
        ? { mcpServers: deps.mcpServers, policy: deps.policy }
        : {}),
    });
  };
  const build = (entry: ModelEntry, withBridge: boolean, onRetry?: RetryObserver): ModelClient =>
    deps.useFakeProvider ? buildFake() : buildReal(entry, withBridge, onRetry);
  return {
    createClient: (entry, onRetry) => build(entry, true, onRetry),
    createChildClient: (entry) => build(entry, false),
  };
}

/**
 * Wave 13 — build the BLOCKING `spawn_subagent` tool the codex spawn bridge runs.
 *
 * A codex parent invokes spawn over MCP and is SYNCHRONOUSLY blocked on the tool
 * result, which it consumes as the child's summary text. So its spawn MUST take the
 * await path: handing it the app's NON-BLOCKING (runner-carrying) tool would return
 * a background HANDLE (`{ status: 'spawned', … }` — no `summary` key), which the
 * bridge's summary extraction turns into an EMPTY MCP result, and the
 * "you'll be notified" promptText the raw-API TUI relays is never read on the MCP
 * channel. So the bridge gets a dedicated runner-LESS clone over the SAME sub-agent
 * deps, given the depth-1 childTools snapshot — the tools registered BEFORE
 * spawn_subagent in `tools` (file + load_skill; shell/brain/mcp are pushed AFTER the
 * subagent and stay absent), exactly the set the registry closed over. This keeps a
 * codex parent's nesting + summary byte-identical to the pre-wave-13 blocking path.
 * (`subagentDeps` is typed to structurally EXCLUDE `runner`, so this instance can
 * never accidentally re-acquire the background path.)
 */
export function createCodexBridgeSpawnTool(
  tools: ReadonlyArray<Tool>,
  subagentDeps: Omit<SubagentDeps, 'childTools' | 'runner'>,
): Tool {
  const spawnIndex = tools.findIndex((tool) => tool.name === 'spawn_subagent');
  const childTools = spawnIndex >= 0 ? tools.slice(0, spawnIndex) : [];
  return createSubagentTool({ ...subagentDeps, childTools });
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`juno ${versionFromEnv(env)}\n`);
    return;
  }

  const config = createConfigService({ env });
  const settings = config.get();
  // Select the dark/light palette BEFORE the first render: components resolve
  // colours off the active palette at render time (like the DEPTH cache), so the
  // background must be chosen up front. Precedence: JUNO_THEME env > settings.theme
  // > COLORFGBG > dark (see detectBackground).
  setActiveTheme(detectBackground({ override: settings.theme, env }));
  const catalog = createModelCatalog(BUILTIN_MODELS);
  const model = catalog.resolve(settings.defaultModel) ?? catalog.default();

  if (model === undefined) {
    process.stderr.write('juno: no model is configured.\n');
    process.exitCode = 1;
    return;
  }

  // One shared policy (the executor AND every sub-agent use it, so remembered
  // allow-patterns persist) and one client factory (App + sub-agents share it).
  // Factory: build a client for whichever entry the picker selects. Provider
  // config is keyed on the SELECTED entry's provider (not the frozen default),
  // so selecting a cross-provider entry routes to its own endpoint.
  const policy = createPermissionPolicy({
    autoAllowSafe: true,
    mode: settings.permissionMode,
    allow: settings.permissions?.allow,
    deny: settings.permissions?.deny,
  });
  // Test-only backend gate (opt-in via `JUNO_PROVIDER=fake`): route the client
  // factory to the deterministic, network/key-free FakeModelClient so the real
  // TUI can be driven end-to-end through a pty (tests/tui.smoke.test.ts) with no
  // provider credentials. It short-circuits BEFORE any real adapter is built, so
  // it never touches the network. Any other JUNO_PROVIDER value (or none) leaves
  // the production routing untouched — createModelClient still routes on the
  // resolved entry's own provider, so this sentinel changes no real backend.
  const useFakeProvider = env.JUNO_PROVIDER === 'fake';
  // Test-only: emit a long single-turn stream (N text lines) so the pty
  // autoscroll regression can drive a turn taller than the viewport.
  const fakeLongLines = Number.parseInt(env.JUNO_FAKE_LONG_LINES ?? '', 10);
  // Optional companion: pad each streamed line to this display width so one source
  // line WRAPS to several rows — the wide-prose shape the autoscroll wrap-aware
  // budget must handle (see tests/autoscroll.pty.test.ts).
  const fakeLineWidth = Number.parseInt(env.JUNO_FAKE_LINE_WIDTH ?? '', 10);
  // Test-only: emit a subagent turn (spawn_subagent + child tool calls) so the
  // subagent-browser panel (LANE B) can be driven end-to-end through a pty. Combined with
  // JUNO_FAKE_LONG_LINES it instead prepends running subagents to the long stream so the
  // agents dropdown can be expanded over a tall live turn (scrollback pty regression).
  const fakeSubagent = env.JUNO_FAKE_SUBAGENT === '1';
  // Optional companions to the combined mode above: how many subagents to prepend, and a
  // slower per-event tick so a pty test can act (expand the dropdown) mid-stream.
  const fakeSubagentCount = Number.parseInt(env.JUNO_FAKE_SUBAGENT_COUNT ?? '', 10);
  const fakeTickMs = Number.parseInt(env.JUNO_FAKE_TICK_MS ?? '', 10);
  // Test-only: emit a turn that spawns TWO subagents concurrently (both parents run
  // before either settles) so the selftest harness can exercise concurrent spawns.
  const fakeMultiSubagent = env.JUNO_FAKE_SUBAGENTS === '2';
  // Test-only: emit a CODEX-shaped concurrent-subagent turn (parent tool named `Task`,
  // claude-cli arg shape) so the selftest harness can prove the subagent surface is
  // provider-agnostic (UX-SPEC R3). See fakeClient CODEX_SUBAGENT_SCRIPT.
  const fakeCodexSubagents = env.JUNO_FAKE_SUBAGENTS === 'codex';
  // Test-only: emit a CODEX-shaped concurrent-subagent turn where one subagent ERRORS
  // (JUNO_FAKE_SUBAGENTS=codex-error) so the selftest harness can prove a FAILED codex parent
  // surfaces identically to a claude/juno one (R3 failure parity). See CODEX_ERROR_SUBAGENT_SCRIPT.
  const fakeCodexErrorSubagent = env.JUNO_FAKE_SUBAGENTS === 'codex-error';
  // Test-only: emit a concurrent-subagent turn whose descriptions carry CJK + emoji so the
  // selftest harness can prove the panel/spawn-card clips measure display cells (a CJK/emoji
  // label renders on one row, never wrapping into the \x1b[3J erase branch on a narrow strip).
  const fakeCjkSubagents = env.JUNO_FAKE_SUBAGENTS === 'cjk';
  // Test-only: emit a concurrent-subagent turn where one subagent ERRORS so the selftest
  // harness can prove the failure surfaces cleanly (dropdown failed bucket + `✗` row glyph +
  // the spawn card's inline error tail), with no raw JSON.
  const fakeErrorSubagent = env.JUNO_FAKE_SUBAGENTS === 'error';
  // Test-only: emit a CONCURRENT PLAIN-TOOL burst (three top-level tools in one batch) so the
  // grouped-tool-rows selftest can drive the live grouped unit + its condensed committed form.
  // `concurrent` is all-ok; `concurrent-error` fails one call (the failure-surface edge).
  const fakeConcurrentTools = env.JUNO_FAKE_TOOLS === 'concurrent';
  const fakeConcurrentToolsError = env.JUNO_FAKE_TOOLS === 'concurrent-error';
  // Wave 8 (codex-bridge, opt-in via JUNO_CODEX_SPAWN_BRIDGE=1): lets a codex PARENT
  // spawn juno subagents over an in-process MCP server. Populated below once the tool
  // set (and thus the spawn_subagent tool) exists; read lazily by createClient so a
  // codex-cli client is built with the bridge + its MCP endpoint. Undefined ⇒ codex
  // keeps its built-in toolset (default, all existing behaviour).
  let codexBridgeWiring: CodexBridgeWiring | undefined;
  // Two factories, one difference: the PARENT (App) factory may carry the codex
  // spawn bridge; the CHILD (sub-agent) factory never does. Passing the SAME
  // bridge-injecting factory into subagent deps would (a) launch a codex CHILD with
  // the `-c mcp_servers.…` flags → a sub-agent could spawn unbounded grandchildren
  // (depth-1 escape), and (b) have the child turn's beginTurn REPLACE the parent
  // turn's bridge registration, wedging every later spawn in the parent turn. See
  // ClientFactories.createChildClient.
  // Brain read-only MCP server (decision b): when brain is enabled, fold the
  // recall+get_episode-only server into the configured mcpServers under the `brain`
  // id (user config at that id wins). ONE effective map feeds BOTH the MCP manager
  // (so its tools are discovered) AND the codex passthrough (so the gate sees the
  // server's risk posture) — they must never diverge. The server is WHOLESALE
  // `risk:'safe'` (read-only by construction), so the passthrough wires it AND stays
  // compliant against tools codex might add on its own connection (late-added-tool
  // gate); the full server, with its `remember` write on a risky default, never
  // clears the gate. Brain disabled ⇒ the map is untouched (zero behavior change).
  const mcpServers =
    settings.brain?.enabled === true
      ? withBrainReadonlyMcpServer(settings.mcpServers, settings.brain)
      : settings.mcpServers;
  const { createClient, createChildClient } = createClientFactories({
    useFakeProvider,
    fakeLongLines,
    fakeLineWidth,
    fakeSubagent,
    fakeSubagentCount,
    fakeTickMs,
    fakeMultiSubagent,
    fakeCodexSubagents,
    fakeCodexErrorSubagent,
    fakeCjkSubagents,
    fakeErrorSubagent,
    fakeConcurrentTools,
    fakeConcurrentToolsError,
    providers: settings.providers,
    env,
    getCodexBridge: () => codexBridgeWiring,
    mcpServers,
    policy,
  });

  // Discover skills (~/.claude/skills + <cwd>/.claude/skills) and sub-agent
  // definitions (.claude/agents) once at startup. Skill names+descriptions go
  // into the (raw-API) system prompt; `load_skill` reads bodies on demand;
  // `spawn_subagent` runs fresh nested turns. Tools + specs are derived from ONE
  // built array so the model's tool specs always match the registered tools.
  const skillsService = createSkillsService({ cwd: settings.cwd });
  const skills = skillsService.list();
  let systemPrompt = assembleSystemPrompt(skills);

  // Read-only brain (personal-memory) integration, Phase 0. Behind the opt-in
  // `brain.enabled` flag: run the user's `brain-session-start` SessionStart hook
  // once and append its unwrapped memory context to the system prompt as
  // background reference. Fail-open — any failure leaves the prompt unchanged.
  if (settings.brain?.enabled === true) {
    const brainContext = await fetchBrainSessionContext({
      command: settings.brain.command,
      cwd: settings.cwd,
      timeoutMs: settings.brain.timeoutMs,
      onWarn: (message) => process.stderr.write(`juno: ${message}\n`),
    });
    systemPrompt = appendBrainMemoryContext(systemPrompt, brainContext);
  }
  // Ambient per-prompt recall (brain Phase 2) — behind brain.enabled AND the
  // brain.ambientRecall sub-flag (default true). Each raw user prompt is sent
  // to the FTS-only `brain-hook` UserPromptSubmit hook under a tight latency
  // budget; matched-memory blocks ride that turn's outgoing user message on
  // every backend. One session id per process so the hook's per-session dedup
  // never re-injects a memory it already surfaced. Silent fail-open (no onWarn:
  // stderr writes mid-turn would corrupt the ink TUI).
  const ambientRecall =
    settings.brain?.enabled === true && settings.brain.ambientRecall
      ? ((brain: BrainSettings): ((prompt: string) => Promise<string | undefined>) => {
          const sessionId = `juno-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          return (prompt) =>
            fetchBrainAmbientRecall(
              {
                command: brain.hookCommand,
                cwd: settings.cwd,
                timeoutMs: Math.min(brain.timeoutMs, AMBIENT_RECALL_TIMEOUT_MS),
                sessionId,
              },
              prompt,
            );
        })(settings.brain)
      : undefined;
  const agents = loadAgentDefinitions({ cwd: settings.cwd });
  // File-backed durable memory (default dir ~/.config/juno/memory) powering the
  // explicit `remember_fact` / `recall_facts` tools; real clock in production.
  const memoryStore = createMemoryStore();
  // Durable-memory WRITE tool (`brain_remember`) — the durable tier paired with
  // the session-scratch native memory tools. Registered ONLY when brain is
  // enabled, so it is absent from the model's tool set otherwise. risk:'risky'
  // (it pushes to a private remote) ⇒ always prompt-gated; parent-agent-only.
  const brainRemember =
    settings.brain?.enabled === true
      ? {
          command: settings.brain.rememberCommand,
          cwd: settings.cwd,
          timeoutMs: settings.brain.timeoutMs,
        }
      : undefined;
  // Read-only brain tools (`brain_recall` / `brain_get`) — the read tier paired
  // with the durable write tool. Registered ONLY when brain is enabled, so they
  // are absent from the model's tool set otherwise. risk:'safe' (reads only).
  const brainRead =
    settings.brain?.enabled === true
      ? {
          command: settings.brain.recallCommand,
          cwd: settings.cwd,
          timeoutMs: settings.brain.timeoutMs,
        }
      : undefined;
  // MCP servers (Wave 4; async-connect in Wave 2) — BUILD the configured fleet's
  // manager but do NOT connect it here: App kicks start() after first paint, so
  // the render is never gated on the brain spawn (~569ms; up to 30s for a dead
  // server). The base tool set is therefore MCP-less at first paint; App late-
  // binds the discovered MCP tools once the background connect resolves. No
  // servers configured → mcp undefined and nothing to late-bind.
  const mcpWiring = initMcpWiring(mcpServers, settings.cwd);
  // Wave 12 — opt-in OS confinement for run_shell (default OFF). Probe sandbox-exec
  // ONCE at startup; the provider single-sources both the risk flip and the child
  // wrapping. Fail-closed: when the flag is off we pass no sandbox (today's bare
  // `sh -c`, always-prompt); when on but the host cannot enforce it (not darwin /
  // sandbox-exec missing / self-test fails) the provider is unavailable, so risk
  // stays 'dangerous' and run_shell keeps prompting — never an unwrapped auto-allow.
  const sandbox: SandboxProvider | undefined =
    settings.shellSandbox === true
      ? await createSandboxProvider({
          platform: process.platform,
          spawn: defaultProbeSpawn,
          env,
          realpath: fsRealpath,
          // Config knob: default-true network for the confined child (git/npm),
          // flip via shellSandboxNetwork:false / JUNO_SHELL_SANDBOX_NETWORK.
          allowNetwork: settings.shellSandboxNetwork,
        })
      : undefined;
  // Wave 13 — the NON-BLOCKING background-agent runner. `spawn_subagent` hands the
  // child off to it (returning a handle synchronously) so the parent turn is no
  // longer pinned on the child. Uses createChildClient (never the codex bridge —
  // same reason the subagent tool does), the SHARED policy, the session cwd, and the
  // PreToolUse hooks for gate parity. App late-binds turn.dispatch via attach().
  const backgroundAgents = createBackgroundAgentRunner({
    createClient: createChildClient,
    policy,
    cwd: settings.cwd,
    ...(settings.hooks !== undefined ? { hooks: settings.hooks } : {}),
  });
  // The sub-agent deps SHARED by both `spawn_subagent` instances so they can never
  // drift: the NON-BLOCKING one in the app toolset below (runner added at the call
  // site) and the BLOCKING one the codex bridge builds via createCodexBridgeSpawnTool
  // (runner-LESS). createChildClient (NOT createClient): a codex sub-agent must never
  // be handed the spawn bridge — see ClientFactories.createChildClient for why.
  const subagentDeps: Omit<SubagentDeps, 'childTools' | 'runner'> = {
    createClient: createChildClient,
    catalog,
    defaultModel: settings.defaultModel,
    policy,
    agents,
    // Gate parity: sub-agents honor the same PreToolUse hook denials as the parent.
    hooks: settings.hooks,
  };
  const tools = createDefaultTools({
    // W12 sensitive-path deny for the five file tools. Defaults ON; opt out with
    // permissions.denySensitiveDefaults:false, extend with permissions.sensitivePaths.
    // (Object spreads keep unset keys ABSENT for exactOptionalPropertyTypes.) Covers
    // juno's own file tools only — not run_shell (see fileTools.ts header).
    fileTools: {
      sensitiveDeny: {
        ...(settings.permissions?.denySensitiveDefaults === false
          ? { disableDefaults: true }
          : {}),
        ...(settings.permissions?.sensitivePaths !== undefined
          ? { extra: settings.permissions.sensitivePaths }
          : {}),
      },
    },
    skills: skillsService,
    subagent: {
      ...subagentDeps,
      // Wave 13: hand spawns to the background runner (non-blocking) instead of
      // awaiting the child inline. The tool captures the resolved entry and calls
      // runner.spawn(); absent ⇒ the blocking fallback. NOTE: the codex bridge does
      // NOT get this instance — see createCodexBridgeSpawnTool below.
      runner: backgroundAgents,
    },
    shell: sandbox !== undefined ? { sandbox } : {},
    memory: { store: memoryStore },
    brainRead,
    brainRemember,
    // MCP tools are NOT built here — App appends them after the async connect.
    mcp: undefined,
  });
  const specs = tools.map((tool) => tool.spec);

  // Wave 8 (codex-bridge): stand up the in-process spawn_subagent MCP server + bridge
  // and populate `codexBridgeWiring` so a codex-cli client reaches it. Opt-in +
  // fail-open — any bind failure leaves codex on its built-in toolset, never fatal.
  let codexBridgeShutdown: (() => Promise<void>) | undefined;
  if (env.JUNO_CODEX_SPAWN_BRIDGE === '1') {
    try {
      // A dedicated runner-LESS (BLOCKING) spawn tool — NOT the app's non-blocking
      // one from `tools`. A codex parent blocks on the MCP result and consumes the
      // child summary, so it must await the child, not get a background handle. See
      // createCodexBridgeSpawnTool.
      const spawnTool = createCodexBridgeSpawnTool(tools, subagentDeps);
      const bridge = createCodexSpawnBridge({ spawnTool });
      const host = await createCodexBridgeHost({ handler: bridge.spawn });
      codexBridgeWiring = { bridge, mcpConfig: host.mcpConfig };
      codexBridgeShutdown = host.shutdown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`juno: codex spawn bridge disabled (${message})\n`);
    }
  }

  // Session persistence store (default dir ~/.config/juno/sessions). Powers
  // `/resume` (list + hydrate) and best-effort save of committed turns.
  const sessionStore = createSessionStore();

  const deps: AppDeps = {
    createClient,
    tools,
    policy,
    catalog,
    settings,
    specs,
    systemPrompt,
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    sessionStore,
    // Per-subagent transcript recorder (Wave 7), bound per active session by App.
    // fs-backed; writes under ~/.config/juno/sessions/<id>.subagents/.
    createSubagentRecorder: (sessionId) => createSubagentRecorder({ sessionId }),
    // Read side: rehydrate a resumed session's settled subagents from their JSONL.
    readSubagentTranscripts: (sessionId) => readSubagentTools({ sessionId }),
    ambientRecall,
    version: versionFromEnv(env),
    // Async MCP wiring: the built-but-not-started manager + its servers. App owns
    // the connect (mount effect) + tool late-bind; undefined when no servers.
    mcp: mcpWiring.mcp,
    // Wave 13: the SAME runner the spawn_subagent tool hands children to. App
    // attaches turn.dispatch, drains its completion queue into turn.steer, and
    // overrides the agents panel's status from its live task snapshot.
    backgroundAgents,
  };

  // `exitOnCtrlC:false` — App's useCtrlCExit hook OWNS Ctrl+C now (double-press:
  // first press aborts an in-flight turn / clears input + arms an exit hint,
  // second press within the window exits). Ink's default handler would otherwise
  // race that state machine and unmount on the FIRST \x03. With it disabled Ink
  // drops its own SIGINT handler, so the hook is the sole ctrl+c owner.
  const instance = render(createElement(App, { deps }), { exitOnCtrlC: false });
  // Teardown: the app's only exit path is Ink unmounting — useCtrlCExit's second
  // press calls Ink's useApp().exit() (there are no process.exit calls in the
  // app), and waitUntilExit settles on that unmount, so hook MCP shutdown there.
  // `shutdown` never throws/rejects, so this can neither block nor noisily fail
  // the exit. (If the process dies harder — a signal/exit() — the MCP child
  // processes' stdio pipes close with us and they terminate on their own.)
  const teardown = async (): Promise<void> => {
    // Drain queued session/memory writes FIRST so a graceful exit never loses a
    // committed-turn save still sitting in the per-key write queue. Best-effort —
    // drain must never block or noisily fail the exit.
    await sessionStore.drain?.().catch(() => {});
    await memoryStore.drain?.().catch(() => {});
    await mcpWiring.shutdown();
    // Best-effort: unbind the codex bridge host (HTTP listener + MCP server).
    if (codexBridgeShutdown !== undefined) {
      await codexBridgeShutdown().catch(() => {});
    }
  };
  void instance.waitUntilExit().then(teardown, teardown);
}

// Run main() only when invoked directly (works under tsx `.ts` and a built `.js`).
const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath !== undefined && /(?:^|\/)(?:cli|juno)\.(?:ts|js)$/.test(invokedPath)) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`juno: ${message}\n`);
    process.exit(1);
  });
}
