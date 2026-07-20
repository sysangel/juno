import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Block, Msg, ToolState } from '../core/reducer';
import { parseDelegationReceipt } from '../core/delegationEvidence';
import { atomicWriteFile } from './atomicWrite';
import { createKeyedQueue } from './keyedQueue';

/**
 * On-disk persisted-format version stamped into every session `.json` meta on
 * write. ADVISORY / telemetry only — the reader surfaces whatever version a file
 * carries but NEVER hard-gates `load()` on it (a legacy file with no version and
 * a file from a higher, unknown version both still load). Block-level
 * forward-compatibility is delivered by preserve-unknown (`parseBlock`), not by
 * this number. Bump only when a change needs an out-of-band migration hook. The
 * JSONL transcript has no meta line to hold a version — it relies on
 * preserve-unknown alone.
 */
export const CURRENT_FORMAT_VERSION = 1;

export interface SessionMeta {
  id: string;
  createdAt: string; // ISO-8601; caller supplies the clock
  model?: string;
  cwd?: string;
  title?: string;
  /** Advisory on-disk format version; see CURRENT_FORMAT_VERSION. */
  formatVersion?: number;
}

export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<ReadonlyArray<SessionMeta>>;
  load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined>;
  /** Persist the full committed transcript for a session (overwrite). */
  save(id: string, messages: ReadonlyArray<Msg>): Promise<void>;
  delete(id: string): Promise<void>;
  /** Drain any queued writes (per-key serialized). Optional so lightweight fakes
   * need not implement it; the file-backed store wires it to its write queue. */
  drain?(): Promise<void>;
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

/**
 * Deterministic key for an unknown block that lacks a string `id`, so React has a
 * stable key across loads (identical raw content → identical key). Kept OUT of
 * `raw` — `raw` must stay byte-identical to the original file for a faithful
 * round-trip, so the synthesized id lives only on the in-memory Block.
 */
function synthesizeBlockId(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < json.length; i += 1) {
    hash = (Math.imul(hash, 31) + json.charCodeAt(i)) | 0;
  }
  return `unknown:${(hash >>> 0).toString(36)}`;
}

/**
 * Normalize one parsed value into a Block. A recognized kind with a valid shape
 * becomes its typed block; a non-empty string `kind` that is unrecognized (or a
 * known kind whose shape is wrong) is PRESERVED verbatim as an `unknown`
 * passthrough (forward-compat); only a truly malformed value — not a record, or
 * a record without a usable string `kind` — yields `undefined`.
 */
function parseBlock(value: unknown): Block | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = value.kind;

  if (kind === 'text' && typeof value.id === 'string' && typeof value.text === 'string') {
    return { kind: 'text', id: value.id, text: value.text };
  }
  if (kind === 'tool' && typeof value.id === 'string' && typeof value.toolCallId === 'string') {
    return { kind: 'tool', id: value.id, toolCallId: value.toolCallId };
  }
  if (kind === 'notice' && typeof value.id === 'string' && typeof value.text === 'string') {
    return { kind: 'notice', id: value.id, text: value.text };
  }

  if (typeof kind === 'string' && kind.length > 0) {
    const id = typeof value.id === 'string' ? value.id : synthesizeBlockId(value);
    // `raw` is the ORIGINAL parsed object, kept verbatim for a byte-identical
    // read→write round-trip. The synthesized id is NOT written into it.
    return { kind: 'unknown', id, raw: value };
  }

  return undefined;
}

/**
 * Validate a message's top-level shape (id/role/blocks/done as before) then map
 * its blocks through `parseBlock`. Rejects (→ undefined) ONLY when the top-level
 * shape is bad or a block is truly unparseable; unknown blocks are KEPT. Returns
 * a fresh, cloned Msg (safe to hand straight to callers).
 */
