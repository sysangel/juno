import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/events';
import {
  detectColorDepth,
  downsample,
  theme,
  token,
  type ColorDepth,
  type FlatTokenName,
  type Hex,
} from '../src/ui/theme';

/** Exact allow-list of named-16 Ink colours `downsample('ansi16')` may emit. */
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

const TOOL_STATUSES = [
  'pending',
  'running',
  'result',
  'error',
] as const satisfies readonly ToolStatus[];

const STATUS_CAPITALIZED = {
  pending: 'Pending',
  running: 'Running',
  result: 'Result',
  error: 'Error',
} as const satisfies Record<ToolStatus, Capitalize<ToolStatus>>;

type ToolTokenName = `tool${Capitalize<ToolStatus>}`;

describe('downsample', () => {
  it('returns the hex unchanged for truecolor', () => {
    const hex: Hex = '#7AA2F7';
    expect(downsample(hex, 'truecolor')).toBe(hex);
    expect(downsample(theme.accent, 'truecolor')).toBe(theme.accent);
  });

  it('returns a numeric palette string within 16..255 for ansi256', () => {
    const samples = [
      '#000000',
      '#FFFFFF',
      '#FF0000',
      '#00FF00',
      '#0000FF',
      '#66D9EF',
      '#A6E22E',
      '#F92672',
    ] as const satisfies readonly Hex[];
    for (const s of samples) {
      const out = downsample(s, 'ansi256');
      expect(out).toMatch(/^\d+$/);
      const n = Number(out);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(16);
      expect(n).toBeLessThanOrEqual(255);
    }
  });

  it('returns a valid Ink colour name for ansi16 and is total', () => {
    // Includes well-formed hexes + malformed (cast) inputs to prove totality.
    const samples: readonly Hex[] = [
      '#000000',
      '#FFFFFF',
      '#FF0000',
      '#00FF00',
      '#0000FF',
      '#66D9EF',
      '#A6E22E',
      '#F92672',
      '#75715E',
      '#FF4FD8',
      '#' as Hex,
      '#XYZXYZ' as Hex,
      '#12345' as Hex,
      '#1234567' as Hex,
    ];
    for (const s of samples) {
      expect(() => downsample(s, 'ansi16')).not.toThrow();
      const out = downsample(s, 'ansi16');
      expect(typeof out).toBe('string');
      expect(ANSI16_NAMES.has(out)).toBe(true);
    }
  });

  it('is pure: same args -> same result for every depth', () => {
    const hex: Hex = '#66D9EF';
    expect(downsample(hex, 'truecolor')).toBe(downsample(hex, 'truecolor'));
    expect(downsample(hex, 'ansi256')).toBe(downsample(hex, 'ansi256'));
    expect(downsample(hex, 'ansi16')).toBe(downsample(hex, 'ansi16'));
  });
});

describe('detectColorDepth', () => {
  it('returns a valid ColorDepth and never throws in a non-TTY/test env', () => {
    let depth: ColorDepth | undefined;
    expect(() => {
      depth = detectColorDepth();
    }).not.toThrow();
    expect(['truecolor', 'ansi256', 'ansi16']).toContain(depth);
  });
});

describe('token', () => {
  it("resolves 'effortBadge.high' to theme.effortBadge.high at truecolor", () => {
    expect(token('effortBadge.high', 'truecolor')).toBe(theme.effortBadge.high);
  });

  it('resolves every effortBadge variant at truecolor', () => {
    const efforts = ['medium', 'high', 'xhigh'] as const;
    for (const e of efforts) {
      const name = `effortBadge.${e}` as FlatTokenName;
      expect(token(name, 'truecolor')).toBe(theme.effortBadge[e]);
    }
  });

  it("resolves 'text' to theme.text at truecolor", () => {
    expect(token('text', 'truecolor')).toBe(theme.text);
  });

  it('exposes a tool token for every ToolStatus value', () => {
    for (const status of TOOL_STATUSES) {
      const name = `tool${STATUS_CAPITALIZED[status]}` as ToolTokenName;
      expect(theme[name]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(token(name, 'truecolor')).toBe(theme[name]);
    }
  });

  it('downsamples when a depth is supplied', () => {
    const out = token('accent', 'ansi256');
    expect(out).toMatch(/^\d+$/);
    const n = Number(out);
    expect(n).toBeGreaterThanOrEqual(16);
    expect(n).toBeLessThanOrEqual(255);
  });

  it('uses detectColorDepth when no depth is supplied', () => {
    const depth = detectColorDepth();
    expect(token('success')).toBe(downsample(theme.success, depth));
  });
});
