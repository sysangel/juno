=== FILE: src/services/config.ts ===
```ts
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
}

export interface ConfigService {
  get(): Settings;
  getValue<K extends keyof Settings>(key: K): Settings[K];
  reload(): Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: 'openai',
  defaultModel: 'gpt-4.1',
  cwd: process.cwd(),
  maxContext: 1_047_576,
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'juno', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneProviders(providers: Settings['providers']): Settings['providers'] {
  if (providers === undefined) {
    return undefined;
  }

  const cloned: Record<string, { baseUrl?: string; apiKeyEnv?: string }> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const next: { baseUrl?: string; apiKeyEnv?: string } = {};
    if (provider.baseUrl !== undefined) {
      next.baseUrl = provider.baseUrl;
    }
    if (provider.apiKeyEnv !== undefined) {
      next.apiKeyEnv = provider.apiKeyEnv;
    }
    cloned[name] = next;
  }
  return cloned;
}

function parseProviders(value: unknown): Settings['providers'] {
  if (!isRecord(value)) {
    return undefined;
  }

  const providers: Record<string, { baseUrl?: string; apiKeyEnv?: string }> = {};
  for (const [name, rawProvider] of Object.entries(value)) {
    if (!isRecord(rawProvider)) {
      continue;
    }

    const provider: { baseUrl?: string; apiKeyEnv?: string } = {};
    if (typeof rawProvider.baseUrl === 'string') {
      provider.baseUrl = rawProvider.baseUrl;
    }
    if (typeof rawProvider.apiKeyEnv === 'string') {
      provider.apiKeyEnv = rawProvider.apiKeyEnv;
    }
    providers[name] = provider;
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function parseSettings(value: unknown): Partial<Settings> {
  if (!isRecord(value)) {
    return {};
  }

  const settings: Partial<Settings> = {};

  if (typeof value.defaultProvider === 'string') {
    settings.defaultProvider = value.defaultProvider;
  }
  if (typeof value.defaultModel === 'string') {
    settings.defaultModel = value.defaultModel;
  }
  if (typeof value.cwd === 'string') {
    settings.cwd = value.cwd;
  }
  if (
    typeof value.maxContext === 'number' &&
    Number.isSafeInteger(value.maxContext) &&
    value.maxContext > 0
  ) {
    settings.maxContext = value.maxContext;
  }

  const providers = parseProviders(value.providers);
  if (providers !== undefined) {
    settings.providers = providers;
  }

  return settings;
}

function mergeProviders(
  base: Settings['providers'],
  overlay: Settings['providers'],
): Settings['providers'] {
  const merged = cloneProviders(base) ?? {};

  if (overlay !== undefined) {
    for (const [name, provider] of Object.entries(overlay)) {
      merged[name] = {
        ...(merged[name] ?? {}),
        ...provider,
      };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeSettings(base: Settings, overlay: Partial<Settings>): Settings {
  const settings: Settings = {
    defaultProvider: overlay.defaultProvider ?? base.defaultProvider,
    defaultModel: overlay.defaultModel ?? base.defaultModel,
    cwd: overlay.cwd ?? base.cwd,
  };

  const maxContext = overlay.maxContext ?? base.maxContext;
  if (maxContext !== undefined) {
    settings.maxContext = maxContext;
  }

  const providers = mergeProviders(base.providers, overlay.providers);
  if (providers !== undefined) {
    settings.providers = providers;
  }

  return settings;
}

function readConfigFile(configPath: string): Partial<Settings> {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parseSettings(parsed);
  } catch {
    return {};
  }
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function applyEnvOverrides(settings: Settings, env: NodeJS.ProcessEnv): Settings {
  const overlay: Partial<Settings> = {};

  const provider = envString(env, 'JUNO_PROVIDER');
  if (provider !== undefined) {
    overlay.defaultProvider = provider;
  }

  const model = envString(env, 'JUNO_MODEL');
  if (model !== undefined) {
    overlay.defaultModel = model;
  }

  const cwd = envString(env, 'JUNO_CWD');
  if (cwd !== undefined) {
    overlay.cwd = cwd;
  }

  const rawMaxContext = envString(env, 'JUNO_MAX_CONTEXT');
  if (rawMaxContext !== undefined) {
    const maxContext = Number.parseInt(rawMaxContext, 10);
    if (Number.isSafeInteger(maxContext) && maxContext > 0) {
      overlay.maxContext = maxContext;
    }
  }

  return mergeSettings(settings, overlay);
}

export function createConfigService(opts?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): ConfigService {
  const configPath = opts?.configPath ?? DEFAULT_CONFIG_PATH;
  const env = opts?.env ?? process.env;
  let cached: Settings | undefined;

  const read = (): Settings => {
    const withFile = mergeSettings(DEFAULT_SETTINGS, readConfigFile(configPath));
    return applyEnvOverrides(withFile, env);
  };

  const getCached = (): Settings => {
    cached ??= read();
    return cached;
  };

  return {
    get(): Settings {
      return getCached();
    },
    getValue<K extends keyof Settings>(key: K): Settings[K] {
      return getCached()[key];
    },
    reload(): Settings {
      cached = read();
      return cached;
    },
  };
}

export function createFakeConfigService(settings: Settings): ConfigService {
  return {
    get(): Settings {
      return settings;
    },
    getValue<K extends keyof Settings>(key: K): Settings[K] {
      return settings[key];
    },
    reload(): Settings {
      return settings;
    },
  };
}
```

