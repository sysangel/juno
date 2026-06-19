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
  /** Permission mode. 'acceptEdits' auto-allows the edit tools only. Default: 'default'. */
  permissionMode?: 'default' | 'acceptEdits';
  /** Config-driven seeded permission patterns. Deny wins over allow. */
  permissions?: { allow: string[]; deny: string[] };
  /**
   * Context-Compression trigger: compact once estimated re-sent transcript pressure
   * reaches this fraction of `maxContext`. Range (0, 1]. Optional — the consumer
   * defaults to 0.5 (`DEFAULT_COMPACTION_THRESHOLD`) when absent. Env: `JUNO_COMPACTION_THRESHOLD`.
   */
  compactionThreshold?: number;
  /**
   * Estimated-token budget for the verbatim tail kept after a compaction. Optional —
   * the consumer defaults to ~25% of `maxContext` when absent.
   */
  compactionKeepBudget?: number;
  /**
   * Per-turn tool-call ceiling for the raw-API re-entry loop; a runaway guard. When the
   * tool-call count in a single user submission reaches this limit the turnRunner stops
   * with a terminal `error` instead of re-entering the model again. Absent => unbounded.
   * On the claude-cli backend this is inert by construction (that backend never re-loops
   * on `tool_use`). Env: `JUNO_MAX_TOOL_CALLS`.
   */
  maxToolCalls?: number;
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
  // The default backend is the claude-cli subscription client on Opus. It needs
  // no apiKeyEnv (drives `claude -p` via the logged-in OAuth session). The
  // raw-API providers below remain available for the selectable secondaries.
  defaultProvider: 'claude-cli',
  defaultModel: 'claude-opus-4-8',
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
  permissionMode: 'default',
  permissions: { allow: [], deny: [] },
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'juno', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enum-whitelist guard. Returns the value only if it is a known permission mode,
 * else undefined. Shared by the config-file parse path and the env-override path
 * (the env helpers do not validate enums; an unguarded bad value would poison the
 * mode). */
function parsePermissionMode(value: unknown): Settings['permissionMode'] {
  return value === 'default' || value === 'acceptEdits' ? value : undefined;
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

/** Deep-copy `permissions` so a merged Settings never shares the module-global
 * `DEFAULT_SETTINGS.permissions` arrays (mirrors `cloneProviders`). Without this,
 * a consumer that mutates `settings.permissions.allow` would poison the defaults
 * process-wide. */
function clonePermissions(permissions: Settings['permissions']): Settings['permissions'] {
  if (permissions === undefined) {
    return undefined;
  }
  return { allow: [...permissions.allow], deny: [...permissions.deny] };
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

/** Coerce an arbitrary value to a string-only array (filtering non-strings); a
 * missing or non-array value becomes `[]`. */
function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Parse `permissions` ONLY if it is a non-null, non-array object. Each list is
 * normalized to a string-only array; a missing/invalid list becomes `[]`. So
 * `permissions:{}` ⇒ `{allow:[],deny:[]}`. A non-object value ⇒ undefined (the
 * field is omitted and the base default is preserved by the merge). */
function parsePermissions(value: unknown): Settings['permissions'] {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    allow: parseStringList(value.allow),
    deny: parseStringList(value.deny),
  };
}

/** Accept a compaction threshold only if it is a finite number in (0, 1]; else undefined. */
function parseCompactionThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

/** Accept a keep-budget only if it is a positive safe integer; else undefined. */
function parseCompactionKeepBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Accept a per-turn tool-call ceiling only if it is a positive safe integer; else undefined
 * (rejects 0, negatives, NaN, Infinity, and non-integer floats). */
function parseMaxToolCalls(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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

  const permissionMode = parsePermissionMode(value.permissionMode);
  if (permissionMode !== undefined) {
    settings.permissionMode = permissionMode;
  }

  const permissions = parsePermissions(value.permissions);
  if (permissions !== undefined) {
    settings.permissions = permissions;
  }

  const compactionThreshold = parseCompactionThreshold(value.compactionThreshold);
  if (compactionThreshold !== undefined) {
    settings.compactionThreshold = compactionThreshold;
  }

  const compactionKeepBudget = parseCompactionKeepBudget(value.compactionKeepBudget);
  if (compactionKeepBudget !== undefined) {
    settings.compactionKeepBudget = compactionKeepBudget;
  }

  const maxToolCalls = parseMaxToolCalls(value.maxToolCalls);
  if (maxToolCalls !== undefined) {
    settings.maxToolCalls = maxToolCalls;
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

  const permissionMode = overlay.permissionMode ?? base.permissionMode;
  if (permissionMode !== undefined) {
    settings.permissionMode = permissionMode;
  }

  const permissions = clonePermissions(overlay.permissions ?? base.permissions);
  if (permissions !== undefined) {
    settings.permissions = permissions;
  }

  const compactionThreshold = overlay.compactionThreshold ?? base.compactionThreshold;
  if (compactionThreshold !== undefined) {
    settings.compactionThreshold = compactionThreshold;
  }

  const compactionKeepBudget = overlay.compactionKeepBudget ?? base.compactionKeepBudget;
  if (compactionKeepBudget !== undefined) {
    settings.compactionKeepBudget = compactionKeepBudget;
  }

  const maxToolCalls = overlay.maxToolCalls ?? base.maxToolCalls;
  if (maxToolCalls !== undefined) {
    settings.maxToolCalls = maxToolCalls;
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

  // Enum-allowlist guard: apply ONLY if the value is a known mode. A present-but-
  // invalid value is ignored (config-file/default value stands). No env override
  // for the allow/deny lists — those are config-file only.
  const permissionMode = parsePermissionMode(envString(env, 'JUNO_PERMISSION_MODE'));
  if (permissionMode !== undefined) {
    overlay.permissionMode = permissionMode;
  }

  // Env override for the compaction trigger. Parsed as a float in (0, 1]; a present-
  // but-invalid value is ignored (the config-file/default value stands).
  const rawThreshold = envString(env, 'JUNO_COMPACTION_THRESHOLD');
  if (rawThreshold !== undefined) {
    const compactionThreshold = parseCompactionThreshold(Number.parseFloat(rawThreshold));
    if (compactionThreshold !== undefined) {
      overlay.compactionThreshold = compactionThreshold;
    }
  }

  // Env override for the per-turn tool-call ceiling. Parsed as a base-10 int and guarded
  // (positive safe integer); a present-but-invalid value is ignored (file/default stands).
  const rawMaxToolCalls = envString(env, 'JUNO_MAX_TOOL_CALLS');
  if (rawMaxToolCalls !== undefined) {
    const maxToolCalls = parseMaxToolCalls(Number.parseInt(rawMaxToolCalls, 10));
    if (maxToolCalls !== undefined) {
      overlay.maxToolCalls = maxToolCalls;
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
