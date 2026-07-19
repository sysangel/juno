// src/ui/liveWindow.ts
// LANE D (wave 7) — autoscroll / terminal-follow fix.
//
// THE PROBLEM. Committed turns live in Ink's <Static> (printed once into the
// terminal's own scrollback). The IN-FLIGHT turn (`state.live`) is NOT in Static —
// it renders in Ink's dynamic redraw region, below Static, every token flush. Ink's
// renderer (node_modules/ink/build/ink.js onRender) has a hard branch:
//
//     if (outputHeight >= stdout.rows)
//         stdout.write(clearTerminal + fullStaticOutput + output)   // \x1b[2J\x1b[3J\x1b[H
//
// i.e. the MOMENT the dynamic region (the live turn + composer chrome) grows taller
// than the viewport, Ink stops doing in-place log-update and instead full-screen
// repaints EVERY frame, erasing the scrollback (\x1b[3J) each time. The visible
// result is the reported bug: the terminal no longer scroll-follows the newest
// streamed text, earlier scrollback is destroyed, and the user must scroll manually.
//
// THE FIX (keep <Static> — a viewport rewrite was rejected). Bound the live turn's
// RENDERED height to the last `maxLines` lines so the dynamic region always stays
// shorter than the viewport. Ink then keeps using in-place log-update: the window
// slides as tokens arrive (newest line pinned just above the composer = native
// bottom-follow), scrollback is preserved, and at commit (`assistant-done`) the FULL
// untruncated turn flows into <Static>/scrollback exactly as before — nothing is
// lost, the elision is a live-streaming display bound only.
//
// This is a pure, render-time transform of the live Msg — no reducer/state change,
// so committed history, tool snapshots, and the StatusLine/InputBox memo bail-outs
// are all untouched.
import type { Block, Msg, ToolState } from '../core/reducer';
import { displayWidth, rowsForText, rowsForWidth, sanitizeForDisplay, wrapCells } from './clipText';
import { describeSubagent, isSubagentDescendant, isSubagentToolName } from '../core/selectors';
import { buildGroupingBlocks, planConcurrentToolGroups, type GroupPlan, type ToolGroup } from './toolGroups';
import { ARGS_MAX_CHARS, humanizeArgs, MAX_NEST_DEPTH, RESULT_TAIL_MAX_CHARS, TOOL_CARD_ROWS } from './ToolCallCard';
import { STATUS_DESC_MAX_CHARS } from './SubagentStatusRow';
import { GROUP_HEADER_ROWS, GROUP_MAX_VISIBLE_ROWS } from './GroupedToolRows';
import { renderedRows } from './MarkdownView';
import { parseMarkdown } from './markdown';

/** Stable React key for the elision marker (constant → no remount churn). */
export const LIVE_WINDOW_MARKER_ID = 'live-window:elided';
/** Text of the dim marker prepended when leading live content is elided. */
export const LIVE_WINDOW_MARKER_TEXT = '⋮ earlier output — full text prints when the turn completes';

// Rendered-height estimates. Ink WRAPS every line at the terminal width, so a block's
// rendered ROW count is not its source-line count — a single long paragraph is one source
// line but many wrapped rows. The whole point of this budget is to keep the live turn
// shorter than the viewport, so it MUST count wrapped rows (see finding: source-line
// budgeting left the autoscroll bug reproducible for wide prose). Tool blocks now reserve
// their REAL rendered height by reusing the renderer's OWN row constants + shared classifier
// (see blockLines), not the deleted wave-7 multi-line-card guess. Over-estimating is safe
// (windows a little early); under-estimating re-triggers Ink's scrollback-erasing repaint.
const NOTICE_EST_LINES = 1;
// A solo tool card (and a subagent spawn card + its status row) has NO terminal-width clip —
// unlike a grouped unit's width-clipped rows, Ink WORD-wraps it, and our cell-budget count
// (rowsForWidth over the summed segment widths) is only a cell-wrap bound. Reserve one extra
// row per such unit so word-wrap raggedness never under-counts. Group headers/rows ARE
// width-clipped by GroupedToolRows, so they take no headroom.
export const WRAP_HEADROOM = 1;
/** The status glyph / spinner cell that leads every tool card and status row — one cell wide. */
const GLYPH_CELLS = 1;
/** Widest ` · via <x> cli` delegate tag a card can carry. The estimator does not see
 *  providerKind, so it ALWAYS reserves this — an over-estimate is the safe direction. */
