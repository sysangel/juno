import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Read-only personal-memory ("brain") integration. When `enabled`, juno runs the
 * user's `brain-session-start` SessionStart hook once at startup and appends its
 * unwrapped `additionalContext` to the system prompt as background reference.
 * All fields fail open — a missing binary/timeout/malformed output is silently
 * ignored. Default: disabled (zero behavior change).
 */
export interface BrainSettings {
  /** Master opt-in. Default false. */
  enabled: boolean;
  /** Ambient per-prompt memory recall (Phase 2): on each user prompt, run the
   * brain's fast FTS-only UserPromptSubmit hook (`hookCommand`) and append any
   * matched-memory block to that turn's outgoing user message. Only meaningful
   * when `enabled` is true. Default true (on whenever the brain is on). */
  ambientRecall: boolean;
  /** argv for the hook, spawned WITHOUT a shell. Default: `uv run … brain-session-start`. */
  command: string[];
  /** argv for the per-prompt UserPromptSubmit hook (powers `ambientRecall`),
   * spawned WITHOUT a shell. Default: `uv run … brain-hook`. */
  hookCommand: string[];
  /** argv for the durable-memory WRITE CLI, spawned WITHOUT a shell (powers the
   * `brain_remember` tool). Default: `uv run … brain-remember`. */
  rememberCommand: string[];
  /** argv for the read-only RECALL CLI, spawned WITHOUT a shell (powers the
   * `brain_recall` + `brain_get` tools). Default: `uv run … brain-recall`. */
  recallCommand: string[];
  /** argv for the read-only MCP SERVER (recall + get_episode only), spawned WITHOUT
   * a shell. When `enabled`, juno wires this as an mcpServer keyed `brain` with a
   * WHOLESALE `risk:'safe'` (see brainReadonlyMcpServer) — read-only by construction —
   * so every tool it exposes auto-allows and the server clears the codex passthrough's
   * gate (including its late-added-tool posture check), which the FULL server (with its
   * `remember` write, risky default) never can. Default: `uv run … brain-server-readonly`. */
  serverCommand: string[];
  /** Hard timeout (ms) for the hook; the child is killed on expiry. Default 10_000. */
  timeoutMs: number;
}

/**
 * One configured MCP (Model Context Protocol) stdio server. `command` is the argv
 * spawned WITHOUT a shell (argv[0] is the binary); `env`/`cwd` shape the child
 * process. `timeoutMs` bounds a single connect/tool-call; `risk` is the RiskLevel
 * ('safe' | 'risky' | 'dangerous') applied to every tool this server exposes.
 * All fields but `command` are optional — the consumer supplies defaults.
 */
export interface McpServerConfig {
  /** argv for the server, spawned WITHOUT a shell. Required and non-empty. */
  command: string[];
  /** Extra env for the child (string→string). Optional. */
  env?: Record<string, string>;
  /** Child cwd. Optional (consumer falls back to the workspace root). */
  cwd?: string;
  /** Per connect / per tool-call timeout (ms). Optional (consumer default). */
  timeoutMs?: number;
  /** RiskLevel for this server's tools. Optional (consumer default). */
  risk?: 'safe' | 'risky' | 'dangerous';
  /**
   * Per-tool RiskLevel classification, keyed by the server's OWN (un-namespaced)
   * tool name. This is the general risk-classification hook for MCP tools: an
   * entry here supersedes the server-wide `risk` for that single tool, letting a
   * server's read tools be marked 'safe' (auto-allowed) while its write tools
   * stay 'risky' (prompt-gated) — e.g. the brain server marks `recall` +
   * `get_episode` safe but leaves `remember` risky. A tool with no entry falls
   * back to `risk`, then the consumer default. Optional. Invalid values dropped.
   */
  toolRisk?: Record<string, 'safe' | 'risky' | 'dangerous'>;
}

