// src/services/backgroundTaskStore.ts
// Wave 14 (lane b7-background-durability) — a dependency-free, injectable-fs,
// fail-soft durability store for the NON-BLOCKING background-agent runner
// (src/services/backgroundAgents.ts). The runner is entirely in-memory: a
// detached child loop that dies with the TUI process, dropping every task's
// state and output. This store gives the runner a crash-durable shadow so a
// resumed session can (1) reconcile tasks that were 'running' when the process
// died — never fake-completing them, (2) re-surface a done/error completion that
// finished but was never drained to the user, and (3) offer the child's partial
// output for inspection.
//
// CO-LOCATION (deliberate — see the wave-7 subagentRecorder header): the durable
// files live in the SAME `<sessionId>.subagents/` dir as the per-subagent JSONL
// transcripts, but end in `.state.json` / `.output.ndjson`. subagentReader globs
// only `*.jsonl` and SessionStore.list() globs the sessions ROOT for `*.json`, so
// these files are invisible to both — they are private to this store.
//
// SHAPE mirrors subagentRecorder: lazy mkdir (per session dir), injectable
// appendFile/mkdir/readFile/readdir/now/onError, all writes serialized through a
// single per-instance promise chain so lines never interleave and the record
// write lands in call order. The record JSON goes through atomicWriteFile (the
// a4 save-queue write path — never a second, non-atomic writer) so a crash
// mid-write leaves the previous whole record, never a truncated one.
import {
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
} from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite';
import { DEFAULT_SESSION_DIR } from './sessions';

export type BackgroundTaskRecordStatus =
  | 'queued'
  | 'running'
  | 'needs-user'
  | 'done'
  | 'error'
  | 'interrupted';

export interface BackgroundPermissionCheckpoint {
  toolCallId: string;
  toolName: string;
  risk: string;
  sanitizedArgs: unknown;
  requestedAt: number;
}

/** The durable shadow of one background task. `model`/`provider` are the PINNED
 * spawn-time values. `delivered` records whether the settled completion was ever
 * surfaced to the user (so a resume does not re-surface it). */
export interface BackgroundTaskRecord {
  schemaVersion: number; // = 1
  taskId: string; // spawn card id
  sessionId: string;
  model: string; // pinned
  provider: string; // pinned
  description: string; // spawn task label
  status: BackgroundTaskRecordStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  summary?: string; // done
  error?: string; // error
  delivered?: boolean; // whether the completion was surfaced to the user
  profile?: string;
  checkpoint?: BackgroundPermissionCheckpoint;
}

/** One NDJSON output-log line: the child's write-through stream + lifecycle edges. */
export type BackgroundOutputLine =
  | {
      kind: 'lifecycle';
      event: 'spawn' | 'done' | 'error' | 'interrupted';
      ts: number;
      summary?: string;
      error?: string;
    }
  | { kind: 'text'; delta: string; ts: number }
  | { kind: 'reasoning'; delta: string; ts: number }
  | {
      kind: 'tool';
      event: 'call' | 'status';
      toolCallId: string;
      ts: number;
      name?: string;
      status?: 'pending' | 'running' | 'result' | 'error';
    }
  | { kind: 'steer'; text: string; ts: number }
  | {
      kind: 'checkpoint';
      event: 'requested' | 'resolved';
      toolCallId: string;
      toolName: string;
      ts: number;
      risk?: string;
      decision?: 'allow-once' | 'deny';
    };

export interface BackgroundTaskStoreDeps {
  /** Sessions root dir. Defaults to the shared `~/.config/juno/sessions`. */
  dir?: string;
  /** Injectable record write. Defaults to the atomic (crash-safe) writer. */
  writeFile?: (p: string, data: string) => Promise<void>;
  /** Injectable NDJSON append. Defaults to node:fs/promises appendFile. */
  appendFile?: (p: string, data: string) => Promise<void>;
  /** Injectable read (utf8). Defaults to node:fs/promises readFile. */
  readFile?: (p: string) => Promise<string>;
  /** Injectable readdir. Defaults to node:fs/promises readdir. */
  readdir?: (dir: string) => Promise<string[]>;
  /** Injectable mkdir (recursive). Defaults to node:fs/promises mkdir. */
  mkdir?: (dir: string) => Promise<void>;
  /** Clock. Defaults to Date.now. */
  now?: () => number;
  /** Best-effort error sink (durability must never crash a turn). */
  onError?: (e: unknown) => void;
}

