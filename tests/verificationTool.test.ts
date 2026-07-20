import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCtx } from '../src/core/contracts';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createDefaultTools } from '../src/tools/registry';
import { createVerificationTool } from '../src/tools/verificationTool';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project(scripts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'juno-verify-')); roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts }));
  return await realpath(root);
}
function ctx(cwd: string): ToolCtx { return { cwd, signal: new AbortController().signal, emit: () => undefined, awaitPermission: async () => 'allow-once', state: {} as ToolCtx['state'] }; }

describe('run_verification', () => {
  it('runs named package presets without accepting a command and returns structured status', async () => {
    const root = await project({ test: 'node -e "console.log(\'two tests passed\')"', typecheck: 'node -e "process.exit(0)"' });
    const result = await createVerificationTool().run({ checks: ['test', 'typecheck'] }, ctx(root));
    expect(result.ok).toBe(true); expect(result.data).toMatchObject({ status: 'passed', passed: 2, failed: 0, unavailable: [] });
    const commands = (result.data as { commands: Array<Record<string, unknown>> }).commands;
    expect(commands.map((command) => command.command)).toEqual(['npm run test', 'npm run typecheck']);
    expect(commands.every((command) => command.status === 'passed' && typeof command.durationMs === 'number')).toBe(true);
  });

  it('bounds diagnostics and extracts bounded failure hints', async () => {
    const root = await project({ test: 'node -e "console.log(\'x\'.repeat(400)); console.error(\'FAIL sample test\'); process.exit(2)"' });
    const result = await createVerificationTool({ maxDiagnosticsChars: 80 }).run({ checks: ['test'] }, ctx(root));
    const command = (result.data as { commands: Array<Record<string, unknown>> }).commands[0]!;
    expect(result.ok).toBe(true); expect(result.data).toMatchObject({ status: 'failed', passed: 0, failed: 1 });
    expect(command).toMatchObject({ status: 'failed', exitCode: 2, diagnosticsTruncated: true, failedTestHints: ['FAIL sample test'] });
    expect((command.diagnostics as string).length).toBeLessThanOrEqual(80);
  });

  it('rejects arbitrary checks and workspace escapes', async () => {
    const root = await project({ test: 'node -e "process.exit(0)"' });
    await expect(createVerificationTool().run({ checks: ['test; rm -rf /'] }, ctx(root))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('checks must') });
    await mkdir(path.join(root, 'child'));
    await expect(createVerificationTool().run({ checks: ['test'], cwd: '..' }, ctx(root))).resolves.toMatchObject({ ok: false, error: 'cwd escapes the workspace' });
  });

  it('is risky, parent-only, and registered only when enabled', () => {
    expect(createDefaultTools().some((tool) => tool.name === 'run_verification')).toBe(false);
    const tools = createDefaultTools({ subagent: { client: {} } as never, verification: {} });
    const verification = tools.find((tool) => tool.name === 'run_verification'); const spawn = tools.findIndex((tool) => tool.name === 'spawn_subagent');
    expect(verification?.risk).toBe('risky'); expect(tools.indexOf(verification!)).toBeGreaterThan(spawn);
    expect(createPermissionPolicy().evaluate('run_verification', { checks: ['test'] }, 'risky')).toBe('prompt');
  });
});
