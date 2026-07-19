// src/ui/toolGroups.ts
// Pure grouping logic for the grouped-tool-rows feature — NO state, NO I/O, NO JSX. A total
// function of its inputs, unit-tested apart from any render (mirrors collapse.ts / liveBudget.ts).
//
// THE CONCURRENCY DEFINITION (see docs/UX-SPEC.md R5). juno's reducer stamps each TOP-LEVEL
// tool call with a `concurrencyGroupId` at dispatch time: a call joins the batch of any sibling
// top-level call still non-terminal (pending/running) at that instant — they are in flight
// together — else it opens its own batch. That is the honest signal on both runtime paths (the
// raw-API executor runs a message's calls sequentially but they all land `pending` first; the
// claude-cli stream lands parallel `tool_use`s `pending` together while sequential rounds resolve
// before the next call arrives). This module turns those ids into render units:
//
//   - a CONCURRENT GROUP  = a maximal run of ADJACENT top-level plain-tool blocks sharing one
//                            defined `concurrencyGroupId`, length >= 2 → one grouped unit;
//   - a SOLO card         = anything else (a lone id, an unstamped tool, a run of length 1) →
//                            today's single ToolCallCard, unchanged.
//
// Adjacency (a non-eligible block — text / notice / subagent spawn / suppressed child — breaks a
// run) keeps rendering order stable and never pulls a card out from under an interleaved spawn.
import type { Block, ToolState } from '../core/reducer';
import { isSubagentDescendant, isSubagentToolName, presentedStatus } from '../core/selectors';

/**
 * One block's minimal view for grouping. `groupId` is the block's
 * `ToolState.concurrencyGroupId` ONLY when the block is an eligible top-level plain tool
 * (a real tool, not a subagent spawn / suppressed child / descendant); it is `undefined`
 * for every other block (text, notice, ineligible tool, or an unstamped tool). An undefined
 * id is a run-breaker, so ineligibility is expressed purely through this one field.
 */
export interface GroupingBlock {
  readonly blockId: string;
  readonly toolCallId: string;
  readonly groupId: string | undefined;
}

/** A concurrent group: >= 2 adjacent same-id members, rendered at the anchor (first) block. */
export interface ToolGroup {
  readonly groupId: string;
  readonly members: readonly GroupingBlock[];
  readonly anchorBlockId: string;
}

export interface GroupPlan {
  /** Anchor (first-member) block id → the group it heads. Only groups of >= 2 members appear. */
  readonly groupByAnchor: ReadonlyMap<string, ToolGroup>;
  /** Block ids consumed as NON-anchor group members — the render walk skips these. */
  readonly consumed: ReadonlySet<string>;
}

/**
 * Plan concurrent groups over a message's blocks, in stream order. Groups maximal runs of
 * adjacent blocks that share one defined `groupId`; a run of length 1 (or a block with an
 * undefined id) is left ungrouped (solo). Pure and total: order-stable, key-stable (keyed on
 * block ids), and never groups across a run-breaking block.
 */
export function planConcurrentToolGroups(blocks: readonly GroupingBlock[]): GroupPlan {
  const groupByAnchor = new Map<string, ToolGroup>();
  const consumed = new Set<string>();

  let run: { groupId: string; members: GroupingBlock[] } | null = null;
  const flush = (): void => {
    if (run !== null && run.members.length >= 2) {
      const anchor = run.members[0];
      groupByAnchor.set(anchor.blockId, {
        groupId: run.groupId,
        members: run.members.slice(),
        anchorBlockId: anchor.blockId,
      });
      for (let i = 1; i < run.members.length; i += 1) consumed.add(run.members[i].blockId);
    }
    run = null;
  };

  for (const block of blocks) {
    if (block.groupId === undefined) {
      flush(); // a run-breaker (ineligible / unstamped) ends any open run
      continue;
    }
    if (run !== null && run.groupId === block.groupId) {
      run.members.push(block);
    } else {
      flush();
      run = { groupId: block.groupId, members: [block] };
    }
  }
  flush();

  return { groupByAnchor, consumed };
}

/**
 * Map a message's blocks to their {@link GroupingBlock} view — the SHARED bridge both the
 * transcript renderer (Message.renderBlocks) and the live-window height estimator
 * (liveWindow.ts) feed into {@link planConcurrentToolGroups}, so the two derive IDENTICAL
 * group plans (the anti-drift point of the measurement lane). A block is an eligible group
 * candidate iff it is a top-level (no `parentToolUseId`), non-subagent-spawn, non-descendant
 * tool the reducer stamped with a `concurrencyGroupId`; every other block (text / notice /
 * ineligible-or-unstamped tool) gets an undefined `groupId` (a run-breaker). `lookup` returns
 * a tool by id (snapshot-first for a committed msg, else the live map).
 */
