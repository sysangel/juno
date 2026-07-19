import { Box, Text } from 'ink';
import { Fragment, memo, type ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { CONTEXT_DANGER_FRACTION, CONTEXT_WARN_FRACTION } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { effortDisplay } from './EffortBadge';
import { abbreviateHome, basename } from './paths';

const DEPTH: ColorDepth = detectColorDepth();

/** The dim ` · ` chip separator (Claude-Code minimal; never collapsed/truncated). */
const SEP = ' · ';

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
  width?: number;
}

/** Token count → compact label: 200000 → `200k`, 48500 → `48.5k`, 1047576 → `1M`. */
function humanizeTokens(n: number): string {
  const oneDecimal = (x: number): string => {
    const s = x.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return `${oneDecimal(n / 1_000_000)}M`;
  if (n >= 1_000) return `${oneDecimal(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * Tiered tint for the context-window gauge so thresholds are visible at a glance:
 * green while healthy, amber at/over WARN (consider clearing), red at/over DANGER.
 */
function contextTint(fraction: number): FlatTokenName {
  if (fraction >= CONTEXT_DANGER_FRACTION) return 'error';
  if (fraction >= CONTEXT_WARN_FRACTION) return 'warning';
  return 'success';
}

/** A single status chip: measurable plain `text` + its semantic color. */
export interface StatusChip {
  key: string;
  text: string;
  color: FlatTokenName;
  /**
   * Drop priority for narrow widths — LOWER drops FIRST. `undefined` = never
   * dropped (the model chip is the anchor). Spec order for the CORE chips is
   * skills → ctx → cwd → effort; the auxiliary chips (cmp/tools/cost/mode) drop
   * before skills.
   */
  dropRank?: number;
  /** A shorter alternative text tried ONCE before this chip is dropped (cwd → basename). */
  shrink?: string;
}

/** Rendered width of a chip list joined by ` · ` (no ANSI — plain text only). */
function joinedLength(chips: ReadonlyArray<StatusChip>): number {
  const textLen = chips.reduce((n, c) => n + c.text.length, 0);
  return textLen + SEP.length * Math.max(0, chips.length - 1);
}

/**
 * Responsive chip layout: drop whole chips (never collapse a separator, never
 * truncate mid-chip) in `dropRank` order until the line fits `width`, shrinking
 * cwd to its basename before dropping it. Pure + exported so the drop order and
 * width math are unit-testable without rendering. `width === undefined` keeps all.
 */
export function layoutStatusChips(chips: ReadonlyArray<StatusChip>, width?: number): StatusChip[] {
  const current: StatusChip[] = chips.map((c) => ({ ...c }));
  if (width === undefined) return current;
  while (joinedLength(current) > width) {
    let victim: StatusChip | undefined;
    for (const chip of current) {
      if (chip.dropRank === undefined) continue;
      if (victim === undefined || chip.dropRank < victim.dropRank!) victim = chip;
    }
    if (victim === undefined) break; // only never-drop chips remain
    if (victim.shrink !== undefined && victim.shrink.length < victim.text.length) {
      victim.text = victim.shrink;
      victim.shrink = undefined;
      continue;
    }
    const at = current.indexOf(victim);
    current.splice(at, 1);
  }
  return current;
}

/**
 * Build the ordered chip list from status. Display order is the spec's
 * `model · cwd · ctx · effort · skills` plus auxiliary chips; zero/empty chips are
 * omitted entirely (fresh idle → `model · cwd · effort`). Exported for tests.
 */
export function buildStatusChips(status: StatusLineState): StatusChip[] {
  const chips: StatusChip[] = [];
  // model — the anchor, never dropped. Uniform-dim (E): rendered `textDim` (not the
  // brand accent) and unbolded, so the strip reads as one muted line and colour is
  // reserved for chips that carry state (ctx/effort/mode/mcp).
  chips.push({ key: 'model', text: status.model, color: 'textDim' });

  // cwd — home-abbreviated; shrinks to basename before being dropped.
  const cwdFull = abbreviateHome(status.cwd);
  chips.push({ key: 'cwd', text: cwdFull, color: 'textDim', dropRank: 6, shrink: basename(cwdFull) });

  // ctx — only once the window has real occupancy; `~` marks an estimate.
  const cw = status.contextWindow;
  if (cw.used > 0) {
    const pct = Math.round(cw.fraction * 100);
    chips.push({
      key: 'ctx',
      text: `ctx ${cw.estimated ? '~' : ''}${humanizeTokens(cw.used)} (${pct}%)`,
      color: contextTint(cw.fraction),
      dropRank: 5,
    });
  }

  // effort — plain lowercase colored text (no inverse chip); dropped last.
  const effort = effortDisplay(status.effort);
  chips.push({ key: 'effort', text: effort.text, color: effort.color, dropRank: 7 });

  // skills — count only when present; first of the core chips to drop. Uniform-dim
  // (E): `textDim` rather than `info` — a passive count, not a state signal.
  if (status.skills !== undefined && status.skills.length > 0) {
    chips.push({ key: 'skills', text: `skills:${status.skills.length}`, color: 'textDim', dropRank: 4 });
  }

  // --- auxiliary chips (retained from prior waves; drop before the core set) ---
  // mcp — async MCP connect state (Wave 2 async-mcp). This chip CARRIES meaning
  // via color (amber connecting/partial, red failed), so it is exempt from the
  // uniform-dim rule. A benign `connecting` chip keeps dropRank 0 (first shed — it is
  // transient chrome), but an ERROR state (partial/failed) is a real outage that must
  // stay visible on narrow widths, so it ranks 6 (above the auxiliaries + skills/ctx;
  // below effort=7 which drops last). A fully-`ready` fleet is the silent happy path (no
  // chip); undefined (no servers) renders nothing.
  if (status.mcp !== undefined) {
    const { state, connected, total } = status.mcp;
    if (state === 'connecting') {
      chips.push({ key: 'mcp', text: 'mcp:connecting…', color: 'warning', dropRank: 0 });
    } else if (state === 'partial') {
      chips.push({ key: 'mcp', text: `mcp:${connected}/${total}`, color: 'warning', dropRank: 6 });
    } else if (state === 'failed') {
      chips.push({ key: 'mcp', text: 'mcp:failed', color: 'error', dropRank: 6 });
    }
  }
  if (status.permissionMode !== undefined && status.permissionMode !== 'default') {
    chips.push({ key: 'mode', text: `mode:${status.permissionMode}`, color: 'warning', dropRank: 3 });
  }
  if (status.cost !== undefined) {
    chips.push({ key: 'cost', text: `cost:$${status.cost.usd.toFixed(4)}`, color: 'info', dropRank: 2 });
  }
  const budget = status.toolBudget;
  if (budget !== undefined && budget.max !== undefined && budget.used > 0) {
    chips.push({
      key: 'tools',
      text: `tools:${budget.used}/${budget.max}`,
      color: budget.used >= budget.max * 0.8 ? 'warning' : 'info',
      dropRank: 1,
    });
  }
  if (status.isCompacting === true) {
    chips.push({ key: 'cmp', text: 'cmp:compacting…', color: 'warning', dropRank: 0 });
  } else if ((status.compactions ?? 0) > 0) {
    chips.push({ key: 'cmp', text: `cmp:${status.compactions}`, color: 'info', dropRank: 0 });
  }

  return chips;
}

/**
 * One dim status line (status-strip item D). Replaces the old 4-row bordered
 * header: no box, no `tok:` counter, no `[----------]` gauge — just the ` · `
 * separated chips on a single non-wrapping row (width-pinned so a resize can never
 * grow the line count). Chips drop whole per `layoutStatusChips` under narrow widths.
 */
function StatusLineView({ status, depth, width }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  const chips = layoutStatusChips(buildStatusChips(status), width);
  // Each chip (and its ` · ` separator) is its OWN <Text> flex item — the row is NOT one
  // wrapping <Text>. This is load-bearing, not cosmetic: a single wrapping `<Text
  // wrap="truncate-end">` reports a shrinkable min-content width (its longest word), and
  // in the tall-live-turn full-repaint layout Yoga offers that node only ~half the
  // terminal and Ink truncates the whole status mid-chip (`… · ctx ~5`, dropping `(0%) ·
  // medium`) even though the content fits the real width. Separate small Text items never
  // collapse that way, so the full status renders during a run exactly as it does idle.
  // `overflow: 'hidden'` clips the row to the box's real (correctly-computed) width as a
  // one-row backstop — `layoutStatusChips` already drops whole chips until the content
  // fits `width`, so it normally never fires, but it keeps the footer height structurally
  // fixed (never wrap-driven) if a chip ever overflows on resize.
  const rowOverflow = width === undefined ? undefined : 'hidden';
  const chipWrap = width === undefined ? undefined : 'truncate-end';
  return (
    <Box width={width} overflow={rowOverflow}>
      {chips.map((chip, i) => (
        <Fragment key={chip.key}>
          {i > 0 ? (
            <Text color={token('textDim', d)} wrap={chipWrap}>
              {SEP}
            </Text>
          ) : null}
          <Text color={token(chip.color, d)} wrap={chipWrap}>
            {chip.text}
          </Text>
        </Fragment>
      ))}
    </Box>
  );
}

/**
 * Memoized (statusline-memo, Wave 2 item C). The caller (app.tsx) hands a `status`
 * bundle that is itself `useMemo`d over every field `selectStatusLine` reads, so its
 * identity is STABLE across token flushes that touch no status field — the default
 * shallow compare then bails the render fn out entirely on those commits (`depth`
 * defaults module-level and `width` is the pinned column count, both stable). This
 * trims render-fn work + Yoga churn; it does NOT stop Ink re-serializing the footer
 * per commit below React (the 80ms repaint is Ink's, not React's).
 */
export const StatusLine = memo(StatusLineView);