function parseMsg(value: unknown): Msg | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.id !== 'string' ||
    !isRole(value.role) ||
    !isUnknownArray(value.blocks) ||
    typeof value.done !== 'boolean'
  ) {
    return undefined;
  }

  if (value.reasoning !== undefined && typeof value.reasoning !== 'string') {
    return undefined;
  }
  if (value.toolSnapshot !== undefined && !isRecord(value.toolSnapshot)) {
    return undefined;
  }

  const blocks: Block[] = [];
  for (const rawBlock of value.blocks) {
    const block = parseBlock(rawBlock);
    if (block === undefined) {
      return undefined; // one truly-unparseable block rejects only THIS message
    }
    blocks.push(block);
  }

  const message: Msg = {
    id: value.id,
    role: value.role,
    blocks,
    done: value.done,
  };

  if (typeof value.reasoning === 'string') {
    message.reasoning = value.reasoning;
  }
  // reasoningStartedAt/reasoningEndedAt round-trip (previously dropped on load).
  if (typeof value.reasoningStartedAt === 'number') {
    message.reasoningStartedAt = value.reasoningStartedAt;
  }
  if (typeof value.reasoningEndedAt === 'number') {
    message.reasoningEndedAt = value.reasoningEndedAt;
  }
  if (isRecord(value.toolSnapshot)) {
    message.toolSnapshot = { ...value.toolSnapshot } as Record<string, ToolState>;
  }
  // `tone` discriminator (terminal-error visibility). Copied ONLY for the recognized
  // 'error' value — an unrecognized future tone is ignored, never rejected, so a
  // downgrade reading a higher version's file still loads the message (forward-compat,
  // same spirit as preserve-unknown for blocks).
  if (value.tone === 'error') {
    message.tone = 'error';
  }
  const delegationReceipt = parseDelegationReceipt(value.delegationReceipt);
  if (delegationReceipt !== undefined) {
    message.delegationReceipt = delegationReceipt;
  }

  return message;
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
  // Advisory only: accept any numeric version (or none). A higher-than-known
  // version must still load, so this NEVER gates the file out.
  if (value.formatVersion !== undefined && typeof value.formatVersion !== 'number') {
    return false;
  }

  return true;
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
  if (meta.formatVersion !== undefined) {
    cloned.formatVersion = meta.formatVersion;
  }

  return cloned;
}

function cloneBlock(block: Block): Block {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', id: block.id, text: block.text };
    case 'tool':
      return { kind: 'tool', id: block.id, toolCallId: block.toolCallId };
    case 'notice':
      return { kind: 'notice', id: block.id, text: block.text };
    case 'unknown':
      return {
        kind: 'unknown',
        id: block.id,
        raw: JSON.parse(JSON.stringify(block.raw)) as Record<string, unknown>,
      };
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
  if (message.reasoningStartedAt !== undefined) {
    cloned.reasoningStartedAt = message.reasoningStartedAt;
  }
  if (message.reasoningEndedAt !== undefined) {
    cloned.reasoningEndedAt = message.reasoningEndedAt;
  }
  if (message.toolSnapshot !== undefined) {
    cloned.toolSnapshot = { ...message.toolSnapshot };
  }
  if (message.tone !== undefined) {
    cloned.tone = message.tone;
  }
  if (message.delegationReceipt !== undefined) {
    cloned.delegationReceipt = parseDelegationReceipt(
      JSON.parse(JSON.stringify(message.delegationReceipt)) as unknown,
    );
  }

  return cloned;
}

/**
 * Wire form of a block. For `unknown` this UNWRAPS `raw` back out verbatim so the
 * written bytes equal the original file (JSON preserves insertion order, so
 * `JSON.stringify(raw)` reproduces the source). This is what makes preserve-
 * unknown survive the WRITE side (`save`/`append` re-serialize) — a read-only
 * change would round-trip losslessly only until the next save.
 */
function serializeBlock(block: Block): Record<string, unknown> {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', id: block.id, text: block.text };
    case 'tool':
      return { kind: 'tool', id: block.id, toolCallId: block.toolCallId };
    case 'notice':
      return { kind: 'notice', id: block.id, text: block.text };
    case 'unknown':
      return block.raw;
  }

  const exhaustive: never = block;
  return exhaustive;
}

function serializeMsg(message: Msg): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: message.id,
    role: message.role,
    blocks: message.blocks.map(serializeBlock),
    done: message.done,
  };

  if (message.reasoning !== undefined) {
    wire.reasoning = message.reasoning;
  }
  if (message.reasoningStartedAt !== undefined) {
    wire.reasoningStartedAt = message.reasoningStartedAt;
  }
  if (message.reasoningEndedAt !== undefined) {
    wire.reasoningEndedAt = message.reasoningEndedAt;
  }
  if (message.toolSnapshot !== undefined) {
    wire.toolSnapshot = message.toolSnapshot;
  }
  if (message.tone !== undefined) {
    wire.tone = message.tone;
  }
  if (message.delegationReceipt !== undefined) {
    wire.delegationReceipt = message.delegationReceipt;
  }

  return wire;
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

