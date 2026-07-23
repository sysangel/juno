import { Box, Text } from 'ink';
import { memo, type ReactElement } from 'react';
import type { Block, Msg, ToolState } from '../core/reducer';
import { collapse, collapseIndicator } from './collapse';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { ToolCallCard, MAX_NEST_DEPTH, resultTail } from './ToolCallCard';
import { SubagentStatusRow, STATUS_DESC_MAX_CHARS, type SubagentRowStatus } from './SubagentStatusRow';
import {
  describeSubagent,
  isSubagentDescendant,
  isSubagentToolName,
  presentedStatus,
} from '../core/selectors';
import type { ProviderKind } from './providerKind';
import { MessageSeparator } from './MessageSeparator';
import { Markdown } from './MarkdownView';
import { FAIL, OK, PROMPT_LINE, RUNNING_HALF, THINKING } from './glyphs';
import { clipCells, sanitizeForDisplay } from './clipText';
import { ToolBlock as VerbToolBlock } from './ToolBlock';
import { planWorkBlocks } from './workBlocks';
import { delegationCounts, type DelegationReceipt } from '../core/delegationEvidence';

const DEPTH: ColorDepth = detectColorDepth();

/** While streaming, thinking shows a bounded live preview (never the full dump). */
const THINKING_MAX_LINES = 4;
const THINKING_MAX_CHARS = 500;

/**
 * Whole-second thinking duration from the reducer-frozen bounds, or null when the
 * bounds are absent (no edge clock) or the phase rounds to sub-second — in which
 * case the committed marker omits the duration (`✻ thought`).
 */
function reasoningSeconds(msg: Msg): number | null {
  const start = msg.reasoningStartedAt;
  const end = msg.reasoningEndedAt;
  if (start === undefined || end === undefined) return null;
  const secs = Math.round((end - start) / 1000);
  return secs >= 1 ? secs : null;
}

/**
 * Thinking-collapse. The extended-thinking region renders differently by lifecycle
 * but is NEVER deleted:
 *  - LIVE (streaming, `!msg.done`): a dim italic `✻ thinking…` marker followed by
 *    the current thinking text, bounded to a live preview (+ overflow indicator).
 *  - COMMITTED (`msg.done`): a single dim `✻ thought for <n>s` line (duration
 *    omitted when unavailable). The full thinking text is intentionally not
 *    rendered in scrollback, but the marker always is.
 * Returns null for a turn that never streamed any reasoning.
 */
function renderReasoning(msg: Msg, d: ColorDepth): ReactElement | null {
  const reasoning = msg.reasoning;
  if (reasoning === undefined || reasoning.length === 0) return null;

  if (msg.done) {
    const secs = reasoningSeconds(msg);
    const label = secs !== null ? `${THINKING} thought for ${secs}s` : `${THINKING} thought`;
    return (
      // Single-dim convention (item 6): `textDim` only — no stacked Ink `dimColor`.
      <Text color={token('textDim', d)}>{label}</Text>
    );
  }

  const c = collapse(reasoning, { maxLines: THINKING_MAX_LINES, maxChars: THINKING_MAX_CHARS });
  const indicator = collapseIndicator(c);
  return (
    // Single-dim convention (item 6): the whole live-thinking region is `textDim`
    // only (no stacked `dimColor`), so the marker, preview, and overflow indicator
    // read at one uniform dim rather than three brightnesses.
    <Box flexDirection="column">
      <Text color={token('textDim', d)} italic>
        {`${THINKING} thinking…`}
      </Text>
      <Text color={token('textDim', d)}>{c.text}</Text>
      {indicator.length > 0 ? (
        <Text color={token('textDim', d)}>{indicator}</Text>
      ) : null}
    </Box>
  );
}