export interface Settings {
  defaultProvider: string;
  defaultModel: string;
  cwd: string;
  maxContext?: number;
  /** Read-only personal-memory integration (see BrainSettings). Default: disabled. */
  brain?: BrainSettings;
  /** Configured MCP stdio servers, keyed by a stable server id (see McpServerConfig).
   * Malformed entries — or entries without a runnable `command` — are dropped at
   * parse time. Absent when none are configured (additive default). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Arbitrary provider creds/base-urls keyed by provider id. `apiKeyEnv` names
   * an ENV VAR; its value is read by W9 at call time, never read/stored here. */
  providers?: Record<string, { baseUrl?: string; apiKeyEnv?: string }>;
  /**
   * Explicit UI theme override, consumed by `detectBackground()` to pick the
   * dark/light palette. When set it wins over the COLORFGBG terminal heuristic;
   * the `JUNO_THEME` env var still wins over this (env beats file). Absent ⇒
   * auto-detect (COLORFGBG, else dark).
   */
  theme?: 'dark' | 'light';
  /** Permission mode. 'acceptEdits' auto-allows the edit tools only. Default: 'default'. */
  permissionMode?: 'default' | 'acceptEdits';
  /** Config-driven seeded permission patterns. Deny wins over allow. */
  permissions?: { allow: string[]; deny: string[] };
  /**
   * Context-Compression trigger: compact once estimated re-sent transcript pressure
   * reaches this fraction of `maxContext`. Range (0, 1]. Optional — the consumer
   * defaults to 0.5 (`DEFAULT_COMPACTION_THRESHOLD`) when absent. Env: `JUNO_COMPACTION_THRESHOLD`.
   */
  compactionThreshold?: number;
  /**
   * Estimated-token budget for the verbatim tail kept after a compaction. Optional —
   * the consumer defaults to ~25% of `maxContext` when absent.
   */
  compactionKeepBudget?: number;
  /**
   * Per-turn tool-call ceiling for the raw-API re-entry loop; a runaway guard. When the
   * tool-call count in a single user submission reaches this limit the turnRunner stops
   * with a terminal `error` instead of re-entering the model again. Absent => unbounded.
   * On the claude-cli backend this is inert by construction (that backend never re-loops
   * on `tool_use`). Env: `JUNO_MAX_TOOL_CALLS`.
   */
  maxToolCalls?: number;
  /**
   * Per-execution wall-clock timeout (ms) for a single tool run. A wedged tool
   * would otherwise wedge the whole turn; on expiry the executor aborts the
   * tool's signal and resolves a terminal error so the turn continues. Optional —
   * the executor defaults to `DEFAULT_TOOL_TIMEOUT_MS` (120_000) when absent.
   * Env: `JUNO_TOOL_TIMEOUT_MS`.
   */
  toolTimeoutMs?: number;
  /**
   * Ring the terminal bell (BEL) once when a turn completes, as a cue for a user
   * whose focus is in another window. Default: off. Env: `JUNO_COMPLETION_BELL`.
   */
  completionBell?: boolean;
}

export interface ConfigService {
  /** Full resolved settings (defaults <- file <- env), cached after first load. */
  get(): Settings;
  /** One key, typed. */
  getValue<K extends keyof Settings>(key: K): Settings[K];
  /** Reload from disk; refreshes the cache and returns the new settings. */
  reload(): Settings;
}

/** Default brain integration: disabled, hook run via `uv` against ~/src/brain. */
export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  enabled: false,
  ambientRecall: true,
  command: ['uv', 'run', '--directory', path.join(os.homedir(), 'src', 'brain'), 'brain-session-start'],
  hookCommand: ['uv', 'run', '--directory', path.join(os.homedir(), 'src', 'brain'), 'brain-hook'],
  rememberCommand: ['uv', 'run', '--directory', path.join(os.homedir(), 'src', 'brain'), 'brain-remember'],
  recallCommand: ['uv', 'run', '--directory', path.join(os.homedir(), 'src', 'brain'), 'brain-recall'],
  serverCommand: ['uv', 'run', '--directory', path.join(os.homedir(), 'src', 'brain'), 'brain-server-readonly'],
  timeoutMs: 10_000,
};

