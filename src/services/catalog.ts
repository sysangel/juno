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
 * The PRIMARY/default backend is the `claude-cli` subscription client on Opus
 * (`claude-opus-4-8`): it drives `claude -p` headless via the logged-in Max
 * subscription OAuth — NO API key, no apiKeyEnv (verified Wave 0A). The
 * openai/openrouter/anthropic raw-API entries remain selectable SECONDARIES.
 *
 * The claude-cli entry is APPENDED (not prepended) so the openai entries keep
 * their leading catalog positions — the model-picker navigates `list()` order
 * and the app smoke tests' index math depends on it. `default()` resolves by
 * the `default:true` flag, not position, so being last is fine.
 */
/**
 * PRICING PROVENANCE (read before trusting the cost chip).
 *
 * The `pricing` figures below are the providers' PUBLISHED LIST prices in
 * USD per 1,000,000 tokens (input / output), transcribed by hand:
 *   - openai gpt-4.1 / gpt-4.1-mini ......... OpenAI API pricing page
 *   - anthropic claude-sonnet-4-6 ........... Anthropic API pricing page
 *   - openrouter openai/gpt-4.1,
 *     anthropic/claude-sonnet-4 ............. OpenRouter model pages (list price;
 *                                             OpenRouter routes to upstreams that
 *                                             may differ — treat as an ESTIMATE)
 *
 * Effective date of transcription: 2026-06-21. These are STATIC CONSTANTS, not a
 * live feed: providers change prices, and OpenRouter's effective rate depends on
 * the routed upstream, so the cost chip is a best-effort ESTIMATE, not a billing
 * figure. Re-verify against the provider pages when updating, and bump the date.
 * The subscription `claude-cli` entry intentionally has NO pricing (a $ chip on a
 * flat-rate subscription would be a lie) so the chip stays hidden for it.
 */
export const BUILTIN_MODELS: ReadonlyArray<ModelEntry> = [
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    contextWindow: 1_047_576,
    aliases: ['gpt4.1', 'gpt-4'],
    pricing: { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 Mini',
    contextWindow: 1_047_576,
    aliases: ['mini', 'gpt4.1-mini'],
    pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    aliases: ['claude-sonnet-4', 'sonnet'],
    pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openrouter',
    label: 'GPT-4.1 via OpenRouter',
    contextWindow: 1_047_576,
    aliases: ['openrouter-gpt-4.1'],
    pricing: { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  },
  {
    id: 'anthropic/claude-sonnet-4',
    provider: 'openrouter',
    label: 'Claude Sonnet 4 via OpenRouter',
    contextWindow: 200_000,
    aliases: ['openrouter-sonnet'],
    pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  },
  {
    id: 'claude-opus-4-8',
    provider: 'claude-cli',
    label: 'Claude Opus 4.8 (subscription)',
    contextWindow: 1_000_000,
    aliases: ['opus', 'claude-opus'],
    default: true,
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