/** Auditable terminal receipt. It renders evidence counts, never assistant claims. */
function renderDelegationReceipt(
  receipt: DelegationReceipt | undefined,
  d: ColorDepth,
  columns?: number,
): ReactElement | null {
  if (receipt === undefined) return null;
  const budget = Math.max(20, (columns ?? 120) - 1);
  if (receipt.warning === 'unsupported-delegation-claim') {
    const counts = delegationCounts(receipt.entries);
    const evidence = counts.started === 0
      ? 'no recorded agent calls'
      : `${counts.started} recorded · ${counts.completed} completed · ${counts.active} active · ${counts.failed} unsuccessful`;
    return (
      <Text color={token('warning', d)}>
        {clipCells(`! delegation unverified · ${evidence}`, budget)}
      </Text>
    );
  }

  const counts = delegationCounts(receipt.entries);
  const parts: string[] = [];
  if (counts.completed > 0) parts.push(`${counts.completed} completed`);
  if (counts.active > 0) parts.push(`${counts.active} active`);
  if (counts.failed > 0) parts.push(`${counts.failed} unsuccessful`);
  const labels = receipt.entries
    .map((entry) => entry.role ?? entry.description)
    .filter((value): value is string => value !== undefined)
    .slice(0, 3);
  const noun = counts.started === 1 ? 'agent' : 'agents';
  const glyph = counts.failed > 0 ? FAIL : counts.active > 0 ? RUNNING_HALF : OK;
  const line = `${glyph} ${counts.started} ${noun} · ${parts.join(' · ')}${labels.length > 0 ? ` · ${labels.join(' · ')}` : ''}`;
  const tint: FlatTokenName = counts.failed > 0 ? 'warning' : counts.active > 0 ? 'toolRunning' : 'success';
  return <Text color={token(tint, d)}>{clipCells(sanitizeForDisplay(line), budget)}</Text>;
}

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
  separated?: boolean;
  /**
   * LIVE tools map (reducer `state.tools`) for the in-flight streaming message,
   * whose tool blocks have no frozen `toolSnapshot` yet (that is set only at
   * commit). Lookup order is snapshot-first, so committed <Static> messages
   * NEVER read the live map (the frozen-snapshot contract is preserved).
   */
  tools?: Record<string, ToolState>;
  /**
   * The tool call whose permission prompt is open (`state.pendingPermissionToolCallId`),
   * so its tool line — the solo card AND a grouped concurrent unit's member row — renders
   * `waiting on permission` (amber) instead of running/queued — the honest state mapping
   * (wave-1 item C). Only meaningful for the LIVE turn; committed messages carry resolved
   * tools, so this never matches there.
   */
  pendingPermissionToolCallId?: string | null;
  /**
   * The rendering class of the active backend (see {@link ProviderKind}). Threaded
   * to each tool line so a render-only delegate CLI's replayed tools are tagged
   * `· via claude cli` / `· via codex cli`; `api` (or undefined) tools run under
   * juno's own executor and are unmarked.
   */
  providerKind?: ProviderKind;
  /**
   * Terminal columns, threaded to a grouped concurrent-tool unit so its live rows clip to one
   * terminal row in DISPLAY CELLS (never wrapping into Ink's scrollback-erase branch). Present
   * on the LIVE path (StreamingMessage has the size); absent on the committed <Static> path,
   * where the group renders as one condensed line and falls back to a fixed cap.
   */
  columns?: number;
}

/** Role -> tint token. Exhaustive over Role. Uniform-dim (E): `system` is now
 * dim neutral (`textDim`), not bold purple — a system line is chrome/feedback, not
 * a state signal. ('tool' is already dim/neutral.) */
function roleToken(role: Msg['role']): FlatTokenName {
  switch (role) {
    case 'user':
      return 'roleUser';
    case 'assistant':
      return 'roleAssistant';
    case 'system':
      return 'textDim';
    case 'tool':
      return 'textDim';
  }
}

function roleLabel(role: Msg['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
  }
}

/**
 * A committed SYSTEM message that represents a FAILED turn (the reducer `error`
 * case). Detected by the `tone: 'error'` discriminator OR — for sessions persisted
 * before that field existed — the `system-error-` id prefix the reducer has always
 * stamped. Such a message renders a bold `✗ error` heading in the `toolError` token
 * (not the dim neutral `system` label) and keeps its BODY at normal `text` so a long
 * provider error stays legible — so a real failure is never mistaken for benign
 * chrome like `session cleared`. terminal-error-visibility.
 */
