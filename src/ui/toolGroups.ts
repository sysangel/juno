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
import type { ToolState } from '../core/reducer';

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

export interface ToolGroupSummary {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  /** No member is still non-terminal — the group has fully settled (→ condensed committed form). */
  readonly allSettled: boolean;
  /** Non-terminal members (pending + running) — the header's "N running" count. */
  readonly inFlight: number;
  /** Every member's tool name, in stream order (for the condensed one-line name list). */
  readonly names: readonly string[];
  /** First errored member's name + RAW reason (caller clips), or undefined when none failed. */
  readonly firstFailure?: { readonly name: string; readonly reason: string };
}

/**
 * Roll a concurrent group's member ToolStates into its header/condensed summary. Pure — the
 * counts drive the live header buckets (`2 running, 2 done`), `allSettled` flips the unit from
 * its expanded live form to the condensed committed line, and `firstFailure` carries the reason a
 * `✗` condensed line must show (never a bare count that reads like a clean finish).
 */
export function summarizeToolGroup(members: readonly ToolState[]): ToolGroupSummary {
  let pending = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  const names: string[] = [];
  let firstFailure: { name: string; reason: string } | undefined;
  for (const tool of members) {
    names.push(tool.name);
    switch (memberLifecycle(tool.status)) {
      case 'pending':
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
    }
  }
  const inFlight = pending + running;
  return {
    total: members.length,
    pending,
    running,
    done,
    failed,
    allSettled: inFlight === 0,
    inFlight,
    names,
    ...(firstFailure !== undefined ? { firstFailure } : {}),
  };
}
