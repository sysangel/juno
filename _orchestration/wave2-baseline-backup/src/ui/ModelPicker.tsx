import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ModelEntry } from '../services/catalog';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
}

export function ModelPicker({ models, selectedId, depth }: ModelPickerProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', d)} paddingLeft={1} paddingRight={1}>
      <Text color={token('textDim', d)}>models</Text>
      {models.map((model) => {
        const selected = model.id === selectedId;
        const marker = selected ? '▸' : ' ';
        return (
          <Box key={model.id} gap={1}>
            <Text color={selected ? token('accent', d) : token('textDim', d)}>{marker}</Text>
            <Text color={selected ? token('accent', d) : token('text', d)} bold={selected}>
              {model.label}
            </Text>
            <Text color={token('textDim', d)}>{model.id}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
