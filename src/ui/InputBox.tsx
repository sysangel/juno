import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { ReactElement } from 'react';
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

export function InputBox({ value, onChange, onSubmit, placeholder, depth, focus }: InputBoxProps): ReactElement {
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
