import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Msg } from '../core/reducer';

export interface SessionMeta {
  id: string;
  createdAt: string; // ISO-8601; caller supplies the clock
  model?: string;
  cwd?: string;
  title?: string;
}

export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<ReadonlyArray<SessionMeta>>;
  load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined>;
  /** Persist the full committed transcript for a session (overwrite). */
  save(id: string, messages: ReadonlyArray<Msg>): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Append-only line log of committed messages (JSONL); separate from SessionStore. */
export interface TranscriptLog {
  append(sessionId: string, message: Msg): Promise<void>;
  read(sessionId: string): Promise<Msg[]>;
}

interface SessionFile {
  meta: SessionMeta;
  messages: Msg[];
}

export const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.config', 'juno', 'sessions');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRole(value: unknown): value is Msg['role'] {
  return value === 'user' || value === 'assistant' || value === 'tool' || value === 'system';
}

function isBlock(value: unknown): value is Msg['blocks'][number] {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }

  if (value.kind === 'text') {
    return typeof value.text === 'string';
  }

  if (value.kind === 'tool') {
    return typeof value.toolCallId === 'string';
  }

  if (value.kind === 'notice') {
    return typeof value.text === 'string';
  }

  return false;
}

function isMsg(value: unknown): value is Msg {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== 'string' ||
    !isRole(value.role) ||
    !isUnknownArray(value.blocks) ||
    typeof value.done !== 'boolean'
  ) {
    return false;
  }

  if (!value.blocks.every(isBlock)) {
    return false;
  }

  if (value.reasoning !== undefined && typeof value.reasoning !== 'string') {
    return false;
  }

  if (value.toolSnapshot !== undefined && !isRecord(value.toolSnapshot)) {
    return false;
  }

  return true;
}

function isMsgArray(value: unknown): value is Msg[] {
  return isUnknownArray(value) && value.every(isMsg);
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== 'string' || typeof value.createdAt !== 'string') {
    return false;
  }

  if (value.model !== undefined && typeof value.model !== 'string') {
    return false;
  }
  if (value.cwd !== undefined && typeof value.cwd !== 'string') {
    return false;
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    return false;
  }

  return true;
}

function isSessionFile(value: unknown): value is SessionFile {
  return isRecord(value) && isSessionMeta(value.meta) && isMsgArray(value.messages);
}

function cloneMeta(meta: SessionMeta): SessionMeta {
  const cloned: SessionMeta = {
    id: meta.id,
    createdAt: meta.createdAt,
  };

  if (meta.model !== undefined) {
    cloned.model = meta.model;
  }
  if (meta.cwd !== undefined) {
    cloned.cwd = meta.cwd;
  }
  if (meta.title !== undefined) {
    cloned.title = meta.title;
  }

  return cloned;
}

function cloneBlock(block: Msg['blocks'][number]): Msg['blocks'][number] {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', id: block.id, text: block.text };
    case 'tool':
      return { kind: 'tool', id: block.id, toolCallId: block.toolCallId };
    case 'notice':
      return { kind: 'notice', id: block.id, text: block.text };
  }

  const exhaustive: never = block;
  return exhaustive;
}

function cloneMsg(message: Msg): Msg {
  const cloned: Msg = {
    id: message.id,
    role: message.role,
    blocks: message.blocks.map(cloneBlock),
    done: message.done,
  };

  if (message.reasoning !== undefined) {
    cloned.reasoning = message.reasoning;
  }
  if (message.toolSnapshot !== undefined) {
    cloned.toolSnapshot = { ...message.toolSnapshot };
  }

  return cloned;
}

function cloneMessages(messages: ReadonlyArray<Msg>): Msg[] {
  return messages.map(cloneMsg);
}

function sessionFilePath(dir: string, id: string): string {
  return path.join(dir, `${encodeURIComponent(id)}.json`);
}

function transcriptFilePath(dir: string, id: string): string {
  return path.join(dir, `${encodeURIComponent(id)}.jsonl`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return undefined;
  }
}