function isErrorMessage(msg: Msg): boolean {
  return msg.role === 'system' && (msg.tone === 'error' || msg.id.startsWith('system-error-'));
}

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/** Snapshot-first tool lookup: frozen `toolSnapshot` (committed), else the LIVE
 * `tools` map (streaming message — no snapshot until commit). */
function lookupTool(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  toolCallId: string,
): ToolState | undefined {
  return msg.toolSnapshot?.[toolCallId] ?? tools?.[toolCallId];
}

/** Render a single tool block as a compact line (or a dim fallback if state lacks it).
 * `nestDepth` is the subagent-nesting level (0 = top-level, 1 = child, 2 = grandchild, …)
 * threaded from `renderBlocks`; it drives the card's left indent. */
function renderToolBlock(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  block: ToolBlock,
  d: ColorDepth,
  opts: { pendingPermissionToolCallId?: string | null; providerKind?: ProviderKind; columns?: number },
  nestDepth = 0,
): ReactElement {
  const tool = lookupTool(msg, tools, block.toolCallId);
  return tool !== undefined ? (
    <ToolCallCard
      key={block.id}
      tool={tool}
      depth={d}
      nestDepth={nestDepth}
      waitingOnPermission={opts.pendingPermissionToolCallId === block.toolCallId}
      providerKind={opts.providerKind}
      // W5: thread the terminal width so the solo card clips to one row in DISPLAY CELLS
      // (never Ink's scrollback-erase wrap). Absent on the width-less committed-fallback /
      // unit-test path, where the card keeps its char-cap output.
      {...(opts.columns !== undefined ? { columns: opts.columns } : {})}
    />
  ) : (
    <Text key={block.id} color={token('textDim', d)}>
      [tool {block.toolCallId}]
    </Text>
  );
}

/** Tool names that spawn a subagent (claude-cli `Agent`/`Task`; juno's own
 * `spawn_subagent`) — shared definition in `core/selectors`. */
const isSubagentTool = isSubagentToolName;

/** First non-blank line of a string, clipped to `max` DISPLAY CELLS (single-spaced),
 * or ''. Shares {@link clipCells} with ToolCallCard.oneLine + SubagentPanel.clip so a
 * CJK/emoji description or error line is measured in terminal cells (not UTF-16 code
 * units) and never overflows its one-row budget or splits a surrogate at the cut. */
function firstLineClipped(value: string | undefined, max: number): string {
  if (value === undefined) return '';
  const lines = value.split('\n');
  const idx = lines.findIndex((l) => l.trim().length > 0);
  const line = (idx === -1 ? lines[0] : lines[idx]) ?? '';
  return clipCells(line, max);
}

/**
 * The per-subagent status row rendered directly beneath a subagent spawn card, replacing
 * the old dim `⎿ ↓ agents` pointer (LANE B). It presents the subagent honestly by
 * lifecycle — running (spinner + description + model + elapsed), done (check + outcome
 * hint), error (red cross + reason), aborted (neutral ⊘ + reason, for a user cancel) — in
 * dim/secondary styling consistent with the condensed
 * cards. Descendant tool chatter stays suppressed (written to disk + summarised in the
 * below-composer agents panel), so this ONE row is the subagent's whole presence in
 * scrollback. Returns null when the block's tool is unknown or is not a subagent spawn.
 * `rowNestDepth` indents it one step deeper than its card.
 */
