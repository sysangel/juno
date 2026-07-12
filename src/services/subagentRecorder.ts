// src/services/subagentRecorder.ts
// Wave 7 — per-subagent transcript recorder. Persists the tool activity of every
// subagent (juno-orchestrated children AND claude-cli native children) to
//   <sessionDir>/<sessionId>.subagents/<toolUseId>.jsonl
// This feeds the upcoming subagent-browser panel.
//
// WHERE IT RUNS: at the reducer/event level — the dispatch edge in
// `useStreamingTurn` calls `record(action, state)` for EVERY dispatched action,
// AFTER the reducer has applied it. It keys off `parentToolUseId`, which the
// reducer stamps for BOTH subagent paths (claude-cli native `parent_tool_use_id`
// and the juno orchestrator's re-emitted child events). So it captures whatever
// parented tool events juno observes, regardless of which backend produced them.
// It is PURE side-effect I/O; the reducer itself stays pure.
//
// FORMAT (simple JSONL, one JSON object per line):
//   line 1  — meta header: { kind:'meta', toolUseId, description?, model?, startRef }
//   line 2+ — events:      { kind:'event', event: { … tool-call/-delta/-status … } }
// The meta header is written once, lazily, the first time a child event for a
// given parent tool-use id is seen (so the parent tool card is already in
// `state.tools` and its args are available to describe it).
import { appendFile as fsAppendFile, mkdir as fsMkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Action, State, ToolState } from '../core/reducer';
import { DEFAULT_SESSION_DIR } from './sessions';

/** A recorded event line's payload — the tool-relevant AgentEvent shape. */
type RecordedEvent =
  | { type: 'tool-call'; toolCallId: string; name: string; args: unknown; parentToolUseId?: string }
  | { type: 'tool-call-delta'; toolCallId: string; argsDelta: string }
  | {
      type: 'tool-status';
      toolCallId: string;
      status: ToolState['status'];
      result?: unknown;
      error?: string;
    };

export interface SubagentRecorderDeps {
  /** The active session id; names the `<sessionId>.subagents/` directory. */
  readonly sessionId: string;
  /** Sessions root dir. Defaults to the shared `~/.config/juno/sessions`. */
  readonly dir?: string;
  /** Injectable append (tests). Defaults to node:fs/promises appendFile. */
  readonly appendFile?: (file: string, data: string) => Promise<void>;
  /** Injectable mkdir (tests). Defaults to node:fs/promises mkdir(recursive). */
  readonly mkdir?: (dir: string) => Promise<void>;
  /** Clock for the meta header's `startRef`. Defaults to ISO-8601 now. */
  readonly now?: () => string;
  /** Best-effort error sink (recording must never crash a turn). */
  readonly onError?: (error: unknown) => void;
}

export interface SubagentRecorder {
  /**
   * Observe one dispatched action against the POST-reduction state. No-op unless
   * the action is a subagent-child tool event (i.e. it resolves to a
   * `parentToolUseId`). Schedules the write and returns synchronously.
   */
  record(action: Action, state: State): void;
}

/** Sanitize a tool-use id into a safe single filename segment. */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Pull a human description out of a spawn/Agent tool call's args, if present. */
function describeParent(tool: ToolState | undefined): { description?: string; model?: string } {
  if (tool === undefined) return {};
  const args = tool.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  const record = args as Record<string, unknown>;
  const pickString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  };
  // juno `spawn_subagent` → { task, model, agent }; claude-cli Agent/Task →
  // { description, prompt, subagent_type }. Cover both.
  const description = pickString('description', 'task', 'prompt');
  const model = pickString('model', 'subagent_type');
  return {
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** Resolve the parent tool-use id an action's tool event belongs to, if any. */
function parentIdFor(action: Action, state: State): string | undefined {
  switch (action.t) {
    case 'tool-call':
      return action.parentToolUseId;
    case 'tool-call-delta':
    case 'tool-status':
      return state.tools[action.toolCallId]?.parentToolUseId;
    default:
      return undefined;
  }
}

/** Map a tool action to its recorded-event payload (drops the dispatch-edge `ts`). */
function toRecordedEvent(action: Action): RecordedEvent | undefined {
  switch (action.t) {
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: action.toolCallId,
        name: action.name,
        args: action.args,
        ...(action.parentToolUseId !== undefined
          ? { parentToolUseId: action.parentToolUseId }
          : {}),
      };
    case 'tool-call-delta':
      return { type: 'tool-call-delta', toolCallId: action.toolCallId, argsDelta: action.argsDelta };
    case 'tool-status':
      return {
        type: 'tool-status',
        toolCallId: action.toolCallId,
        status: action.status,
        ...(action.result !== undefined ? { result: action.result } : {}),
        ...(action.error !== undefined ? { error: action.error } : {}),
      };
    default:
      return undefined;
  }
}

/** JSON.stringify that never throws on a cyclic/odd payload (best-effort record). */
function safeLine(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ kind: 'event', event: { type: 'unserializable' } });
  }
}

/**
 * Build a recorder bound to one session. Writes are serialized through a single
 * promise chain (per instance) so lines never interleave and the directory is
 * created before the first append. All I/O is best-effort and fail-soft.
 */
export function createSubagentRecorder(deps: SubagentRecorderDeps): SubagentRecorder {
  const rootDir = deps.dir ?? DEFAULT_SESSION_DIR;
  const subagentDir = path.join(rootDir, `${deps.sessionId}.subagents`);
  const appendFile = deps.appendFile ?? ((file, data) => fsAppendFile(file, data));
  const mkdir = deps.mkdir ?? ((dir) => fsMkdir(dir, { recursive: true }).then(() => undefined));
  const now = deps.now ?? ((): string => new Date().toISOString());
  const onError = deps.onError ?? ((): void => {});

  const seenParents = new Set<string>();
  let dirEnsured = false;
  // Serialize all writes (dir create + every append) so lines land in order.
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((error) => {
      onError(error);
    });
  };

  return {
    record(action: Action, state: State): void {
      const parentId = parentIdFor(action, state);
      if (parentId === undefined) return;
      const event = toRecordedEvent(action);
      if (event === undefined) return;

      const file = path.join(subagentDir, `${safeSegment(parentId)}.jsonl`);
      const firstForParent = !seenParents.has(parentId);
      if (firstForParent) {
        seenParents.add(parentId);
      }
      const meta = firstForParent
        ? {
            kind: 'meta' as const,
            toolUseId: parentId,
            ...describeParent(state.tools[parentId]),
            startRef: now(),
          }
        : undefined;

      enqueue(async () => {
        if (!dirEnsured) {
          await mkdir(subagentDir);
          dirEnsured = true;
        }
        const lines: string[] = [];
        if (meta !== undefined) lines.push(safeLine(meta));
        lines.push(safeLine({ kind: 'event', event }));
        await appendFile(file, lines.join('\n') + '\n');
      });
    },
  };
}
