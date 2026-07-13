import type { ModelClient, PermissionPolicy } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import type { McpServerConfig } from '../services/config';
import { createAnthropicClient } from './anthropicClient';
import { createOpenAICompatClient } from './openaiCompatClient';
import { createClaudeCliClient, type SpawnImpl } from './claudeCliClient';
import { createCodexCliClient, type CodexMcpConfig } from './codexCliClient';
import type { CodexSpawnBridge } from './codexSpawnBridge';

/**
 * Runtime deps the registry threads into each adapter. `provider` is the
 * per-provider config from W10 `Settings.providers[entry.provider]`; `env` and
 * `fetchImpl` default to `process.env` / global `fetch` and are injected in
 * tests. The API key named by `provider.apiKeyEnv` is read by the adapter at
 * call time — never stored, logged, or emitted.
 *
 * `spawnImpl` is the claude-cli backend's analogue of `fetchImpl`: an injectable
 * child-process spawner so unit tests never launch the real `claude` subprocess.
 * It is ignored by the HTTP adapters (openai/openrouter/anthropic).
 */
export interface ProviderDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
  /**
   * Wave 8 (codex-bridge). When both are present AND the resolved entry is a
   * `codex-cli` backend, a codex PARENT can spawn juno subagents: `codexSpawnBridge`
   * emits the spawn card + nested child tool events into the active turn, and
   * `codexMcpConfig` points codex at juno's in-process `spawn_subagent` MCP server.
   * Ignored by every other backend. Absent ⇒ codex keeps its built-in toolset.
   */
  codexSpawnBridge?: CodexSpawnBridge;
  codexMcpConfig?: CodexMcpConfig;
  /**
   * Wave 9 (MCP passthrough). When both are present AND the resolved entry is a
   * `claude-cli` backend, the render-only child is handed a `--mcp-config` for
   * juno's configured MCP servers and its allow/deny grants mirror juno's gate
   * (`policy`) per tool. Threaded only by the PARENT factory (MCP tools are
   * parent-agent-only). Ignored by every other backend; absent ⇒ no passthrough.
   */
  mcpServers?: Record<string, McpServerConfig>;
  policy?: PermissionPolicy;
}

/** Provider ids this registry can build. */
export type ProviderId = 'openai' | 'openrouter' | 'anthropic' | 'claude-cli' | 'codex-cli';

/** Resolve a ModelClient by `entry.provider`. Throws on an unknown provider id. */
export function createModelClient(entry: ModelEntry, deps: ProviderDeps = {}): ModelClient {
  switch (entry.provider) {
    case 'openai':
      return createOpenAICompatClient(entry, { ...deps, isOpenRouter: false });
    case 'openrouter':
      return createOpenAICompatClient(entry, { ...deps, isOpenRouter: true });
    case 'anthropic':
      return createAnthropicClient(entry, deps);
    case 'claude-cli':
      return createClaudeCliClient(entry, {
        spawnImpl: deps.spawnImpl,
        env: deps.env,
        ...(deps.mcpServers !== undefined ? { mcpServers: deps.mcpServers } : {}),
        ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      });
    case 'codex-cli':
      return createCodexCliClient(entry, {
        spawnImpl: deps.spawnImpl,
        env: deps.env,
        ...(deps.codexSpawnBridge !== undefined ? { bridge: deps.codexSpawnBridge } : {}),
        ...(deps.codexMcpConfig !== undefined ? { mcpConfig: deps.codexMcpConfig } : {}),
      });
    default:
      throw new Error(`unknown provider: ${entry.provider}`);
  }
}
