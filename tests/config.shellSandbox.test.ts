// tests/config.shellSandbox.test.ts
// The opt-in `shellSandbox` flag: default OFF, config-file + env parse, and the
// guard that it does NOT leak into the MCP per-server risk grammar.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigService, DEFAULT_SETTINGS } from '../src/services/config';

describe('config shellSandbox (opt-in OS confinement)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-sandbox-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('defaults OFF (compat/safety): DEFAULT_SETTINGS + missing file both false', () => {
    expect(DEFAULT_SETTINGS.shellSandbox).toBe(false);
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: {},
    });
    expect(service.getValue('shellSandbox')).toBe(false);
  });

  it('parses shellSandbox:true from a config file', async () => {
    const configPath = await writeConfig({ shellSandbox: true });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('shellSandbox')).toBe(true);
  });

  it('ignores a non-boolean shellSandbox in a config file (default stands)', async () => {
    const configPath = await writeConfig({ shellSandbox: 'yes' });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('shellSandbox')).toBe(false);
  });

  it('applies JUNO_SHELL_SANDBOX as an env override over the file value', async () => {
    const configPath = await writeConfig({ shellSandbox: false });
    const service = createConfigService({
      configPath,
      env: { JUNO_SHELL_SANDBOX: 'true' },
    });
    expect(service.getValue('shellSandbox')).toBe(true);

    const off = createConfigService({
      configPath: await writeConfig({ shellSandbox: true }),
      env: { JUNO_SHELL_SANDBOX: 'off' },
    });
    expect(off.getValue('shellSandbox')).toBe(false);
  });

  it('ignores an invalid JUNO_SHELL_SANDBOX env value (file value stands)', async () => {
    const configPath = await writeConfig({ shellSandbox: true });
    const service = createConfigService({
      configPath,
      env: { JUNO_SHELL_SANDBOX: 'maybe' },
    });
    expect(service.getValue('shellSandbox')).toBe(true);
  });

  it('shellSandboxNetwork defaults ON (git/npm need the network in the confined child)', () => {
    expect(DEFAULT_SETTINGS.shellSandboxNetwork).toBe(true);
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: {},
    });
    expect(service.getValue('shellSandboxNetwork')).toBe(true);
  });

  it('parses shellSandboxNetwork:false from a config file and via env override', async () => {
    const configPath = await writeConfig({ shellSandboxNetwork: false });
    expect(createConfigService({ configPath, env: {} }).getValue('shellSandboxNetwork')).toBe(false);

    // Env wins over the file; an invalid env value is ignored (file stands).
    const onViaEnv = createConfigService({
      configPath: await writeConfig({ shellSandboxNetwork: false }),
      env: { JUNO_SHELL_SANDBOX_NETWORK: 'true' },
    });
    expect(onViaEnv.getValue('shellSandboxNetwork')).toBe(true);

    const invalidEnv = createConfigService({
      configPath: await writeConfig({ shellSandboxNetwork: false }),
      env: { JUNO_SHELL_SANDBOX_NETWORK: 'maybe' },
    });
    expect(invalidEnv.getValue('shellSandboxNetwork')).toBe(false);
  });

  it('does NOT accept "sandboxed" as an MCP per-server risk (no self-classification)', async () => {
    // parseRisk must remain the 3-value RiskLevel enum: a server marked
    // risk:'sandboxed' is DROPPED (invalid), never letting MCP config self-grant
    // an auto-allow via the sandbox path.
    const configPath = await writeConfig({
      mcpServers: { fs: { command: ['fs-server'], risk: 'sandboxed' } },
    });
    const service = createConfigService({ configPath, env: {} });
    const servers = service.getValue('mcpServers');
    expect(servers?.fs.command).toEqual(['fs-server']);
    expect(servers?.fs.risk).toBeUndefined();
  });
});
