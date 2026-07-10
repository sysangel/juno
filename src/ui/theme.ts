// src/ui/theme.ts
// W5 — Semantic-token theme + colour-depth downsampling.
//
// Replaces the old Python `theme.py` rainbow cosmetics with a small set of
// NAMED semantic tokens. W4 (UI) imports tokens by NAME; the hex/ANSI VALUES
// behind a name may change without touching W4.
//
// Self-contained: imports ONLY `supports-color`. No React/Ink, no W4 component.
// The token names key 1:1 off the FROZEN W3 core:
//   toolPending/toolRunning/toolResult/toolError <- ToolStatus ('pending'|'running'|'result'|'error')
//   effortBadge.{medium,high,xhigh}              <- State['effort']
import supportsColor from 'supports-color';

/** A colour expressed as a 24-bit truecolor hex string, e.g. '#A6E22E'. */
export type Hex = `#${string}`;

/** Terminal colour capability; chosen once at startup from supports-color. */
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16';

/** The frozen set of semantic token names. ONE flag/state flips ONE token. */
export interface Theme {
  // base text
  text: Hex; // primary foreground
  textDim: Hex; // secondary / muted (timestamps, hints)
  textInverse: Hex; // fg on a coloured background
  background: Hex; // app background (may be unused by Ink, kept for parity)
  border: Hex; // panel / card borders

  // semantic status
  accent: Hex; // brand / focus / selected
  success: Hex;
  warning: Hex;
  error: Hex;
  info: Hex;

  // tool-call lifecycle — keyed 1:1 to ToolStatus from W3
  toolPending: Hex; // ToolStatus 'pending'
  toolRunning: Hex; // ToolStatus 'running'
  toolResult: Hex; // ToolStatus 'result'
  toolError: Hex; // ToolStatus 'error'

  // role tints (Transcript / Message)
  roleUser: Hex;
  roleAssistant: Hex;
  roleSystem: Hex;

  // effort badge — keyed 1:1 to State['effort'] from W3
  effortBadge: {
    medium: Hex;
    high: Hex;
    xhigh: Hex;
  };
}

/** Which terminal background the active palette is tuned for. */
export type Background = 'dark' | 'light';

/** The dark-terminal palette (Monokai-ish) — juno's historical default. */
export const darkTheme: Theme = {
  text: '#F8F8F2',
  textDim: '#8F908A',
  textInverse: '#101218',
  background: '#101218',
  border: '#3B3F4A',

  accent: '#66D9EF',
  success: '#A6E22E',
  warning: '#F4BF75',
  error: '#F92672',
  info: '#AE81FF',

  // tool lifecycle reads dim -> active-cyan -> green -> red
  toolPending: '#75715E',
  toolRunning: '#66D9EF',
  toolResult: '#A6E22E',
  toolError: '#F92672',

  roleUser: '#E6DB74',
  roleAssistant: '#66D9EF',
  roleSystem: '#AE81FF',

  // neutral / blue / hot-intense
  effortBadge: {
    medium: '#CFCFC2',
    high: '#5FA8FF',
    xhigh: '#FF4FD8',
  },
};

/**
 * The light-terminal palette: dark text on a light background, with DARKER
 * accents (e.g. a teal `#0B7285` instead of the bright cyan) so the same
 * semantic tokens stay legible against white. Same token set as `darkTheme`, so
 * every `token()` name resolves under either palette.
 */
export const lightTheme: Theme = {
  text: '#101218',
  textDim: '#5C6370',
  textInverse: '#F8F8F2',
  background: '#F8F8F2',
  border: '#C4C9D4',

  accent: '#0B7285',
  success: '#2B8A3E',
  warning: '#B8860B',
  error: '#C92A2A',
  info: '#5F3DC4',

  // tool lifecycle reads dim -> active-teal -> green -> red (darkened for light bg)
  toolPending: '#868E96',
  toolRunning: '#0B7285',
  toolResult: '#2B8A3E',
  toolError: '#C92A2A',

  roleUser: '#9C6A00',
  roleAssistant: '#0B7285',
  roleSystem: '#5F3DC4',

  // neutral / blue / hot-intense (darkened for light bg)
  effortBadge: {
    medium: '#495057',
    high: '#1971C2',
    xhigh: '#C2255C',
  },
};

/**
 * The palette `token()` resolves against. Defaults to `darkTheme` (juno's
 * historical look); `setActiveTheme()` swaps it in `cli.ts` BEFORE first render.
 * A module-global (like the DEPTH cache) so no component needs to thread it.
 */
let activePalette: Theme = darkTheme;

