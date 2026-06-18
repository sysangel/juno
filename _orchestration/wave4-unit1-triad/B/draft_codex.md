=== FILE: src/services/config.ts ===
```ts
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
  permissionMode?: 'default' | 'acceptEdits';
  permissions?: { allow: string[]; deny: string[] };
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

function parsePermissions(value: unknown): Settings['permissions'] {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    allow: Array.isArray(value.allow)
      ? value.allow.filter((entry): entry is string => typeof entry === 'string')
      : [],
    deny: Array.isArray(value.deny)
      ? value.deny.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
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

  const permissions = overlay.permissions ?? base.permissions;
  if (permissions !== undefined) {
    settings.permissions = permissions;
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

  const permissionMode = parsePermissionMode(envString(env, 'JUNO_PERMISSION_MODE'));
  if (permissionMode !== undefined) {
    overlay.permissionMode = permissionMode;
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
```

=== FILE: tests/config.mode.test.ts ===
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createConfigService, DEFAULT_SETTINGS } from '../src/services/config';

let tempDir: string | undefined;

async function createTempDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-mode-'));
  return tempDir;
}

async function writeConfig(value: unknown): Promise<string> {
  const dir = await createTempDir();
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(value), 'utf8');
  return configPath;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('config permission settings', () => {
  it('defines permission defaults', () => {
    expect(DEFAULT_SETTINGS.permissionMode).toBe('default');
    expect(DEFAULT_SETTINGS.permissions).toEqual({ allow: [], deny: [] });
  });

  it('preserves default settings when config file is missing and env is empty', () => {
    const configPath = path.join(os.tmpdir(), 'juno-missing-config-mode.json');
    const service = createConfigService({ configPath, env: {} });

    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('parses acceptEdits permission mode from config file', async () => {
    const configPath = await writeConfig({ permissionMode: 'acceptEdits' });
    const service = createConfigService({ configPath, env: {} });

    expect(service.get().permissionMode).toBe('acceptEdits');
  });

  it('ignores invalid permission mode from config file', async () => {
    const configPath = await writeConfig({ permissionMode: 'garbage' });
    const service = createConfigService({ configPath, env: {} });

    expect(service.get().permissionMode).toBe('default');
  });

  it('parses permissions lists and filters non-string entries', async () => {
    const configPath = await writeConfig({
      permissions: {
        allow: ['write_file:*'],
        deny: ['write_file:secret.txt', 123],
      },
    });
    const service = createConfigService({ configPath, env: {} });

    expect(service.get().permissions).toEqual({
      allow: ['write_file:*'],
      deny: ['write_file:secret.txt'],
    });
  });

  it('applies valid JUNO_PERMISSION_MODE env override', async () => {
    const configPath = await writeConfig({ permissionMode: 'default' });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_MODE: 'acceptEdits' },
    });

    expect(service.get().permissionMode).toBe('acceptEdits');
  });

  it('ignores invalid JUNO_PERMISSION_MODE env override', async () => {
    const configPath = await writeConfig({ permissionMode: 'acceptEdits' });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_MODE: 'bogus' },
    });

    expect(service.get().permissionMode).toBe('acceptEdits');
  });
});
```

=== NOTES ===

The change keeps config resolution synchronous and total. `permissionMode` uses one allowlist parser shared by file parsing and env overrides, so invalid file/env values are ignored instead of poisoning settings. `permissions` is config-file only and is accepted only from a non-null object; each list is normalized to string-only arrays with invalid or missing lists becoming `[]`.

`mergeSettings(DEFAULT_SETTINGS, {})` now explicitly carries `permissionMode` and `permissions` through from the base, preserving the existing missing-file equality seam against `DEFAULT_SETTINGS`.