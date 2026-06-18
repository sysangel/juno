=== FILE: src/ui/theme.ts ===
```ts
import supportsColor from 'supports-color';

export type Hex = `#${string}`;
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16';

export interface Theme {
  text: Hex;
  textDim: Hex;
  textInverse: Hex;
  background: Hex;
  border: Hex;
  accent: Hex;
  success: Hex;
  warning: Hex;
  error: Hex;
  info: Hex;
  toolPending: Hex;
  toolRunning: Hex;
  toolResult: Hex;
  toolError: Hex;
  roleUser: Hex;
  roleAssistant: Hex;
  roleSystem: Hex;
  modeBadge: { normal: Hex; plan: Hex; ultracode: Hex };
}

export const theme: Theme = {
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
  toolPending: '#75715E',
  toolRunning: '#66D9EF',
  toolResult: '#A6E22E',
  toolError: '#F92672',
  roleUser: '#E6DB74',
  roleAssistant: '#66D9EF',
  roleSystem: '#AE81FF',
  modeBadge: {
    normal: '#CFCFC2',
    plan: '#5FA8FF',
    ultracode: '#FF4FD8',
  },
};

export type FlatTokenName =
  | Exclude<keyof Theme, 'modeBadge'>
  | `modeBadge.${keyof Theme['modeBadge']}`;

type Rgb = {
  readonly r: number;
  readonly g: number;
  readonly b: number;
};

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

type Ansi16Color = Rgb & {
  readonly name: Ansi16Name;
};

type FlatThemeTokenName = Exclude<keyof Theme, 'modeBadge'>;
type ModeBadgeName = keyof Theme['modeBadge'];

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MODE_BADGE_PREFIX = 'modeBadge.' as const;

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

const MODE_BADGE_NAMES = ['normal', 'plan', 'ultracode'] as const satisfies readonly ModeBadgeName[];

const ANSI16_COLORS = [
  { name: 'black', r: 0, g: 0, b: 0 },
  { name: 'red', r: 128, g: 0, b: 0 },
  { name: 'green', r: 0, g: 128, b: 0 },
  { name: 'yellow', r: 128, g: 128, b: 0 },
  { name: 'blue', r: 0, g: 0, b: 128 },
  { name: 'magenta', r: 128, g: 0, b: 128 },
  { name: 'cyan', r: 0, g: 128, b: 128 },
  { name: 'white', r: 192, g: 192, b: 192 },
  { name: 'gray', r: 128, g: 128, b: 128 },
  { name: 'redBright', r: 255, g: 0, b: 0 },
  { name: 'greenBright', r: 0, g: 255, b: 0 },
  { name: 'yellowBright', r: 255, g: 255, b: 0 },
  { name: 'blueBright', r: 0, g: 0, b: 255 },
  { name: 'magentaBright', r: 255, g: 0, b: 255 },
  { name: 'cyanBright', r: 0, g: 255, b: 255 },
  { name: 'whiteBright', r: 255, g: 255, b: 255 },
] as const satisfies readonly [Ansi16Color, ...Ansi16Color[]];

let cachedColorDepth: ColorDepth | undefined;

