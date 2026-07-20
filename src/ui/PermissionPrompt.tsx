import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { buildDiff, diffMarker, type DiffLineKind } from './diff';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';
import { humanizeArgs } from './ToolCallCard';
import { rowsForText } from './clipText';

const DEPTH: ColorDepth = detectColorDepth();

/** Max diff lines shown in the prompt so a huge write can't flood the overlay
 * (fits a 24-row terminal so the y/a/d/! controls stay on screen). */
const DIFF_MAX_LINES = 16;

/** The overlay's bold heading. A shared const so the component render and
 *  {@link permissionPromptRows} measure the SAME string (anti-drift). */
const PROMPT_TITLE = '⚠ permission required';
/** Horizontal chrome the round border (2) + paddingLeft(1) + paddingRight(1) steal from the
 *  terminal width, so the inner content wraps at `width - 4`. */
const PROMPT_HORIZONTAL_CHROME = 4;

/** The key-binding hint line. Dangerous risk drops `[a] always allow` (see keyToDecision). A
 *  shared builder so the component and {@link permissionPromptRows} render/measure one string. */
function controlsLine(risk: RiskLevel): string {
  return risk === 'dangerous'
    ? '[y] allow once   [d] deny   [!] dangerous bypass'
    : '[y] allow once   [a] always allow   [d] deny   [!] dangerous bypass';
}

/**
 * Non-diff rows the overlay always needs on screen: round border (2) + the
 * title line + the tool/risk line + the "… +N lines" overflow marker + the
 * controls line (5), plus the headroom the app keeps below the overlay for the
 * status line + input box (≈8). Subtracted from the live terminal height so the
 * diff region never grows tall enough to push the y/a/d/! controls off screen.
 */
const PROMPT_RESERVED_ROWS = 13;

/**
 * The shown-diff cap: without a live terminal height keep the static DIFF_MAX_LINES; with
 * one, tighten it so the diff region + fixed chrome can never exceed the screen. Factored
 * out so the component render AND {@link permissionPromptRows} compute the SAME cap — they
 * cannot drift (a drift would make the budget-reserved height disagree with the render).
 */
export function permissionDiffCap(rows: number | undefined): number {
  return rows === undefined
    ? DIFF_MAX_LINES
    : Math.max(1, Math.min(DIFF_MAX_LINES, rows - PROMPT_RESERVED_ROWS));
}

/** Diff line kind -> theme token. Added=green, removed=red, context/meta=dim. */
function diffToken(kind: DiffLineKind): FlatTokenName {
  switch (kind) {
    case 'add':
      return 'success';
    case 'remove':
      return 'error';
    case 'context':
    case 'meta':
      return 'textDim';
  }
}

export interface PermissionRequest {
  toolCallId: string;
  name: string;
  args: unknown;
  risk: RiskLevel;
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  onDecision: (d: PermissionDecision) => void;
  /** Live terminal width (threaded from the root). When set, the overlay is
   * width-capped and diff/arg lines truncate instead of wrapping, so one long
   * unbroken line stays one screen row. */
  width?: number;
  /** Live terminal height (threaded from the root). When set, the shown-diff
   * cap tightens so the controls stay visible on a short terminal. */
  rows?: number;
}

/** Risk -> tint token. Exhaustive over RiskLevel. Exported for the exhaustiveness
 * unit test (every RiskLevel must resolve to a defined token). */
export function riskToken(risk: RiskLevel): FlatTokenName {
  switch (risk) {
    case 'safe':
      return 'success';
    case 'risky':
      return 'warning';
    case 'dangerous':
      return 'error';
    case 'sandboxed':
      // OS-confined run_shell — normally auto-allows, so this prompt rarely shows;
      // tint it 'warning' (a confined-but-notable cue) rather than 'error'.
      return 'warning';
  }
}

/** Map a keystroke to a decision, or null if it is not a binding.
 * For `dangerous` risk the `a` (always allow) binding is DISABLED: the
 * remembered pattern would be the bare tool name, which matches EVERY future
 * call — one 'a' on a benign shell command would blanket-grant all commands
 * forever. Dangerous tools offer only allow-once / deny / explicit bypass.
 * (The policy additionally refuses to satisfy dangerous risk from an
 * always-allow-pattern rule even if one exists — see policy.ts.) */
function keyToDecision(input: string, risk: RiskLevel): PermissionDecision | null {
  switch (input) {
    case 'y':
      return 'allow-once';
    case 'a':
      return risk === 'dangerous' ? null : 'always-allow-pattern';
    case 'd':
      return 'deny';
    case '!':
      return 'dangerous-bypass';
    default:
      return null;
  }
}

