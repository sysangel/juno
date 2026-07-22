import { isAbortReason, isDenyReason } from './abort';
import type { Msg, ToolState } from './reducer';

/** The only tool names that constitute delegation evidence. */
export function isDelegationToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'agent' || lower === 'task' || lower === 'spawn_subagent' || lower === 'spawn_agent';
}

export type DelegationEvidenceStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'declined';

/** One auditable delegation, derived from an actual managed or provider-native spawn call. */
export interface DelegationEvidenceEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly role?: string;
  readonly description?: string;
  readonly status: DelegationEvidenceStatus;
}

/**
 * Frozen on the terminal assistant message. `entries` are evidence; `warning` is
 * deliberately only a presentation warning produced by conservative claim detection.
 */
export interface DelegationReceipt {
  readonly source: 'recorded-tool-events';
  readonly entries: ReadonlyArray<DelegationEvidenceEntry>;
  readonly warning?: 'unsupported-delegation-claim';
}

export interface DelegationCounts {
  readonly started: number;
  readonly completed: number;
  readonly active: number;
  readonly failed: number;
}

function pickString(args: unknown, ...keys: string[]): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function statusOf(tool: ToolState): DelegationEvidenceStatus {
  switch (tool.status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'result':
      // Juno's non-blocking spawn tool settles its CALL with a handle while the child
      // continues. Treat that exact structured result as active, not completed. The
      // background runner later dispatches a real `delegation-status` terminal.
      if (
        typeof tool.result === 'object' &&
        tool.result !== null &&
        !Array.isArray(tool.result) &&
        (tool.result as Record<string, unknown>).status === 'spawned'
      ) return 'running';
      return 'completed';
    case 'error':
      if (isAbortReason(tool.error)) return 'aborted';
      if (isDenyReason(tool.error)) return 'declined';
      return 'failed';
  }
}

export function delegationEntry(toolCallId: string, tool: ToolState): DelegationEvidenceEntry | undefined {
  if (!isDelegationToolName(tool.name)) return undefined;
  const role = pickString(tool.args, 'agent', 'subagent_type', 'model');
  const description = pickString(tool.args, 'description', 'task', 'prompt');
  return {
    toolCallId,
    toolName: tool.name,
    ...(role !== undefined ? { role } : {}),
    ...(description !== undefined ? { description } : {}),
    status: statusOf(tool),
  };
}

/** Session-wide ledger. It can never be populated by assistant prose. */
export function delegationLedgerFromTools(tools: Readonly<Record<string, ToolState>>): DelegationEvidenceEntry[] {
  const entries: DelegationEvidenceEntry[] = [];
  for (const [toolCallId, tool] of Object.entries(tools)) {
    const entry = delegationEntry(toolCallId, tool);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** Actual delegation calls made since the most recent user message. */
export function delegationLedgerForCurrentTurn(
  committed: ReadonlyArray<Msg>,
  live: Msg,
  tools: Readonly<Record<string, ToolState>>,
): DelegationEvidenceEntry[] {
  let turnStart = -1;
  for (let i = committed.length - 1; i >= 0; i -= 1) {
    if (committed[i]?.role === 'user') {
      turnStart = i;
      break;
    }
  }

  const byId = new Map<string, DelegationEvidenceEntry>();
  const collect = (message: Msg, lookup: Readonly<Record<string, ToolState>>): void => {
    for (const block of message.blocks) {
      if (block.kind !== 'tool') continue;
      const tool = message.toolSnapshot?.[block.toolCallId] ?? lookup[block.toolCallId];
      if (tool === undefined) continue;
      const entry = delegationEntry(block.toolCallId, tool);
      if (entry !== undefined) byId.set(block.toolCallId, entry);
    }
  };

  for (let i = turnStart + 1; i < committed.length; i += 1) {
    const message = committed[i];
    if (message?.role === 'assistant') collect(message, tools);
  }
  collect(live, tools);
  return [...byId.values()];
}

export function delegationCounts(entries: ReadonlyArray<DelegationEvidenceEntry>): DelegationCounts {
  let completed = 0;
  let active = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.status === 'completed') completed += 1;
    else if (entry.status === 'queued' || entry.status === 'running') active += 1;
    else failed += 1;
  }
  return { started: entries.length, completed, active, failed };
}

