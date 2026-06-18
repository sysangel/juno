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
  text: '#E6E6E6',
  textDim: '#7A7A7A',
  textInverse: '#1A1A1A',
  background: '#1A1A1A',
  border: '#3A3A3A',
  accent: '#7AA2F7',
  success: '#9ECE6A',
  warning: '#E0AF68',
  error: '#F7768E',
  info: '#7DCFFF',
  toolPending: '#6B6B6B',
  toolRunning: '#7DCFFF',
  toolResult: '#9ECE6A',
  toolError: '#F7768E',
  roleUser: '#7AA2F7',
  roleAssistant: '#9ECE6A',
  roleSystem: '#E0AF68',
  modeBadge: {
    normal: '#9ECE6A',
    plan: '#7AA2F7',
    ultracode: '#FF7A93',
  },
};

interface ParsedRGB {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: Hex): ParsedRGB | null {
  if (typeof hex !== 'string') return null;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

function clampByte(v: number): number {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

function round5(v: number): number {
  return Math.round((v / 255) * 5);
}

function toAnsi256Index(r: number, g: number, b: number): number {
  return 16 + 36 * round5(r) + 6 * round5(g) + round5(b);
}

const ANSI16_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const;

type Ansi16Name = (typeof ANSI16_NAMES)[number];

function toAnsi16Name(r: number, g: number, b: number): Ansi16Name {
  // Perceived brightness (Rec. 601 luma).
  const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
  const bright = brightness >= 128;

  // Threshold for "channel present".
  const T = 96;
  const rOn = r >= T;
  const gOn = g >= T;
  const bOn = b >= T;

  let base: 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white';

  if (!rOn && !gOn && !bOn) {
    base = 'black';
  } else if (rOn && !gOn && !bOn) {
    base = 'red';
  } else if (!rOn && gOn && !bOn) {
    base = 'green';
  } else if (rOn && gOn && !bOn) {
    base = 'yellow';
  } else if (!rOn && !gOn && bOn) {
    base = 'blue';
  } else if (rOn && !gOn && bOn) {
    base = 'magenta';
  } else if (!rOn && gOn && bOn) {
    base = 'cyan';
  } else {
    base = 'white';
  }

  // Black stays black-ish (use 'gray' for light darks to remain readable).
  if (base === 'black') {
    return bright ? 'gray' : 'black';
  }

  return (bright ? `${base}Bright` : base) as Ansi16Name;
}

export function downsample(hex: Hex, depth: ColorDepth): string {
  const parsed = parseHex(hex);
  const fallback: ParsedRGB = { r: 230, g: 230, b: 230 };
  const { r, g, b } = parsed ?? fallback;

  switch (depth) {
    case 'truecolor':
      return hex;
    case 'ansi256': {
      const idx = toAnsi256Index(clampByte(r), clampByte(g), clampByte(b));
      return String(idx);
    }
    case 'ansi16': {
      const name = toAnsi16Name(clampByte(r), clampByte(g), clampByte(b));
      return name;
    }
    default: {
      // Exhaustive guard; depth is a union of three literals.
      const _exhaustive: never = depth;
      void _exhaustive;
      return hex;
    }
  }
}

export function detectColorDepth(): ColorDepth {
  const level = supportsColor?.stdout?.level ?? 0;
  switch (level) {
    case 3:
      return 'truecolor';
    case 2:
      return 'ansi256';
    case 1:
      return 'ansi16';
    default:
      // Treat level 0 / none as ansi16 so named colours still render.
      return 'ansi16';
  }
}

export type FlatTokenName =
  | Exclude<keyof Theme, 'modeBadge'>
  | `modeBadge.${keyof Theme['modeBadge']}`;

function resolveToken(name: FlatTokenName): Hex {
  if (typeof name === 'string' && name.startsWith('modeBadge.')) {
    const sub = name.slice('modeBadge.'.length) as keyof Theme['modeBadge'];
    switch (sub) {
      case 'normal':
        return theme.modeBadge.normal;
      case 'plan':
        return theme.modeBadge.plan;
      case 'ultracode':
        return theme.modeBadge.ultracode;
      default: {
        const _exhaustive: never = sub;
        void _exhaustive;
        // Defensive fallback; should be unreachable given the type.
        return theme.text;
      }
    }
  }

  // Non-modeBadge flat token.
  const key = name as Exclude<keyof Theme, 'modeBadge'>;
  const value: Hex | undefined = theme[key];
  if (typeof value === 'string') {
    return value as Hex;
  }
  // Defensive fallback for any unexpected shape.
  return theme.text;
}

export function token(name: FlatTokenName, depth?: ColorDepth): string {
  const hex = resolveToken(name);
  return downsample(hex, depth ?? detectColorDepth());
}
```

=== FILE: tests/theme.test.ts ===
```ts
import { describe, it, expect } from 'vitest';
import {
  theme,
  downsample,
  detectColorDepth,
  token,
  type Hex,
  type ColorDepth,
  type FlatTokenName,
} from '../src/ui/theme';

const ANSI16_ALLOW = new Set<string>([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
  'gray',
]);

describe('downsample', () => {
  it('returns the hex unchanged for truecolor', () => {
    const hex: Hex = '#7AA2F7';
    expect(downsample(hex, 'truecolor')).toBe(hex);
  });

  it('returns a numeric string in 16..255 for ansi256', () => {
    const samples: Hex[] = ['#000000', '#FFFFFF', '#7AA2F7', '#9ECE6A', '#F7768E'];
    for (const s of samples) {
      const out = downsample(s, 'ansi256');
      expect(out).toMatch(/^\d+$/);
      const n = Number(out);
      expect(n).toBeGreaterThanOrEqual(16);
      expect(n).toBeLessThanOrEqual(255);
    }
  });

  it('returns a valid Ink colour name for ansi16 and is total', () => {
    const samples: Hex[] = [
      '#000000',
      '#FFFFFF',
      '#7AA2F7',
      '#9ECE6A',
      '#F7768E',
      '#E0AF68',
      '#7DCFFF',
      '#6B6B6B',
      '#FF7A93',
      '#1A1A1A',
      '#3A3A3A',
      '#7A7A7A',
    ];
    for (const s of samples) {
      expect(() => downsample(s, 'ansi16')).not.toThrow();
      const out = downsample(s, 'ansi16');
      expect(typeof out).toBe('string');
      expect(ANSI16_ALLOW.has(out)).toBe(true);
    }
  });

  it('is pure: same args -> same result', () => {
    const hex: Hex = '#7AA2F7';
    const a = downsample(hex, 'ansi256');
    const b = downsample(hex, 'ansi256');
    expect(a).toBe(b);
    const c = downsample(hex, 'ansi16');
    const d = downsample(hex, 'ansi16');
    expect(c).toBe(d);
  });
});

describe('token', () => {
  it("resolves 'modeBadge.plan' to theme.modeBadge.plan at truecolor", () => {
    expect(token('modeBadge.plan', 'truecolor')).toBe(theme.modeBadge.plan);
  });

  it("resolves 'text' to theme.text at truecolor", () => {
    expect(token('text', 'truecolor')).toBe(theme.text);
  });

  it('exposes a tool token for every ToolStatus value', () => {
    const statuses = ['pending', 'running', 'result', 'error'] as const;
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    for (const s of statuses) {
      const name = `tool${cap(s)}` as FlatTokenName;
      const hex = token(name, 'truecolor');
      expect(typeof hex).toBe('string');
      expect(hex.startsWith('#')).toBe(true);
    }
    // Direct theme assertions for the four tool tokens.
    expect(theme.toolPending).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(theme.toolRunning).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(theme.toolResult).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(theme.toolError).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('downsamples when a depth is provided', () => {
    const out = token('accent', 'ansi256');
    expect(out).toMatch(/^\d+$/);
    const n = Number(out);
    expect(n).toBeGreaterThanOrEqual(16);
    expect(n).toBeLessThanOrEqual(255);
  });

  it('works without an explicit depth (uses detectColorDepth)', () => {
    const depth: ColorDepth = detectColorDepth();
    const out = token('success');
    expect(typeof out).toBe('string');
    // Should match what downsample produces at the detected depth.
    expect(out).toBe(downsample(theme.success, depth));
  });
});
```

=== NOTES ===
`theme.ts` exposes the frozen `Theme` shape with a dark-terminal palette: tool lifecycle reads gray→cyan→green→red, mode badges neutral/blue/hot-pink. `downsample` is pure and deterministic: truecolor passes hex through; ansi256 uses the standard 6×6×6 cube formula; ansi16 maps by dominant channels + brightness (with `gray` for light darks). `detectColorDepth` is the only impure function, wrapping `supports-color` and defaulting level 0 to `ansi16`. `token()` resolves dotted `FlatTokenName`s (narrowing on the `modeBadge.` prefix, no `any`) and downsamples for the given or detected depth. Exhaustive switches satisfy strict mode. Tests cover purity, totality, the four tool tokens, and dotted resolution.
