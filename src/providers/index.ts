import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { createAnthropicClient } from './anthropicClient';
import { createOpenAICompatClient } from './openaiCompatClient';
import { createClaudeCliClient, type SpawnImpl } from './claudeCliClient';
import { createCodexCliClient } from './codexCliClient';

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
      return createClaudeCliClient(entry, { spawnImpl: deps.spawnImpl, env: deps.env });
    case 'codex-cli':
      return createCodexCliClient(entry, { spawnImpl: deps.spawnImpl, env: deps.env });
    default:
      throw new Error(`unknown provider: ${entry.provider}`);
  }
}