/**
 * Conservative, warning-only detection. Negated disclosures are explicitly ignored;
 * this function can never create positive evidence or a verified receipt.
 */
export function hasUnsupportedDelegationClaim(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (/\b(?:no|zero) subagents?\b|\bdid not (?:spawn|use|invoke|delegate)\b/.test(normalized)) {
    return false;
  }
  return (
    /\b(?:both|two|\d+) subagents? (?:completed|finished|reviewed|found|identified)\b/.test(normalized) ||
    /\bsubagents? (?:completed|finished|reviewed|found|identified)\b/.test(normalized) ||
    /\bindependent (?:review|reviewer)[^.]{0,120}\b(?:completed|finished|found|identified)\b/.test(normalized) ||
    /\bdelegated (?:the |this )?(?:review|work|task) to (?:an? |the )?(?:subagent|agent|reviewer)\b/.test(normalized)
  );
}

export function buildDelegationReceipt(
  entries: ReadonlyArray<DelegationEvidenceEntry>,
  assistantText: string,
): DelegationReceipt | undefined {
  const claimsDelegation = hasUnsupportedDelegationClaim(assistantText);
  if (entries.length > 0) {
    const counts = delegationCounts(entries);
    return {
      source: 'recorded-tool-events',
      entries,
      ...(claimsDelegation && counts.completed === 0
        ? { warning: 'unsupported-delegation-claim' as const }
        : {}),
    };
  }
  if (claimsDelegation) {
    return {
      source: 'recorded-tool-events',
      entries: [],
      warning: 'unsupported-delegation-claim',
    };
  }
  return undefined;
}

/** Model-facing fact block for raw-provider re-entry after real tool calls. */
export function delegationEvidencePrompt(entries: ReadonlyArray<DelegationEvidenceEntry>): string {
  const counts = delegationCounts(entries);
  const rows = entries.map((entry) => {
    const role = entry.role ?? entry.description ?? entry.toolName;
    return `- ${entry.toolCallId}: ${role} — ${entry.status}`;
  });
  return [
    '<juno-delegation-evidence source="recorded-tool-events">',
    `started: ${counts.started}`,
    `completed: ${counts.completed}`,
    `active: ${counts.active}`,
    `failed: ${counts.failed}`,
    ...rows,
    'Only completed entries may be described as completed independent or delegated work.',
    '</juno-delegation-evidence>',
  ].join('\n');
}

function isEvidenceStatus(value: unknown): value is DelegationEvidenceStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'aborted' ||
    value === 'declined'
  );
}

/** Strict persisted-format parser. Invalid receipts are dropped, never trusted. */
export function parseDelegationReceipt(value: unknown): DelegationReceipt | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.source !== 'recorded-tool-events' || !Array.isArray(record.entries)) return undefined;
  if (
    record.warning !== undefined &&
    record.warning !== 'unsupported-delegation-claim'
  ) return undefined;

  const entries: DelegationEvidenceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of record.entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.toolCallId !== 'string' ||
      typeof entry.toolName !== 'string' ||
      !isDelegationToolName(entry.toolName) ||
      seen.has(entry.toolCallId) ||
      !isEvidenceStatus(entry.status) ||
      (entry.role !== undefined && typeof entry.role !== 'string') ||
      (entry.description !== undefined && typeof entry.description !== 'string')
    ) return undefined;
    seen.add(entry.toolCallId);
    entries.push({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      ...(typeof entry.role === 'string' ? { role: entry.role } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      status: entry.status,
    });
  }
  return {
    source: 'recorded-tool-events',
    entries,
    ...(record.warning === 'unsupported-delegation-claim'
      ? { warning: record.warning }
      : {}),
  };
}
