import { Box, Text } from 'ink';
import { memo, type ReactElement } from 'react';
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
