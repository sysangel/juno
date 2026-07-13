// src/app/slashCommands.ts
// W9 app-decompose — the slash-command REGISTRY + pure parsing/filtering helpers,
// extracted verbatim from app.tsx. No React: everything here is a pure function
// over strings and the registry, so the command surface has exactly one reason to
// change (what commands exist / how a typed line resolves to one) and is unit-
// testable without mounting the app. app.tsx re-exports the public names so
// existing imports (`from '../src/app'`) keep working unchanged.

/**
 * Parse a slash command name from an input string. Returns the lowercased
 * command word (without the leading `/`) or null when the input does not start
 * with `/` followed by at least one command character. Exported so the parse is
 * unit-testable in isolation.
 *
 *   parseSlashCommand('/clear')      → 'clear'
 *   parseSlashCommand('  /EFFORT')   → 'effort'
 *   parseSlashCommand('/model x')    → 'model'
 *   parseSlashCommand('hi /clear')   → null
 *   parseSlashCommand('/')           → null
 */
export function parseSlashCommand(value: string): string | null {
  const match = /^\/([A-Za-z0-9_-]+)/.exec(value.trimStart());
  const command = match?.[1];
  return command === undefined ? null : command.toLowerCase();
}

/**
 * Extract the inline argument text of a `/steer <text>` line. Unlike the other
 * single-word slash commands, `/steer` carries free-form guidance after the command
 * word. Returns the trimmed remainder, or null when there is no text (a bare `/steer`
 * is a no-op — nothing to inject). Exported so the extraction is unit-testable.
 *
 *   parseSteerArg('/steer go faster') → 'go faster'
 *   parseSteerArg('  /STEER  hi ')    → 'hi'
 *   parseSteerArg('/steer')           → null
 *   parseSteerArg('/steering wheel')  → null  (word-boundary: not the steer command)
 */
export function parseSteerArg(value: string): string | null {
  const m = /^\s*\/steer\b\s*(.*)$/i.exec(value);
  const rest = m?.[1]?.trim();
  return rest !== undefined && rest.length > 0 ? rest : null;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  /**
   * The command carries a free-form inline argument after the command word (only
   * `/steer` today). When such a command is chosen from the palette WITHOUT an arg
   * already typed, `runSlashCommand` prefills `/name ` and keeps the composer open
   * so the user types the arg inline (instead of the closing-is-a-no-op behavior).
   */
  readonly takesArgs?: boolean;
}

export const slashCommands: ReadonlyArray<SlashCommand> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
  { name: 'skills', description: 'Choose a skill' },
  { name: 'permissions', description: 'Set permission mode' },
  { name: 'compact', description: 'Summarize & compact the session' },
  { name: 'steer', description: 'Inject mid-turn guidance (no restart)', takesArgs: true },
  { name: 'resume', description: 'Resume a past session' },
  { name: 'mcp', description: 'Show MCP server status' },
  { name: 'help', description: 'Show keyboard shortcuts' },
];

/**
 * Filter the slash-command registry to those whose name starts with `query` (the
 * command word the user has typed after `/`). A null/empty query returns every
 * command. Case-insensitive to match parseSlashCommand's lowercasing. Exported as
 * a pure helper so the type-to-filter behavior is unit-testable in isolation.
 *
 *   filterSlashCommands(cmds, null)   → all commands
 *   filterSlashCommands(cmds, 'c')    → [clear, compact]
 *   filterSlashCommands(cmds, 'zzz')  → []
 */
export function filterSlashCommands(
  commands: ReadonlyArray<SlashCommand>,
  query: string | null,
): ReadonlyArray<SlashCommand> {
  const q = (query ?? '').toLowerCase();
  return commands.filter((command) => command.name.startsWith(q));
}

/**
 * Whether a `/command …` line carries argument text after the command word — a
 * non-space char following the command word and at least one space. Used to decide
 * whether a `takesArgs` command chosen from the palette should PREFILL `/name ` (no
 * arg yet) or run/close (arg already present).
 *
 *   slashCommandHasArg('/steer go')  → true
 *   slashCommandHasArg('/steer ')    → false
 *   slashCommandHasArg('/steer')     → false
 *   slashCommandHasArg('/')          → false
 */
export function slashCommandHasArg(value: string): boolean {
  return /^\s*\/[A-Za-z0-9_-]+\s+\S/.test(value);
}

/** Resolve a parsed command name to its registry entry (undefined if unknown). */
export function findSlashCommand(name: string | null): SlashCommand | undefined {
  if (name === null) {
    return undefined;
  }
  return slashCommands.find((command) => command.name === name);
}
