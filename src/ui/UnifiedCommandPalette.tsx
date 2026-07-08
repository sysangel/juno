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
  rows?: number;
  /**
   * The active type-to-filter query (the command word typed after `/`). When set it
   * is echoed in the palette header so the user sees what they are narrowing by.
   * Omitted/empty ⇒ the plain `commands` header (the full, unfiltered list).
   */
  query?: string;
}

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
  rows?: number;
}

export interface SkillPickerProps {
  skills: ReadonlyArray<SkillPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
  rows?: number;
}

export interface SessionPaletteEntry {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface SessionPickerProps {
  sessions: ReadonlyArray<SessionPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
  rows?: number;
}

export type PermissionModeOption = 'default' | 'acceptEdits';

export interface PermissionModePickerProps {
  selectedMode?: PermissionModeOption;
  depth?: ColorDepth;
  rows?: number;
}

/**
 * Empty-state hint for the skills picker (F). Names the real user skills root juno
 * scans (`~/.claude/skills`; see createSkillsService) so the message is honest —
 * the wave's surface-honestly ethos over the spec's illustrative `~/.config/juno/skills`.
 * Exported so the empty-state test asserts the SOURCE string, not a duplicated literal.
 */
export const SKILLS_EMPTY_HINT = 'no skills found (~/.claude/skills)';

/**
 * Empty-state hint for the slash palette when a type-to-filter query matches no
 * command (mirrors SKILLS_EMPTY_HINT: a dim line, not a bare box). Exported so the
 * empty-filter test asserts the SOURCE string, not a duplicated literal.
 */
export const SLASH_EMPTY_HINT = 'no matching command';

export const PERMISSION_MODE_OPTIONS = [
  { mode: 'default', description: 'Prompt for edits' },
  { mode: 'acceptEdits', description: 'Accept edit tools' },
] as const satisfies ReadonlyArray<{ mode: PermissionModeOption; description: string }>;

export interface HelpOverlayProps {
  depth?: ColorDepth;
  rows?: number;
}

/**
 * The keybind cheatsheet rendered by the help overlay (? or /help). Static data —
 * keep in sync with useKeybinds + PermissionPrompt bindings. Exported so tests
 * assert the overlay renders every advertised binding.
 */
export const HELP_KEYBINDS = [
  { key: 'Esc', description: 'Abort the turn / close an overlay' },
  { key: 'Tab', description: 'Cycle effort level' },
  { key: '/', description: 'Open the command palette (empty input)' },
  { key: '?', description: 'Show this help (empty input)' },
  { key: 'Ctrl+M', description: 'Open the model picker' },
  { key: '↑ ↓ Enter', description: 'Navigate / accept in pickers' },
  { key: 'y a d !', description: 'Permission prompt: once / always / deny / bypass' },
] as const satisfies ReadonlyArray<{ key: string; description: string }>;

export type UnifiedCommandPaletteProps =
  | ({ mode: 'slash' } & SlashPaletteProps)
  | ({ mode: 'model' } & ModelPickerProps)
  | ({ mode: 'skills' } & SkillPickerProps)
  | ({ mode: 'session' } & SessionPickerProps)
  | ({ mode: 'permission-mode' } & PermissionModePickerProps)
  | ({ mode: 'help' } & HelpOverlayProps);

interface PaletteRow {
  readonly key: string;
  readonly primary: string;
  readonly secondary: string;
  readonly selected: boolean;
}

/**
 * Rows a windowed palette cannot spend on entries: round border (2) + the
 * header line (1) + the two "… +N more" overflow markers (2), plus the headroom
 * the surrounding app keeps below the overlay for the status line + input box
 * (≈8). Subtracted from the live terminal height to size the entry window so
 * the palette (and the selected row) always fits on screen.
 */
const PALETTE_RESERVED_ROWS = 13;

export interface RowWindow {
  readonly start: number;
  readonly count: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * Pick the slice of `total` rows to render so the selection stays on screen.
 * The window is centered on `selectedIndex` and clamped to the ends, which
 * keeps the highlight visible and scrolls the window as the selection moves.
 * `maxVisible <= 0` or a list that already fits returns the whole list.
 */
export function computeRowWindow(total: number, selectedIndex: number, maxVisible: number): RowWindow {
  if (maxVisible <= 0 || total <= maxVisible) {
    return { start: 0, count: total, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const anchor = selectedIndex < 0 ? 0 : Math.min(selectedIndex, total - 1);
  const start = Math.min(Math.max(0, anchor - Math.floor(maxVisible / 2)), total - maxVisible);
  return {
    start,
    count: maxVisible,
    hiddenAbove: start,
    hiddenBelow: total - (start + maxVisible),
  };
}

function frame(
  header: string,
  rows: ReadonlyArray<PaletteRow>,
  depth: ColorDepth,
  terminalRows?: number,
  emptyMessage?: string,
): ReactElement {
  // Without a live terminal height (e.g. isolated component tests) fall back to
  // rendering every row — mirrors StatusLine's `width === undefined` guard.
  const maxVisible =
    terminalRows === undefined ? rows.length : Math.max(1, terminalRows - PALETTE_RESERVED_ROWS);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const window = computeRowWindow(rows.length, selectedIndex, maxVisible);
  const visible = rows.slice(window.start, window.start + window.count);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={token('border', depth)} paddingLeft={1} paddingRight={1}>
      <Text color={token('textDim', depth)}>{header}</Text>
      {rows.length === 0 && emptyMessage !== undefined ? (
        <Text color={token('textDim', depth)} dimColor>
          {emptyMessage}
        </Text>
      ) : null}
      {window.hiddenAbove > 0 ? (
        <Text color={token('textDim', depth)} dimColor>
          … +{window.hiddenAbove} more above
        </Text>
      ) : null}
      {visible.map((row) => {
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
      {window.hiddenBelow > 0 ? (
        <Text color={token('textDim', depth)} dimColor>
          … +{window.hiddenBelow} more below
        </Text>
      ) : null}
    </Box>
  );
}

export function UnifiedCommandPalette(props: UnifiedCommandPaletteProps): ReactElement {
  const d = props.depth ?? DEPTH;

  switch (props.mode) {
    case 'slash':
      return frame(
        // Echo the active filter query in the header (still contains 'commands' so the
        // enumeration test's substring check holds). Plain 'commands' when unfiltered.
        props.query !== undefined && props.query.length > 0
          ? `commands · /${props.query}`
          : 'commands',
        props.commands.map((command, index) => ({
          key: command.name,
          primary: `/${command.name}`,
          secondary: command.description,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
        props.rows,
        // Empty-filter hint (a dim line, not a bare box) when the query matches nothing.
        SLASH_EMPTY_HINT,
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
        props.rows,
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
        props.rows,
        // Empty-state hint (F): the real discovery root, not a bare box. Points at the
        // user skills dir juno actually scans (see createSkillsService).
        SKILLS_EMPTY_HINT,
      );

    case 'session':
      return frame(
        'sessions',
        props.sessions.map((session, index) => ({
          key: session.id,
          primary: session.title,
          secondary: session.subtitle,
          selected: index === (props.selectedIndex ?? 0),
        })),
        d,
        props.rows,
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
        props.rows,
      );

    case 'help':
      // Keybind cheatsheet — non-interactive rows (nothing is "selected"), reusing
      // the shared palette frame for visual consistency. Esc closes.
      return frame(
        'keyboard shortcuts',
        HELP_KEYBINDS.map((bind) => ({
          key: bind.key,
          primary: bind.key,
          secondary: bind.description,
          selected: false,
        })),
        d,
        props.rows,
      );
  }
}