const VIA_TAG_MAX_CELLS = displayWidth(' · via claude cli');
/** ` · waiting on permission` — the widest trailing slot a pending/running card can hold (a
 *  gated card presents as waiting; a running card's ` · Ns` elapsed is narrower). */
const WAITING_SUFFIX_CELLS = displayWidth(' · waiting on permission');
/** Widest settled tail slot: the RESULT_TAIL_MAX_CHARS-capped first result/error line, its two
 *  leading spaces, and a ` +NNN lines` overflow marker. */
const RESULT_TAIL_CELLS = RESULT_TAIL_MAX_CHARS + 2 + displayWidth(' +999 lines');
/** Widest ` · Ns` running-elapsed suffix a card / status row shows. */
const ELAPSED_SUFFIX_CELLS = displayWidth(' · 99999s');
/**
 * The single blank row Message.renderBlocks pushes BEFORE every top-level tool unit (a solo
 * card, a spawn card, or a concurrent-group anchor) when anything already rendered above it
 * (Message.tsx — `<Box height={1}/>`). The estimator counts it UNCONDITIONALLY on each top-level
 * unit: over-counting the FIRST unit's (absent) gap only windows a touch early, while UNDER-
 * counting it re-triggers Ink's scrollback-erasing repaint — a group unit is width-clipped with
 * ZERO headroom to absorb an uncounted gap, and a solo card would silently spend its whole
 * WRAP_HEADROOM on the gap instead of on its own word wrap.
 */
const TOOL_UNIT_GAP_ROWS = 1;
// Extended-thinking renders collapsed: a heading + a preview capped at
// THINKING_MAX_LINES lines / THINKING_MAX_CHARS chars (Message.tsx). The char cap
// can wrap past the line count, so the reserve is the max of the two.
const THINKING_MAX_LINES = 4;
const THINKING_MAX_CHARS = 500;

/** Wrapped-row count of one source line (empty line still occupies 1 row). Counts via
 *  rowsForText so a wide-glyph line at odd columns reports its TRUE (never under-counted)
 *  height — under-reserving here re-triggers Ink's scrollback-erasing full repaint. */
function rowsForLine(line: string, columns: number): number {
  return rowsForText(line, columns);
}

/** Wrapped-row count of a whole (possibly multi-line) text block. */
function textRows(text: string, columns: number): number {
  if (text.length === 0) return 0;
  let rows = 0;
  for (const line of text.split('\n')) rows += rowsForLine(line, columns);
  return rows;
}

/**
 * Rendered ROW count of ASSISTANT markdown text, parsed + measured EXACTLY as MarkdownView
 * renders it — `sanitizeForDisplay` (MarkdownView.tsx does this BEFORE parsing, so the estimator
 * must too or the block split differs) → `parseMarkdown` → sum `renderedRows`. Counts the
 * decoration MarkdownView adds (the code/blockquote `│ ` gutter → content wraps at columns-2, the
 * dim code lang label, list markers, table cell padding, an empty-paragraph blank row) that a raw
 * source-line count ignores and would UNDER-reserve on prose-heavy turns (the \x1b[3J overflow).
 */
function markdownRows(text: string, columns: number): number {
  return parseMarkdown(sanitizeForDisplay(text)).reduce((n, b) => n + renderedRows(b, columns), 0);
}

/**
 * The shared classifier context — built ONCE per estimate so every tool block is classified
 * (and every concurrent group planned) exactly as Message.renderBlocks does, from the SAME
 * `buildGroupingBlocks` + `planConcurrentToolGroups`. This is the anti-drift point of the
 * measurement lane: the estimator can never disagree with the renderer about which cards
 * render, group, or vanish.
 */
