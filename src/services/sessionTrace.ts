import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Action, State } from '../core/reducer';
import { initialState, reducer } from '../core/reducer';

export const TRACE_SCHEMA = 'juno.session-trace';
export const TRACE_VERSION = 1;
export const DEFAULT_TRACE_DIR = path.join(os.homedir(), '.config', 'juno', 'traces');
export const DEFAULT_TRACE_RETENTION = 20;
const MAX_QUEUE = 2_048;
const MAX_STRING = 4_096;
const MAX_COLLECTION = 64;
const MAX_DEPTH = 6;

export interface TraceRecordV1 {
  readonly schema: typeof TRACE_SCHEMA;
  readonly version: typeof TRACE_VERSION;
  readonly seq: number;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly action: Action;
}

export interface SessionTraceRecorder {
  readonly path: string;
  record(action: Action): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface TraceIssue {
  readonly kind: 'trace' | 'action' | 'reducer';
  readonly line: number;
  readonly message: string;
}

export interface TraceReadResult {
  readonly records: TraceRecordV1[];
  readonly issues: TraceIssue[];
}

export interface TraceReplayResult extends TraceReadResult {
  readonly state: State;
  readonly applied: number;
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
  return cleaned.length > 0 ? cleaned : 'session';
}

function boundedString(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`;
}

const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|api[_-]?key|private[_-]?key)/i;

function sanitizeUnknown(value: unknown, depth = 0, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedString(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return undefined;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION).map((item) => sanitizeUnknown(item, depth + 1));
    if (value.length > MAX_COLLECTION) items.push(`[${value.length - MAX_COLLECTION} more items]`);
    return items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_COLLECTION);
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries) {
      result[entryKey] = sanitizeUnknown(entryValue, depth + 1, entryKey);
    }
    if (Object.keys(value).length > MAX_COLLECTION) result.__truncated__ = true;
    return result;
  }
  return `[${typeof value}]`;
}

/** Copy an action into the diagnostic trace shape without retaining raw prompts or secrets. */
export function sanitizeTraceAction(action: Action): Action {
  if (action.t === 'user-submit') {
    return { ...action, text: `[redacted prompt: ${action.text.length} chars]` };
  }
  if (action.t === 'tool-call' || action.t === 'permission-open') {
    return { ...action, args: sanitizeUnknown(action.args) };
  }
  if (action.t === 'tool-status') {
    return {
      ...action,
      ...(action.result !== undefined ? { result: sanitizeUnknown(action.result) } : {}),
      ...(action.error !== undefined ? { error: boundedString(action.error) } : {}),
    };
  }
  if (action.t === 'deltas') {
    return { t: 'deltas', actions: action.actions.map(sanitizeTraceAction) };
  }
  if (action.t === 'resume-session') {
    // Loaded transcripts can contain old prompts and complete tool results. The action is
    // useful diagnostically without duplicating that durable content into a second store.
    return { t: 'resume-session', messages: [] };
  }
  return sanitizeUnknown(action) as Action;
}

async function enforceRetention(dir: string, keep: number): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ndjson'));
  const entries = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(path.join(dir, name))).mtimeMs })));
  entries.sort((a, b) => b.mtime - a.mtime);
  // The recorder's new file does not exist yet: retain at most keep-1 old files.
  await Promise.all(entries.slice(Math.max(0, keep - 1)).map(({ name }) => unlink(path.join(dir, name)).catch(() => {})));
}

export function createSessionTraceRecorder(options: {
  sessionId: string;
  dir?: string;
  retention?: number;
  clock?: () => Date;
}): SessionTraceRecorder {
  const dir = options.dir ?? DEFAULT_TRACE_DIR;
  const clock = options.clock ?? (() => new Date());
  const started = clock();
  const filename = `${safeFilePart(options.sessionId)}-${started.toISOString().replace(/[:.]/g, '-')}-${process.pid}.ndjson`;
  const filePath = path.join(dir, filename);
  let seq = 0;
  let turnId: string | null = null;
  let closed = false;
  let scheduled = false;
  let pending: Array<Omit<TraceRecordV1, 'action'> & { action: Action }> = [];
  let writes = Promise.resolve();

  const drain = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    writes = writes.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        // Redaction, bounding, and JSON serialization deliberately happen here, never
        // in record(), which is called from the render-sensitive dispatch funnel.
        const lines = batch.map((record) => JSON.stringify({
          ...record,
          action: sanitizeTraceAction(record.action),
        }));
        await appendFile(filePath, `${lines.join('\n')}\n`, 'utf8');
      } catch {
        // Diagnostic tracing is fail-soft: application behavior always wins over telemetry.
      }
    });
  };

  // Retention is startup-only and off the dispatch path. keep includes the new file.
  writes = mkdir(dir, { recursive: true })
    .then(() => enforceRetention(dir, options.retention ?? DEFAULT_TRACE_RETENTION))
    .catch(() => {});

  return {
    path: filePath,
    record: (action: Action): void => {
      if (closed) return;
      if (action.t === 'user-submit' && !action.id.startsWith('steer-')) turnId = action.id;
      const record: Omit<TraceRecordV1, 'action'> & { action: Action } = {
        schema: TRACE_SCHEMA,
        version: TRACE_VERSION,
        seq,
        timestamp: clock().toISOString(),
        sessionId: options.sessionId,
        turnId,
        action,
      };
      seq += 1;
      if (pending.length >= MAX_QUEUE) pending.shift();
      pending.push(record);
      if (!scheduled) {
        scheduled = true;
        setImmediate(drain);
      }
      if (action.t === 'turn-settle') turnId = null;
    },
    flush: async (): Promise<void> => {
      drain();
      await writes;
    },
    close: async (): Promise<void> => {
      closed = true;
      drain();
      await writes;
    },
  };
}

const ACTION_TYPES = new Set<string>([
  'user-submit', 'turn-start', 'turn-settle', 'compaction-start', 'compaction-settle',
  'assistant-start', 'text-delta', 'reasoning-delta', 'tool-call', 'tool-call-delta',
  'tool-status', 'permission-open', 'permission-resolved', 'assistant-done', 'usage',
  'aborted', 'set-effort', 'cycle-effort', 'set-overlay', 'skill-select',
  'set-permission-mode', 'error', 'notice', 'clear', 'retry-attempt', 'retry-clear',
  'deltas', 'compact', 'resume-session',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): TraceRecordV1 | string {
  if (!isObject(value) || value.schema !== TRACE_SCHEMA || value.version !== TRACE_VERSION) return 'unsupported trace schema/version';
  if (!Number.isSafeInteger(value.seq) || typeof value.timestamp !== 'string' || typeof value.sessionId !== 'string') return 'invalid trace envelope';
  if (value.turnId !== null && typeof value.turnId !== 'string') return 'invalid turn identifier';
  if (!isObject(value.action) || typeof value.action.t !== 'string') return 'missing action discriminator';
  return value as unknown as TraceRecordV1;
}

/** Read NDJSON independently per line so a torn/corrupt write does not hide later records. */
export function readTraceNdjson(text: string): TraceReadResult {
  const records: TraceRecordV1[] = [];
  const issues: TraceIssue[] = [];
  let priorSeq = -1;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) {
      issues.push({ kind: 'trace', line: index + 1, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const record = parseRecord(parsed);
    if (typeof record === 'string') {
      issues.push({ kind: 'trace', line: index + 1, message: record });
      continue;
    }
    if (record.seq <= priorSeq) {
      issues.push({ kind: 'trace', line: index + 1, message: `non-monotonic sequence ${record.seq} after ${priorSeq}` });
      continue;
    }
    priorSeq = record.seq;
    records.push(record);
  }
  return { records, issues };
}

/** Stable first replay seam: validate recorded actions, then fold them through the pure reducer. */
export function replayTraceNdjson(text: string, seed: State = initialState()): TraceReplayResult {
  const read = readTraceNdjson(text);
  const issues = [...read.issues];
  let state = seed;
  let applied = 0;
  for (const record of read.records) {
    if (!ACTION_TYPES.has(record.action.t)) {
      issues.push({ kind: 'action', line: record.seq + 1, message: `unknown action "${record.action.t}"` });
      continue;
    }
    try {
      const next = reducer(state, record.action);
      if (!isObject(next) || typeof next.phase !== 'string') throw new Error('reducer returned an invalid state');
      state = next;
      applied += 1;
    } catch (error) {
      issues.push({ kind: 'reducer', line: record.seq + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ...read, issues, state, applied };
}

/** Convenience read for tooling/tests; does not throw on an absent/unreadable file. */
export async function replayTraceFile(filePath: string): Promise<TraceReplayResult> {
  try {
    const handle = await open(filePath, 'r');
    try { return replayTraceNdjson(await handle.readFile('utf8')); } finally { await handle.close(); }
  } catch (error) {
    return { records: [], issues: [{ kind: 'trace', line: 0, message: error instanceof Error ? error.message : String(error) }], state: initialState(), applied: 0 };
  }
}
