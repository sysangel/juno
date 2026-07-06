// src/tools/brainReadTools.ts
// The read-only brain tools — `brain_recall` and `brain_get` — the READ side of
// juno's personal-memory integration (Phase 1). Where `brain_remember` writes and
// is risk:'risky' (it pushes to a private remote), these only READ, so they are
// risk:'safe', exactly like the workspace file read tools.
//
// Like `brain_remember` they are gated behind `brain.enabled` at the registry
// call site (absent from the model's tool set when brain is off), registered
// AFTER the subagent snapshot (parent-agent-only, keeping the whole brain
// integration a depth-1 capability), and juno-INTERNAL (no claude-cli backend
// mapping). The actual read goes through src/services/brainRecall.ts, which
// spawns the brain-recall CLI shell-free and fails into a structured error result
// — a missing/broken brain never crashes the session.
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import { runBrainRecall } from '../services/brainRecall';
import type { BrainSpawn, TimerHandle } from '../services/brain';

export interface BrainReadToolsDeps {
  /** Base argv for the brain-recall CLI, spawned WITHOUT a shell. */
  readonly command: readonly string[];
  /** Workspace root — the child cwd. */
  readonly cwd: string;
  /** Hard timeout (ms) for a read; the child is killed on expiry. */
  readonly timeoutMs: number;
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  readonly spawnImpl?: BrainSpawn;
  /** Injectable scheduler so the timeout is deterministic in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

const VALID_SCOPES = ['all', 'episodes', 'memories', 'summaries'] as const;
const DEFAULT_K = 6;
const MAX_K = 20;
// An `ep_`/`mem_`/`sum_` id — validated before we ever shell out.
const ID_PATTERN = /^(?:ep_|mem_|sum_)[A-Za-z0-9]+$/;

const brainRecallSpec: ToolSpec = {
  name: 'brain_recall',
  description:
    "Search the user's personal memory (\"brain\") — a hybrid FTS + vector recall over durable " +
    'memories, session summaries, and episodes. Returns compact hits (kind, id, date, project, ' +
    'name, snippet, score); pass an id to brain_get for the full text. Read-only. Use this to ' +
    'recall stable facts, past decisions, and prior context. Only available when the brain is enabled.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'The natural-language search query.',
      },
      k: {
        type: 'number',
        description: `Max number of hits to return. Default ${DEFAULT_K}, capped at ${MAX_K}.`,
      },
      scope: {
        type: 'string',
        enum: [...VALID_SCOPES],
        description: 'Restrict the search: all | episodes | memories | summaries. Default: all.',
      },
    },
    required: ['query'],
  },
};

const brainGetSpec: ToolSpec = {
  name: 'brain_get',
  description:
    "Fetch the FULL text of a single personal-memory (\"brain\") item by its id — an `ep_` " +
    '(episode), `mem_` (memory), or `sum_` (summary) id, typically one returned by brain_recall. ' +
    'Read-only. Only available when the brain is enabled.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: {
        type: 'string',
        description: 'The item id to fetch — must start with ep_, mem_, or sum_.',
      },
    },
    required: ['id'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Clamp a requested k to [1, MAX_K]; a missing/invalid value falls back to DEFAULT_K. */
function clampK(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_K;
  }
  const n = Math.floor(value);
  if (n < 1) {
    return 1;
  }
  return n > MAX_K ? MAX_K : n;
}

/** Build the `brain_recall` tool over injectable process/clock deps. */
export function createBrainRecallTool(deps: BrainReadToolsDeps): Tool {
  return {
    name: 'brain_recall',
    risk: 'safe',
    spec: brainRecallSpec,
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const query = stringProp(args, 'query');
      if (query === undefined || query.trim().length === 0) {
        return { ok: false, error: 'invalid args: query must be a non-empty string' };
      }
      const scope = stringProp(args, 'scope');
      if (scope !== undefined && !(VALID_SCOPES as readonly string[]).includes(scope)) {
        return { ok: false, error: 'invalid args: scope must be all|episodes|memories|summaries' };
      }
      const k = clampK(args.k);

      const request: { query: string; k: number; scope?: string } = { query, k };
      if (scope !== undefined) {
        request.scope = scope;
      }

      const outcome = await runBrainRecall(
        {
          command: deps.command,
          cwd: deps.cwd,
          timeoutMs: deps.timeoutMs,
          spawnImpl: deps.spawnImpl,
          setTimer: deps.setTimer,
        },
        request,
      );

      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      // Surface the compact hits array as the result; fall back to the whole
      // record if the CLI shape ever changes.
      const hits = outcome.result.hits;
      return { ok: true, data: Array.isArray(hits) ? hits : outcome.result };
    },
  };
}

/** Build the `brain_get` tool over injectable process/clock deps. */
export function createBrainGetTool(deps: BrainReadToolsDeps): Tool {
  return {
    name: 'brain_get',
    risk: 'safe',
    spec: brainGetSpec,
    async run(args: unknown, _ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const id = stringProp(args, 'id');
      if (id === undefined || !ID_PATTERN.test(id)) {
        return { ok: false, error: 'invalid args: id must match ^(ep_|mem_|sum_)[A-Za-z0-9]+$' };
      }

      const outcome = await runBrainRecall(
        {
          command: deps.command,
          cwd: deps.cwd,
          timeoutMs: deps.timeoutMs,
          spawnImpl: deps.spawnImpl,
          setTimer: deps.setTimer,
        },
        { getId: id },
      );

      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      return { ok: true, data: outcome.result };
    },
  };
}

/** Both read-only brain tools, as fresh instances. */
export function createBrainReadTools(deps: BrainReadToolsDeps): Tool[] {
  return [createBrainRecallTool(deps), createBrainGetTool(deps)];
}
