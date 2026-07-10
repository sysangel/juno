export interface ModelPricing {
  /** USD per 1,000,000 INPUT tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 OUTPUT tokens. */
  outputPerMTok: number;
}

export interface ModelEntry {
  id: string;
  provider: string;
  label: string;
  contextWindow: number;
  aliases?: string[];
  default?: boolean;
  /** Optional USD pricing for the cost meter. Absent => cost is unknown (chip hidden). */
  pricing?: ModelPricing;
}

export interface ModelCatalog {
  list(): ReadonlyArray<ModelEntry>;
  /** Resolve an id OR alias to its entry; undefined if unknown. */
  resolve(idOrAlias: string): ModelEntry | undefined;
  /** Entries for one provider. */
  byProvider(provider: string): ReadonlyArray<ModelEntry>;
  /** The default entry (entry with default:true, else first). */
  default(): ModelEntry | undefined;
}

/** Built-in model DATA (not presentation). Exactly one entry has default:true.
 *
 * The PRIMARY/default backend is the `claude-cli` subscription client on Fable 5
 * (`claude-fable-5`): it drives `claude -p` headless via the logged-in Max
 * subscription OAuth — NO API key, no apiKeyEnv (verified Wave 0A). A second
 * subscription entry (Sonnet 5) and the openrouter raw-API entries remain
 * selectable SECONDARIES (openrouter is dormant until OPENROUTER_API_KEY exists).
 *
 * ORDERING INVARIANT: the catalog's list() order IS the /model picker display
 * order, and the default entry LEADS. The picker walks list() order and the app
 * smoke tests' index math depends on these positions, so entries are declared in
 * the exact order they should appear — default first. `default()` still resolves
 * by the `default:true` flag (which must sit on the leading entry), not position.
 */
/**
 * PRICING PROVENANCE (read before trusting the cost chip).
 *
 * The `pricing` figures below are the providers' PUBLISHED LIST prices in
 * USD per 1,000,000 tokens (input / output), transcribed by hand:
 *   - openrouter z-ai/glm-5.2 ............... OpenRouter model page (list price)
 *   - openrouter qwen/qwen3-coder ........... OpenRouter model page (list price)
 *                                             OpenRouter routes to upstreams that
 *                                             may differ — treat as an ESTIMATE.
 *
 * Effective date of transcription: 2026-07-10. These are STATIC CONSTANTS, not a
 * live feed: providers change prices, and OpenRouter's effective rate depends on
 * the routed upstream, so the cost chip is a best-effort ESTIMATE, not a billing
 * figure. Re-verify against the provider pages when updating, and bump the date.
 * The subscription `claude-cli` entries intentionally have NO pricing (a $ chip on
 * a flat-rate subscription would be a lie) so the chip stays hidden for them.
 */
export const BUILTIN_MODELS: ReadonlyArray<ModelEntry> = [
  {
    id: 'claude-fable-5',
    provider: 'claude-cli',
    label: 'Claude Fable 5 (subscription)',
    contextWindow: 1_000_000,
    aliases: ['fable', 'claude-fable'],
    default: true,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'claude-cli',
    label: 'Claude Sonnet 5 (subscription)',
    contextWindow: 1_000_000,
    aliases: ['sonnet'],
  },
  // codex-cli entries land here (between the claude-cli subscription entries and the
  // OpenRouter/GLM tail on the trimmed catalog). NO pricing: subscription backends
  // drive the ChatGPT plan at a flat rate, so a per-token $ chip would be a lie
  // (mirrors the claude-cli rationale above). contextWindow figures are codex-cli
  // 0.144.1's advertised context_window per the wave-4 recon.
  {
    id: 'gpt-5.6-sol',
    provider: 'codex-cli',
    label: 'GPT-5.6 Sol (subscription)',
    contextWindow: 372_000,
    aliases: ['sol', 'gpt-5.6'],
  },
  {
    id: 'gpt-5.5',
    provider: 'codex-cli',
    label: 'GPT-5.5 (subscription)',
    contextWindow: 272_000,
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'codex-cli',
    label: 'GPT-5.4 Mini (subscription)',
    contextWindow: 272_000,
    aliases: ['mini'],
  },
  {
    id: 'z-ai/glm-5.2',
    provider: 'openrouter',
    label: 'GLM 5.2 via OpenRouter',
    contextWindow: 1_048_576,
    aliases: ['glm', 'glm-5.2'],
    pricing: { inputPerMTok: 0.56, outputPerMTok: 1.76 },
  },
  {
    id: 'qwen/qwen3-coder',
    provider: 'openrouter',
    label: 'Qwen3 Coder via OpenRouter',
    contextWindow: 1_048_576,
    aliases: ['qwen', 'qwen-coder'],
    pricing: { inputPerMTok: 0.22, outputPerMTok: 1.8 },
  },
];

function cloneEntry(entry: ModelEntry): ModelEntry {
  const cloned: ModelEntry = {
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    contextWindow: entry.contextWindow,
  };

  if (entry.aliases !== undefined) {
    cloned.aliases = [...entry.aliases];
  }
  if (entry.pricing !== undefined) {
    cloned.pricing = { ...entry.pricing };
  }
  if (entry.default !== undefined) {
    cloned.default = entry.default;
  }

  return cloned;
}

/** Build a catalog from data entries (defaults to BUILTIN_MODELS). */
export function createModelCatalog(entries?: ReadonlyArray<ModelEntry>): ModelCatalog {
  // Defensive copy so callers cannot mutate our internal state.
  const models = (entries ?? BUILTIN_MODELS).map(cloneEntry);

  // O(1) resolve: index id first, then aliases (id wins on collision).
  const byKey = new Map<string, ModelEntry>();
  for (const entry of models) {
    if (entry.aliases !== undefined) {
      for (const alias of entry.aliases) {
        if (!byKey.has(alias)) {
          byKey.set(alias, entry);
        }
      }
    }
  }
  for (const entry of models) {
    byKey.set(entry.id, entry);
  }

  return {
    list(): ReadonlyArray<ModelEntry> {
      return models.map(cloneEntry);
    },
    resolve(idOrAlias: string): ModelEntry | undefined {
      const entry = byKey.get(idOrAlias);
      return entry === undefined ? undefined : cloneEntry(entry);
    },
    byProvider(provider: string): ReadonlyArray<ModelEntry> {
      return models.filter((entry) => entry.provider === provider).map(cloneEntry);
    },
    default(): ModelEntry | undefined {
      const entry = models.find((model) => model.default === true) ?? models[0];
      return entry === undefined ? undefined : cloneEntry(entry);
    },
  };
}
