import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigService, DEFAULT_SETTINGS } from '../src/services/config';

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
    // Regression guard for the new fields: the default resolution path must stay
    // deep-equal to DEFAULT_SETTINGS now that it carries permissionMode/permissions.
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

  it('ignores a non-object (array) permissions value', async () => {
    const configPath = await writeConfig({ permissions: ['write_file:*'] });
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

  it('ignores an invalid JUNO_PERMISSION_MODE env value (file mode stands)', async () => {
    const configPath = await writeConfig({ permissionMode: 'acceptEdits' });
    const service = createConfigService({
      configPath,
      env: { JUNO_PERMISSION_MODE: 'bogus' },
    });
    expect(service.getValue('permissionMode')).toBe('acceptEdits');
  });

  it('ignores an invalid JUNO_PERMISSION_MODE env value (default stands)', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: { JUNO_PERMISSION_MODE: 'bogus' },
    });
    expect(service.getValue('permissionMode')).toBe('default');
  });

  it('parses a null permissions value as default empty lists', async () => {
    const configPath = await writeConfig({ permissions: null });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('permissions')).toEqual({ allow: [], deny: [] });
  });

  it('does not share the DEFAULT_SETTINGS.permissions reference (defensive clone)', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: {},
    });
    const permissions = service.getValue('permissions');
    // The merged result must be a fresh object/arrays, never the module-global
    // DEFAULT_SETTINGS.permissions — otherwise a consumer mutation would poison
    // the defaults process-wide.
    expect(permissions).not.toBe(DEFAULT_SETTINGS.permissions);
    expect(permissions?.allow).not.toBe(DEFAULT_SETTINGS.permissions?.allow);
    permissions?.allow.push('write_file:*');
    expect(DEFAULT_SETTINGS.permissions).toEqual({ allow: [], deny: [] });
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

describe('config maxToolCalls (iteration budget)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-budget-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('is undefined by default (absent => unbounded)', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: {},
    });
    expect(service.getValue('maxToolCalls')).toBeUndefined();
    // DEFAULT_SETTINGS must NOT carry it (unbounded is the safe additive default).
    expect(DEFAULT_SETTINGS.maxToolCalls).toBeUndefined();
  });

  it('parses a positive integer maxToolCalls from a config file', async () => {
    const configPath = await writeConfig({ maxToolCalls: 90 });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('maxToolCalls')).toBe(90);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid maxToolCalls (%s) in a config file => undefined',
    async (bad) => {
      const configPath = await writeConfig({ maxToolCalls: bad });
      const service = createConfigService({ configPath, env: {} });
      expect(service.getValue('maxToolCalls')).toBeUndefined();
    },
  );

  it('applies JUNO_MAX_TOOL_CALLS as an env override over the file value', async () => {
    const configPath = await writeConfig({ maxToolCalls: 90 });
    const service = createConfigService({
      configPath,
      env: { JUNO_MAX_TOOL_CALLS: '12' },
    });
    expect(service.getValue('maxToolCalls')).toBe(12);
  });

  it('ignores an invalid JUNO_MAX_TOOL_CALLS env value (file value stands)', async () => {
    const configPath = await writeConfig({ maxToolCalls: 90 });
    const service = createConfigService({
      configPath,
      env: { JUNO_MAX_TOOL_CALLS: 'not-a-number' },
    });
    expect(service.getValue('maxToolCalls')).toBe(90);
  });

  it('ignores a zero/negative JUNO_MAX_TOOL_CALLS env value (undefined stands)', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: { JUNO_MAX_TOOL_CALLS: '0' },
    });
    expect(service.getValue('maxToolCalls')).toBeUndefined();
  });
});

describe('config launch reliability bounds', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-reliability-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('ships bounded background execution and item-aware Codex guard defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      backgroundAgentMaxConcurrent: 3,
      backgroundAgentTimeoutMs: 1_800_000,
      codexIdleTimeoutMs: 180_000,
      codexStaleStreamMs: 300_000,
    });
  });

  it('accepts config values and lets valid env values override them', async () => {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      backgroundAgentMaxConcurrent: 5,
      backgroundAgentTimeoutMs: 600_000,
      codexIdleTimeoutMs: 240_000,
      codexStaleStreamMs: 360_000,
    }), 'utf8');
    const service = createConfigService({
      configPath,
      env: {
        JUNO_BACKGROUND_AGENT_MAX_CONCURRENT: '2',
        JUNO_BACKGROUND_AGENT_TIMEOUT_MS: '900000',
        JUNO_CODEX_IDLE_TIMEOUT_MS: '210000',
        JUNO_CODEX_STALE_STREAM_MS: '330000',
      },
    });
    expect(service.get()).toMatchObject({
      backgroundAgentMaxConcurrent: 2,
      backgroundAgentTimeoutMs: 900_000,
      codexIdleTimeoutMs: 210_000,
      codexStaleStreamMs: 330_000,
    });
  });

  it('ignores invalid non-positive overrides', async () => {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify({
      backgroundAgentMaxConcurrent: 4,
      backgroundAgentTimeoutMs: 700_000,
    }), 'utf8');
    const service = createConfigService({
      configPath,
      env: {
        JUNO_BACKGROUND_AGENT_MAX_CONCURRENT: '0',
        JUNO_BACKGROUND_AGENT_TIMEOUT_MS: '-1',
      },
    });
    expect(service.get().backgroundAgentMaxConcurrent).toBe(4);
    expect(service.get().backgroundAgentTimeoutMs).toBe(700_000);
  });
});
