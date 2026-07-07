import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigService, DEFAULT_SETTINGS } from '../src/services/config';

describe('config mcpServers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-mcp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('is undefined by default (absent => none configured)', () => {
    const service = createConfigService({
      configPath: path.join(tempDir, 'missing.json'),
      env: {},
    });
    expect(service.getValue('mcpServers')).toBeUndefined();
    // The additive default must NOT carry the field.
    expect(DEFAULT_SETTINGS.mcpServers).toBeUndefined();
  });

  it('parses a full server entry (command, env, cwd, timeoutMs, risk)', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        fs: {
          command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { FOO: 'bar' },
          cwd: '/tmp/ws',
          timeoutMs: 15_000,
          risk: 'risky',
        },
      },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({
      fs: {
        command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { FOO: 'bar' },
        cwd: '/tmp/ws',
        timeoutMs: 15_000,
        risk: 'risky',
      },
    });
  });

  it('keeps a minimal entry with only a command (optional fields absent)', async () => {
    const configPath = await writeConfig({
      mcpServers: { git: { command: ['mcp-server-git'] } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ git: { command: ['mcp-server-git'] } });
  });

  it('drops an entry whose command is missing, empty, or all non-strings', async () => {
    const configPath = await writeConfig({
      mcpServers: {
        noCommand: { env: { A: '1' } },
        emptyCommand: { command: [] },
        nonStringCommand: { command: [1, 2, 3] },
        good: { command: ['ok'] },
      },
    });
    const service = createConfigService({ configPath, env: {} });
    // Only the runnable entry survives.
    expect(service.getValue('mcpServers')).toEqual({ good: { command: ['ok'] } });
  });

  it('filters non-string tokens out of a command argv', async () => {
    const configPath = await writeConfig({
      mcpServers: { s: { command: ['bin', 42, 'arg', null] } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin', 'arg'] } });
  });

  it('filters non-string values out of env', async () => {
    const configPath = await writeConfig({
      mcpServers: { s: { command: ['bin'], env: { KEEP: 'v', DROP: 7, ALSO: null } } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'], env: { KEEP: 'v' } } });
  });

  it('ignores a non-string cwd', async () => {
    const configPath = await writeConfig({
      mcpServers: { s: { command: ['bin'], cwd: 123 } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'] } });
  });

  it.each([0, -1, 1.5, Number.NaN, 'soon'])(
    'ignores an invalid timeoutMs (%s) on a server entry',
    async (bad) => {
      const configPath = await writeConfig({
        mcpServers: { s: { command: ['bin'], timeoutMs: bad } },
      });
      const service = createConfigService({ configPath, env: {} });
      expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'] } });
    },
  );

  it('accepts a positive-integer timeoutMs', async () => {
    const configPath = await writeConfig({
      mcpServers: { s: { command: ['bin'], timeoutMs: 30_000 } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'], timeoutMs: 30_000 } });
  });

  it.each(['safe', 'risky', 'dangerous'] as const)('accepts the valid risk level %s', async (risk) => {
    const configPath = await writeConfig({ mcpServers: { s: { command: ['bin'], risk } } });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'], risk } });
  });

  it.each(['bogus', 42, null])('ignores an invalid risk value (%s)', async (bad) => {
    const configPath = await writeConfig({ mcpServers: { s: { command: ['bin'], risk: bad } } });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ s: { command: ['bin'] } });
  });

  it('ignores a non-object mcpServers value', async () => {
    const configPath = await writeConfig({ mcpServers: ['bin'] });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toBeUndefined();
  });

  it('drops a non-object server entry', async () => {
    const configPath = await writeConfig({
      mcpServers: { bad: 'not-an-object', good: { command: ['ok'] } },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toEqual({ good: { command: ['ok'] } });
  });

  it('resolves to undefined when every entry is dropped', async () => {
    const configPath = await writeConfig({ mcpServers: { bad: {}, worse: { command: [] } } });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('mcpServers')).toBeUndefined();
  });

  it('does not share parsed command/env containers across a reload (defensive clone)', async () => {
    const configPath = await writeConfig({
      mcpServers: { s: { command: ['bin'], env: { A: '1' } } },
    });
    const service = createConfigService({ configPath, env: {} });
    const first = service.getValue('mcpServers');
    const second = service.reload().mcpServers;
    // Each resolution deep-copies, so mutating one never bleeds into another.
    expect(first?.s.command).not.toBe(second?.s.command);
    expect(first?.s.env).not.toBe(second?.s.env);
    first?.s.command.push('leak');
    (first?.s.env as Record<string, string>).B = 'leak';
    expect(second?.s.command).toEqual(['bin']);
    expect(second?.s.env).toEqual({ A: '1' });
  });
});
