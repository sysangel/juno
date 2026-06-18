import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface SlashPaletteProps {
  commands: Array<{ name: string; description: string }>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export function SlashPalette({ commands, selectedIndex = 0, depth }: SlashPaletteProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', d)} paddingLeft={1} paddingRight={1}>
      <Text color={token('textDim', d)}>commands</Text>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const marker = selected ? '▸' : ' ';
        return (
          <Box key={command.name} gap={1}>
            <Text color={selected ? token('accent', d) : token('textDim', d)}>{marker}</Text>
            <Text color={selected ? token('accent', d) : token('text', d)} bold={selected}>
              /{command.name}
            </Text>
            <Text color={token('textDim', d)}>{command.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