function parseHex(hex: Hex): Rgb {
  if (!HEX_COLOR_PATTERN.test(hex)) {
    return { r: 0, g: 0, b: 0 };
  }

  const value = Number.parseInt(hex.slice(1), 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function squaredDistance(left: Rgb, right: Rgb): number {
  return (left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2;
}

function nearestAnsi16(rgb: Rgb): Ansi16Name {
  let bestName: Ansi16Name = 'black';
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

function depthFromLevel(level: number): ColorDepth {
  if (level === 3) {
    return 'truecolor';
  }

  if (level === 2) {
    return 'ansi256';
  }

  return 'ansi16';
}

function isFlatTokenName(value: string): value is FlatThemeTokenName {
  for (const name of FLAT_TOKEN_NAMES) {
    if (value === name) {
      return true;
    }
  }

  return false;
}

function isModeBadgeName(value: string): value is ModeBadgeName {
  for (const name of MODE_BADGE_NAMES) {
    if (value === name) {
      return true;
    }
  }

  return false;
}

/** Pure, deterministic. */
export function downsample(hex: Hex, depth: ColorDepth): string {
  if (depth === 'truecolor') {
    return hex;
  }

  const rgb = parseHex(hex);

  if (depth === 'ansi256') {
    const r = Math.round((rgb.r / 255) * 5);
    const g = Math.round((rgb.g / 255) * 5);
    const b = Math.round((rgb.b / 255) * 5);

    return String(16 + 36 * r + 6 * g + b);
  }

  if (depth === 'ansi16') {
    return nearestAnsi16(rgb);
  }

  const exhaustive: never = depth;
  throw new RangeError(`Unsupported color depth: ${exhaustive}`);
}

/** Detect terminal colour depth once, wrapping supports-color. */
export function detectColorDepth(): ColorDepth {
  if (cachedColorDepth !== undefined) {
    return cachedColorDepth;
  }

  const stdoutSupport = supportsColor.stdout;
  const level = stdoutSupport ? stdoutSupport.level : 0;
  cachedColorDepth = depthFromLevel(level);

  return cachedColorDepth;
}

/** Read a token already downsampled for `depth`. */
export function token(name: FlatTokenName, depth?: ColorDepth): string {
  const resolvedDepth = depth ?? detectColorDepth();

  if (name.startsWith(MODE_BADGE_PREFIX)) {
    const modeName = name.slice(MODE_BADGE_PREFIX.length);

    if (!isModeBadgeName(modeName)) {
      throw new RangeError(`Unknown theme token: ${name}`);
    }

    return downsample(theme.modeBadge[modeName], resolvedDepth);
  }

  if (!isFlatTokenName(name)) {
    throw new RangeError(`Unknown theme token: ${name}`);
  }

  return downsample(theme[name], resolvedDepth);
}
```

=== FILE: tests/theme.test.ts ===
```ts
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/events';
import { downsample, theme, token, type Hex } from '../src/ui/theme';

const ANSI16_NAMES: ReadonlySet<string> = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]);

type ToolTokenName = 'toolPending' | 'toolRunning' | 'toolResult' | 'toolError';

const TOOL_STATUSES = ['pending', 'running', 'result', 'error'] as const satisfies readonly ToolStatus[];

const STATUS_CAPITALIZED = {
  pending: 'Pending',
  running: 'Running',
  result: 'Result',
  error: 'Error',
} as const satisfies Record<ToolStatus, Capitalize<ToolStatus>>;

describe('theme', () => {
  it('keeps truecolor hex values unchanged', () => {
    expect(downsample('#A6E22E', 'truecolor')).toBe('#A6E22E');
    expect(downsample(theme.accent, 'truecolor')).toBe(theme.accent);
  });

  it('maps ansi256 values to numeric palette strings within range', () => {
    const inputs = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF'] as const satisfies readonly Hex[];

    for (const input of inputs) {
      const value = downsample(input, 'ansi256');
      const index = Number(value);

      expect(value).toMatch(/^\d+$/);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(16);
      expect(index).toBeLessThanOrEqual(255);
    }
  });

  it('maps ansi16 values to valid Ink color names and is total for malformed hex-like input', () => {
    const inputs = [
      '#000000',
      '#FFFFFF',
      '#FF0000',
      '#00FF00',
      '#0000FF',
      '#A6E22E',
      '#F92672',
      '#66D9EF',
      '#',
      '#XYZXYZ',
      '#12345',
      '#1234567',
    ] as const;

    for (const input of inputs) {
      expect(() => downsample(input as Hex, 'ansi16')).not.toThrow();
      expect(ANSI16_NAMES.has(downsample(input as Hex, 'ansi16'))).toBe(true);
    }
  });

  it('resolves dotted mode badge tokens', () => {
    expect(token('modeBadge.plan', 'truecolor')).toBe(theme.modeBadge.plan);
  });

  it('resolves flat theme tokens', () => {
    expect(token('text', 'truecolor')).toBe(theme.text);
  });

  it('exposes tool status tokens matching every ToolStatus value', () => {
    for (const status of TOOL_STATUSES) {
      const tokenName = `tool${STATUS_CAPITALIZED[status]}` as ToolTokenName;

      expect(theme[tokenName]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(token(tokenName, 'truecolor')).toBe(theme[tokenName]);
    }
  });

  it('downsample is pure for repeated calls with the same arguments', () => {
    expect(downsample('#66D9EF', 'ansi16')).toBe(downsample('#66D9EF', 'ansi16'));
    expect(downsample('#66D9EF', 'ansi256')).toBe(downsample('#66D9EF', 'ansi256'));
  });
});
```

=== NOTES ===

The implementation keeps `theme.ts` independent of React/Ink and local UI code. `downsample()` is pure and total for malformed `Hex`-typed strings by falling back to black for parsed RGB. `detectColorDepth()` caches the first `supports-color` read, and `token()` resolves flat and dotted token names without `any`.