import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import { sanitizeShellEnv } from './shellTool';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_WALL_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_KILL_GRACE_MS = 2_000;

type StreamName = 'stdout' | 'stderr';
type ProcessStatus = 'running' | 'exited' | 'timed_out' | 'terminated' | 'failed';

interface OutputChunk { stream: StreamName; text: string }
interface Session {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason?: string;
  output: OutputChunk[];
  outputChars: number;
  droppedChars: number;
  startedAt: number;
  lastActivityAt: number;
  idleTimeoutMs: number;
  wallTimeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  killRequested: boolean;
}

export interface ProcessManagerOptions {
  maxSessions?: number;
  maxOutputChars?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  id?: () => string;
  realpath?: (value: string) => Promise<string>;
}

export interface ProcessManager {
  readonly tools: readonly Tool[];
  shutdown(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function textArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] as string : undefined;
}
function intArg(args: Record<string, unknown>, key: string, fallback: number): number | undefined {
  const value = args[key] ?? fallback;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS
    ? value : undefined;
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): unknown => ({
  type: 'object', additionalProperties: false, properties, required,
});
const processId = { type: 'string', minLength: 1, description: 'Opaque id returned by start_process.' };

const specs: Record<string, ToolSpec> = {
  start_process: {
    name: 'start_process',
    description: 'Start a long-running shell command and return immediately with a process id. Use for dev servers and long tests; use run_shell for short commands. The selected cwd is canonically jailed to the workspace, but the dangerous shell command is not OS-confined and may access paths or the network, so starting always requires explicit permission. idle_timeout_ms measures time without stdout, stderr, or stdin activity; wall_timeout_ms is an absolute lifetime. Both are bounded to 2 hours. Output is held in a bounded unread ring and the process is killed during Juno shutdown.',
    inputSchema: objectSchema({
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', description: 'Workspace-relative directory. Defaults to ".".' },
      idle_timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_IDLE_TIMEOUT_MS },
      wall_timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_WALL_TIMEOUT_MS },
    }, ['command']),
  },
  poll_process: {
    name: 'poll_process',
    description: 'Read and consume currently buffered output and status for a managed process. Polling does not reset its idle timeout; only process output or stdin activity does.',
    inputSchema: objectSchema({ process_id: processId }, ['process_id']),
  },
  write_process_stdin: {
    name: 'write_process_stdin',
    description: 'Write bounded text to a running managed process stdin. This resets its idle timer. No terminal/PTY is allocated, so programs requiring a TTY are unsupported.',
    inputSchema: objectSchema({ process_id: processId, text: { type: 'string', maxLength: 16_384 } }, ['process_id', 'text']),
  },
  terminate_process: {
    name: 'terminate_process',
    description: 'Terminate a managed process and its process group with SIGTERM, escalating to SIGKILL after a short grace period.',
    inputSchema: objectSchema({ process_id: processId }, ['process_id']),
  },
};