interface EstimatorCtx {
  readonly role: Msg['role'];
  readonly lookup: (id: string) => ToolState | undefined;
  readonly plan: GroupPlan;
  /** Any group member's block id → its group (anchor + consumed), so the tail walk can treat
   *  a group as ONE atomic unit. */
  readonly groupByMember: ReadonlyMap<string, ToolGroup>;
}

function buildEstimatorCtx(msg: Msg, tools?: Record<string, ToolState>): EstimatorCtx {
  // Snapshot-first lookup — identical to Message.lookupTool, so the estimator resolves tools
  // exactly as the renderer. A LIVE turn has no toolSnapshot (frozen only at commit), so in
  // practice this reads the live `tools` map.
  const lookup = (id: string): ToolState | undefined => msg.toolSnapshot?.[id] ?? tools?.[id];
  const plan = planConcurrentToolGroups(buildGroupingBlocks(msg.blocks, lookup));
  const groupByMember = new Map<string, ToolGroup>();
  for (const group of plan.groupByAnchor.values()) {
    for (const member of group.members) groupByMember.set(member.blockId, group);
  }
  return { role: msg.role, lookup, plan, groupByMember };
}

/** Rendered ROW count of a live concurrent group: header + optional `↑ N earlier` head +
 *  windowed member rows (all width-clipped by GroupedToolRows, so no wrap headroom). The
 *  top-level gap that precedes the unit is added by the caller (TOOL_UNIT_GAP_ROWS). */
function groupUnitRows(group: ToolGroup): number {
  const members = group.members.length;
  const overflow = members > GROUP_MAX_VISIBLE_ROWS ? 1 : 0;
  return GROUP_HEADER_ROWS + overflow + Math.min(members, GROUP_MAX_VISIBLE_ROWS);
}

/**
 * Rendered ROW count of a solo {@link ToolCallCard}, width-aware. The card is ONE inline `<Box>`
 * that Ink WORD-wraps at `columns` — and it is NOT width-clipped — so a plain `TOOL_CARD_ROWS + 1`
 * is NOT an upper bound (a settled card with args at the cap + a result tail at the cap renders 2–3
 * rows at 80 cols, 4+ at 32). We sum the MAX cell width of every inline segment (glyph + ` name` +
 * `(args)` + a trailing detail slot + the delegate via tag) and take rowsForWidth over that budget
 * PLUS one word-wrap headroom (rowsForWidth is a cell-wrap LOWER bound on Ink's word wrap). Args are
 * the card's REAL humanized width (already ≤ ARGS_MAX_CHARS cells); the trailing slot reserves the
 * WIDEST of the mutually-exclusive presentations — a settled result/error tail, or the
 * ` · waiting on permission` suffix a gated pending/running card shows (a spawn card carries NO
 * inline tail, so it only ever needs the waiting/elapsed slot). The via tag is always reserved (the
 * estimator does not see providerKind). An undefined tool renders the dim `[tool <id>]` fallback
 * (one short row), reserved flat as TOOL_CARD_ROWS + headroom.
 */
function soloCardRows(tool: ToolState | undefined, columns: number, isSpawn: boolean): number {
  if (tool === undefined) return TOOL_CARD_ROWS + WRAP_HEADROOM;
  const argsStr = humanizeArgs(tool.name, tool.args);
  const argsCells =
    argsStr.length > 0 ? displayWidth(argsStr) : Math.min(ARGS_MAX_CHARS, displayWidth(tool.argsText ?? ''));
  const settled = !isSpawn && (tool.status === 'result' || tool.status === 'error');
  const trailing = settled ? RESULT_TAIL_CELLS : WAITING_SUFFIX_CELLS;
  const cells =
    GLYPH_CELLS + displayWidth(` ${tool.name}`) + 2 /* parens */ + argsCells + trailing + VIA_TAG_MAX_CELLS;
  return rowsForWidth(cells, columns) + WRAP_HEADROOM;
}