function renderSubagentStatusRow(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  block: ToolBlock,
  d: ColorDepth,
  rowNestDepth: number,
  pendingPermissionToolCallId: string | null | undefined,
  columns?: number,
): ReactElement | null {
  const tool = lookupTool(msg, tools, block.toolCallId);
  if (tool === undefined || !isSubagentTool(tool.name)) return null;
  // The ONE shared classifier (mirrors `selectSubagents`, so the transcript row and the panel
  // classify the same card identically): a genuine failure stays 'error', a cancel splits to
  // the neutral 'aborted', a permission/policy deny to 'declined'; a permission-gated spawn
  // reads 'waiting' (never a spinning 'running') so this row agrees with the spawn CARD above
  // it — previously the card got `waitingOnPermission` while this row spun (the item-2 bug).
  const status: SubagentRowStatus = presentedStatus(tool, {
    waitingOnPermission:
      pendingPermissionToolCallId != null && pendingPermissionToolCallId === block.toolCallId,
  });
  const { description, model } = describeSubagent(tool);
  return (
    <SubagentStatusRow
      key={`${block.id}:status`}
      status={status}
      description={firstLineClipped(description ?? tool.name, STATUS_DESC_MAX_CHARS)}
      {...(model !== undefined ? { model } : {})}
      {...(status === 'done' ? { outcomeHint: resultTail(tool.result).text } : {})}
      {...(status === 'error' || status === 'aborted' || status === 'declined'
        ? { reason: firstLineClipped(tool.error ?? 'failed', STATUS_DESC_MAX_CHARS) }
        : {})}
      nestDepth={rowNestDepth}
      depth={d}
      // W5: thread the width so the transcript status row clips its description + reason to one
      // terminal row in DISPLAY CELLS (reason clipped IN, never dropped). Absent ⇒ char-cap path.
      {...(columns !== undefined ? { columns } : {})}
    />
  );
}

/**
 * Render `msg.blocks` with claude-cli subagent grouping: a top-level tool card is
 * followed by its DESCENDANT cards at arbitrary depth — each child (a block whose
 * `ToolState.parentToolUseId` equals the parent's `toolCallId`), then that child's
 * own children, and so on — INDENTED one further step per level via
 * `<ToolCallCard nestDepth />`. Children of children (grandchildren) used to be
 * silently dropped because the child loop was one level deep; it is now a bounded
 * recursion. Text blocks render inline in order. A child whose parent tool block is
 * unknown (orphan) falls back to flat top-level rendering — never drop a card.
 * Order- and key-stable (React keys = `block.id`). A parent with zero children
 * renders exactly as before (no regression for non-subagent turns). A cyclic or
 * duplicated `parentToolUseId` chain cannot hang the renderer: a `visited` set
 * emits each tool card at most once, and `MAX_NEST_DEPTH` bounds the recursion.
 * PURE presentational.
 */
