import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFile, realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult } from '../core/contracts';
import { sanitizeShellEnv } from './shellTool';

export type VerificationCheck = 'test' | 'typecheck' | 'lint' | 'build';
type CommandStatus = 'passed' | 'failed' | 'timed_out' | 'cancelled';
interface ResolvedCommand { check: VerificationCheck; executable: string; args: string[] }
interface CommandResult { check: VerificationCheck; command: string; status: CommandStatus; exitCode: number | null; durationMs: number; diagnostics: string; diagnosticsTruncated: boolean; failedTestHints: string[] }
export interface VerificationToolOptions { spawn?: typeof nodeSpawn; realpath?: (value: string) => Promise<string>; readFile?: (value: string, encoding: BufferEncoding) => Promise<string>; now?: () => number; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxDiagnosticsChars?: number }

const CHECKS: readonly VerificationCheck[] = ['test', 'typecheck', 'lint', 'build'];
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_DIAGNOSTICS_CHARS = 12_000;
const MAX_HINTS = 8;
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function within(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function displayCommand(command: ResolvedCommand): string { return [command.executable, ...command.args].map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(' '); }
function packageManager(files: Set<string>): { executable: string; prefix: string[] } {
  if (files.has('pnpm-lock.yaml')) return { executable: 'pnpm', prefix: ['run'] };
  if (files.has('yarn.lock')) return { executable: 'yarn', prefix: ['run'] };
  if (files.has('bun.lock') || files.has('bun.lockb')) return { executable: 'bun', prefix: ['run'] };
  return { executable: 'npm', prefix: ['run'] };
}
async function resolveCommands(cwd: string, requested: readonly VerificationCheck[], read: (value: string, encoding: BufferEncoding) => Promise<string>): Promise<{ commands: ResolvedCommand[]; unavailable: VerificationCheck[] }> {
  const names = new Set<string>();
  for (const name of ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.toml', 'go.mod', 'pyproject.toml']) { try { await read(path.join(cwd, name), 'utf8'); names.add(name); } catch { /* absent */ } }
  const available = new Map<VerificationCheck, ResolvedCommand>();
  if (names.has('package.json')) {
    try {
      const parsed = JSON.parse(await read(path.join(cwd, 'package.json'), 'utf8')) as unknown;
      const scripts = record(record(parsed)?.scripts); const manager = packageManager(names);
      for (const check of CHECKS) if (typeof scripts?.[check] === 'string') available.set(check, { check, executable: manager.executable, args: [...manager.prefix, check] });
    } catch { /* malformed metadata contributes no presets */ }
  }
  if (names.has('Cargo.toml')) {
    available.set('test', { check: 'test', executable: 'cargo', args: ['test', '--color=never'] }); available.set('typecheck', { check: 'typecheck', executable: 'cargo', args: ['check', '--color=never'] }); available.set('lint', { check: 'lint', executable: 'cargo', args: ['clippy', '--color=never', '--', '-D', 'warnings'] }); available.set('build', { check: 'build', executable: 'cargo', args: ['build', '--color=never'] });
  } else if (names.has('go.mod')) {
    available.set('test', { check: 'test', executable: 'go', args: ['test', './...'] }); available.set('typecheck', { check: 'typecheck', executable: 'go', args: ['vet', './...'] }); available.set('lint', { check: 'lint', executable: 'go', args: ['vet', './...'] }); available.set('build', { check: 'build', executable: 'go', args: ['build', './...'] });
  } else if (names.has('pyproject.toml')) {
    available.set('test', { check: 'test', executable: 'python3', args: ['-m', 'pytest'] }); available.set('typecheck', { check: 'typecheck', executable: 'python3', args: ['-m', 'mypy', '.'] }); available.set('lint', { check: 'lint', executable: 'python3', args: ['-m', 'ruff', 'check', '.'] }); available.set('build', { check: 'build', executable: 'python3', args: ['-m', 'build'] });
  }
  return { commands: requested.flatMap((check) => available.has(check) ? [available.get(check)!] : []), unavailable: requested.filter((check) => !available.has(check)) };
}
function hintsFrom(output: string): string[] {
  const hints: string[] = [];
  for (const raw of output.split(/\r?\n/u)) { const line = raw.trim().replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ''); if (line.length > 0 && /(?:\bFAIL(?:ED)?\b|\bERROR\b|AssertionError|Tests?:.*failed|✗|×)/iu.test(line)) { hints.push(line.slice(0, 300)); if (hints.length === MAX_HINTS) break; } }
  return hints;
}
async function execute(command: ResolvedCommand, cwd: string, ctx: ToolCtx, options: Required<Pick<VerificationToolOptions, 'spawn' | 'now' | 'timeoutMs' | 'maxDiagnosticsChars'>> & { env: NodeJS.ProcessEnv }): Promise<CommandResult> {
  const started = options.now(); let output = ''; let truncated = false;
  const append = (chunk: unknown): void => { output += String(chunk); if (output.length > options.maxDiagnosticsChars) { output = output.slice(-options.maxDiagnosticsChars); truncated = true; } };
  return await new Promise((resolve) => {
    const child: ChildProcess = options.spawn(command.executable, command.args, { cwd, env: { ...sanitizeShellEnv(options.env), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8'); child.stdout?.on('data', append); child.stderr?.on('data', append);
    let status: CommandStatus = 'failed'; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalChild = (signal: NodeJS.Signals): void => { try { if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already stopped */ } };
    const stop = (): void => { if (status === 'timed_out' || status === 'cancelled') return; status = ctx.signal.aborted ? 'cancelled' : 'timed_out'; signalChild('SIGTERM'); killTimer = setTimeout(() => signalChild('SIGKILL'), 2_000); };
    const timer = setTimeout(stop, options.timeoutMs); const abort = (): void => stop(); ctx.signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => append(`Failed to start: ${error.message}\n`));
    child.once('close', (code) => { clearTimeout(timer); if (killTimer !== undefined) clearTimeout(killTimer); ctx.signal.removeEventListener('abort', abort); if (status !== 'timed_out' && status !== 'cancelled') status = code === 0 ? 'passed' : 'failed'; resolve({ check: command.check, command: displayCommand(command), status, exitCode: code, durationMs: Math.max(0, options.now() - started), diagnostics: output.trim(), diagnosticsTruncated: truncated, failedTestHints: hintsFrom(output) }); });
  });
}

export function createVerificationTool(options: VerificationToolOptions = {}): Tool {
  const spawn = options.spawn ?? nodeSpawn; const realpath = options.realpath ?? nodeRealpath; const read = options.readFile ?? readFile; const now = options.now ?? Date.now; const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS; const maxDiagnosticsChars = options.maxDiagnosticsChars ?? MAX_DIAGNOSTICS_CHARS;
  return { name: 'run_verification', risk: 'risky', spec: { name: 'run_verification', description: 'Run recognized project verification presets through a non-interactive, shell-free process path. Select only test, typecheck, lint, and/or build; commands are resolved from package scripts or standard Rust, Go, and Python project metadata. Output and failure hints are bounded. This complements run_shell and managed process sessions for short, structured verification.', inputSchema: { type: 'object', additionalProperties: false, properties: { checks: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: CHECKS }, description: 'Named verification checks. Defaults to every available check.' }, cwd: { type: 'string', description: 'Workspace-relative project directory. Defaults to ".".' } } } },
    async run(raw, ctx): Promise<ToolResult> {
      const args = record(raw); if (args === undefined) return { ok: false, error: 'invalid args' }; const requested = args.checks === undefined ? [...CHECKS] : args.checks;
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > CHECKS.length || requested.some((value) => typeof value !== 'string' || !CHECKS.includes(value as VerificationCheck)) || new Set(requested).size !== requested.length) return { ok: false, error: 'checks must contain unique test, typecheck, lint, and/or build presets' };
      if (args.cwd !== undefined && typeof args.cwd !== 'string') return { ok: false, error: 'cwd must be a string' };
      try {
        const root = await realpath(ctx.cwd); const selected = path.resolve(root, typeof args.cwd === 'string' ? args.cwd : '.'); if (!within(root, selected)) return { ok: false, error: 'cwd escapes the workspace' }; const cwd = await realpath(selected); if (!within(root, cwd)) return { ok: false, error: 'cwd resolves outside the workspace' };
        const resolved = await resolveCommands(cwd, requested as VerificationCheck[], read); if (resolved.commands.length === 0) return { ok: false, error: `no recognized verification presets found in ${cwd}` };
        const results: CommandResult[] = []; for (const command of resolved.commands) { if (ctx.signal.aborted) break; results.push(await execute(command, cwd, ctx, { spawn, now, timeoutMs, maxDiagnosticsChars, env: options.env ?? process.env })); }
        const passed = results.filter((result) => result.status === 'passed').length; const failed = results.length - passed;
        return { ok: true, data: { status: failed === 0 ? 'passed' : 'failed', passed, failed, durationMs: results.reduce((sum, result) => sum + result.durationMs, 0), commands: results, unavailable: resolved.unavailable } };
      } catch (error) { return { ok: false, error: `verification failed to run: ${error instanceof Error ? error.message : String(error)}` }; }
    } };
}