export interface BackgroundTaskStore {
  /**
   * Persist the record, atomically, under the CLOBBER GUARD (the core requirement):
   * once a task's last-written status is terminal (done/error/interrupted), a write
   * with a DIFFERENT status is REFUSED — a late 'running' can never overwrite a
   * terminal record and a terminal state can never flip to a different terminal
   * (first-terminal-wins). An idempotent same-terminal re-write (e.g. only flipping
   * `delivered`) IS allowed. Fail-soft.
   */
  writeRecord(record: BackgroundTaskRecord): Promise<void>;
  /** Append one NDJSON line to the task's `.output.ndjson`; serialized, fail-soft. */
  appendOutput(sessionId: string, taskId: string, line: BackgroundOutputLine): Promise<void>;
  /** All valid records for a session (skips malformed/unreadable; [] on missing dir). */
  readRecords(sessionId: string): Promise<BackgroundTaskRecord[]>;
  /** Reconstruct a task's partial output (drops a torn final line). */
  readOutput(
    sessionId: string,
    taskId: string,
  ): Promise<{ text: string; reasoning: string; lifecycle: BackgroundOutputLine[] }>;
  /** Read-modify-write the task's record to `delivered:true` (guard permits it —
   * status is unchanged). Fail-soft; a missing record is a no-op. */
  markDelivered(sessionId: string, taskId: string): Promise<void>;
}

const TERMINAL: ReadonlySet<BackgroundTaskRecordStatus> = new Set([
  'done',
  'error',
  'interrupted',
]);

const VALID_STATUS: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'needs-user',
  'done',
  'error',
  'interrupted',
]);

/** Sanitize a task id into a safe single filename segment (same as subagentRecorder). */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Validate a parsed value is a well-formed record (shape guard for a fail-soft read). */
function isRecord(value: unknown): value is BackgroundTaskRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.taskId === 'string' &&
    typeof r.status === 'string' &&
    VALID_STATUS.has(r.status)
  );
}

/**
 * PURE classifier (unit-testable without fs). Splits the on-disk records into the
 * two lists a resume acts on. `liveTaskIds` are the ids of tasks STILL running a
 * detached loop in THIS process — a fresh process has none, so every disk
 * 'running' is a dead (interrupted) task; a same-process reconcile skips a live
 * id so a still-running detached loop is NOT falsely interrupted.
 *
 * Idempotent: a record already 'interrupted', or terminal+delivered:true, is
 * returned in NEITHER list — a second reconcile of the same session yields empty.
 */
export function classifyRecords(
  records: BackgroundTaskRecord[],
  liveTaskIds: ReadonlySet<string>,
): { interrupted: BackgroundTaskRecord[]; undelivered: BackgroundTaskRecord[]; needsUser: BackgroundTaskRecord[] } {
  const interrupted: BackgroundTaskRecord[] = [];
  const undelivered: BackgroundTaskRecord[] = [];
  const needsUser: BackgroundTaskRecord[] = [];
  for (const rec of records) {
    if (rec.status === 'queued' || rec.status === 'running') {
      if (!liveTaskIds.has(rec.taskId)) {
        interrupted.push({
          ...rec,
          status: 'interrupted',
          endedAt: rec.endedAt ?? rec.updatedAt,
        });
      }
      // live 'running' → still working, skip.
    } else if (rec.status === 'needs-user') {
      needsUser.push(rec);
    } else if (rec.status === 'done' || rec.status === 'error') {
      if (rec.delivered !== true) undelivered.push(rec);
    }
    // 'interrupted' → already reconciled, neither.
  }
  return { interrupted, undelivered, needsUser };
}

