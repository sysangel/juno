import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { buildDiff, diffMarker, type DiffLineKind } from './diff';
import { detectColorDepth, token, type ColorDepth, type FlatTokenName } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

/** Max diff lines shown in the prompt so a huge write can't flood the overlay
 * (fits a 24-row terminal so the y/a/d/! controls stay on screen). */
const DIFF_MAX_LINES = 16;

/**
 * Non-diff rows the overlay always needs on screen: round border (2) + the
 * title line + the tool/risk line + the "… +N lines" overflow marker + the
 * controls line (5), plus the headroom the app keeps below the overlay for the
 * status line + input box (≈8). Subtracted from the live terminal height so the
 * diff region never grows tall enough to push the y/a/d/! controls off screen.
 */
const PROMPT_RESERVED_ROWS = 13;

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

/** Risk -> tint token. Exhaustive over RiskLevel ('safe' | 'risky' | 'dangerous'). */
function riskToken(risk: RiskLevel): FlatTokenName {
  switch (risk) {
    case 'safe':
      return 'success';
    case 'risky':
      return 'warning';
    case 'dangerous':
      return 'error';
  }
}

/** Narrow `unknown` args to a compact one-line string for display. */
function compact(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value) ?? '[unserializable]';
    return s;
  } catch {
    return '[unserializable]';
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
  // preview instead of the one-lined args payload; anything else keeps the
  // compact arg summary.
  const diff = buildDiff(request.name, request.args);
  const args = diff === null ? compact(request.args) : '';
  // With a live terminal height, tighten the shown-diff cap so the diff region
  // + fixed chrome can never be taller than the screen (the count cap alone
  // does NOT bound HEIGHT — see width-aware truncation below). Without one, keep
  // the static DIFF_MAX_LINES cap (isolated component tests).
  const maxDiffLines =
    rows === undefined ? DIFF_MAX_LINES : Math.max(1, Math.min(DIFF_MAX_LINES, rows - PROMPT_RESERVED_ROWS));
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
        ⚠ permission required
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
            <Text color={token('textDim', DEPTH)} dimColor>
              … +{hiddenDiff} line{hiddenDiff === 1 ? '' : 's'}
            </Text>
          ) : null}
        </Box>
      ) : args.length > 0 ? (
        <Text color={token('textDim', DEPTH)} wrap={textWrap}>
          {args}
        </Text>
      ) : null}
      <Text color={token('text', DEPTH)}>
        {request.risk === 'dangerous'
          ? '[y] allow once   [d] deny   [!] dangerous bypass'
          : '[y] allow once   [a] always allow   [d] deny   [!] dangerous bypass'}
      </Text>
    </Box>
  );
}
