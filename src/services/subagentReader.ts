// src/services/subagentReader.ts
// Wave 7 — the READ side of the per-subagent transcript recorder. Reconstructs a
// live-shaped `Record<toolCallId, ToolState>` from the durable JSONL the recorder
// wrote to `<sessionDir>/<sessionId>.subagents/<toolUseId>.jsonl`.
//
// WHY IT EXISTS: the subagent-browser panel + transcript overlay derive from the
// live `state.tools` map, which is fully authoritative DURING a session (the recorder
// merely mirrors it). But a RESUMED session starts with `tools = {}` (reducer resets
// it on `resume-session`), so the live map has no subagents — yet the committed
// transcript still renders the `↓ agents` pointer and the durable JSONL still holds
// every child step. This reader rehydrates those settled subagents FROM DISK so the
// panel/overlay render the exact artifact the recorder persisted, closing the resume
// dead-affordance (brief item 3: "rendered from the recorder JSONL").
//
// The reconstruction mirrors the reducer's tool-call / tool-call-delta / tool-status
// folding so a reconstructed `ToolState` is indistinguishable from the live one. The
// app merges this map UNDER the live `tools` (live wins on id), so in-session behavior
// is unchanged and only a resume (empty live map) surfaces the on-disk records.
//
// All I/O is fail-soft: any missing dir / unreadable file / malformed line degrades to
// "no subagents" rather than crashing the render.
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolState } from '../core/reducer';
import { DEFAULT_SESSION_DIR } from './sessions';

/** A recorded event line's payload — mirrors the recorder's `RecordedEvent`. */
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

/** The once-per-parent meta header (line 1 of each file). */
interface RecordedMeta {
  toolUseId: string;
  name?: string;
  description?: string;
  model?: string;
}

export interface SubagentReaderDeps {
  /** The session id whose `<sessionId>.subagents/` directory to read. */
  readonly sessionId: string;
  /** Sessions root dir. Defaults to the shared `~/.config/juno/sessions`. */
  readonly dir?: string;
  /** Injectable dir listing (tests). Defaults to node:fs/promises readdir. */
  readonly readdir?: (dir: string) => Promise<string[]>;
  /** Injectable file read (tests). Defaults to node:fs/promises readFile (utf8). */
  readonly readFile?: (file: string) => Promise<string>;
}

/** True iff `value` is a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Defensive: pull a string field, else undefined. */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'result', 'error']);

/** Parse one JSONL line into a meta header, a recorded event, or nothing (malformed). */
function parseLine(line: string): { meta?: RecordedMeta; event?: RecordedEvent } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  if (parsed.kind === 'meta') {
    const toolUseId = str(parsed, 'toolUseId');
    if (toolUseId === undefined) return {};
    return {
      meta: {
        toolUseId,
        ...(str(parsed, 'name') !== undefined ? { name: str(parsed, 'name') } : {}),
        ...(str(parsed, 'description') !== undefined
          ? { description: str(parsed, 'description') }
          : {}),
        ...(str(parsed, 'model') !== undefined ? { model: str(parsed, 'model') } : {}),
      },
    };
  }

  if (parsed.kind === 'event' && isRecord(parsed.event)) {
    const ev = parsed.event;
    const type = str(ev, 'type');
    const toolCallId = str(ev, 'toolCallId');
    if (toolCallId === undefined) return {};
    if (type === 'tool-call' && typeof str(ev, 'name') === 'string') {
      const parentToolUseId = str(ev, 'parentToolUseId');
      return {
        event: {
          type: 'tool-call',
          toolCallId,
          name: str(ev, 'name')!,
          args: ev.args,
          ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
        },
      };
    }
    if (type === 'tool-call-delta' && typeof str(ev, 'argsDelta') === 'string') {
      return { event: { type: 'tool-call-delta', toolCallId, argsDelta: str(ev, 'argsDelta')! } };
    }
    if (type === 'tool-status') {
      const status = str(ev, 'status');
      if (status === undefined || !STATUSES.has(status)) return {};
      return {
        event: {
          type: 'tool-status',
          toolCallId,
          status: status as ToolState['status'],
          ...('result' in ev ? { result: ev.result } : {}),
          ...(str(ev, 'error') !== undefined ? { error: str(ev, 'error') } : {}),
        },
      };
    }
  }
  return {};
}