export function PermissionPrompt({ request, onDecision, width, rows }: PermissionPromptProps): ReactElement {
  const decidedRef = useRef(false);

  useInput((input) => {
    if (decidedRef.current) return;
    const decision = keyToDecision(input, request.risk);
    if (decision !== null) {
      decidedRef.current = true;
      onDecision(decision);
    }
  });

  const color = token(riskToken(request.risk), DEPTH);
  // For file mutations (write_file/edit_file) show a colorized unified-diff
  // preview instead of the one-lined args payload; anything else humanizes the
  // args to the ONE meaningful field (shell→command, Read→path, mcp__…→primary
  // arg, …) — the SAME condenser the grouped tool rows use — so the prompt never
  // prints a raw `{"command":…}` JSON blob (wave-9 humanizeArgs parity).
  const diff = buildDiff(request.name, request.args);
  const args = diff === null ? humanizeArgs(request.name, request.args) : '';
  // With a live terminal height, tighten the shown-diff cap so the diff region
  // + fixed chrome can never be taller than the screen (the count cap alone
  // does NOT bound HEIGHT — see width-aware truncation below). Without one, keep
  // the static DIFF_MAX_LINES cap (isolated component tests).
  const maxDiffLines = permissionDiffCap(rows);
  const shownDiff = diff !== null ? diff.slice(0, maxDiffLines) : [];
  const hiddenDiff = diff !== null ? diff.length - shownDiff.length : 0;
  // When width is known, cap the overlay and truncate long lines to one screen
  // row apiece so a single unbroken diff/arg line can't wrap the controls off
  // screen. Mirrors StatusLine's `width === undefined` no-op guard.
  const textWrap = width === undefined ? undefined : 'truncate-end';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingLeft={1}
      paddingRight={1}
      width={width}
    >
      <Text color={color} bold>
        {PROMPT_TITLE}
      </Text>
      <Box gap={1}>
        <Text color={token('text', DEPTH)} bold wrap={textWrap}>
          {request.name}
        </Text>
        <Text color={token('textDim', DEPTH)}>risk:</Text>
        <Text color={color} bold>
          {request.risk}
        </Text>
      </Box>
      {diff !== null ? (
        <Box flexDirection="column">
          {shownDiff.map((line, i) => (
            <Text key={i} color={token(diffToken(line.kind), DEPTH)} wrap={textWrap}>
              {diffMarker(line.kind)} {line.text}
            </Text>
          ))}
          {hiddenDiff > 0 ? (
            <Text color={token('textDim', DEPTH)}>
              … +{hiddenDiff} line{hiddenDiff === 1 ? '' : 's'}
            </Text>
          ) : null}
        </Box>
      ) : args.length > 0 ? (
        <Text color={token('textDim', DEPTH)} wrap={textWrap}>
          {args}
        </Text>
      ) : null}
      <Text color={token('text', DEPTH)}>{controlsLine(request.risk)}</Text>
    </Box>
  );
}

/**
 * An UPPER bound on the terminal-row height {@link PermissionPrompt} renders at, mirroring the
 * component's layout so app.tsx can reserve it in the live budget (src/ui/liveBudget.ts) —
 * a permission prompt opened mid-turn must not push the dynamic region past the viewport.
 * Fixed chrome: 2 (round border) + the title + 1 (tool/risk line) + the body + the controls line.
 * The body is either the shown diff (capped by the SAME {@link permissionDiffCap} the component
 * uses, plus one row for the `… +N` overflow marker) or a single humanized-args row (truncate-end
 * → one row) — 0 when there are no args.
 *
 * The title and controls lines carry NO wrap='truncate-end' (only the body/name/arg lines do), so
 * on a narrow terminal Ink WORD-wraps them past one row — the non-dangerous controls string is
 * ~67 cells and wraps below ~70 cols. Measuring them via `rowsForText` at the overlay's inner
 * content width (terminal width minus {@link PROMPT_HORIZONTAL_CHROME}) makes the reserve a true
 * upper bound; hardcoding 1 each under-counted and re-opened the `>= rows` scrollback-erase edge
 * on a narrow terminal. `width` undefined (isolated callers) ⇒ no wrap ⇒ one row each.
 */
export function permissionPromptRows(
  request: PermissionRequest,
  width: number | undefined,
  rows: number | undefined,
): number {
  const diff = buildDiff(request.name, request.args);
  let body: number;
  if (diff !== null) {
    const shown = Math.min(diff.length, permissionDiffCap(rows));
    body = shown + (diff.length > shown ? 1 : 0);
  } else {
    const args = humanizeArgs(request.name, request.args);
    body = args.length > 0 ? 1 : 0;
  }
  const inner = width === undefined ? Number.POSITIVE_INFINITY : Math.max(1, width - PROMPT_HORIZONTAL_CHROME);
  const titleRows = rowsForText(PROMPT_TITLE, inner);
  const controlRows = rowsForText(controlsLine(request.risk), inner);
  return 2 /* round border */ + titleRows + 1 /* tool/risk line */ + body + controlRows;
}