/**
 * Rendered ROW count of the per-agent {@link SubagentStatusRow} that rides beneath a spawn card,
 * width-aware in the SAME way as {@link soloCardRows}: the row is NOT width-clipped (no truncate on
 * its inline Text), so at a narrow terminal it word-wraps past one row — a flat 1
 * under-counts. Sum its cell budget (indent + glyph + ` description` clipped to
 * STATUS_DESC_MAX_CHARS + ` · model` + a trailing ` · Ns`/outcome/reason slot) and rowsForWidth +
 * one headroom. desc/outcome/reason are clipped to STATUS_DESC_MAX_CHARS by Message.firstLineClipped;
 * the model is NOT clipped, so its REAL width is measured. A settled row shows a
 * ≤STATUS_DESC_MAX_CHARS outcome/reason, a running one a short elapsed — reserve the wider by
 * lifecycle.
 */
function statusRowRows(tool: ToolState, nestDepth: number, columns: number): number {
  const { description, model } = describeSubagent(tool);
  const descCells = Math.min(STATUS_DESC_MAX_CHARS, displayWidth(description ?? tool.name));
  const modelCells = model !== undefined && model.length > 0 ? displayWidth(` · ${model}`) : 0;
  const indent = Math.max(0, Math.min(nestDepth, MAX_NEST_DEPTH)) * 2;
  const settled = tool.status === 'result' || tool.status === 'error';
  const trailing = settled ? displayWidth(' · ') + STATUS_DESC_MAX_CHARS : ELAPSED_SUFFIX_CELLS;
  const cells = indent + GLYPH_CELLS + 1 /* leading space */ + descCells + modelCells + trailing;
  return rowsForWidth(cells, columns) + WRAP_HEADROOM;
}

/**
 * Estimated rendered ROW count of a single block, wrap-aware — a tight UPPER bound on the
 * real rendered height. Tool blocks mirror Message.renderBlocks EXACTLY via the shared
 * classifier in `ctx` (see the numbered cases). Text is markdown on the assistant path
 * (counting MarkdownView's decoration) and verbatim otherwise.
 */
function blockLines(block: Block, columns: number, ctx: EstimatorCtx): number {
  if (block.kind === 'text') {
    // Assistant text renders as MARKDOWN (Message.tsx) — count the decoration MarkdownView
    // adds (code/quote gutters, the lang label, list markers, table padding, an empty-
    // paragraph blank row) that a raw source-line count ignores. Same parse the renderer
    // uses, so the counts match. parseMarkdown is O(n) and runs per frame here (Message
    // memoizes; the estimator does not — a windowed live turn is bounded and the memo
    // bookkeeping is not worth it).
    if (ctx.role === 'assistant') {
      return markdownRows(block.text, columns);
    }
    // user / system / tool text renders VERBATIM (Message.tsx) — raw source-line wrap.
    return textRows(block.text, columns);
  }
  if (block.kind === 'notice') {
    return Math.max(NOTICE_EST_LINES, rowsForLine(block.text, columns));
  }
  // A persisted `unknown` passthrough renders as nothing — reserve no rows for it.
  if (block.kind !== 'tool') return 0;

  // tool — mirror Message.renderBlocks, reusing its shared classifier + group plan, in order.
  // Every TOP-LEVEL unit (group anchor / spawn / solo card) also reserves the one-row gap
  // Message.renderBlocks pushes before it (TOOL_UNIT_GAP_ROWS); consumed members / suppressed
  // descendants render nothing and take neither rows nor a gap.
  // 1. a NON-anchor group member renders nothing (its anchor draws the whole unit).
  if (ctx.plan.consumed.has(block.id)) return 0;
  // 2. a group ANCHOR draws the top-level gap + header + optional `↑ N earlier` head + rows.
  const group = ctx.plan.groupByAnchor.get(block.id);
  if (group !== undefined) return groupUnitRows(group) + TOOL_UNIT_GAP_ROWS;
  // 3. a subagent DESCENDANT is suppressed from inline scrollback (Message.tsx) — no gap, no rows.
  if (isSubagentDescendant(ctx.lookup, block.toolCallId)) return 0;
  // 4. a subagent SPAWN card renders the top-level gap + one width-bounded card PLUS its per-agent
  //    status row (which rides directly beneath it with NO gap of its own).
  const tool = ctx.lookup(block.toolCallId);
  if (tool !== undefined && isSubagentToolName(tool.name)) {
    return soloCardRows(tool, columns, true) + statusRowRows(tool, 1, columns) + TOOL_UNIT_GAP_ROWS;
  }
  // 5. a plain solo card (incl. a nested non-subagent child, which still renders as one card) —
  //    the top-level gap + the width-bounded card. A nested child actually renders WITHOUT a gap,
  //    so counting one for it is an over-estimate (the safe direction).
  return soloCardRows(tool, columns, false) + TOOL_UNIT_GAP_ROWS;
}