/**
 * Point the active palette at the dark or light theme. MUST run before the first
 * component render (cli.ts calls it pre-`render`), since components resolve colours
 * off `activePalette` at render time. Idempotent — safe to call repeatedly.
 */
export function setActiveTheme(background: Background): void {
  activePalette = background === 'light' ? lightTheme : darkTheme;
}

/**
 * Back-compat alias for the historical single `theme` export (== `darkTheme`).
 * Kept so existing imports + the theme.test equality assertions (which hold under
 * the dark default) keep working. New code should prefer `token()`.
 */
export const theme: Theme = darkTheme;

/** Dotted token names addressable by `token()`, e.g. 'text' | 'effortBadge.high'. */
export type FlatTokenName =
  | Exclude<keyof Theme, 'effortBadge'>
  | `effortBadge.${keyof Theme['effortBadge']}`;

// ---------------------------------------------------------------------------
// Internal colour math (PURE — no I/O, no global reads)
// ---------------------------------------------------------------------------

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

type Ansi16Name =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright';

interface Ansi16Color extends Rgb {
  readonly name: Ansi16Name;
}

type FlatThemeTokenName = Exclude<keyof Theme, 'effortBadge'>;
type EffortBadgeName = keyof Theme['effortBadge'];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const EFFORT_BADGE_PREFIX = 'effortBadge.' as const;

const FLAT_TOKEN_NAMES = [
  'text',
  'textDim',
  'textInverse',
  'background',
  'border',
  'accent',
  'success',
  'warning',
  'error',
  'info',
  'toolPending',
  'toolRunning',
  'toolResult',
  'toolError',
  'roleUser',
  'roleAssistant',
  'roleSystem',
] as const satisfies readonly FlatThemeTokenName[];

