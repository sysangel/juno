import { afterEach, describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/events';
import {
  darkTheme,
  detectBackground,
  detectColorDepth,
  downsample,
  explicitTheme,
  lightTheme,
  setActiveTheme,
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

describe('setActiveTheme (E: adaptive light/dark palette)', () => {
  // Restore the dark default the other suites (and the `theme` alias) assume.
  afterEach(() => setActiveTheme('dark'));

  it('defaults to the dark palette — the `theme` alias mirrors darkTheme', () => {
    expect(theme).toBe(darkTheme);
    expect(token('accent', 'truecolor')).toBe(darkTheme.accent);
  });

  it('resolves the light palette after setActiveTheme("light")', () => {
    // Sanity: the two palettes genuinely differ, so the swap is observable.
    expect(lightTheme.accent).not.toBe(darkTheme.accent);
    setActiveTheme('light');
    expect(token('accent', 'truecolor')).toBe(lightTheme.accent);
    expect(token('text', 'truecolor')).toBe(lightTheme.text);
    expect(token('effortBadge.high', 'truecolor')).toBe(lightTheme.effortBadge.high);
  });

  it('swaps back to the dark palette after setActiveTheme("dark")', () => {
    setActiveTheme('light');
    setActiveTheme('dark');
    expect(token('accent', 'truecolor')).toBe(darkTheme.accent);
  });
});

describe('detectBackground (E: override / COLORFGBG / fallback)', () => {
  const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
    over as NodeJS.ProcessEnv;

  it('honors an explicit override (settings.theme) over the COLORFGBG heuristic', () => {
    expect(detectBackground({ override: 'light', env: env({ COLORFGBG: '15;0' }) })).toBe('light');
    expect(detectBackground({ override: 'dark', env: env({ COLORFGBG: '0;15' }) })).toBe('dark');
  });

  it('honors JUNO_THEME env above the override and COLORFGBG (env beats file)', () => {
    expect(
      detectBackground({ override: 'dark', env: env({ JUNO_THEME: 'light', COLORFGBG: '15;0' }) }),
    ).toBe('light');
    // Trimmed + case-insensitive.
    expect(detectBackground({ env: env({ JUNO_THEME: ' DARK ' }) })).toBe('dark');
  });

  it('reads a DARK background from COLORFGBG (last field 0-6 or 8)', () => {
    expect(detectBackground({ env: env({ COLORFGBG: '15;0' }) })).toBe('dark');
    expect(detectBackground({ env: env({ COLORFGBG: '15;default;0' }) })).toBe('dark'); // 3-field form
    expect(detectBackground({ env: env({ COLORFGBG: '7;8' }) })).toBe('dark'); // index 8 is dark
  });

  it('reads a LIGHT background from COLORFGBG (last field 7 or 9-15)', () => {
    expect(detectBackground({ env: env({ COLORFGBG: '0;15' }) })).toBe('light');
    expect(detectBackground({ env: env({ COLORFGBG: '0;7' }) })).toBe('light');
  });

  it('falls back to dark when unset and ignores unparseable/invalid values', () => {
    expect(detectBackground({ env: env({}) })).toBe('dark');
    expect(detectBackground({ env: env({ COLORFGBG: 'nonsense' }) })).toBe('dark');
    expect(detectBackground({ env: env({ JUNO_THEME: 'purple' }) })).toBe('dark'); // invalid override ignored
  });

  it('uses the osc11 auto-detect over COLORFGBG when no explicit preference is set', () => {
    // COLORFGBG says dark, but the OSC 11 probe found a light terminal → light.
    expect(detectBackground({ osc11: 'light', env: env({ COLORFGBG: '15;0' }) })).toBe('light');
    expect(detectBackground({ osc11: 'dark', env: env({ COLORFGBG: '0;15' }) })).toBe('dark');
  });

  it('lets an explicit preference beat the osc11 auto-detect', () => {
    // settings.theme override wins over osc11.
    expect(detectBackground({ override: 'dark', osc11: 'light', env: env({}) })).toBe('dark');
    // JUNO_THEME env wins over osc11.
    expect(detectBackground({ osc11: 'light', env: env({ JUNO_THEME: 'dark' }) })).toBe('dark');
  });

  it('falls through to COLORFGBG/dark when osc11 is undefined (regression)', () => {
    expect(detectBackground({ osc11: undefined, env: env({ COLORFGBG: '0;15' }) })).toBe('light');
    expect(detectBackground({ osc11: undefined, env: env({}) })).toBe('dark');
  });
});

describe('explicitTheme (shared explicit-preference resolver)', () => {
  const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
    over as NodeJS.ProcessEnv;

  it('returns the JUNO_THEME env preference (case/space-insensitive)', () => {
    expect(explicitTheme({ env: env({ JUNO_THEME: 'light' }) })).toBe('light');
    expect(explicitTheme({ env: env({ JUNO_THEME: ' DARK ' }) })).toBe('dark');
  });

  it('returns the override when there is no env preference', () => {
    expect(explicitTheme({ override: 'light', env: env({}) })).toBe('light');
    // env beats the override.
    expect(explicitTheme({ override: 'light', env: env({ JUNO_THEME: 'dark' }) })).toBe('dark');
  });

  it('returns undefined when neither an env nor an override preference is set', () => {
    expect(explicitTheme({ env: env({}) })).toBeUndefined();
    expect(explicitTheme({ env: env({ COLORFGBG: '15;0' }) })).toBeUndefined(); // COLORFGBG is NOT explicit
    expect(explicitTheme({ env: env({ JUNO_THEME: 'purple' }) })).toBeUndefined(); // invalid ignored
  });
});