/**
 * Fold one recorded event onto the reconstruction map, mirroring the reducer's
 * tool-call / tool-call-delta / tool-status handling (including the error race-guard)
 * so a reconstructed `ToolState` matches what the live reducer would hold.
 */
function applyEvent(tools: Record<string, ToolState>, event: RecordedEvent): void {
  switch (event.type) {
    case 'tool-call':
      tools[event.toolCallId] = {
        status: 'pending',
        name: event.name,
        args: event.args,
        ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
      };
      return;
    case 'tool-call-delta': {
      const base = tools[event.toolCallId] ?? { status: 'pending', name: '', args: undefined };
      tools[event.toolCallId] = { ...base, argsText: (base.argsText ?? '') + event.argsDelta };
      return;
    }
    case 'tool-status': {
      const existing = tools[event.toolCallId];
      if (existing === undefined) return;
      // Race guard (mirrors reducer): once 'error', a later non-error must not clobber.
      if (existing.status === 'error' && event.status !== 'error') return;
      tools[event.toolCallId] = {
        ...existing,
        status: event.status,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
      return;
    }
  }
}

/**
 * PURE core: reconstruct a `tools` map from every JSONL file's raw text. Each file's
 * event lines fold into the shared map (child cards, carrying their `parentToolUseId`);
 * each file's meta header synthesizes the SPAWNING parent card if no event ever declared
 * it (the parent's own top-level tool-call is never recorded — it has no
 * `parentToolUseId`). A parent that DID appear as another subagent's child (a nested
 * subagent) keeps that authoritative child-derived entry; its meta is only used to fill
 * a missing description/model.
 *
 * File order is irrelevant: a child's `parentToolUseId` links to its ancestor regardless
 * of whether the ancestor's entry exists yet, and `descendantOf` tolerates missing links.
 */
export function reconstructSubagentTools(files: ReadonlyArray<string>): Record<string, ToolState> {
  const tools: Record<string, ToolState> = {};
  const metas: RecordedMeta[] = [];
  for (const content of files) {
    for (const line of content.split('\n')) {
      const { meta, event } = parseLine(line);
      if (event !== undefined) applyEvent(tools, event);
      if (meta !== undefined) metas.push(meta);
    }
  }
  // Synthesize each spawning parent from its meta. A top-level parent has no recorded
  // tool-call anywhere, so it only exists here; a nested subagent already has an
  // authoritative entry (from its own parent's file) — enrich it, never overwrite.
  for (const meta of metas) {
    const existing = tools[meta.toolUseId];
    const args = {
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
    };
    if (existing === undefined) {
      // Settled parent from a resumed session: it finished before persistence, so it
      // rolls up as done. Its child rows carry the accurate per-step status.
      tools[meta.toolUseId] = {
        status: 'result',
        name: meta.name ?? 'subagent',
        args,
      };
    } else if (!isRecord(existing.args) || Object.keys(existing.args).length === 0) {
      // Nested subagent whose own tool-call carried no describable args — backfill from meta.
      tools[meta.toolUseId] = { ...existing, args };
    }
  }
  return tools;
}

/**
 * Read + reconstruct all subagents recorded for `sessionId`. Fail-soft: a missing
 * `.subagents/` directory (a session that never spawned one) or any unreadable file
 * yields an empty map rather than throwing.
 */
export async function readSubagentTools(
  deps: SubagentReaderDeps,
): Promise<Record<string, ToolState>> {
  const rootDir = deps.dir ?? DEFAULT_SESSION_DIR;
  const subagentDir = path.join(rootDir, `${deps.sessionId}.subagents`);
  const readdir = deps.readdir ?? ((dir) => fsReaddir(dir));
  const readFile = deps.readFile ?? ((file) => fsReadFile(file, 'utf8'));

  let names: string[];
  try {
    names = await readdir(subagentDir);
  } catch {
    return {};
  }
  const jsonl = names.filter((name) => name.endsWith('.jsonl'));
  const contents: string[] = [];
  for (const name of jsonl) {
    try {
      contents.push(await readFile(path.join(subagentDir, name)));
    } catch {
      // Skip an unreadable file; the rest still reconstruct.
    }
  }
  return reconstructSubagentTools(contents);
}
