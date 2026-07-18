import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ModelEntry } from '../services/catalog';
import { clipCells, displayWidth } from './clipText';
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
   * Live terminal width in columns. When set, {@link frame} fixes the palette box to it
   * and clips the header/footer and every entry so each row is provably one visual line
   * (the invariant computeRowWindow assumes). Omitted ⇒ isolated-component fallback: no
   * width, bare rows, exactly the legacy render.
   */
  columns?: number;
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
  /** Live terminal width — see {@link SlashPaletteProps.columns}. */
  columns?: number;
}

export interface SkillPickerProps {
  skills: ReadonlyArray<SkillPaletteEntry>;
  selectedIndex?: number;
  depth?: ColorDepth;
  rows?: number;
  /** Live terminal width — see {@link SlashPaletteProps.columns}. */
  columns?: number;
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
  /** Live terminal width — see {@link SlashPaletteProps.columns}. */
  columns?: number;
}

export type PermissionModeOption = 'default' | 'acceptEdits';

export interface PermissionModePickerProps {
  selectedMode?: PermissionModeOption;
  depth?: ColorDepth;
  rows?: number;
  /** Live terminal width — see {@link SlashPaletteProps.columns}. */
  columns?: number;
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

/**
 * Empty-state hint for the session picker (C). openSessionPicker opens unconditionally
 * (even with zero saved sessions); this dim line makes the otherwise-bare box
 * self-explanatory instead of showing just a header. Exported so the empty-state test
 * asserts the SOURCE string, not a duplicated literal.
 */
export const SESSIONS_EMPTY_HINT = 'no saved sessions yet';

/**
 * Footer hint (B) rendered as frame()'s final dim line. Interactive pickers
 * (slash/model/skills/session/permission-mode) advertise the shared navigation controls
 * — mirroring the explicit controls ToolDetailOverlay/PermissionPrompt already show — so
 * the palette is not silent about how to move/accept/cancel. Exported for the footer test.
 */
export const PALETTE_FOOTER_HINT = '↑↓ move · enter select · esc cancel';

/**
 * Footer hint for the help overlay (B): the cheatsheet is non-interactive (Esc closes),
 * so it advertises only that. Exported for the footer test.
 */
export const HELP_FOOTER_HINT = 'esc close';

export const PERMISSION_MODE_OPTIONS = [
  { mode: 'default', description: 'Prompt for edits' },
  { mode: 'acceptEdits', description: 'Accept edit tools' },
] as const satisfies ReadonlyArray<{ mode: PermissionModeOption; description: string }>;

export interface HelpOverlayProps {
  depth?: ColorDepth;
  rows?: number;
  /** Live terminal width — see {@link SlashPaletteProps.columns}. */
  columns?: number;
}

/**
 * The keybind cheatsheet rendered by the help overlay (? or /help). Static data —
 * keep in sync with useKeybinds + PermissionPrompt bindings. Exported so tests
 * assert the overlay renders every advertised binding.
 */
export const HELP_KEYBINDS = [
  { key: 'Esc', description: 'Abort the turn / close an overlay' },
  { key: 'Ctrl+C', description: 'Abort turn / press twice to exit' },
  { key: 'Tab', description: 'Cycle effort level' },
  { key: '/', description: 'Open the command palette (empty input)' },
  { key: '?', description: 'Show this help (empty input)' },
  { key: '↓', description: 'Focus the agents dropdown (empty input)' },
  { key: 'Ctrl+O', description: 'Open the tool-call detail overlay' },
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
 * header line (1) + the footer hint line (1) + the two "… +N more" overflow
 * markers (2), plus the headroom the surrounding app keeps below the overlay
 * for the status line + input box (≈8). Subtracted from the live terminal
 * height to size the entry window so the palette (and the selected row) always
 * fits on screen. Bumped 13→14 when the footer hint (B) added its line.
 */
const PALETTE_RESERVED_ROWS = 14;

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

interface FrameOptions {
  /** Live terminal HEIGHT — sizes the entry window (see PALETTE_RESERVED_ROWS). */
  readonly terminalRows?: number;
  /** Live terminal WIDTH — fixes the box width and clips every line to fit (Part A). */
  readonly columns?: number;
  /** Dim footer hint rendered as the box's final line (Part B). */
  readonly footer?: string;
  /** Dim line shown in place of entries when `rows` is empty (Part C etc). */
  readonly emptyMessage?: string;
}

function frame(
  header: string,
  rows: ReadonlyArray<PaletteRow>,
  depth: ColorDepth,
  opts: FrameOptions = {},
): ReactElement {
  const { terminalRows, columns, footer, emptyMessage } = opts;
  // Without a live terminal height (e.g. isolated component tests) fall back to
  // rendering every row — mirrors StatusLine's `width === undefined` guard.
  const maxVisible =
    terminalRows === undefined ? rows.length : Math.max(1, terminalRows - PALETTE_RESERVED_ROWS);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const window = computeRowWindow(rows.length, selectedIndex, maxVisible);
  const visible = rows.slice(window.start, window.start + window.count);

  // Inner content budget of the bordered box: total columns minus the round
  // border (1 cell each side) minus the horizontal padding (1 cell each side)
  // = columns − 4 (Ink's box model). Undefined when no live width is threaded
  // (isolated component tests) — then every line renders unclipped and the box
  // auto-sizes, exactly the legacy behaviour.
  const inner = columns === undefined ? undefined : columns - 4;
  return (
    <Box
      flexDirection="column"
      width={columns}
      borderStyle="round"
      borderColor={token('border', depth)}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text color={token('textDim', depth)}>{inner === undefined ? header : clipCells(header, inner)}</Text>
      {rows.length === 0 && emptyMessage !== undefined ? (
        <Text color={token('textDim', depth)} dimColor>
          {inner === undefined ? emptyMessage : clipCells(emptyMessage, inner)}
        </Text>
      ) : null}
      {window.hiddenAbove > 0 ? (
        <Text color={token('textDim', depth)} dimColor>
          … +{window.hiddenAbove} more above
        </Text>
      ) : null}
      {visible.map((row) => {
        const marker = row.selected ? '▸' : ' ';
        if (inner !== undefined) {
          // Row layout in cells: marker(1) + gap(1) + primary + gap(1) + secondary.
          // Budget the secondary against the space the marker/gaps and the MEASURED
          // (cell, not code-unit) primary width leave; when that is non-positive the
          // primary alone fills the row, so drop the secondary and clip the primary to
          // its own share (inner − marker − gap). Every entry is then provably one line.
          const primaryWidth = displayWidth(row.primary);
          const secondaryBudget = inner - 2 - primaryWidth - 1;
          const showSecondary = secondaryBudget > 0;
          const primary = showSecondary ? row.primary : clipCells(row.primary, inner - 2);
          const secondary = showSecondary ? clipCells(row.secondary, secondaryBudget) : '';
          return (
            <Box key={row.key} gap={1}>
              <Text color={row.selected ? token('accent', depth) : token('textDim', depth)}>{marker}</Text>
              <Text color={row.selected ? token('accent', depth) : token('text', depth)} bold={row.selected}>
                {primary}
              </Text>
              {secondary.length > 0 ? <Text color={token('textDim', depth)}>{secondary}</Text> : null}
            </Box>
          );
        }
        // No live width (isolated component tests): the exact legacy row structure —
        // bare, unclipped, secondary always present — so existing snapshots are untouched.
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
      {footer !== undefined ? (
        <Text color={token('textDim', depth)} dimColor>
          {inner === undefined ? footer : clipCells(footer, inner)}
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
        {
          terminalRows: props.rows,
          columns: props.columns,
          footer: PALETTE_FOOTER_HINT,
          // Empty-filter hint (a dim line, not a bare box) when the query matches nothing.
          emptyMessage: SLASH_EMPTY_HINT,
        },
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
        { terminalRows: props.rows, columns: props.columns, footer: PALETTE_FOOTER_HINT },
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
        {
          terminalRows: props.rows,
          columns: props.columns,
          footer: PALETTE_FOOTER_HINT,
          // Empty-state hint (F): the real discovery root, not a bare box. Points at the
          // user skills dir juno actually scans (see createSkillsService).
          emptyMessage: SKILLS_EMPTY_HINT,
        },
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
        {
          terminalRows: props.rows,
          columns: props.columns,
          footer: PALETTE_FOOTER_HINT,
          // Empty-state hint (C): the picker opens even with zero saved sessions, so a
          // dim line explains the bare box instead of showing only the header.
          emptyMessage: SESSIONS_EMPTY_HINT,
        },
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
        { terminalRows: props.rows, columns: props.columns, footer: PALETTE_FOOTER_HINT },
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
        { terminalRows: props.rows, columns: props.columns, footer: HELP_FOOTER_HINT },
      );
  }
}