async function readSessionFile(filePath: string): Promise<SessionFile | undefined> {
  const parsed = await readJsonFile(filePath);
  return isSessionFile(parsed) ? parsed : undefined;
}

async function writeSessionFile(dir: string, id: string, session: SessionFile): Promise<void> {
  await ensureDir(dir);
  await writeFile(sessionFilePath(dir, id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

function compareMeta(left: SessionMeta, right: SessionMeta): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

export function createSessionStore(opts?: { dir?: string }): SessionStore {
  const dir = opts?.dir ?? DEFAULT_SESSION_DIR;

  return {
    async create(meta: SessionMeta): Promise<void> {
      await writeSessionFile(dir, meta.id, { meta: cloneMeta(meta), messages: [] });
    },
    async list(): Promise<ReadonlyArray<SessionMeta>> {
      await ensureDir(dir);
      const names = await readdir(dir);
      const metas: SessionMeta[] = [];

      for (const name of names) {
        if (!name.endsWith('.json')) {
          continue;
        }

        const session = await readSessionFile(path.join(dir, name));
        if (session !== undefined) {
          metas.push(cloneMeta(session.meta));
        }
      }

      return metas.sort(compareMeta);
    },
    async load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined> {
      const session = await readSessionFile(sessionFilePath(dir, id));
      if (session === undefined) {
        return undefined;
      }

      return {
        meta: cloneMeta(session.meta),
        messages: cloneMessages(session.messages),
      };
    },
    async save(id: string, messages: ReadonlyArray<Msg>): Promise<void> {
      const existing = await readSessionFile(sessionFilePath(dir, id));
      await writeSessionFile(dir, id, {
        meta: existing === undefined ? { id, createdAt: '' } : cloneMeta(existing.meta),
        messages: cloneMessages(messages),
      });
    },
    async delete(id: string): Promise<void> {
      await rm(sessionFilePath(dir, id), { force: true });
    },
  };
}

export function createTranscriptLog(opts?: { dir?: string }): TranscriptLog {
  const dir = opts?.dir ?? DEFAULT_SESSION_DIR;

  return {
    async append(sessionId: string, message: Msg): Promise<void> {
      await ensureDir(dir);
      await appendFile(transcriptFilePath(dir, sessionId), `${JSON.stringify(message)}\n`, 'utf8');
    },
    async read(sessionId: string): Promise<Msg[]> {
      let raw: string;
      try {
        raw = await readFile(transcriptFilePath(dir, sessionId), 'utf8');
      } catch {
        return [];
      }

      const messages: Msg[] = [];
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (isMsg(parsed)) {
            messages.push(cloneMsg(parsed));
          }
        } catch {
          continue;
        }
      }

      return messages;
    },
  };
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionFile>();

  return {
    async create(meta: SessionMeta): Promise<void> {
      sessions.set(meta.id, { meta: cloneMeta(meta), messages: [] });
    },
    async list(): Promise<ReadonlyArray<SessionMeta>> {
      return [...sessions.values()].map((session) => cloneMeta(session.meta)).sort(compareMeta);
    },
    async load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined> {
      const session = sessions.get(id);
      if (session === undefined) {
        return undefined;
      }

      return {
        meta: cloneMeta(session.meta),
        messages: cloneMessages(session.messages),
      };
    },
    async save(id: string, messages: ReadonlyArray<Msg>): Promise<void> {
      const existing = sessions.get(id);
      sessions.set(id, {
        meta: existing === undefined ? { id, createdAt: '' } : cloneMeta(existing.meta),
        messages: cloneMessages(messages),
      });
    },
    async delete(id: string): Promise<void> {
      sessions.delete(id);
    },
  };
}

export function createMemoryTranscriptLog(): TranscriptLog {
  const transcripts = new Map<string, Msg[]>();

  return {
    async append(sessionId: string, message: Msg): Promise<void> {
      const messages = transcripts.get(sessionId) ?? [];
      messages.push(cloneMsg(message));
      transcripts.set(sessionId, messages);
    },
    async read(sessionId: string): Promise<Msg[]> {
      return cloneMessages(transcripts.get(sessionId) ?? []);
    },
  };
}
