#!/usr/bin/env -S tsx
// src/cli.ts
// W6 — the `juno` entry point. Parses --help/--version (preserving the W1
// behavior), else builds the real deps (config, catalog, client, policy, tools)
// and renders <App deps=... />.
//
// Windows note: npm's global bin shim invokes `node`, which cannot run .ts
// directly. Use `npm start` / `tsx src/cli.ts`. See docs/DECISIONS.md.
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app';
import type { AppDeps } from './app';
import { createPermissionPolicy } from './permissions/policy';
import { createModelClient } from './providers';
import { createFakeModelClient } from './core/fakeClient';
import { createConfigService } from './services/config';
import type { BrainSettings, McpServerConfig } from './services/config';
import { createMcpManager, type McpManager } from './services/mcpManager';
import type { McpToolsDeps } from './tools/mcpTools';
import { BUILTIN_MODELS, createModelCatalog, type ModelEntry } from './services/catalog';
import { createDefaultTools } from './tools/registry';
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

const HELP = `juno — terminal agent UI

Usage:
  juno              launch the TUI
  juno --help       show this help
  juno --version    print version
`;

function versionFromEnv(env: NodeJS.ProcessEnv): string {
  return env.npm_package_version ?? '0.0.0';
}

/** What `initMcpWiring` hands back to main(): the registry option (undefined
 * when no servers are configured) and a never-throwing teardown. */
export interface McpWiring {
  mcp: McpToolsDeps | undefined;
  shutdown: () => Promise<void>;
}

/**
 * MCP startup wiring (Wave 4), extracted from main() so it is testable without
 * a TTY. When servers are configured: build the manager, `start()` it (the
 * manager is internally parallel + fail-soft with per-server timeouts), and
 * report each skipped-server warning through `onWarn` — main() calls this
 * BEFORE render(), because stderr writes mid-turn would corrupt the ink TUI.
 * `shutdown` is best-effort teardown for exit paths: it swallows any error so
 * a failed shutdown can never block the process from exiting.
 */
export async function initMcpWiring(
  servers: Record<string, McpServerConfig> | undefined,
  cwd: string,
  onWarn: (message: string) => void,
  createManager: (
    servers: Record<string, McpServerConfig>,
    fallbackCwd: string,
  ) => McpManager = createMcpManager,
): Promise<McpWiring> {
  const configured = servers ?? {};
  if (Object.keys(configured).length === 0) {
    return { mcp: undefined, shutdown: async () => {} };
  }
  const manager = createManager(configured, cwd);
  const { warnings } = await manager.start();
  for (const warning of warnings) {
    onWarn(warning);
  }
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
  const createClient = (entry: ModelEntry) =>
    useFakeProvider
      ? createFakeModelClient()
      : createModelClient(entry, {
          provider: settings.providers?.[entry.provider],
          env,
          fetchImpl: fetch,
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
  // MCP servers (Wave 4) — connect the configured fleet once at startup.
  // start() is parallel + fail-soft (a dead/slow server is a warning, never
  // fatal); warnings go to stderr HERE, before render(), because stderr writes
  // mid-turn would corrupt the ink TUI. No servers configured → mcp undefined
  // and no tools are registered.
  const mcpWiring = await initMcpWiring(settings.mcpServers, settings.cwd, (message) =>
    process.stderr.write(`juno: ${message}\n`),
  );
  const tools = createDefaultTools({
    skills: skillsService,
    subagent: { createClient, catalog, policy, defaultModel: settings.defaultModel, agents },
    shell: {},
    memory: { store: memoryStore },
    brainRead,
    brainRemember,
    mcp: mcpWiring.mcp,
  });
  const specs = tools.map((tool) => tool.spec);

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
    ambientRecall,
  };

  const instance = render(createElement(App, { deps }));
  // Teardown: the app's only exit path is Ink unmounting (ctrl-c via Ink's
  // default exitOnCtrlC — there are no process.exit calls in the app), and
  // waitUntilExit settles on unmount, so hook MCP shutdown there. `shutdown`
  // never throws/rejects, so this can neither block nor noisily fail the exit.
  // (If the process dies harder — a signal/exit() — the MCP child processes'
  // stdio pipes close with us and they terminate on their own.)
  void instance.waitUntilExit().then(mcpWiring.shutdown, mcpWiring.shutdown);
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