/**
 * Estimated rendered ROW count of the WHOLE live turn `msg` at `columns` wide (the total
 * `windowLiveMsg` keeps bounded to `maxLines`). Reuses the SAME shared classifier + markdown
 * measurement as the render, so it is a tight UPPER bound on the real rendered height — never
 * below the truth (an under-count re-triggers Ink's scrollback-erasing full repaint). `tools`
 * is the live tools map (omit for non-app callers → tool blocks classify as plain solo cards).
 * Exported so tests can pin the estimate against the real rendered heights.
 */
export function estimatedRows(
  msg: Msg,
  columns: number = Number.POSITIVE_INFINITY,
  tools?: Record<string, ToolState>,
): number {
  const ctx = buildEstimatorCtx(msg, tools);
  let total = msg.reasoning ? reasoningRows(columns) : 0;
  for (const block of msg.blocks) total += blockLines(block, columns, ctx);
  return total;
}

/** Wrap-aware reserve for the collapsed extended-thinking region. */
function reasoningRows(columns: number): number {
  return 1 + Math.max(THINKING_MAX_LINES, rowsForWidth(THINKING_MAX_CHARS, columns));
}

/**
 * Return the trailing `remaining` WRAPPED ROWS of a text block, splitting mid-line
 * when the boundary source line is itself taller than the remaining budget (a wide
 * paragraph). Character-slicing a wrapped line to its tail rows is approximate but
 * only ever shows LESS than the budget, never more — the bound we must not exceed.
 */
function tailTextByRows(
  text: string,
  remaining: number,
  columns: number,
  isMarkdown: boolean,
): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const rows = rowsForLine(line, columns);
    if (used + rows <= remaining) {
      kept.unshift(line);
      used += rows;
      continue;
    }
    const rowsLeft = remaining - used;
    if (rowsLeft > 0 && Number.isFinite(columns) && columns > 0) {
      // Keep the last `rowsLeft` wrapped rows, measured in DISPLAY CELLS via the
      // clipText authority. The old `line.slice(line.length - rowsLeft*columns)`
      // treated `rowsLeft*columns` as a UTF-16 CODE-UNIT count: on a CJK stream
      // (1 code unit = 2 cells) that kept ~2x the row budget — overflowing the
      // live window and re-triggering Ink's scrollback-erasing full repaint — and
      // could slice through a surrogate pair, emitting a lone `�`. wrapCells breaks
      // only on whole code points and never mid-glyph, and joins back losslessly.
      const wrapped = wrapCells(line, columns);
      const partial = wrapped.slice(-rowsLeft).join('');
      if (partial.length > 0) kept.unshift(partial);
    }
    break;
  }
  if (isMarkdown) {
    // The kept lines were counted RAW (one wrapped-row count per SOURCE line), but assistant
    // text renders as MARKDOWN — decoration can make the SAME lines render TALLER (a code /
    // blockquote gutter wraps content at columns-2; a table pads cells wider), and slicing a
    // fenced region loose can even re-parse a line into a fresh code block. Measure the kept
    // tail EXACTLY as MarkdownView will render it (same sanitize+parse), and drop leading (oldest)
    // kept lines until its real height fits `remaining` — so a decorated boundary block never
    // overflows the window (Ink's scrollback-erasing repaint). Plain prose is one paragraph per
    // line (rendered == raw), so this trims nothing there; it only bites code/table/list tails.
    let start = 0;
    while (start < kept.length && markdownRows(kept.slice(start).join('\n'), columns) > remaining) {
      start += 1;
    }
    if (start > 0) return kept.slice(start).join('\n');
  }
  return kept.join('\n');
}