function renderBlocks(
  msg: Msg,
  tools: Record<string, ToolState> | undefined,
  d: ColorDepth,
  opts: { pendingPermissionToolCallId?: string | null; providerKind?: ProviderKind; columns?: number },
): ReactElement[] {
  // Snapshot-first tool lookup closure, shared with the work-block classifier and the
  // descendant walk (and with liveWindow's estimator) so the
  // renderer and the height estimator classify every tool block identically.
  const lookup = (id: string): ToolState | undefined => lookupTool(msg, tools, id);

  // The set of toolCallIds that have a tool block in THIS message (so we can tell
  // a real parent from an orphan reference).
  const toolBlockIds = new Set<string>();
  for (const block of msg.blocks) {
    if (block.kind === 'tool') {
      toolBlockIds.add(block.toolCallId);
    }
  }

  // Semantic run grouping: every top-level plain tool becomes part of a verb-headed
  // work block, and adjacent same-family calls share one block (read+search → Explored,
  // shell/process → Ran, writes → Edited, MCP calls → Called/Recalled). Text, agents,
  // descendants, and family changes are hard boundaries. The same pure plan drives
  // liveWindow's height accounting.
  const workPlan = planWorkBlocks(msg.blocks, lookup, msg.done);

  // parent toolCallId -> its child tool blocks, in stream order.
  const childBlocksByParent = new Map<string, ToolBlock[]>();
  for (const block of msg.blocks) {
    if (block.kind !== 'tool') continue;
    const parentToolUseId = lookupTool(msg, tools, block.toolCallId)?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      const children = childBlocksByParent.get(parentToolUseId) ?? [];
      children.push(block);
      childBlocksByParent.set(parentToolUseId, children);
    }
  }

  const rendered: ReactElement[] = [];
  let lastTopLevelKind: 'text' | 'tool' | 'notice' | undefined;

  // Subagent depth: a top-level tool card is depth 0, its direct children depth 1,
  // grandchildren depth 2, … Every descendant renders INDENTED beneath its parent,
  // in stream order, with NO inter-card gap (the blank line separates only top-level
  // groups, below). `visited` emits each tool card at most once, so a cyclic or
  // duplicated `parentToolUseId` chain terminates instead of hanging the renderer;
  // `MAX_NEST_DEPTH` additionally bounds the recursion (and the indentation) for a
  // pathologically deep chain. Both mitigations are load-bearing per the malformed-
  // input contract in the doc comment above.
  const visited = new Set<string>();
  const pushDescendants = (parentToolCallId: string, nestDepth: number): void => {
    if (nestDepth > MAX_NEST_DEPTH) return;
    for (const childBlock of childBlocksByParent.get(parentToolCallId) ?? []) {
      if (visited.has(childBlock.toolCallId)) continue;
      visited.add(childBlock.toolCallId);
      rendered.push(renderToolBlock(msg, tools, childBlock, d, opts, nestDepth));
      // A nested subagent (a child that itself spawned subagents) gets its own live
      // rollup row, indented one step further than its card.
      const nestedStatus = renderSubagentStatusRow(
        msg,
        tools,
        childBlock,
        d,
        nestDepth + 1,
        opts.pendingPermissionToolCallId,
        opts.columns,
      );
      if (nestedStatus !== null) rendered.push(nestedStatus);
      pushDescendants(childBlock.toolCallId, nestDepth + 1);
    }
  };

  for (const block of msg.blocks) {
    if (block.kind === 'notice') {
      // System-feedback line (F): always dim, never markdown, role-independent.
      // Single-dim convention (item 6): `textDim` only, no stacked `dimColor`.
      rendered.push(
        <Text key={block.id} color={token('textDim', d)}>
          {sanitizeForDisplay(block.text)}
        </Text>,
      );
      lastTopLevelKind = 'notice';
      continue;
    }
    if (block.kind === 'text') {
      // A completed tool row and the prose that explains its result are separate
      // semantic units. Give that boundary the same single blank row already used
      // for prose→tool and tool→tool transitions; otherwise the final answer looks
      // glued to the last call even though individual calls are legible.
      if (lastTopLevelKind === 'tool') {
        rendered.push(<Box key={`${block.id}:gap`} height={1} />);
      }
      // Live-markdown (D): render markdown for ALL assistant text — streaming AND
      // committed — so the live turn already reads as its final formatted form and
      // there is no re-snap when it commits to <Static>. The tokenizer is total and
      // tolerant of half-written constructs (an unclosed fence renders its tail as
      // code, a dangling `**bo` stays literal until its closer streams in), so
      // parsing partial prose never throws; only a small trailing construct
      // re-forms as its closer arrives. user / system / tool roles stay verbatim.
      if (msg.role === 'assistant') {
        rendered.push(<Markdown key={block.id} text={block.text} depth={d} workBlockRhythm />);
      } else if (msg.role === 'user') {
        // Transcript-identity (E) + echo-brightness (wave 3): user turns carry NO
        // `user` label. The `❯ ` marker stays dim gray (textDim + dimColor) for
        // composer-prompt continuity, but the echoed text itself renders at NORMAL
        // prose foreground (`text`, no dim) so it is fully legible — previously the
        // text stacked BOTH token('textDim') AND Ink's dimColor and read faint.
        // The marker prefixes the block once (interior lines wrap naturally). NOT
        // yellow (the old roleUser tint is gone).
        rendered.push(
          <Text key={block.id}>
            <Text color={token('textDim', d)} dimColor>
              {PROMPT_LINE}
            </Text>
            <Text color={token('text', d)}>{sanitizeForDisplay(block.text)}</Text>
          </Text>,
        );
      } else {
        // system / tool prose stays raw in its role tint (never markdown). A committed
        // error message keeps its BODY at normal `text` (not the dim role tint) so a
        // long provider error stays fully legible — the bold red `✗ error` heading is
        // what carries the failure signal. terminal-error-visibility.
        const bodyToken: FlatTokenName = isErrorMessage(msg) ? 'text' : roleToken(msg.role);
        rendered.push(
          <Text key={block.id} color={token(bodyToken, d)}>
            {sanitizeForDisplay(block.text)}
          </Text>,
        );
      }
      lastTopLevelKind = 'text';
      continue;
    }
    // Persisted forward-compat passthrough (`unknown`): renders as nothing. After
    // the notice/text guards the only real Block left is `tool`; this narrows the
    // union so the `.toolCallId` accesses below type-check (and drops `unknown`).
    if (block.kind !== 'tool') continue;
    // A descendant (at any depth) of a subagent spawn stays SUPPRESSED — never inline —
    // EVEN when the spawn-card block itself was windowed out of the live turn
    // (liveWindow.ts elides the block tail during a long subagent turn). Decide this from
    // tool ancestry in the tools map, not block presence: a windowed-out spawn card used
    // to leave its orphaned children to leak as flat, misattributed top-level cards
    // (a child `shell(npm test)` presented as if the MAIN agent were running it).
    if (isSubagentDescendant(lookup, block.toolCallId)) {
      continue;
    }
    // A NON-subagent child whose parent block is present is rendered under that parent
    // (nested, below); skip its flat render here. An orphan (parent not present) falls
    // through to flat top-level render — never dropped.
    const parentToolUseId = lookupTool(msg, tools, block.toolCallId)?.parentToolUseId;
    if (parentToolUseId !== undefined && toolBlockIds.has(parentToolUseId)) {
      continue;
    }
    // A non-anchor work member is drawn by its anchor. At the anchor render one
    // bounded tree block; provenance appears once on its verb line, never per call.
    if (workPlan.consumed.has(block.id)) continue;
    const work = workPlan.blockByAnchor.get(block.id);
    if (work !== undefined) {
      if (rendered.length > 0) {
        rendered.push(<Box key={`${block.id}:gap`} height={1} />);
      }
      const entries = work.members.flatMap((member) => {
        const tool = lookupTool(msg, tools, member.toolCallId);
        return tool !== undefined ? [{ toolCallId: member.toolCallId, tool }] : [];
      });
      rendered.push(
        <VerbToolBlock
          key={`${block.id}:work`}
          entries={entries}
          family={work.family}
          sealed={work.sealed}
          committed={msg.done}
          depth={d}
          {...(opts.columns !== undefined ? { columns: opts.columns } : {})}
          {...(opts.providerKind !== undefined ? { providerKind: opts.providerKind } : {})}
          {...(opts.pendingPermissionToolCallId !== undefined && opts.pendingPermissionToolCallId !== null
            ? { pendingPermissionToolCallId: opts.pendingPermissionToolCallId }
            : {})}
        />,
      );
      lastTopLevelKind = 'tool';
      // Work blocks replace the parent's solo card, but they do not replace its
      // non-agent child tree. Preserve the bounded descendant walk for each
      // grouped top-level call; otherwise a single work-block anchor would make
      // its Depth1+ evidence disappear from the transcript.
      for (const member of work.members) {
        visited.add(member.toolCallId);
        pushDescendants(member.toolCallId, 1);
      }
      continue;
    }
    // Within-turn vertical rhythm (UX track 3): one blank line before each
    // top-level tool group when something already rendered above it — i.e.
    // between consecutive top-level tool groups AND at a text→tool boundary.
    // NEVER before the first block (guarded by rendered.length), and NEVER
    // inside a nested group (the child loop below pushes cards with no gap).
    // The gap depends only on block order + kind, which is identical for the
    // live (tools map) and committed (toolSnapshot) paths, so a turn's spacing
    // does not shift when it commits to <Static> (append-only invariant).
    if (rendered.length > 0) {
      rendered.push(<Box key={`${block.id}:gap`} height={1} />);
    }
    rendered.push(renderToolBlock(msg, tools, block, d, opts));
    lastTopLevelKind = 'tool';
    const tool = lookupTool(msg, tools, block.toolCallId);
    if (tool !== undefined && isSubagentTool(tool.name)) {
      // Transcript de-clutter (LANE B): a subagent's nested child cards no longer render
      // inline — they are written to disk and summarised in the below-composer agents
      // panel. The parent spawn card stays as ONE condensed line, followed by a single
      // per-agent status row (running/done/error). We do NOT recurse into descendants;
      // the descendant blocks are already skipped by the parent-present guard above, so
      // leaving `pushDescendants` uncalled hides the whole subtree.
      const statusRow = renderSubagentStatusRow(
        msg,
        tools,
        block,
        d,
        1,
        opts.pendingPermissionToolCallId,
        opts.columns,
      );
      if (statusRow !== null) rendered.push(statusRow);
      continue;
    }
    // Seed the parent's own id so a descendant that cyclically references this
    // top-level ancestor is caught, then render the whole subtree recursively.
    visited.add(block.toolCallId);
    pushDescendants(block.toolCallId, 1);
  }
  return rendered;
}

