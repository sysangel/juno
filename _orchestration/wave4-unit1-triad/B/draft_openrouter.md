```markdown
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

const PERMISSION_MODES = new Set<string>(['default', 'acceptEdits']);

function isPermissionMode(value: unknown): value is 'default' | 'acceptEdits' {
  return typeof value === 'string' && PERMISSION_MODES.has(value);
}

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

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parsePermissions(value: unknown): Settings['permissions'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    allow: parseStringList(value.allow),
    deny: parseStringList(value.deny),
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

  if (isPermissionMode(value.permissionMode)) {
    settings.permissionMode = value.permissionMode;
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

  const rawPermissionMode = envString(env, 'JUNO_PERMISSION_MODE');
  if (rawPermissionMode !== undefined && isPermissionMode(rawPermissionMode)) {
    overlay.permissionMode = rawPermissionMode;
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createConfigService,
  DEFAULT_SETTINGS,
} from '../src/services/config.js';

describe('config permissionMode / permissions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-mode-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('exposes default permissionMode and permissions on DEFAULT_SETTINGS', () => {
    expect(DEFAULT_SETTINGS.permissionMode).toBe('default');
    expect(DEFAULT_SETTINGS.permissions).toEqual({ allow: [], deny: [] });
  });

  it('resolves to DEFAULT_SETTINGS when file is missing and env is empty', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'does-not-exist.json'),
      env: {},
    });
    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('parses permissionMode acceptEdits from a config file', async () => {
    const configPath = await writeConfig({ permissionMode: 'acceptEdits' });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissionMode')).toBe('acceptEdits');
  });

  it('ignores an invalid permissionMode in a config file', async () => {
    const configPath = await writeConfig({ permissionMode: 'garbage' });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissionMode')).toBe('default');
  });

  it('ignores a non-string permissionMode in a config file', async () => {
    const configPath = await writeConfig({ permissionMode: 42 });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissionMode')).toBe('default');
  });

  it('parses permissions, filtering non-string entries', async () => {
    const configPath = await writeConfig({
      permissions: {
        allow: ['write_file:*'],
        deny: ['write_file:secret.txt', 123],
      },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissions')).toEqual({
      allow: ['write_file:*'],
      deny: ['write_file:secret.txt'],
    });
  });

  it('parses an empty permissions object as empty allow/deny lists', async () => {
    const configPath = await writeConfig({ permissions: {} });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissions')).toEqual({ allow: [], deny: [] });
  });

  it('ignores a non-object permissions value', async () => {
    const configPath = await writeConfig({
      permissions: ['write_file:*'],
    });
    const service = createConfigService({ configPath, env: {} });
    // Falls back to DEFAULT_SETTINGS.permissions.
    expect(service.getValue('permissions')).toEqual({ allow: [], deny: [] });
  });

  it('applies JUNO_PERMISSION_MODE=acceptEdits as an env override', async () => {
    const configPath = await writeConfig({ permissionMode: 'default' });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_MODE: 'acceptEdits' },
    });
    expect(service.getValue('permissionMode')).toBe('acceptEdits');
  });

  it('ignores an invalid JUNO_PERMISSION_MODE env value', async () => {
    const configPath = await writeConfig({ permissionMode: 'acceptEdits' });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_MODE: 'bogus' },
    });
    expect(service.getValue('permissionMode')).toBe('acceptEdits');
  });

  it('ignores an invalid JUNO_PERMISSION_MODE env value when default is set', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: { JUNO_PERMISSION_MODE: 'bogus' },
    });
    expect(service.getValue('permissionMode')).toBe('default');
  });

  it('does not provide an env override for permissions lists', async () => {
    const configPath = await writeConfig({
      permissions: { allow: ['read_file:*'], deny: [] },
    });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_ALLOW: 'write_file:*' },
    });
    expect(service.getValue('permissions')).toEqual({
      allow: ['read_file:*'],
      deny: [],
    });
  });
});
```

=== NOTES ===
Design choices:
- Added a single `isPermissionMode` enum-allowlist guard reused by both `parseSettings` (config-file path) and `applyEnvOverrides` (env path). This is the new enum-validation seam the brief requires, since `envString` only checks non-empty strings.
- `parsePermissions` reuses `isRecord` (rejects arrays/null/primitives) and a `parseStringList` helper that filters to `typeof x === 'string'`, so `{}` ⇒ `{allow:[],deny:[]}` and non-objects ⇒ `undefined` (field omitted, falling back to base).
- `mergeSettings` mirrors the existing `maxContext`/`providers` discipline: resolve via `overlay ?? base`, then assign only when defined — preserving optional-field shape and the missing-file+empty-env `toEqual(DEFAULT_SETTINGS)` regression.
- No env override for allow/deny lists (config-file only), per spec.
- Everything stays synchronous and total; bad input degrades to defaults rather than throwing.
- `createConfigService`/`createFakeConfigService` signatures unchanged; the new fields are optional on `Settings` but populated on `DEFAULT_SETTINGS`.
```
```
