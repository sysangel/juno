import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  /** Arbitrary provider creds/base-urls keyed by provider id. `apiKeyEnv` names
   * an ENV VAR; its value is read by W9 at call time, never read/stored here. */
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
}

export interface ConfigService {
  /** Full resolved settings (defaults <- file <- env), cached after first load. */
  get(): Settings;
  /** One key, typed. */
  getValue<K extends keyof Settings>(key: K): Settings[K];
  /** Reload from disk; refreshes the cache and returns the new settings. */
  reload(): Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4.1',
  cwd: process.cwd(),
  maxContext: 1_047_576,
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'juno', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneProviders(providers: Settings['providers']): Settings['providers'] {
  if (providers === undefined) {
    return undefined;
  }

  const cloned: Record<string, { baseUrl?: string; apiKeyEnv?: string }> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const next: { baseUrl?: string; apiKeyEnv?: string } = {};
    if (provider.baseUrl !== undefined) {
      next.baseUrl = provider.baseUrl;
    }
    if (provider.apiKeyEnv !== undefined) {
      next.apiKeyEnv = provider.apiKeyEnv;
    }
    cloned[name] = next;
  }
  return cloned;
}

function parseProviders(value: unknown): Settings['providers'] {
  if (!isRecord(value)) {
    return undefined;
  }

  const providers: Record<string, { baseUrl?: string; apiKeyEnv?: string }> = {};
  for (const [name, rawProvider] of Object.entries(value)) {
    if (!isRecord(rawProvider)) {
      continue;
    }

    const provider: { baseUrl?: string; apiKeyEnv?: string } = {};
    if (typeof rawProvider.baseUrl === 'string') {
      provider.baseUrl = rawProvider.baseUrl;
    }
    if (typeof rawProvider.apiKeyEnv === 'string') {
      provider.apiKeyEnv = rawProvider.apiKeyEnv;
    }
    providers[name] = provider;
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function parseSettings(value: unknown): Partial<Settings> {
  if (!isRecord(value)) {
    return {};
  }

  const settings: Partial<Settings> = {};

  if (typeof value.defaultProvider === 'string') {
    settings.defaultProvider = value.defaultProvider;
  }
  if (typeof value.defaultModel === 'string') {
    settings.defaultModel = value.defaultModel;
  }
  if (typeof value.cwd === 'string') {
    settings.cwd = value.cwd;
  }
  if (
    typeof value.maxContext === 'number' &&
    Number.isSafeInteger(value.maxContext) &&
    value.maxContext > 0
  ) {
    settings.maxContext = value.maxContext;
  }

  const providers = parseProviders(value.providers);
  if (providers !== undefined) {
    settings.providers = providers;
  }

  return settings;
}

function mergeProviders(
  base: Settings['providers'],
  overlay: Settings['providers'],
): Settings['providers'] {
  const merged = cloneProviders(base) ?? {};

  if (overlay !== undefined) {
    for (const [name, provider] of Object.entries(overlay)) {
      merged[name] = {
        ...(merged[name] ?? {}),
        ...provider,
      };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeSettings(base: Settings, overlay: Partial<Settings>): Settings {
  const settings: Settings = {
    defaultProvider: overlay.defaultProvider ?? base.defaultProvider,
    defaultModel: overlay.defaultModel ?? base.defaultModel,
    cwd: overlay.cwd ?? base.cwd,
  };

  const maxContext = overlay.maxContext ?? base.maxContext;
  if (maxContext !== undefined) {
    settings.maxContext = maxContext;
  }

  const providers = mergeProviders(base.providers, overlay.providers);
  if (providers !== undefined) {
    settings.providers = providers;
  }

  return settings;
}

function readConfigFile(configPath: string): Partial<Settings> {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parseSettings(parsed);
  } catch {
    // Missing or corrupt file degrades to defaults — never throws on startup.
    return {};
  }
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function applyEnvOverrides(settings: Settings, env: NodeJS.ProcessEnv): Settings {
  const overlay: Partial<Settings> = {};

  const provider = envString(env, 'JUNO_PROVIDER');
  if (provider !== undefined) {
    overlay.defaultProvider = provider;
  }

  const model = envString(env, 'JUNO_MODEL');
  if (model !== undefined) {
    overlay.defaultModel = model;
  }

  const cwd = envString(env, 'JUNO_CWD');
  if (cwd !== undefined) {
    overlay.cwd = cwd;
  }

  const rawMaxContext = envString(env, 'JUNO_MAX_CONTEXT');
  if (rawMaxContext !== undefined) {
    const maxContext = Number.parseInt(rawMaxContext, 10);
    if (Number.isSafeInteger(maxContext) && maxContext > 0) {
      overlay.maxContext = maxContext;
    }
  }

  return mergeSettings(settings, overlay);
}

/** Load config from `configPath` (default: `<homedir>/.config/juno/config.json`).
 * Sync reads keep the pinned `get()`/`reload()` seam synchronous. */
export function createConfigService(opts?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): ConfigService {
  const configPath = opts?.configPath ?? DEFAULT_CONFIG_PATH;
  const env = opts?.env ?? process.env;
  let cached: Settings | undefined;

  const read = (): Settings => {
    const withFile = mergeSettings(DEFAULT_SETTINGS, readConfigFile(configPath));
    return applyEnvOverrides(withFile, env);
  };

  const getCached = (): Settings => {
    cached ??= read();
    return cached;
  };

  return {
    get(): Settings {
      return getCached();
    },
    getValue<K extends keyof Settings>(key: K): Settings[K] {
      return getCached()[key];
    },
    reload(): Settings {
      cached = read();
      return cached;
    },
  };
}

/** Deterministic, file-free service over a literal Settings (tests/fakes). */
export function createFakeConfigService(settings: Settings): ConfigService {
  return {
    get(): Settings {
      return settings;
    },
    getValue<K extends keyof Settings>(key: K): Settings[K] {
      return settings[key];
    },
    reload(): Settings {
      return settings;
    },
  };
}
