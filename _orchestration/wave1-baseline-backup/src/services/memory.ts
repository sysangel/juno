import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string; // ISO-8601; caller supplies the clock
}

export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | undefined>;
  set(key: string, value: string, updatedAt: string): Promise<void>;
  list(): Promise<ReadonlyArray<MemoryEntry>>;
  delete(key: string): Promise<void>;
  /** Total bytes of stored values; enforced against `maxBytes`. */
  size(): Promise<number>;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MEMORY_DIR = path.join(os.homedir(), '.config', 'juno', 'memory');
const MEMORY_FILE = 'memory.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.value === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return {
    key: entry.key,
    value: entry.value,
    updatedAt: entry.updatedAt,
  };
}

function resolveMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return DEFAULT_MAX_BYTES;
  }

  return Math.floor(maxBytes);
}

function entryBytes(entry: MemoryEntry): number {
  return Buffer.byteLength(entry.value, 'utf8');
}

function totalBytes(entries: Iterable<MemoryEntry>): number {
  let total = 0;
  for (const entry of entries) {
    total += entryBytes(entry);
  }
  return total;
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  const updated = left.updatedAt.localeCompare(right.updatedAt);
  return updated === 0 ? left.key.localeCompare(right.key) : updated;
}

function sortedEntries(entries: Iterable<MemoryEntry>): MemoryEntry[] {
  return [...entries].sort(compareEntries);
}

/** FIFO trim: evict oldest-by-updatedAt until stored value bytes fit maxBytes. */
function evictToLimit(entries: Map<string, MemoryEntry>, maxBytes: number): void {
  if (totalBytes(entries.values()) <= maxBytes) {
    return;
  }
  // Sort once oldest-first, then drop from the front until it fits.
  const ordered = sortedEntries(entries.values());
  let total = totalBytes(entries.values());
  for (const oldest of ordered) {
    if (total <= maxBytes) {
      break;
    }
    entries.delete(oldest.key);
    total -= entryBytes(oldest);
  }
}

function entriesFromUnknown(value: unknown): MemoryEntry[] {
  const rawEntries = isRecord(value) ? value.entries : value;
  if (!isUnknownArray(rawEntries)) {
    return [];
  }

  const entries: MemoryEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (isMemoryEntry(rawEntry)) {
      entries.push(cloneEntry(rawEntry));
    }
  }
  return entries;
}

function toMap(entries: Iterable<MemoryEntry>): Map<string, MemoryEntry> {
  const map = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    map.set(entry.key, cloneEntry(entry));
  }
  return map;
}

function memoryFilePath(dir: string): string {
  return path.join(dir, MEMORY_FILE);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readEntries(filePath: string): Promise<Map<string, MemoryEntry>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return toMap(entriesFromUnknown(parsed));
  } catch {
    return new Map<string, MemoryEntry>();
  }
}

async function writeEntries(dir: string, entries: Map<string, MemoryEntry>): Promise<void> {
  await ensureDir(dir);
  await writeFile(
    memoryFilePath(dir),
    `${JSON.stringify({ entries: sortedEntries(entries.values()) }, null, 2)}\n`,
    'utf8',
  );
}

/** File-backed, BOUNDED: writes exceeding `maxBytes` (default 64 KiB) evict
 * oldest-by-`updatedAt` (FIFO) until they fit. */
export function createMemoryStore(opts?: { dir?: string; maxBytes?: number }): MemoryStore {
  const dir = opts?.dir ?? DEFAULT_MEMORY_DIR;
  const maxBytes = resolveMaxBytes(opts?.maxBytes);
  const filePath = memoryFilePath(dir);

  return {
    async get(key: string): Promise<MemoryEntry | undefined> {
      const entries = await readEntries(filePath);
      const entry = entries.get(key);
      return entry === undefined ? undefined : cloneEntry(entry);
    },
    async set(key: string, value: string, updatedAt: string): Promise<void> {
      const entries = await readEntries(filePath);
      entries.set(key, { key, value, updatedAt });
      evictToLimit(entries, maxBytes);
      await writeEntries(dir, entries);
    },
    async list(): Promise<ReadonlyArray<MemoryEntry>> {
      const entries = await readEntries(filePath);
      return sortedEntries(entries.values()).map(cloneEntry);
    },
    async delete(key: string): Promise<void> {
      const entries = await readEntries(filePath);
      if (entries.delete(key)) {
        await writeEntries(dir, entries);
      }
    },
    async size(): Promise<number> {
      const entries = await readEntries(filePath);
      return totalBytes(entries.values());
    },
  };
}

/** In-memory, deterministic, honours the same byte bound (tests/fakes). */
export function createInMemoryMemoryStore(opts?: { maxBytes?: number }): MemoryStore {
  const maxBytes = resolveMaxBytes(opts?.maxBytes);
  const entries = new Map<string, MemoryEntry>();

  return {
    async get(key: string): Promise<MemoryEntry | undefined> {
      const entry = entries.get(key);
      return entry === undefined ? undefined : cloneEntry(entry);
    },
    async set(key: string, value: string, updatedAt: string): Promise<void> {
      entries.set(key, { key, value, updatedAt });
      evictToLimit(entries, maxBytes);
    },
    async list(): Promise<ReadonlyArray<MemoryEntry>> {
      return sortedEntries(entries.values()).map(cloneEntry);
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
    async size(): Promise<number> {
      return totalBytes(entries.values());
    },
  };
}
