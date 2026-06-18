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
}

export function InputBox({ value, onChange, onSubmit, placeholder, depth }: InputBoxProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box>
      <Text color={token('accent', d)}>{'❯ '}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder ?? ''} />
    </Box>
  );
}