=== FILE: src/services/catalog.ts ===
```ts
export interface ModelEntry {
  id: string;
  provider: string;
  label: string;
  contextWindow: number;
  aliases?: string[];
  default?: boolean;
}

export interface ModelCatalog {
  list(): ReadonlyArray<ModelEntry>;
  resolve(idOrAlias: string): ModelEntry | undefined;
  byProvider(provider: string): ReadonlyArray<ModelEntry>;
  default(): ModelEntry | undefined;
}

export const BUILTIN_MODELS: ReadonlyArray<ModelEntry> = [
  {
    id: 'gpt-4.1',
    provider: 'openai',
    label: 'GPT-4.1',
    contextWindow: 1_047_576,
    aliases: ['gpt4.1', 'gpt-4'],
    default: true,
  },
  {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    label: 'GPT-4.1 Mini',
    contextWindow: 1_047_576,
    aliases: ['mini', 'gpt4.1-mini'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    label: 'Claude Sonnet 4',
    contextWindow: 200_000,
    aliases: ['claude-sonnet-4', 'sonnet'],
  },
  {
    id: 'openai/gpt-4.1',
    provider: 'openrouter',
    label: 'GPT-4.1 via OpenRouter',
    contextWindow: 1_047_576,
    aliases: ['openrouter-gpt-4.1'],
  },
  {
    id: 'anthropic/claude-sonnet-4',
    provider: 'openrouter',
    label: 'Claude Sonnet 4 via OpenRouter',
    contextWindow: 200_000,
    aliases: ['openrouter-sonnet'],
  },
];

function cloneEntry(entry: ModelEntry): ModelEntry {
  const cloned: ModelEntry = {
    id: entry.id,
    provider: entry.provider,
    label: entry.label,
    contextWindow: entry.contextWindow,
  };

  if (entry.aliases !== undefined) {
    cloned.aliases = [...entry.aliases];
  }
  if (entry.default !== undefined) {
    cloned.default = entry.default;
  }

  return cloned;
}

export function createModelCatalog(entries?: ReadonlyArray<ModelEntry>): ModelCatalog {
  const models = (entries ?? BUILTIN_MODELS).map(cloneEntry);

  return {
    list(): ReadonlyArray<ModelEntry> {
      return models.map(cloneEntry);
    },
    resolve(idOrAlias: string): ModelEntry | undefined {
      const byId = models.find((entry) => entry.id === idOrAlias);
      if (byId !== undefined) {
        return cloneEntry(byId);
      }

      const byAlias = models.find((entry) => entry.aliases?.includes(idOrAlias) === true);
      return byAlias === undefined ? undefined : cloneEntry(byAlias);
    },
    byProvider(provider: string): ReadonlyArray<ModelEntry> {
      return models.filter((entry) => entry.provider === provider).map(cloneEntry);
    },
    default(): ModelEntry | undefined {
      const entry = models.find((model) => model.default === true) ?? models[0];
      return entry === undefined ? undefined : cloneEntry(entry);
    },
  };
}
```

=== FILE: src/services/sessions.ts ===
```ts
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Msg } from '../core/reducer';

export interface SessionMeta {
  id: string;
  createdAt: string;
  model?: string;
  cwd?: string;
  title?: string;
}

export interface SessionStore {
  create(meta: SessionMeta): Promise<void>;
  list(): Promise<ReadonlyArray<SessionMeta>>;
  load(id: string): Promise<{ meta: SessionMeta; messages: Msg[] } | undefined>;
  save(id: string, messages: ReadonlyArray<Msg>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TranscriptLog {
  append(sessionId: string, message: Msg): Promise<void>;
  read(sessionId: string): Promise<Msg[]>;
}

interface SessionFile {
  meta: SessionMeta;
  messages: Msg[];
}

const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.config', 'juno', 'sessions');

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
```

=== FILE: src/services/memory.ts ===
```ts
import { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface MemoryEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | undefined>;
  set(key: string, value: string, updatedAt: string): Promise<void>;
  list(): Promise<ReadonlyArray<MemoryEntry>>;
  delete(key: string): Promise<void>;
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

function evictToLimit(entries: Map<string, MemoryEntry>, maxBytes: number): void {
  while (totalBytes(entries.values()) > maxBytes && entries.size > 0) {
    const oldest = sortedEntries(entries.values())[0];
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest.key);
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
```