/**
 * Read a session `.json`, tolerating individual bad messages. The meta is gated
 * by `isSessionMeta` (a malformed meta makes the file unusable), but the message
 * list is parsed PER-MESSAGE: good and unknown-bearing messages are kept, only
 * truly-unparseable ones are dropped — so one new/bad message no longer nukes the
 * whole file (the old `isSessionFile` was all-or-nothing).
 */
async function readSessionFile(filePath: string): Promise<SessionFile | undefined> {
  const parsed = await readJsonFile(filePath);
  if (!isRecord(parsed) || !isSessionMeta(parsed.meta) || !isUnknownArray(parsed.messages)) {
    return undefined;
  }

  const messages: Msg[] = [];
  for (const rawMessage of parsed.messages) {
    const message = parseMsg(rawMessage);
    if (message !== undefined) {
      messages.push(message);
    }
  }

  return { meta: parsed.meta, messages };
}

async function writeSessionFile(dir: string, id: string, session: SessionFile): Promise<void> {
  await ensureDir(dir);
  // Stamp the advisory format version onto the wire meta (single choke point for
  // both create() and save()) and unwrap unknown blocks back to their raw form.
  const wire = {
    meta: { ...cloneMeta(session.meta), formatVersion: CURRENT_FORMAT_VERSION },
    messages: session.messages.map(serializeMsg),
  };
  // Atomic tmp+rename: a crash mid-write can never truncate the session file (the
  // tolerant reader would silently drop a torn file — see readSessionFile).
  await atomicWriteFile(sessionFilePath(dir, id), `${JSON.stringify(wire, null, 2)}\n`);
}

function compareMeta(left: SessionMeta, right: SessionMeta): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  return created === 0 ? left.id.localeCompare(right.id) : created;
}

export function createSessionStore(opts?: { dir?: string }): SessionStore {
  const dir = opts?.dir ?? DEFAULT_SESSION_DIR;
  // Per-session-id serialization: mutations to one session file run one-at-a-time
  // in enqueue order (so save's read-modify-write can't interleave with another
  // write to the SAME file), while different sessions stay concurrent. Reads
  // (load/list) stay UNQUEUED — atomic rename means a concurrent read sees the
  // whole old OR whole new file, never a torn one.
  const queue = createKeyedQueue();

  return {
    async create(meta: SessionMeta): Promise<void> {
      const cloned = cloneMeta(meta);
      return queue.run(meta.id, async () => {
        await writeSessionFile(dir, meta.id, { meta: cloned, messages: [] });
      });
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
      // Clone SYNCHRONOUSLY (before the enqueue defers the task) so the persisted
      // bytes reflect the transcript at save-CALL time, immune to later caller
      // mutation. The ENTIRE read-modify-write runs inside ONE queued task so the
      // existing-meta read and the write are atomic against a concurrent save.
      const snapshot = cloneMessages(messages);
      return queue.run(id, async () => {
        const existing = await readSessionFile(sessionFilePath(dir, id));
        await writeSessionFile(dir, id, {
          meta: existing === undefined ? { id, createdAt: '' } : cloneMeta(existing.meta),
          messages: snapshot,
        });
      });
    },
    async delete(id: string): Promise<void> {
      // Same chain as save so a delete can't interleave with an in-flight save's
      // read-modify-write.
      return queue.run(id, async () => {
        await rm(sessionFilePath(dir, id), { force: true });
      });
    },
    drain(): Promise<void> {
      return queue.drain();
    },
  };
}

export function createTranscriptLog(opts?: { dir?: string }): TranscriptLog {
  const dir = opts?.dir ?? DEFAULT_SESSION_DIR;

  return {
    async append(sessionId: string, message: Msg): Promise<void> {
      await ensureDir(dir);
      // Route through serializeMsg so an unknown block is written back as its raw
      // form (byte-identical round-trip), matching the SessionStore write path.
      await appendFile(
        transcriptFilePath(dir, sessionId),
        `${JSON.stringify(serializeMsg(message))}\n`,
        'utf8',
      );
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
          const message = parseMsg(parsed);
          if (message !== undefined) {
            messages.push(message);
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
    // No queue to drain; present for interface symmetry (mutations are synchronous).
    async drain(): Promise<void> {},
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
