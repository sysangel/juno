export interface ModelEntry {
  id: string;
  provider: string;
  label: string;
  contextWindow: number;
  aliases?: string[];
  default?: boolean;
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

/** Built-in model DATA (not presentation). Exactly one entry has default:true. */
export const BUILTIN_MODELS: ReadonlyArray<ModelEntry> = [
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    contextWindow: 1_047_576,
    aliases: ['gpt4.1', 'gpt-4'],
    default: true,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 Mini',
    contextWindow: 1_047_576,
    aliases: ['mini', 'gpt4.1-mini'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    label: 'Claude Sonnet 4',
    contextWindow: 200_000,
    aliases: ['claude-sonnet-4', 'sonnet'],
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openrouter',
    label: 'GPT-4.1 via OpenRouter',
    contextWindow: 1_047_576,
    aliases: ['openrouter-gpt-4.1'],
  },
  {
    id: 'anthropic/claude-sonnet-4',
    provider: 'openrouter',
    label: 'Claude Sonnet 4 via OpenRouter',
    contextWindow: 200_000,
    aliases: ['openrouter-sonnet'],
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