/** The stable mcpServers id under which the brain read-only server is wired. A
 * user-configured `mcpServers.brain` entry wins over the injected default (see
 * withBrainReadonlyMcpServer), so this never clobbers an explicit choice. */
export const BRAIN_MCP_SERVER_ID = 'brain';

/**
 * The brain read-only MCP server as an `McpServerConfig`: `serverCommand` plus a
 * WHOLESALE `risk:'safe'`. The server is read-only BY CONSTRUCTION — it exposes only
 * `recall` + `get_episode`, and every tool it will ever expose is a read — so trusting
 * the server wide is the correct posture. Server-wide `risk:'safe'` (not a per-tool
 * `toolRisk`) is also what the codex passthrough's late-added-tool gate REQUIRES: codex
 * opens its own live connection and can call tools not in juno's per-turn snapshot, so a
 * server made safe only via per-tool overrides atop a risky default is denied (a
 * later-added tool would ride ungated). `risk:'safe'` covers future tools; the full brain
 * server (risky default + a `remember` write) can never qualify. `timeoutMs` carries the
 * brain timeout so a dead server spawn is bounded like the other brain integrations.
 */
export function brainReadonlyMcpServer(brain: BrainSettings): McpServerConfig {
  return {
    command: [...brain.serverCommand],
    risk: 'safe',
    timeoutMs: brain.timeoutMs,
  };
}

/**
 * Fold the brain read-only server into an mcpServers map under `BRAIN_MCP_SERVER_ID`.
 * A user-configured entry at that id WINS (returned untouched) — explicit config is
 * never clobbered. Returns a NEW map (never mutates the input); the input may be
 * undefined (no servers configured yet). Callers gate this on `brain.enabled`.
 */
export function withBrainReadonlyMcpServer(
  servers: Record<string, McpServerConfig> | undefined,
  brain: BrainSettings,
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = { ...(servers ?? {}) };
  if (merged[BRAIN_MCP_SERVER_ID] === undefined) {
    merged[BRAIN_MCP_SERVER_ID] = brainReadonlyMcpServer(brain);
  }
  return merged;
}

export const DEFAULT_SETTINGS: Settings = {
  // The default backend is the claude-cli subscription client on Fable 5. It needs
  // no apiKeyEnv (drives `claude -p` via the logged-in OAuth session). The
  // raw-API providers below remain available for the selectable secondaries.
  // Keep this id in sync with the catalog's default:true entry (exactly one).
  defaultProvider: 'claude-cli',
  defaultModel: 'claude-fable-5',
  cwd: process.cwd(),
  maxContext: 1_000_000,
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
  },
  permissionMode: 'default',
  permissions: { allow: [], deny: [] },
  brain: DEFAULT_BRAIN_SETTINGS,
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'juno', 'config.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Enum-whitelist guard. Returns the value only if it is a known permission mode,
 * else undefined. Shared by the config-file parse path and the env-override path
 * (the env helpers do not validate enums; an unguarded bad value would poison the
 * mode). */
function parsePermissionMode(value: unknown): Settings['permissionMode'] {
  return value === 'default' || value === 'acceptEdits' ? value : undefined;
}

/** Enum-whitelist guard for the theme override. Returns the value only if it is a
 * known background ('dark' | 'light'), else undefined (auto-detect stands). */