const EFFORT_BADGE_NAMES = [
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly EffortBadgeName[];

/**
 * Canonical RGB anchors for the named-16 Ink palette. `downsample` maps a hex
 * to the nearest of these by squared Euclidean distance — deterministic and
 * total (every input resolves to exactly one name).
 */
const ANSI16_COLORS = [
  { name: 'black', r: 0, g: 0, b: 0 },
  { name: 'red', r: 170, g: 0, b: 0 },
  { name: 'green', r: 0, g: 170, b: 0 },
  { name: 'yellow', r: 170, g: 85, b: 0 },
  { name: 'blue', r: 0, g: 0, b: 170 },
  { name: 'magenta', r: 170, g: 0, b: 170 },
  { name: 'cyan', r: 0, g: 170, b: 170 },
  { name: 'white', r: 170, g: 170, b: 170 },
  { name: 'gray', r: 85, g: 85, b: 85 },
  { name: 'redBright', r: 255, g: 85, b: 85 },
  { name: 'greenBright', r: 85, g: 255, b: 85 },
  { name: 'yellowBright', r: 255, g: 255, b: 85 },
  { name: 'blueBright', r: 85, g: 85, b: 255 },
  { name: 'magentaBright', r: 255, g: 85, b: 255 },
  { name: 'cyanBright', r: 85, g: 255, b: 255 },
  { name: 'whiteBright', r: 255, g: 255, b: 255 },
] as const satisfies readonly [Ansi16Color, ...Ansi16Color[]];

/** Parse `#RRGGBB` to RGB; total — malformed input falls back to black. */
function parseHex(hex: Hex): Rgb {
  if (!HEX_COLOR_PATTERN.test(hex)) {
    return { r: 0, g: 0, b: 0 };
  }
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function squaredDistance(left: Rgb, right: Rgb): number {
  return (
    (left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2
  );
}

function nearestAnsi16(rgb: Rgb): Ansi16Name {
  let bestName: Ansi16Name = ANSI16_COLORS[0].name;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of ANSI16_COLORS) {
    const distance = squaredDistance(rgb, candidate);
    if (distance < bestDistance) {
      bestName = candidate.name;
      bestDistance = distance;
    }
  }
  return bestName;
}

/** r,g,b in 0..255 -> xterm-256 6x6x6 colour-cube index (16..231). */
function toAnsi256Index(rgb: Rgb): number {
  const r = Math.round((rgb.r / 255) * 5);
  const g = Math.round((rgb.g / 255) * 5);
  const b = Math.round((rgb.b / 255) * 5);
  return 16 + 36 * r + 6 * g + b;
}

function depthFromLevel(level: number): ColorDepth {
  if (level >= 3) return 'truecolor';
  if (level === 2) return 'ansi256';
  // level 1 OR 0/none -> ansi16 so named colours still render.
  return 'ansi16';
}

function isFlatTokenName(value: string): value is FlatThemeTokenName {
  return (FLAT_TOKEN_NAMES as readonly string[]).includes(value);
}

function isEffortBadgeName(value: string): value is EffortBadgeName {
  return (EFFORT_BADGE_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Public API — names/signatures are frozen
// ---------------------------------------------------------------------------

/**
 * Downsample a truecolor hex to the terminal's capability. Pure, deterministic.
 * - 'truecolor' returns the hex unchanged.
 * - 'ansi256' returns a 256-palette cube index as a string (e.g. '113').
 * - 'ansi16' returns a named-16 Ink colour (e.g. 'green', 'cyan', 'gray').
 */
export function downsample(hex: Hex, depth: ColorDepth): string {
  switch (depth) {
    case 'truecolor':
      return hex;
    case 'ansi256':
      return String(toAnsi256Index(parseHex(hex)));
    case 'ansi16':
      return nearestAnsi16(parseHex(hex));
    default: {
      const exhaustive: never = depth;
      return exhaustive;
    }
  }
}

/**
 * Detect the terminal colour depth, wrapping supports-color. The only impure
 * function here. Never throws in a non-TTY / test env (supports-color reports
 * `false` for stdout, which maps to level 0 -> 'ansi16').
 */
export function detectColorDepth(): ColorDepth {
  const stdoutSupport = supportsColor.stdout;
  const level =
    stdoutSupport !== undefined && stdoutSupport !== false
      ? stdoutSupport.level
      : 0;
  return depthFromLevel(level);
}

/**
 * Read a token already downsampled for `depth` (defaults to detectColorDepth()).
 * Resolves a dotted `FlatTokenName` ('text', 'effortBadge.high', ...) to its Hex
 * off `theme`, then downsamples. Returns a string ready for Ink's
 * <Text color={...}>. Total: an unknown name (only reachable by an unsafe cast)
 * falls back to `theme.text` rather than throwing.
 */
export function token(name: FlatTokenName, depth?: ColorDepth): string {
  const resolvedDepth = depth ?? detectColorDepth();

  if (name.startsWith(EFFORT_BADGE_PREFIX)) {
    const effortName = name.slice(EFFORT_BADGE_PREFIX.length);
    const hex = isEffortBadgeName(effortName)
      ? activePalette.effortBadge[effortName]
      : activePalette.text;
    return downsample(hex, resolvedDepth);
  }

  const hex = isFlatTokenName(name) ? activePalette[name] : activePalette.text;
  return downsample(hex, resolvedDepth);
}

/**
 * Map a COLORFGBG value to a background. The variable is `fg;bg` (some terminals
 * emit `fg;<default>;bg`), so the LAST field is the background's ANSI-16 index:
 * 0-6 and 8 are dark, 7 and 9-15 are light. Anything unparseable ⇒ undefined
 * (the caller then falls through to its next signal). PURE.
 */
function backgroundFromColorFgBg(raw: string | undefined): Background | undefined {
  if (raw === undefined) return undefined;
  const fields = raw.split(';');
  const last = fields[fields.length - 1];
  if (last === undefined) return undefined;
  const index = Number.parseInt(last.trim(), 10);
  if (!Number.isInteger(index)) return undefined;
  if (index === 7 || (index >= 9 && index <= 15)) return 'light';
  if ((index >= 0 && index <= 6) || index === 8) return 'dark';
  return undefined;
}

/** Normalize an explicit theme string ('dark'|'light', case/space-insensitive). */
function normalizeBackground(raw: string | undefined): Background | undefined {
  const value = raw?.trim().toLowerCase();
  return value === 'dark' || value === 'light' ? value : undefined;
}

/**
 * Decide which background the palette should target, in precedence order:
 *   1. `JUNO_THEME` env ('dark'|'light') — the explicit user override (env beats
 *      file, matching the config service's env-over-file convention).
 *   2. `opts.override` — the resolved `settings.theme` from config (file).
 *   3. `COLORFGBG` — the terminal-reported background heuristic.
 *   4. 'dark' — juno's historical default (NO OSC 11 query this wave).
 * Impure only in that it reads `env` (defaults to `process.env`); never throws.
 */
export function detectBackground(opts?: {
  override?: Background;
  env?: NodeJS.ProcessEnv;
}): Background {
  const env = opts?.env ?? process.env;
  const envTheme = normalizeBackground(env.JUNO_THEME);
  if (envTheme !== undefined) return envTheme;
  if (opts?.override === 'dark' || opts?.override === 'light') return opts.override;
  const fromFgBg = backgroundFromColorFgBg(env.COLORFGBG);
  if (fromFgBg !== undefined) return fromFgBg;
  return 'dark';
}
