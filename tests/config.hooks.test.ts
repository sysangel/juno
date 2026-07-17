// tests/config.hooks.test.ts
// Wave 12 (rank 5) — the config.json `hooks` block: parse (drop malformed),
// whole-block replace on merge, and deep-clone isolation.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigService, DEFAULT_SETTINGS } from '../src/services/config';

describe('config hooks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'juno-config-hooks-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents), 'utf8');
    return configPath;
  }

  it('is undefined by default (feature off; no default block)', () => {
    const service = createConfigService({ configPath: path.join(tempDir, 'missing.json'), env: {} });
    expect(service.getValue('hooks')).toBeUndefined();
    expect(DEFAULT_SETTINGS.hooks).toBeUndefined();
  });

  it('parses a well-formed PreToolUse + PostToolUse block', async () => {
    const configPath = await writeConfig({
      hooks: {
        PreToolUse: [
          { matcher: 'edit_file|write_file', hooks: [{ command: ['guard', '--pre'], timeoutMs: 3000 }] },
        ],
        PostToolUse: [{ matcher: '*', hooks: [{ command: ['remind'] }] }],
      },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toEqual({
      PreToolUse: [
        { matcher: 'edit_file|write_file', hooks: [{ command: ['guard', '--pre'], timeoutMs: 3000 }] },
      ],
      PostToolUse: [{ matcher: '*', hooks: [{ command: ['remind'] }] }],
    });
  });

  it('accepts an empty-string matcher (match-all is legal)', async () => {
    const configPath = await writeConfig({
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ command: ['g'] }] }] },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toEqual({
      PreToolUse: [{ matcher: '', hooks: [{ command: ['g'] }] }],
    });
  });

  it('drops malformed entries: non-string matcher, empty command, non-array hooks', async () => {
    const configPath = await writeConfig({
      hooks: {
        PreToolUse: [
          { matcher: 42, hooks: [{ command: ['ok'] }] }, // bad matcher → group dropped
          { matcher: 'a', hooks: [{ command: [] }] }, // empty command → hook dropped → group empty → dropped
          { matcher: 'b', hooks: 'nope' }, // hooks not an array → group dropped
          { matcher: 'c', hooks: [{ command: ['keep'], timeoutMs: -5 }] }, // bad timeout dropped, command kept
        ],
      },
    });
    const service = createConfigService({ configPath, env: {} });
    // Only the last group survives; its invalid timeoutMs is dropped.
    expect(service.getValue('hooks')).toEqual({
      PreToolUse: [{ matcher: 'c', hooks: [{ command: ['keep'] }] }],
    });
  });

  it('a non-string command entry inside a command array is filtered', async () => {
    const configPath = await writeConfig({
      hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ command: ['bin', 5, 'arg', null] }] }] },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toEqual({
      PreToolUse: [{ matcher: 'x', hooks: [{ command: ['bin', 'arg'] }] }],
    });
  });

  it('an all-empty hooks block resolves to undefined (feature off)', async () => {
    const configPath = await writeConfig({ hooks: { PreToolUse: [], PostToolUse: [{ matcher: 'a', hooks: [] }] } });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toBeUndefined();
  });

  it('a non-object hooks value is ignored', async () => {
    const configPath = await writeConfig({ hooks: 'not an object' });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toBeUndefined();
  });

  it('whole-block replace on merge: a file block supersedes the base wholesale', async () => {
    // The base default has no hooks; a file block is carried through unchanged.
    const configPath = await writeConfig({
      hooks: { PreToolUse: [{ matcher: 'read_file', hooks: [{ command: ['only'] }] }] },
    });
    const service = createConfigService({ configPath, env: {} });
    expect(service.getValue('hooks')).toEqual({
      PreToolUse: [{ matcher: 'read_file', hooks: [{ command: ['only'] }] }],
    });
    // PostToolUse stays absent (no default block to leak in).
    expect(service.getValue('hooks')?.PostToolUse).toBeUndefined();
  });

  it('cloneHooks isolates arrays: mutating the loaded config never poisons a reload', async () => {
    const configPath = await writeConfig({
      hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ command: ['bin', 'arg'] }] }] },
    });
    const service = createConfigService({ configPath, env: {} });
    const first = service.getValue('hooks');
    // Mutate the returned structure in place.
    first?.PreToolUse?.[0]?.hooks?.[0]?.command.push('INJECTED');
    first?.PreToolUse?.push({ matcher: 'y', hooks: [{ command: ['z'] }] });

    const fresh = service.reload().hooks;
    expect(fresh).toEqual({
      PreToolUse: [{ matcher: 'x', hooks: [{ command: ['bin', 'arg'] }] }],
    });
  });
});