function parseTheme(value: unknown): Settings['theme'] {
  return value === 'dark' || value === 'light' ? value : undefined;
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

/** Deep-copy `permissions` so a merged Settings never shares the module-global
 * `DEFAULT_SETTINGS.permissions` arrays (mirrors `cloneProviders`). Without this,
 * a consumer that mutates `settings.permissions.allow` would poison the defaults
 * process-wide. */
function clonePermissions(permissions: Settings['permissions']): Settings['permissions'] {
  if (permissions === undefined) {
    return undefined;
  }
  return { allow: [...permissions.allow], deny: [...permissions.deny] };
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

/** Coerce an arbitrary value to a string-only array (filtering non-strings); a
 * missing or non-array value becomes `[]`. */
function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Parse `permissions` ONLY if it is a non-null, non-array object. Each list is
 * normalized to a string-only array; a missing/invalid list becomes `[]`. So
 * `permissions:{}` ⇒ `{allow:[],deny:[]}`. A non-object value ⇒ undefined (the
 * field is omitted and the base default is preserved by the merge). */
function parsePermissions(value: unknown): Settings['permissions'] {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    allow: parseStringList(value.allow),
    deny: parseStringList(value.deny),
  };
}

/** Accept a compaction threshold only if it is a finite number in (0, 1]; else undefined. */
function parseCompactionThreshold(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

/** Accept a keep-budget only if it is a positive safe integer; else undefined. */
function parseCompactionKeepBudget(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Deep-copy a BrainSettings so a merged Settings never shares the module-global
 * DEFAULT_BRAIN_SETTINGS.command array (mirrors cloneProviders/clonePermissions). */
function cloneBrain(brain: Settings['brain']): Settings['brain'] {
  if (brain === undefined) {
    return undefined;
  }
  return {
    enabled: brain.enabled,
    ambientRecall: brain.ambientRecall,
    command: [...brain.command],
    hookCommand: [...brain.hookCommand],
    rememberCommand: [...brain.rememberCommand],
    recallCommand: [...brain.recallCommand],
    serverCommand: [...brain.serverCommand],
    timeoutMs: brain.timeoutMs,
  };
}

/** Parse a `brain` block. Non-object ⇒ undefined (base default preserved). Any
 * present, well-typed field overrides the default; anything invalid is dropped,
 * so a partial block (e.g. `{"enabled":true}`) keeps the default command/timeout. */
function parseBrain(value: unknown): Settings['brain'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const brain: BrainSettings = {
    enabled: DEFAULT_BRAIN_SETTINGS.enabled,
    ambientRecall: DEFAULT_BRAIN_SETTINGS.ambientRecall,
    command: [...DEFAULT_BRAIN_SETTINGS.command],
    hookCommand: [...DEFAULT_BRAIN_SETTINGS.hookCommand],
    rememberCommand: [...DEFAULT_BRAIN_SETTINGS.rememberCommand],
    recallCommand: [...DEFAULT_BRAIN_SETTINGS.recallCommand],
    serverCommand: [...DEFAULT_BRAIN_SETTINGS.serverCommand],
    timeoutMs: DEFAULT_BRAIN_SETTINGS.timeoutMs,
  };
  if (typeof value.enabled === 'boolean') {
    brain.enabled = value.enabled;
  }
  if (typeof value.ambientRecall === 'boolean') {
    brain.ambientRecall = value.ambientRecall;
  }
  const command = parseStringList(value.command);
  if (command.length > 0) {
    brain.command = command;
  }
  const hookCommand = parseStringList(value.hookCommand);
  if (hookCommand.length > 0) {
    brain.hookCommand = hookCommand;
  }
  const rememberCommand = parseStringList(value.rememberCommand);
  if (rememberCommand.length > 0) {
    brain.rememberCommand = rememberCommand;
  }
  const recallCommand = parseStringList(value.recallCommand);
  if (recallCommand.length > 0) {
    brain.recallCommand = recallCommand;
  }
  const serverCommand = parseStringList(value.serverCommand);
  if (serverCommand.length > 0) {
    brain.serverCommand = serverCommand;
  }
  if (
    typeof value.timeoutMs === 'number' &&
    Number.isSafeInteger(value.timeoutMs) &&
    value.timeoutMs > 0
  ) {
    brain.timeoutMs = value.timeoutMs;
  }
  return brain;
}

/** Coerce a value to a string→string map, dropping any non-string value; a
 * missing or non-object value ⇒ undefined. Used for an MCP server's `env`. */
function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

/** A server id must round-trip cleanly through the `mcp__<server>__<tool>`
 * namespace AND the permission-pattern grammar. We keep the accepted id charset
 * conservative — ASCII letters, digits, `_`, `-` — and additionally reject the
 * `__` namespace separator: without this, server `a__b` collides with server `a`'s
 * tool `b__…` (both → `mcp__a__b__…`, one silently shadowing the other) and a
 * user allow-rule `mcp__a__*` would bleed onto server `a__b`'s tools. The charset
 * already excludes `*` and `:` (the pattern metacharacter and matchKey separator).
 * An id failing this is DROPPED, the same skip-the-bad-entry way a bad command is. */
function isValidMcpServerId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && !id.includes('__');
}

/** Enum-allowlist guard for a per-server risk level. Returns the value only if it
 * is a known RiskLevel ('safe' | 'risky' | 'dangerous'), else undefined. Mirrors
 * parsePermissionMode — an unguarded bad value would poison the tool's risk. */
function parseRisk(value: unknown): McpServerConfig['risk'] {
  return value === 'safe' || value === 'risky' || value === 'dangerous' ? value : undefined;
}

/** Coerce a value to a per-tool risk map, keeping only entries whose value is a
 * valid RiskLevel (via parseRisk); a non-object value ⇒ undefined, and an
 * all-dropped result ⇒ undefined (so the field stays absent, mirroring how an
 * all-empty mcpServers block resolves to undefined). */
function parseToolRisk(value: unknown): McpServerConfig['toolRisk'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, 'safe' | 'risky' | 'dangerous'> = {};
  for (const [tool, raw] of Object.entries(value)) {
    const risk = parseRisk(raw);
    if (risk !== undefined) {
      out[tool] = risk;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Deep-copy mcpServers so a merged Settings never shares the parsed command/env
 * containers (mirrors cloneProviders/cloneBrain). */
function cloneMcpServers(servers: Settings['mcpServers']): Settings['mcpServers'] {
  if (servers === undefined) {
    return undefined;
  }
  const cloned: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const next: McpServerConfig = { command: [...server.command] };
    if (server.env !== undefined) {
      next.env = { ...server.env };
    }
    if (server.cwd !== undefined) {
      next.cwd = server.cwd;
    }
    if (server.timeoutMs !== undefined) {
      next.timeoutMs = server.timeoutMs;
    }
    if (server.risk !== undefined) {
      next.risk = server.risk;
    }
    if (server.toolRisk !== undefined) {
      next.toolRisk = { ...server.toolRisk };
    }
    cloned[name] = next;
  }
  return cloned;
}

/** Parse an `mcpServers` block. Non-object ⇒ undefined (field omitted). Each entry
 * must be an object with a non-empty string-only `command`; an entry without a
 * runnable command is DROPPED (a server we cannot spawn is not a server), the same
 * skip-the-bad-entry way parseProviders drops a malformed provider. Optional fields
 * are each validated and only carried when well-typed. An all-empty result ⇒
 * undefined (so the field stays absent, its additive default). */
function parseMcpServers(value: unknown): Settings['mcpServers'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(value)) {
    if (!isRecord(rawServer)) {
      continue;
    }
    // Drop a server whose id cannot round-trip through the namespace/pattern
    // grammar (e.g. an id containing `__`, `*`, or `:`) — an unspawnable-safe id
    // is not a usable server, the same way a missing command drops the entry.
    if (!isValidMcpServerId(name)) {
      continue;
    }
    const command = parseStringList(rawServer.command);
    if (command.length === 0) {
      continue;
    }
    const server: McpServerConfig = { command };
    const env = parseStringRecord(rawServer.env);
    if (env !== undefined) {
      server.env = env;
    }
    if (typeof rawServer.cwd === 'string') {
      server.cwd = rawServer.cwd;
    }
    if (
      typeof rawServer.timeoutMs === 'number' &&
      Number.isSafeInteger(rawServer.timeoutMs) &&
      rawServer.timeoutMs > 0
    ) {
      server.timeoutMs = rawServer.timeoutMs;
    }
    const risk = parseRisk(rawServer.risk);
    if (risk !== undefined) {
      server.risk = risk;
    }
    const toolRisk = parseToolRisk(rawServer.toolRisk);
    if (toolRisk !== undefined) {
      server.toolRisk = toolRisk;
    }
    servers[name] = server;
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/** Parse a boolean-ish env string; unrecognized values ⇒ undefined (ignored). */
function parseBoolEnv(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    return true;
  }
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') {
    return false;
  }
  return undefined;
}

/** Accept a per-turn tool-call ceiling only if it is a positive safe integer; else undefined
 * (rejects 0, negatives, NaN, Infinity, and non-integer floats). */
function parseMaxToolCalls(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Accept a per-execution tool timeout only if it is a positive safe integer (ms); else undefined
 * (rejects 0, negatives, NaN, Infinity, and non-integer floats). */
function parseToolTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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

  const theme = parseTheme(value.theme);
  if (theme !== undefined) {
    settings.theme = theme;
  }

  const permissionMode = parsePermissionMode(value.permissionMode);
  if (permissionMode !== undefined) {
    settings.permissionMode = permissionMode;
  }

  const permissions = parsePermissions(value.permissions);
  if (permissions !== undefined) {
    settings.permissions = permissions;
  }

  const compactionThreshold = parseCompactionThreshold(value.compactionThreshold);
  if (compactionThreshold !== undefined) {
    settings.compactionThreshold = compactionThreshold;
  }

  const compactionKeepBudget = parseCompactionKeepBudget(value.compactionKeepBudget);
  if (compactionKeepBudget !== undefined) {
    settings.compactionKeepBudget = compactionKeepBudget;
  }

  const maxToolCalls = parseMaxToolCalls(value.maxToolCalls);
  if (maxToolCalls !== undefined) {
    settings.maxToolCalls = maxToolCalls;
  }

  const toolTimeoutMs = parseToolTimeoutMs(value.toolTimeoutMs);
  if (toolTimeoutMs !== undefined) {
    settings.toolTimeoutMs = toolTimeoutMs;
  }

  const brain = parseBrain(value.brain);
  if (brain !== undefined) {
    settings.brain = brain;
  }

  const mcpServers = parseMcpServers(value.mcpServers);
  if (mcpServers !== undefined) {
    settings.mcpServers = mcpServers;
  }

  if (typeof value.completionBell === 'boolean') {
    settings.completionBell = value.completionBell;
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

  const theme = overlay.theme ?? base.theme;
  if (theme !== undefined) {
    settings.theme = theme;
  }

  const permissionMode = overlay.permissionMode ?? base.permissionMode;
  if (permissionMode !== undefined) {
    settings.permissionMode = permissionMode;
  }

  const permissions = clonePermissions(overlay.permissions ?? base.permissions);
  if (permissions !== undefined) {
    settings.permissions = permissions;
  }

  const compactionThreshold = overlay.compactionThreshold ?? base.compactionThreshold;
  if (compactionThreshold !== undefined) {
    settings.compactionThreshold = compactionThreshold;
  }

  const compactionKeepBudget = overlay.compactionKeepBudget ?? base.compactionKeepBudget;
  if (compactionKeepBudget !== undefined) {
    settings.compactionKeepBudget = compactionKeepBudget;
  }

  const maxToolCalls = overlay.maxToolCalls ?? base.maxToolCalls;
  if (maxToolCalls !== undefined) {
    settings.maxToolCalls = maxToolCalls;
  }

  const toolTimeoutMs = overlay.toolTimeoutMs ?? base.toolTimeoutMs;
  if (toolTimeoutMs !== undefined) {
    settings.toolTimeoutMs = toolTimeoutMs;
  }

  const brain = cloneBrain(overlay.brain ?? base.brain);
  if (brain !== undefined) {
    settings.brain = brain;
  }

  // Whole-block replace (like brain): a config-file mcpServers block supersedes
  // the base wholesale — there is no default block and no env override for it.
  const mcpServers = cloneMcpServers(overlay.mcpServers ?? base.mcpServers);
  if (mcpServers !== undefined) {
    settings.mcpServers = mcpServers;
  }

  const completionBell = overlay.completionBell ?? base.completionBell;
  if (completionBell !== undefined) {
    settings.completionBell = completionBell;
  }

  return settings;
}

function readConfigFile(configPath: string): Partial<Settings> {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parseSettings(parsed);
  } catch {
    // Missing or corrupt file degrades to defaults — never throws on startup.
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

  // Enum-allowlist guard: apply ONLY if the value is a known mode. A present-but-
  // invalid value is ignored (config-file/default value stands). No env override
  // for the allow/deny lists — those are config-file only.
  const permissionMode = parsePermissionMode(envString(env, 'JUNO_PERMISSION_MODE'));
  if (permissionMode !== undefined) {
    overlay.permissionMode = permissionMode;
  }

  // Env override for the compaction trigger. Parsed as a float in (0, 1]; a present-
  // but-invalid value is ignored (the config-file/default value stands).
  const rawThreshold = envString(env, 'JUNO_COMPACTION_THRESHOLD');
  if (rawThreshold !== undefined) {
    const compactionThreshold = parseCompactionThreshold(Number.parseFloat(rawThreshold));
    if (compactionThreshold !== undefined) {
      overlay.compactionThreshold = compactionThreshold;
    }
  }

  // Env override for the per-turn tool-call ceiling. Parsed as a base-10 int and guarded
  // (positive safe integer); a present-but-invalid value is ignored (file/default stands).
  const rawMaxToolCalls = envString(env, 'JUNO_MAX_TOOL_CALLS');
  if (rawMaxToolCalls !== undefined) {
    const maxToolCalls = parseMaxToolCalls(Number.parseInt(rawMaxToolCalls, 10));
    if (maxToolCalls !== undefined) {
      overlay.maxToolCalls = maxToolCalls;
    }
  }

  // Env override for the per-execution tool timeout. Parsed as a base-10 int and guarded
  // (positive safe integer, ms); a present-but-invalid value is ignored (file/default stands).
  const rawToolTimeoutMs = envString(env, 'JUNO_TOOL_TIMEOUT_MS');
  if (rawToolTimeoutMs !== undefined) {
    const toolTimeoutMs = parseToolTimeoutMs(Number.parseInt(rawToolTimeoutMs, 10));
    if (toolTimeoutMs !== undefined) {
      overlay.toolTimeoutMs = toolTimeoutMs;
    }
  }

  // Env override for the brain master switch. Applied over the already-merged
  // (default<-file) brain block so command/timeout survive; an unrecognized
  // value is ignored (file/default stands).
  const rawBrainEnabled = envString(env, 'JUNO_BRAIN_ENABLED');
  if (rawBrainEnabled !== undefined && settings.brain !== undefined) {
    const enabled = parseBoolEnv(rawBrainEnabled);
    if (enabled !== undefined) {
      overlay.brain = {
        ...settings.brain,
        command: [...settings.brain.command],
        hookCommand: [...settings.brain.hookCommand],
        rememberCommand: [...settings.brain.rememberCommand],
        recallCommand: [...settings.brain.recallCommand],
        serverCommand: [...settings.brain.serverCommand],
        enabled,
      };
    }
  }

  // Env override for the completion bell. Boolean-parsed; a present-but-invalid
  // value is ignored (file/default stands).
  const rawCompletionBell = envString(env, 'JUNO_COMPLETION_BELL');
  if (rawCompletionBell !== undefined) {
    const completionBell = parseBoolEnv(rawCompletionBell);
    if (completionBell !== undefined) {
      overlay.completionBell = completionBell;
    }
  }

  return mergeSettings(settings, overlay);
}

/** Load config from `configPath` (default: `<homedir>/.config/juno/config.json`).
 * Sync reads keep the pinned `get()`/`reload()` seam synchronous. */
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

/** Deterministic, file-free service over a literal Settings (tests/fakes). */
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