export function buildGroupingBlocks(
  blocks: readonly Block[],
  lookup: (id: string) => ToolState | undefined,
): GroupingBlock[] {
  return blocks.map((block) => {
    if (block.kind !== 'tool') return { blockId: block.id, toolCallId: '', groupId: undefined };
    const tool = lookup(block.toolCallId);
    const eligible =
      tool !== undefined &&
      tool.parentToolUseId === undefined &&
      tool.concurrencyGroupId !== undefined &&
      !isSubagentToolName(tool.name) &&
      !isSubagentDescendant(lookup, block.toolCallId);
    return {
      blockId: block.id,
      toolCallId: block.toolCallId,
      groupId: eligible ? tool.concurrencyGroupId : undefined,
    };
  });
}

/** The lifecycle a group member resolves to for its status glyph / bucket. */
export type MemberLifecycle = 'pending' | 'running' | 'done' | 'error';

/** Map a ToolState.status to the group-row lifecycle (`result` → `done`). */
export function memberLifecycle(status: ToolState['status']): MemberLifecycle {
  switch (status) {
    case 'error':
      return 'error';
    case 'result':
      return 'done';
    case 'running':
      return 'running';
    case 'pending':
      return 'pending';
  }
}

/**
 * One group member as the summarizer sees it: the accumulated ToolState plus the render-edge
 * fact that a permission prompt is currently open for it. The honest state mapping (mirrors
 * ToolCallCard.presentationOf, wave-1 item C): a gated member presents as WAITING ON PERMISSION,
 * never as running or queued — but a settled status (result/error) always wins over a stale flag.
 */
export interface GroupMember {
  readonly tool: ToolState;
  readonly waitingOnPermission?: boolean;
}

export interface ToolGroupSummary {
  readonly total: number;
  /** Members issued but not yet executing (status `pending`, no open permission prompt) — the
   *  header's "N queued" bucket. The raw-API executor runs a batch sequentially, so mid-execution
   *  a batch is typically 1 running + N queued; folding these into "running" would contradict the
   *  member rows directly beneath the header (1 spinner + N pending glyphs). */
  readonly pending: number;
  /** Members actually executing (status `running`, no open permission prompt). */
  readonly running: number;
  /** Members whose permission prompt is open — presented as waiting, never running/queued. */
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  /** Members CANCELLED (aborted): a user Esc/Ctrl+C or parent-abort cascade. NEVER counted into
   *  `failed` and never sets `firstFailure` — a cancel is not a crash, so a cancelled batch must
   *  not redden into a `✗ N failed` condensed line. */
  readonly cancelled: number;
  /** Members DECLINED (permission/policy deny). Also NEVER counted into `failed`/`firstFailure` —
   *  a routine decline is neutral, not a failure. */
  readonly declined: number;
  /** No member is still non-terminal — the group has fully settled (→ condensed committed form). */
  readonly allSettled: boolean;
  /** Non-terminal members (pending + running + waiting). */
  readonly inFlight: number;
  /** Every member's tool name, in stream order (for the condensed one-line name list). */
  readonly names: readonly string[];
  /** First errored member's name + RAW reason (caller clips), or undefined when none failed. */
  readonly firstFailure?: { readonly name: string; readonly reason: string };
}

/**
 * Roll a concurrent group's members into its header/condensed summary. Pure — the counts drive
 * the live header buckets (`1 running, 2 queued, 1 done`), each counted TRUTHFULLY by what the
 * member is actually doing (queued and permission-gated members are never folded into "running");
 * `allSettled` flips the unit from its expanded live form to the condensed committed line; and
 * `firstFailure` carries the reason a `✗` condensed line must show (never a bare count that reads
 * like a clean finish).
 */
export function summarizeToolGroup(members: readonly GroupMember[]): ToolGroupSummary {
  let pending = 0;
  let running = 0;
  let waiting = 0;
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  let declined = 0;
  const names: string[] = [];
  let firstFailure: { name: string; reason: string } | undefined;
  for (const { tool, waitingOnPermission } of members) {
    names.push(tool.name);
    // The ONE shared classifier (mirrors the solo ToolCallCard): a gated member is WAITING,
    // never running/queued; a settled result/error always wins over a stale flag (presentedStatus
    // only branches pending/running on the flag). A cancel splits to `aborted`, a deny to
    // `declined` — neither is bucketed into `failed` nor promoted to `firstFailure`.
    const p = presentedStatus(tool, { waitingOnPermission: waitingOnPermission === true });
    switch (p) {
      case 'waiting':
        waiting += 1;
        break;
      case 'queued':
        pending += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'done':
        done += 1;
        break;
      case 'error':
        failed += 1;
        if (firstFailure === undefined) {
          const reason = (tool.error ?? 'failed').split('\n').find((l) => l.trim().length > 0) ?? 'failed';
          firstFailure = { name: tool.name, reason };
        }
        break;
      case 'aborted':
        cancelled += 1;
        break;
      case 'declined':
        declined += 1;
        break;
    }
  }
  const inFlight = pending + running + waiting;
  return {
    total: members.length,
    pending,
    running,
    waiting,
    done,
    failed,
    cancelled,
    declined,
    allSettled: inFlight === 0,
    inFlight,
    names,
    ...(firstFailure !== undefined ? { firstFailure } : {}),
  };
}
