import type { ModelClient, PermissionPolicy } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import type { McpServerConfig } from '../services/config';
import { createAnthropicClient } from './anthropicClient';
import { createOpenAICompatClient } from './openaiCompatClient';
import { createClaudeCliClient, type SpawnImpl } from './claudeCliClient';
import { createCodexCliClient, type CodexMcpConfig } from './codexCliClient';
import type { CodexSpawnBridge } from './codexSpawnBridge';
import type { RetryOptions } from './retryFetch';

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
  /**
   * Bounded pre-first-byte retry policy for the HTTP adapters (openai/openrouter/
   * anthropic). A transient 429/5xx/network blip is retried before any assistant
   * output is emitted; omit for defaults. Ignored by the cli backends.
   */
  retry?: RetryOptions;
  /**
   * Wave 13 (retry-ui): transport-retry observer. Invoked SYNCHRONOUSLY by `retryFetch`
   * immediately before each backoff sleep, with `(attempt, max, delayMs)` — the app
   * bridges it to a `retry-attempt` reducer action so the busy line shows `retrying n/m`
   * live during the backoff. Threaded only into the HTTP adapters (anthropic/openai/
   * openrouter); ignored by the cli backends. Omit ⇒ retries are silent (e.g. subagents).
   */
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
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
  /** Disable Codex's built-in multi-agent tools for managed children / bridged parents. */
  disableCodexNativeMultiAgent?: boolean;
  /**
   * MCP passthrough (Wave 9 claude-cli, Wave 10 codex-cli). When both are present AND
   * the resolved entry is a `claude-cli` OR `codex-cli` backend, the render-only child
   * is pinned to juno's configured MCP servers, gated by juno's own decision (`policy`):
   *   - claude-cli: a `--mcp-config` FILE + per-tool `--allowedTools`/`--disallowedTools`
   *     + `--strict-mcp-config` (Wave 9).
   *   - codex-cli: `-c mcp_servers.<name>.…` overrides for the auto-allowed, env-free
   *     servers + `--ignore-user-config` (Wave 10) — SERVER-granularity, since codex
   *     exec has no per-tool MCP allowlist (see codexCliClient.CodexCliDeps for gaps).
   * Threaded only by the PARENT factory (MCP tools are parent-agent-only). Ignored by
   * every other backend; absent ⇒ no passthrough.
   */
  mcpServers?: Record<string, McpServerConfig>;
  policy?: PermissionPolicy;
  /** Settings-backed Codex silence guards (env is normalized by ConfigService). */
  codexIdleTimeoutMs?: number;
  codexStaleStreamMs?: number;
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
        ...(deps.disableCodexNativeMultiAgent !== undefined
          ? { disableNativeMultiAgent: deps.disableCodexNativeMultiAgent }
          : {}),
        // Wave 10 MCP passthrough (parent-only, gated upstream on the same parent flag
        // as the bridge): translate juno's gated servers into codex `-c mcp_servers.…`
        // + `--ignore-user-config`. Ignored on the child factory (no mcpServers passed).
        ...(deps.mcpServers !== undefined ? { mcpServers: deps.mcpServers } : {}),
        ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
        ...(deps.codexIdleTimeoutMs !== undefined
          ? { idleTimeoutMs: deps.codexIdleTimeoutMs }
          : {}),
        ...(deps.codexStaleStreamMs !== undefined
          ? { staleStreamMs: deps.codexStaleStreamMs }
          : {}),
      });
    default:
      throw new Error(`unknown provider: ${entry.provider}`);
  }
}
