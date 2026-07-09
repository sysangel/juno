import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { memo, type ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface InputBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  depth?: ColorDepth;
  /**
   * Focus gate for the composer. When false, TextInput's own useInput goes
   * inactive so keystrokes do NOT edit the input — REQUIRED while any overlay is
   * open: useKeybinds only swallows keybind ACTIONS, but Ink still delivers every
   * keypress to each active useInput, so an ungated TextInput types behind
   * overlays. Default true.
   */
  focus?: boolean;
}

function InputBoxView({ value, onChange, onSubmit, placeholder, depth, focus }: InputBoxProps): ReactElement {
  const d = depth ?? DEPTH;
  // Render our OWN dim placeholder instead of ink-text-input's built-in one: its
  // placeholder paints the first char with `chalk.inverse` (a fake cursor OVER the
  // text), the boxed-header-era artifact. Passing an empty placeholder makes
  // TextInput emit just its clean inverse-space cursor block when the input is
  // empty+focused; the dim placeholder text then sits AFTER that block.
  const showPlaceholder = value.length === 0 && placeholder !== undefined && placeholder.length > 0;
  return (
    <Box>
      <Text color={token('accent', d)}>{'❯ '}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder=""
        focus={focus ?? true}
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
