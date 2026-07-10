import { Box, Text } from 'ink';
import { memo, type MutableRefObject, type ReactElement } from 'react';
import { Composer } from './Composer';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface InputBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  depth?: ColorDepth;
  /**
   * Focus gate for the composer. When false, the Composer's own useInput goes
   * inactive so keystrokes do NOT edit the input — REQUIRED while any overlay is
   * open: useKeybinds only swallows keybind ACTIONS, but Ink still delivers every
   * keypress to each active useInput, so an ungated composer types behind
   * overlays. Default true.
   */
  focus?: boolean;
  /** Up on the first line → recall an older history entry (G). Wired only at overlay 'none'. */
  onHistoryPrev?: () => void;
  /** Down on the last line → recall a newer entry / restore the draft (G). */
  onHistoryNext?: () => void;
  /**
   * Shared in-paste flag the Composer mirrors from its bracketed-paste buffer, so a
   * sibling useInput (useKeybinds) can ignore keys mid-paste. Threaded straight through.
   */
  pasteActiveRef?: MutableRefObject<boolean>;
}

function InputBoxView({
  value,
  onChange,
  onSubmit,
  placeholder,
  depth,
  focus,
  onHistoryPrev,
  onHistoryNext,
  pasteActiveRef,
}: InputBoxProps): ReactElement {
  const d = depth ?? DEPTH;
  // Render our OWN dim placeholder instead of the composer's built-in one: the
  // upstream ink-text-input placeholder painted the first char with `chalk.inverse`
  // (a fake cursor OVER the text), the boxed-header-era artifact. The Composer emits
  // just its clean inverse-space cursor block when the input is empty+focused; the
  // dim placeholder text then sits AFTER that block.
  const showPlaceholder = value.length === 0 && placeholder !== undefined && placeholder.length > 0;
  return (
    <Box>
      <Text color={token('accent', d)}>{'❯ '}</Text>
      <Composer
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={focus ?? true}
        onHistoryPrev={onHistoryPrev}
        onHistoryNext={onHistoryNext}
        pasteActiveRef={pasteActiveRef}
      />
      {showPlaceholder ? <Text color={token('textDim', d)}>{placeholder}</Text> : null}
    </Box>
  );
}

/**
 * Memoized (statusline-memo, Wave 2 item C). app.tsx feeds `onChange`/`onSubmit`
 * from `useCallback` and a constant `placeholder`, so shallow compare only re-renders
 * on a real `value`/`focus`/`depth` change — a token flush mid-turn no longer re-runs
 * the composer's render fn. TextInput keeps its own internal cursor state; memo gates
 * only parent-prop-driven re-renders, so nothing about focus or editing changes.
 */
export const InputBox = memo(InputBoxView);

/** Single box-drawing hairline char (U+2500). One row, never a full border box. */
const RULE_CHAR = '─';

export interface ComposerRuleProps {
  /** Terminal columns — the rule spans exactly this width. Undefined (isolated
   *  component tests) falls back to a short fixed span so the hairline still shows. */
  width?: number;
  depth?: ColorDepth;
  /**
   * Right-anchored mode tag (Claude-Code's mode-tag pattern). Rendered only when set
   * AND not `'default'` — the default mode is the silent happy path, so the top rule
   * is a bare hairline then. A stable-identity string prop, so the memo below bails on
   * token flushes (permissionMode never moves mid-stream).
   */
  mode?: string;
  /** One blank line ABOVE the rule — the single transcript↔composer gap (top rule only). */
  spaceAbove?: boolean;
}

/**
 * Dim hairline rule that brackets the composer (composer-framing, Wave 3). Two of
 * these — one above (with the mode tag) and one below the InputBox — frame the input
 * WITHOUT a full border box (which would eat two extra columns + read heavier). Uses
 * the shared `token('border', depth)` so it matches the adjacent overlay borders in
 * both the dark and light palettes. The optional mode tag is right-anchored: dashes
 * fill the row up to the tag so a resize can never grow the line count.
 */
function ComposerRuleView({ width, depth, mode, spaceAbove }: ComposerRuleProps): ReactElement {
  const d = depth ?? DEPTH;
  const showChip = mode !== undefined && mode.length > 0 && mode !== 'default';
  const chipText = showChip ? ` mode:${mode} ` : '';
  // Fallback span when width is unknown (isolated tests): a short rule that still
  // renders the hairline + any tag.
  const span = width ?? Math.max(chipText.length + 8, 24);
  // Drop the tag on a width too narrow to hold it plus a few dashes, so the rule can
  // never wrap to a second row (which would add a stray blank beyond the two rules).
  const fits = chipText.length === 0 || span - chipText.length >= 4;
  const dashCount = Math.max(0, span - (fits ? chipText.length : 0));
  return (
    <Box width={width} marginTop={spaceAbove === true ? 1 : 0}>
      <Text color={token('border', d)}>{RULE_CHAR.repeat(dashCount)}</Text>
      {fits && chipText.length > 0 ? <Text color={token('warning', d)}>{chipText}</Text> : null}
    </Box>
  );
}

/**
 * Memoized: all props (`width`, `depth`, `mode`, `spaceAbove`) are stable-identity
 * primitives across a token flush, so the rule bails out on mid-stream re-renders
 * exactly like the InputBox/StatusLine it sits between.
 */
export const ComposerRule = memo(ComposerRuleView);