=== FILE: tests/services.test.ts ===
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Msg } from '../src/core/reducer';
import {
  DEFAULT_SETTINGS,
  createConfigService,
  createFakeConfigService,
  type Settings,
} from '../src/services/config';
import { createModelCatalog } from '../src/services/catalog';
import {
  createMemorySessionStore,
  createMemoryTranscriptLog,
  type SessionMeta,
} from '../src/services/sessions';
import { createInMemoryMemoryStore } from '../src/services/memory';

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `juno-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config services', () => {
  it('returns fake settings and typed values', () => {
    const settings: Settings = {
      defaultProvider: 'test-provider',
      defaultModel: 'test-model',
      cwd: '/tmp/project',
      maxContext: 42,
    };

    const service = createFakeConfigService(settings);
    const model: string = service.getValue('defaultModel');

    expect(service.get()).toBe(settings);
    expect(model).toBe('test-model');
  });

  it('uses defaults when the config file is missing', async () => {
    const dir = await makeTempDir('config');
    const service = createConfigService({
      configPath: path.join(dir, 'missing.json'),
      env: {},
    });

    expect(service.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('model catalog', () => {
  it('lists, resolves, filters, and returns the default model', () => {
    const catalog = createModelCatalog();
    const models = catalog.list();

    expect(models.length).toBeGreaterThan(0);

    const first = models[0];
    if (first === undefined) {
      throw new Error('expected a builtin model');
    }

    expect(catalog.resolve(first.id)).toEqual(first);

    const withAlias = models.find((model) => model.aliases !== undefined && model.aliases.length > 0);
    if (withAlias === undefined || withAlias.aliases === undefined || withAlias.aliases[0] === undefined) {
      throw new Error('expected a builtin model alias');
    }

    expect(catalog.resolve(withAlias.aliases[0])).toEqual(withAlias);

    const byProvider = catalog.byProvider(first.provider);
    expect(byProvider.length).toBeGreaterThan(0);
    expect(byProvider.every((model) => model.provider === first.provider)).toBe(true);

    const defaultEntry = models.find((model) => model.default === true);
    expect(catalog.default()).toEqual(defaultEntry);
  });
});

describe('session services', () => {
  it('round-trips sessions and transcripts in memory', async () => {
    const store = createMemorySessionStore();
    const transcript = createMemoryTranscriptLog();

    expect(await store.load('missing')).toBeUndefined();
    expect(await transcript.read('missing')).toEqual([]);

    const meta: SessionMeta = {
      id: 'session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'gpt-4.1',
      cwd: '/tmp/project',
      title: 'Test session',
    };

    const firstMessage: Msg = {
      id: 'msg-1',
      role: 'user',
      blocks: [{ kind: 'text', id: 'block-1', text: 'hello' }],
      done: true,
      reasoning: 'kept',
      toolSnapshot: { sample: { status: 'done' } },
    };

    const secondMessage: Msg = {
      id: 'msg-2',
      role: 'assistant',
      blocks: [{ kind: 'text', id: 'block-2', text: 'hi' }],
      done: true,
    };

    await store.create(meta);
    expect(await store.list()).toEqual([meta]);

    await store.save(meta.id, [firstMessage]);
    const loaded = await store.load(meta.id);

    expect(loaded).toBeDefined();
    expect(loaded?.meta).toEqual(meta);
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.blocks[0]).toEqual(firstMessage.blocks[0]);
    expect(loaded?.messages[0]?.toolSnapshot).toEqual(firstMessage.toolSnapshot);

    await transcript.append(meta.id, firstMessage);
    await transcript.append(meta.id, secondMessage);

    expect((await transcript.read(meta.id)).map((message) => message.id)).toEqual(['msg-1', 'msg-2']);
  });
});

describe('memory services', () => {
  it('round-trips memory entries in memory', async () => {
    const store = createInMemoryMemoryStore({ maxBytes: 100 });

    await store.set('alpha', 'one', '2026-01-01T00:00:00.000Z');

    expect(await store.get('alpha')).toEqual({
      key: 'alpha',
      value: 'one',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await store.list()).toEqual([
      {
        key: 'alpha',
        value: 'one',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('evicts the oldest entry by updatedAt when over the byte limit', async () => {
    const store = createInMemoryMemoryStore({ maxBytes: 5 });

    await store.set('old', 'aa', '2026-01-01T00:00:00.000Z');
    await store.set('middle', 'bb', '2026-01-02T00:00:00.000Z');
    await store.set('new', 'ccc', '2026-01-03T00:00:00.000Z');

    expect(await store.get('old')).toBeUndefined();
    expect(await store.get('middle')).toEqual({
      key: 'middle',
      value: 'bb',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(await store.get('new')).toEqual({
      key: 'new',
      value: 'ccc',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(await store.size()).toBe(5);
    expect(await store.size()).toBeLessThan(7);
  });
});
```

=== NOTES ===
The services are factory-created only, with no shared mutable singleton state. File-backed readers defensively narrow parsed JSON and degrade missing or corrupt files to defaults, `undefined`, or empty collections. Config uses sync reads because its pinned seam is synchronous; sessions and memory stay Promise-based, including in-memory implementations.