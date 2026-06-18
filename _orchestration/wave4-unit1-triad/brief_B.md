# Triad Brief B — juno config: add `permissionMode` + `permissions` to Settings

You are writing a focused, correct change to a TypeScript module in the **juno**
terminal-agent codebase. Output the FULL new contents of the file plus a new test
file. You CANNOT browse the repo — everything you need is in this brief.

## Context
- juno is a TS/Ink agent. `src/services/config.ts` resolves Settings as
  `defaults <- config file <- env overrides`, all SYNCHRONOUS, cached after first load.
- tsconfig: `strict:true`, `exactOptionalPropertyTypes` OFF, `noUncheckedIndexedAccess` OFF.
- Gate that must pass: `npx tsc --noEmit && npx vitest run` (vitest, not jest).
- Scope: add two new settings — a `permissionMode` enum and a `permissions` object
  with `allow`/`deny` string-pattern lists — that a different unit (cli.ts) will feed
  into the permission policy. Modes are `default` + `acceptEdits` ONLY.

## Task
1. Extend `Settings`, `DEFAULT_SETTINGS`, `parseSettings`, `mergeSettings`, and
   `applyEnvOverrides` in `src/services/config.ts` (the "5-touch") to support
   `permissionMode` and `permissions`.
2. Write a NEW standalone test file `tests/config.mode.test.ts` covering the new
   parse/merge/env-override behavior (do NOT edit the existing services.test.ts).

## Frozen seam (do NOT change the shape)
```ts
export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
  // NEW:
  permissionMode?: 'default' | 'acceptEdits';
  permissions?: { allow: string[]; deny: string[] };
}
```

## Exact behavior required
- `DEFAULT_SETTINGS`: add `permissionMode: 'default'` and `permissions: { allow: [], deny: [] }`.
- `parseSettings(value)`:
  - parse `permissionMode` ONLY if it is exactly the string `'default'` or
    `'acceptEdits'` (enum-whitelist; any other value, including non-strings, is
    silently ignored — do NOT set the field).
  - parse `permissions` ONLY if it is a non-null, non-array object. Build
    `{ allow, deny }` where each is the input array filtered to `typeof x === 'string'`
    entries; a missing/invalid list becomes `[]`. (So `permissions: {}` ⇒
    `{ allow: [], deny: [] }`.) Only set `settings.permissions` if the input was a
    valid object.
- `mergeSettings(base, overlay)`: `overlay.permissionMode ?? base.permissionMode`
  and `overlay.permissions ?? base.permissions`, mirroring how `maxContext`/`providers`
  are merged (only assign when the resolved value is not undefined, to keep the
  existing optional-field discipline). Match the EXISTING merge style in the file.
- `applyEnvOverrides(settings, env)`: read `JUNO_PERMISSION_MODE`. Apply it as an
  overlay ONLY if its value is exactly `'default'` or `'acceptEdits'` — a NEW
  enum-allowlist guard. A present-but-invalid value is ignored (the existing env
  helpers like `envString` do not validate enums; an unguarded bad value would poison
  the mode). Do NOT add an env override for the allow/deny lists (config-file only).
- Keep everything synchronous and total (never throw on bad input — degrade to
  defaults, exactly like the existing `readConfigFile` try/catch and the numeric
  `maxContext` guard).
- Preserve `createFakeConfigService` and `createConfigService` signatures unchanged.

## CURRENT FULL CONTENTS of `src/services/config.ts`
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
```

## IMPORTANT compatibility note (do not break an existing test)
There is an existing test that asserts `createConfigService` with a missing file and
`env:{}` returns EXACTLY `DEFAULT_SETTINGS` (`expect(service.get()).toEqual(DEFAULT_SETTINGS)`).
Therefore: the default resolution path (no file, no env) MUST yield an object deep-equal
to your new `DEFAULT_SETTINGS` (which now includes `permissionMode:'default'` and
`permissions:{allow:[],deny:[]}`). Ensure `mergeSettings(DEFAULT_SETTINGS, {})`
reproduces those fields (merge must carry `permissionMode`/`permissions` through from
base when the overlay omits them). Verify your merge does this.

## Test requirements (new file `tests/config.mode.test.ts`, vitest)
- `DEFAULT_SETTINGS.permissionMode === 'default'` and `permissions` deep-equals `{allow:[],deny:[]}`.
- `createConfigService` missing file + `env:{}` still deep-equals `DEFAULT_SETTINGS` (regression guard for the new fields).
- parse a config file with `permissionMode:'acceptEdits'` ⇒ resolved mode is `'acceptEdits'`.
- parse a config file with `permissionMode:'garbage'` ⇒ mode stays `'default'` (ignored).
- parse `permissions:{allow:['write_file:*'],deny:['write_file:secret.txt', 123]}` ⇒ `{allow:['write_file:*'],deny:['write_file:secret.txt']}` (non-string filtered).
- `JUNO_PERMISSION_MODE=acceptEdits` env override ⇒ mode `'acceptEdits'`; `JUNO_PERMISSION_MODE=bogus` ⇒ stays whatever the file/default said (ignored).
- Use a temp dir + `node:fs/promises` writeFile to create config files, mirroring the existing services.test.ts pattern (mkdtemp in os.tmpdir, clean up in afterEach). Self-contained — set up your own temp dir helper in the file.

## Output contract (FOLLOW EXACTLY)
Respond with a SINGLE markdown document. For every file you propose, put a line
`=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block
with the full file contents. After all files, add a `=== NOTES ===` section
(<200 words) on key design choices and the seams you expose/consume. Do NOT write
to the filesystem — output only this document.

Files you must output:
1. `=== FILE: src/services/config.ts ===` — full new contents.
2. `=== FILE: tests/config.mode.test.ts ===` — a NEW standalone vitest file.