function MessageView({
  msg,
  depth,
  separated,
  tools,
  pendingPermissionToolCallId,
  providerKind,
  columns,
}: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  // A notice-only message (F: system feedback like `session cleared`) is a bare dim
  // line — it carries no role label (a bold `system` heading over a one-line notice
  // is chrome the Claude-Code-minimal direction drops).
  const noticeOnly = msg.blocks.length > 0 && msg.blocks.every((block) => block.kind === 'notice');
  // A FAILED-turn system line (reducer `error` case) must ALWAYS carry a heading — it
  // is the sole failure surface, so a notice-only path can never be allowed to swallow
  // it into a bare dim line. terminal-error-visibility.
  const isError = isErrorMessage(msg);
  // Transcript-identity (E): the `user`/`assistant` label lines are gone — a user
  // turn is identified by its `❯ ` prefix (see renderBlocks) and assistant prose is
  // unlabeled default text. system/tool turns keep their heading (system errors etc.
  // still need the tag); notice-only messages remain bare dim lines.
  const labeled = isError || (!noticeOnly && (msg.role === 'system' || msg.role === 'tool'));
  return (
    <Box flexDirection="column">
      {separated === true ? <MessageSeparator depth={d} /> : null}
      {labeled ? (
        isError ? (
          // Terminal-error visibility: a committed failure reads as a bold `✗ error`
          // heading in the error token — never the dim neutral `system` label, which
          // is indistinguishable from benign chrome.
          <Text color={token('toolError', d)} bold>
            {`${FAIL} error`}
          </Text>
        ) : (
          // Uniform-dim (E): the `system` heading is dim neutral and UNBOLD (not the
          // old bold purple); the `tool` heading keeps its bold weight.
          <Text color={token(roleToken(msg.role), d)} bold={msg.role !== 'system'}>
            {roleLabel(msg.role)}
          </Text>
        )
      ) : null}
      {renderReasoning(msg, d)}
      {renderBlocks(msg, tools, d, {
        pendingPermissionToolCallId,
        providerKind,
        ...(columns !== undefined ? { columns } : {}),
      })}
      {renderDelegationReceipt(msg.delegationReceipt, d, columns)}
    </Box>
  );
}

/**
 * Memoized (statusline-memo, Wave 2 item C). Default shallow compare on purpose:
 * the reducer hands a NEW `msg` (fresh `blocks`, and for the live turn a fresh
 * `tools` map) on every mutation, so the render fn re-runs on exactly those changes
 * — live markdown text (item D) is never frozen — while a parent commit that touches
 * none of these props bails out. Committed messages sit inside Transcript's
 * `<Static>` (rendered once) so this memo only affects the live-turn `<Message>`.
 */
export const Message = memo(MessageView);