export function createBackgroundTaskStore(deps: BackgroundTaskStoreDeps = {}): BackgroundTaskStore {
  const rootDir = deps.dir ?? DEFAULT_SESSION_DIR;
  const writeFile = deps.writeFile ?? ((p: string, data: string) => atomicWriteFile(p, data));
  const appendFile = deps.appendFile ?? ((p: string, data: string) => fsAppendFile(p, data));
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const readdir = deps.readdir ?? ((dir: string) => fsReaddir(dir));
  const mkdir =
    deps.mkdir ?? ((dir: string) => fsMkdir(dir, { recursive: true }).then(() => undefined));
  const now = deps.now ?? Date.now;
  const onError = deps.onError ?? ((): void => {});

  // The clobber guard's authority: the last status this instance WROTE per task.
  const lastStatus = new Map<string, BackgroundTaskRecordStatus>();
  // Directories this instance has ensured (mkdir once per session dir).
  const ensuredDirs = new Set<string>();
  // Serialize every write (record + append) so lines land in call order and the
  // dir is created before the first write. Fail-soft: a failed task routes to
  // onError and the chain continues.
  let chain: Promise<void> = Promise.resolve();

  const subagentDirFor = (sessionId: string): string =>
    path.join(rootDir, `${sessionId}.subagents`);

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(() =>
      task().catch((error) => {
        onError(error);
      }),
    );
    chain = run;
    return run;
  };

  const ensureDir = async (dir: string): Promise<void> => {
    if (ensuredDirs.has(dir)) return;
    await mkdir(dir);
    ensuredDirs.add(dir);
  };

  /** Synchronous clobber-guard check-and-set (call-order decision). */
  const guardAllows = (taskId: string, status: BackgroundTaskRecordStatus): boolean => {
    const prev = lastStatus.get(taskId);
    if (prev !== undefined && TERMINAL.has(prev) && status !== prev) {
      return false;
    }
    lastStatus.set(taskId, status);
    return true;
  };

  const persistRecord = (record: BackgroundTaskRecord): Promise<void> => {
    // Guard decision is SYNCHRONOUS (call order); the disk write is serialized.
    if (!guardAllows(record.taskId, record.status)) {
      return Promise.resolve();
    }
    const dir = subagentDirFor(record.sessionId);
    const file = path.join(dir, `${safeSegment(record.taskId)}.state.json`);
    const data = JSON.stringify(record, null, 2) + '\n';
    return enqueue(async () => {
      await ensureDir(dir);
      await writeFile(file, data);
    });
  };

  return {
    writeRecord(record: BackgroundTaskRecord): Promise<void> {
      return persistRecord(record);
    },

    appendOutput(sessionId: string, taskId: string, line: BackgroundOutputLine): Promise<void> {
      const dir = subagentDirFor(sessionId);
      const file = path.join(dir, `${safeSegment(taskId)}.output.ndjson`);
      const data = JSON.stringify(line) + '\n';
      return enqueue(async () => {
        await ensureDir(dir);
        await appendFile(file, data);
      });
    },

    async readRecords(sessionId: string): Promise<BackgroundTaskRecord[]> {
      const dir = subagentDirFor(sessionId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return []; // missing dir → nothing durable yet.
      }
      const out: BackgroundTaskRecord[] = [];
      for (const name of names) {
        if (!name.endsWith('.state.json')) continue;
        try {
          const raw = await readFile(path.join(dir, name));
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed)) out.push(parsed);
        } catch (error) {
          onError(error); // malformed/unreadable → skip, keep the good ones.
        }
      }
      return out;
    },

    async readOutput(
      sessionId: string,
      taskId: string,
    ): Promise<{ text: string; reasoning: string; lifecycle: BackgroundOutputLine[] }> {
      const dir = subagentDirFor(sessionId);
      const file = path.join(dir, `${safeSegment(taskId)}.output.ndjson`);
      const empty = { text: '', reasoning: '', lifecycle: [] as BackgroundOutputLine[] };
      let raw: string;
      try {
        raw = await readFile(file);
      } catch {
        return empty; // missing file → nothing to inspect.
      }
      let text = '';
      let reasoning = '';
      const lifecycle: BackgroundOutputLine[] = [];
      for (const rawLine of raw.split('\n')) {
        if (rawLine.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue; // torn/half-written line (a crash mid-append) → drop it.
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const line = parsed as BackgroundOutputLine;
        if (line.kind === 'text' && typeof line.delta === 'string') {
          text += line.delta;
        } else if (line.kind === 'reasoning' && typeof line.delta === 'string') {
          reasoning += line.delta;
        } else if (
          line.kind === 'lifecycle' ||
          line.kind === 'tool' ||
          line.kind === 'steer' ||
          line.kind === 'checkpoint'
        ) {
          lifecycle.push(line);
        }
      }
      return { text, reasoning, lifecycle };
    },

    markDelivered(sessionId: string, taskId: string): Promise<void> {
      // Serialize the read-modify-write behind any pending record write so it reads
      // the CURRENT (terminal) record, then re-writes it with delivered:true. The
      // guard permits it (status unchanged). A missing record is a no-op.
      return enqueue(async () => {
        const dir = subagentDirFor(sessionId);
        const file = path.join(dir, `${safeSegment(taskId)}.state.json`);
        let raw: string;
        try {
          raw = await readFile(file);
        } catch {
          return; // no durable record → nothing to mark.
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          onError(error);
          return;
        }
        if (!isRecord(parsed)) return;
        if (parsed.delivered === true) return; // already delivered.
        const next: BackgroundTaskRecord = { ...parsed, delivered: true };
        if (!guardAllows(next.taskId, next.status)) return;
        await ensureDir(dir);
        await writeFile(file, JSON.stringify(next, null, 2) + '\n');
      });
    },
  };
}