/**
 * Return a display copy of the live streaming `msg` whose rendered height is
 * bounded to roughly `maxLines` TERMINAL ROWS (showing the TAIL — the newest
 * content), prefixed with a dim elision marker when anything was dropped. Returns
 * the SAME `msg` reference (no allocation) when it already fits or clamping is
 * disabled (`maxLines` non-finite / ≤ 0) — so short turns and non-app callers are
 * untouched.
 *
 * `columns` is the terminal width used to count wrapped rows; pass the real
 * viewport width (app.tsx threads it from useTerminalSize). A non-finite /
 * non-positive `columns` disables wrap counting (1 row per source line) — the
 * behavior unit tests and non-TTY callers rely on. Callers should pass a
 * `maxLines` with headroom below the true viewport (see app.tsx).
 *
 * `tools` is the live tools map (StreamingMessage threads `state.tools`), used to classify
 * tool blocks EXACTLY as the renderer does — a spawn card + its status row, a concurrent
 * group folded to one unit, a suppressed subagent descendant. Omit it and tool blocks
 * classify as plain solo cards (deterministic; the pre-existing unit tests rely on this).
 */
export function windowLiveMsg(
  msg: Msg,
  maxLines: number,
  columns: number = Number.POSITIVE_INFINITY,
  tools?: Record<string, ToolState>,
): Msg {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return msg;

  // Build the shared classifier context ONCE (lookup + concurrency plan + member→group map)
  // so the fit check and the tail walk classify every block identically to the renderer.
  const ctx = buildEstimatorCtx(msg, tools);

  const budget = msg.reasoning ? maxLines - reasoningRows(columns) : maxLines;
  const effectiveBudget = Math.max(1, budget);

  let total = 0;
  for (const block of msg.blocks) total += blockLines(block, columns, ctx);
  if (total <= effectiveBudget) return msg;

  // Walk from the LAST block toward the first, keeping blocks until the budget is
  // spent; slice the boundary text block to its trailing wrapped rows.
  const kept: Block[] = [];
  let used = 0;
  let i = msg.blocks.length - 1;
  while (i >= 0) {
    const block = msg.blocks[i]!;
    const remaining = effectiveBudget - used;
    if (remaining <= 0) break;

    // A concurrent group renders as ONE atomic unit (header + windowed rows). Keep the WHOLE
    // contiguous group or stop before it — never a suffix of members: a dropped anchor would
    // re-group the survivors into a TALLER unit (an under-count that fires Ink's scrollback
    // erase). buildGroupingBlocks makes members contiguous with the anchor first, so the group
    // spans indices [i - count + 1, i] when `i` is its last member.
    const group = ctx.groupByMember.get(block.id);
    if (group !== undefined) {
      // Same height blockLines charges the anchor: the atomic group unit PLUS the top-level gap
      // Message.renderBlocks pushes before it — both call sites must agree or the fit check and
      // the tail walk disagree on the group's cost.
      const height = groupUnitRows(group) + TOOL_UNIT_GAP_ROWS;
      if (height <= remaining) {
        const count = group.members.length;
        for (let j = i; j > i - count; j -= 1) kept.push(msg.blocks[j]!);
        used += height;
        i -= count;
        continue;
      }
      break; // atomic and does not fit — stop before it
    }

    const height = blockLines(block, columns, ctx);
    if (height <= remaining) {
      kept.push(block);
      used += height;
      i -= 1;
      continue;
    }
    // Over budget: only a text block can be partially shown (its last `remaining`
    // wrapped rows). A tool/notice block is atomic — stop before it.
    if (block.kind === 'text') {
      const tail = tailTextByRows(block.text, remaining, columns, ctx.role === 'assistant');
      if (tail.length > 0) kept.push({ ...block, text: tail });
    }
    break;
  }
  kept.reverse();

  const marker: Block = {
    kind: 'notice',
    id: LIVE_WINDOW_MARKER_ID,
    text: LIVE_WINDOW_MARKER_TEXT,
  };
  return { ...msg, blocks: [marker, ...kept] };
}
