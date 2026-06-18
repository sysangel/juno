import type { ModelClient } from '../core/contracts';
import type { ModelEntry } from '../services/catalog';
import { createAnthropicClient } from './anthropicClient';
import { createOpenAICompatClient } from './openaiCompatClient';

/**
 * Runtime deps the registry threads into each adapter. `provider` is the
 * per-provider config from W10 `Settings.providers[entry.provider]`; `env` and
 * `fetchImpl` default to `process.env` / global `fetch` and are injected in
 * tests. The API key named by `provider.apiKeyEnv` is read by the adapter at
 * call time — never stored, logged, or emitted.
 */
export interface ProviderDeps {
  provider?: { baseUrl?: string; apiKeyEnv?: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** Provider ids this registry can build in v1. (`claude-cli` is deferred.) */
export type ProviderId = 'openai' | 'openrouter' | 'anthropic';

/** Resolve a ModelClient by `entry.provider`. Throws on an unknown provider id. */
export function createModelClient(entry: ModelEntry, deps: ProviderDeps = {}): ModelClient {
  switch (entry.provider) {
    case 'openai':
      return createOpenAICompatClient(entry, { ...deps, isOpenRouter: false });
    case 'openrouter':
      return createOpenAICompatClient(entry, { ...deps, isOpenRouter: true });
    case 'anthropic':
      return createAnthropicClient(entry, deps);
    default:
      throw new Error(`unknown provider: ${entry.provider}`);
  }
}
