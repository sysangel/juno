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
