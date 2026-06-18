import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ModelEntry } from '../services/catalog';
import { detectColorDepth, token, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface CommandPaletteEntry {
  readonly name: string;
  readonly description: string;
}

export interface SkillPaletteEntry {
  readonly name: string;
  readonly description: string;
}

export interface SlashPaletteProps {
  commands: Array<CommandPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
}

export interface SkillPickerProps {
  skills: ReadonlyArray<SkillPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export type PermissionModeOption = 'default' | 'acceptEdits';

export interface PermissionModePickerProps {
  selectedMode?: PermissionModeOption;
  depth?: ColorDepth;
}

export const PERMISSION_MODE_OPTIONS = [
  { mode: 'default', description: 'Prompt for edits' },
  { mode: 'acceptEdits', description: 'Accept edit tools' },
] as const satisfies ReadonlyArray<{ mode: PermissionModeOption; description: string }>;

export type UnifiedCommandPaletteProps =
  | ({ mode: 'slash' } & SlashPaletteProps)
  | ({ mode: 'model' } & ModelPickerProps)
  | ({ mode: 'skills' } & SkillPickerProps)
  | ({ mode: 'permission-mode' } & PermissionModePickerProps);

interface PaletteRow {
  readonly key: string;
  readonly primary: string;
  readonly secondary: string;
  readonly selected: boolean;
}

function frame(header: string, rows: ReadonlyArray<PaletteRow>, depth: ColorDepth): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', depth)} paddingLeft={1} paddingRight={1}>
      <Text color={token('textDim', depth)}>{header}</Text>
      {rows.map((row) => {
        const marker = row.selected ? '▸' : ' ';
        return (
          <Box key={row.key} gap={1}>
            <Text color={row.selected ? token('accent', depth) : token('textDim', depth)}>{marker}</Text>
            <Text color={row.selected ? token('accent', depth) : token('text', depth)} bold={row.selected}>
              {row.primary}
            </Text>
            <Text color={token('textDim', depth)}>{row.secondary}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function UnifiedCommandPalette(props: UnifiedCommandPaletteProps): ReactElement {
  const d = props.depth ?? DEPTH;

  switch (props.mode) {
    case 'slash':
      return frame(
        'commands',
        props.commands.map((command, index) => ({
          key: command.name,
          primary: `/${command.name}`,
          secondary: command.description,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
      );

    case 'model':
      return frame(
        'models',
        props.models.map((model) => ({
          key: model.id,
          primary: model.label,
          secondary: model.id,
          selected: model.id === props.selectedId,
        })),
        d,
      );

    case 'skills':
      return frame(
        'skills',
        props.skills.map((skill, index) => ({
          key: skill.name,
          primary: skill.name,
          secondary: skill.description,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
      );

    case 'permission-mode':
      return frame(
        'permission mode',
        PERMISSION_MODE_OPTIONS.map((option) => ({
          key: option.mode,
          primary: option.mode,
          secondary: option.description,
          selected: option.mode === (props.selectedMode ?? 'default'),
        })),
        d,
      );
  }
}