export function createProcessManager(options: ProcessManagerOptions = {}): ProcessManager {
  const sessions = new Map<string, Session>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const now = options.now ?? Date.now;
  const makeId = options.id ?? (() => randomUUID().slice(0, 12));
  const realpath = options.realpath ?? nodeRealpath;
  let shuttingDown = false;

  const append = (session: Session, stream: StreamName, text: string): void => {
    if (text.length === 0) return;
    session.lastActivityAt = now();
    session.output.push({ stream, text });
    session.outputChars += text.length;
    while (session.outputChars > maxOutputChars && session.output.length > 0) {
      const first = session.output[0]!;
      const excess = session.outputChars - maxOutputChars;
      if (first.text.length <= excess) {
        session.output.shift();
        session.outputChars -= first.text.length;
        session.droppedChars += first.text.length;
      } else {
        first.text = first.text.slice(excess);
        session.outputChars -= excess;
        session.droppedChars += excess;
      }
    }
  };

  const kill = (session: Session, status: ProcessStatus, reason: string): void => {
    if (session.status !== 'running' || session.killRequested) return;
    session.killRequested = true;
    session.status = status;
    session.reason = reason;
    if (session.timer !== undefined) clearTimeout(session.timer);
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (session.child.pid !== undefined && process.platform !== 'win32') process.kill(-session.child.pid, signal);
        else session.child.kill(signal);
      } catch { /* already gone */ }
    };
    signalGroup('SIGTERM');
    session.killTimer = setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
  };

  const schedule = (session: Session): void => {
    if (session.status !== 'running') return;
    if (session.timer !== undefined) clearTimeout(session.timer);
    const wallLeft = session.startedAt + session.wallTimeoutMs - now();
    const idleLeft = session.lastActivityAt + session.idleTimeoutMs - now();
    const delay = Math.max(1, Math.min(wallLeft, idleLeft));
    session.timer = setTimeout(() => {
      const at = now();
      if (at >= session.startedAt + session.wallTimeoutMs) {
        kill(session, 'timed_out', `wall timeout after ${session.wallTimeoutMs}ms`);
      } else if (at >= session.lastActivityAt + session.idleTimeoutMs) {
        kill(session, 'timed_out', `idle timeout after ${session.idleTimeoutMs}ms without process I/O`);
      } else schedule(session);
    }, delay);
  };

  const lookup = (args: unknown): { args?: Record<string, unknown>; session?: Session; error?: string } => {
    const parsed = record(args);
    const id = parsed === undefined ? undefined : textArg(parsed, 'process_id');
    if (parsed === undefined || id === undefined || id.length === 0) return { error: 'invalid process_id' };
    const session = sessions.get(id);
    return session === undefined ? { error: `unknown process: ${id}` } : { args: parsed, session };
  };

  const start: Tool = {
    name: 'start_process', risk: 'dangerous', spec: specs.start_process!,
    async run(raw, ctx): Promise<ToolResult> {
      if (shuttingDown) return { ok: false, error: 'process manager is shutting down' };
      const args = record(raw);
      const command = args === undefined ? undefined : textArg(args, 'command');
      const idleTimeoutMs = args === undefined ? undefined : intArg(args, 'idle_timeout_ms', DEFAULT_IDLE_TIMEOUT_MS);
      const wallTimeoutMs = args === undefined ? undefined : intArg(args, 'wall_timeout_ms', DEFAULT_WALL_TIMEOUT_MS);
      if (args === undefined || command === undefined || command.trim() === '' || idleTimeoutMs === undefined || wallTimeoutMs === undefined) return { ok: false, error: 'invalid args' };
      if (sessions.size >= maxSessions) return { ok: false, error: `process session limit reached (${maxSessions})` };
      try {
        const root = await realpath(ctx.cwd);
        const requested = path.resolve(root, textArg(args, 'cwd') ?? '.');
        if (!within(root, requested)) return { ok: false, error: 'cwd escapes the workspace' };
        const cwd = await realpath(requested);
        if (!within(root, cwd)) return { ok: false, error: 'cwd resolves outside the workspace' };
        const child = nodeSpawn('sh', ['-c', command], {
          cwd, env: sanitizeShellEnv(options.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true, detached: process.platform !== 'win32',
        });
        let id = makeId();
        for (let attempt = 0; sessions.has(id) && attempt < 10; attempt += 1) id = makeId();
        if (sessions.has(id)) {
          try { child.kill('SIGKILL'); } catch { /* best-effort collision cleanup */ }
          return { ok: false, error: 'failed to allocate a unique process id' };
        }
        const at = now();
        const session: Session = { id, command, cwd, child, status: 'running', exitCode: null, signal: null, output: [], outputChars: 0, droppedChars: 0, startedAt: at, lastActivityAt: at, idleTimeoutMs, wallTimeoutMs, killRequested: false };
        sessions.set(id, session);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { append(session, 'stdout', chunk); schedule(session); });
        child.stderr?.on('data', (chunk: string) => { append(session, 'stderr', chunk); schedule(session); });
        child.once('error', (error) => { session.status = 'failed'; session.reason = error.message; if (session.timer !== undefined) clearTimeout(session.timer); });
        child.once('close', (code, signal) => {
          if (session.timer !== undefined) clearTimeout(session.timer);
          // If termination was requested, leave the escalation armed even when
          // the shell closes: a descendant may still hold the detached process
          // group alive after its leader exits. The later group SIGKILL is the
          // no-orphan backstop (ESRCH is harmless when the group is already gone).
          if (!session.killRequested && session.killTimer !== undefined) clearTimeout(session.killTimer);
          session.exitCode = code;
          session.signal = signal;
          if (session.status === 'running') session.status = code === 0 ? 'exited' : 'failed';
        });
        schedule(session);
        return { ok: true, data: { processId: id, status: 'running', command, cwd, idleTimeoutMs, wallTimeoutMs } };
      } catch (error) {
        return { ok: false, error: `failed to start process: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };

  const poll: Tool = {
    name: 'poll_process', risk: 'safe', spec: specs.poll_process!,
    async run(raw): Promise<ToolResult> {
      const found = lookup(raw);
      if (found.session === undefined) return { ok: false, error: found.error };
      const session = found.session;
      const chunks = session.output.splice(0);
      const droppedChars = session.droppedChars;
      session.outputChars = 0;
      session.droppedChars = 0;
      const data = { processId: session.id, status: session.status, chunks, droppedChars, exitCode: session.exitCode, signal: session.signal, ...(session.reason === undefined ? {} : { reason: session.reason }) };
      // A terminal session remains observable until one final poll drains it, then
      // releases its slot. Running sessions are retained across turns.
      if (session.status !== 'running') sessions.delete(session.id);
      return { ok: true, data };
    },
  };

  const write: Tool = {
    name: 'write_process_stdin', risk: 'dangerous', spec: specs.write_process_stdin!,
    async run(raw): Promise<ToolResult> {
      const found = lookup(raw);
      const text = found.args === undefined ? undefined : textArg(found.args, 'text');
      if (found.session === undefined || text === undefined || text.length > 16_384) return { ok: false, error: found.error ?? 'invalid text' };
      const session = found.session;
      if (session.status !== 'running' || session.child.stdin === null || session.child.stdin.destroyed) return { ok: false, error: `process is not writable (${session.status})` };
      try {
        await new Promise<void>((resolve, reject) => session.child.stdin!.write(text, (error) => error === null || error === undefined ? resolve() : reject(error)));
        session.lastActivityAt = now();
        schedule(session);
        return { ok: true, data: { processId: session.id, bytesWritten: Buffer.byteLength(text) } };
      } catch (error) { return { ok: false, error: `stdin write failed: ${error instanceof Error ? error.message : String(error)}` }; }
    },
  };

  const terminate: Tool = {
    name: 'terminate_process', risk: 'risky', spec: specs.terminate_process!,
    async run(raw): Promise<ToolResult> {
      const found = lookup(raw);
      if (found.session === undefined) return { ok: false, error: found.error };
      if (found.session.status !== 'running') return { ok: true, data: { processId: found.session.id, status: found.session.status, alreadySettled: true } };
      kill(found.session, 'terminated', 'terminated by request');
      return { ok: true, data: { processId: found.session.id, status: 'terminated', signal: 'SIGTERM' } };
    },
  };

  return {
    tools: [start, poll, write, terminate],
    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const session of sessions.values()) kill(session, 'terminated', 'Juno shutdown');
      await Promise.all([...sessions.values()].map((session) => session.child.exitCode === null && session.child.signalCode === null
        ? new Promise<void>((resolve) => { session.child.once('close', () => resolve()); setTimeout(resolve, killGraceMs + 250); })
        : Promise.resolve()));
      sessions.clear();
    },
  };
}
