// tests/textStyleSystem.test.tsx
// Wave 5 item 6 — text style system + markdown gaps. Gate coverage:
//   • heading levels render at DISTINCT weights (was all `bold accent`);
//   • the single-dim convention drops stacked Ink `dimColor` (blockquote, link
//     URL, reasoning, notice) so one muted brightness reads everywhere;
//   • strikethrough / bold-italic / task-list checkboxes render;
//   • inline code no longer collides with the heading accent hue;
//   • tables align by terminal DISPLAY width (string-width), not `.length`, so
//     emoji + CJK cells line up.
// Every colour-sensitive check runs under BOTH palettes. Colour assertions are
// only meaningful when ink emits real SGR escapes; the vitest env reports
// supports-color level 0, so chalk is forced to a real level for THIS file
// (mirrors tests/transcriptIdentity.test.tsx) and the dark default is restored
// after any theme swap.
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { render } from 'ink-testing-library';
import type { Msg } from '../src/core/reducer';
import { Message } from '../src/ui/Message';
import { Markdown } from '../src/ui/MarkdownView';
import { setActiveTheme, type Background } from '../src/ui/theme';

let priorChalkLevel: typeof chalk.level;
beforeAll(() => {
  priorChalkLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = priorChalkLevel;
});
// Restore the historical dark default after any theme-swapping test.
afterEach(() => {
  setActiveTheme('dark');
});

// SGR attributes emitted by chalk (palette-independent).
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const STRIKE = '\x1b[9m';
const DIM = '\x1b[2m'; // stacked `dimColor` — must NOT appear under single-dim

const frameOf = (el: Parameters<typeof render>[0]): string => render(el).lastFrame() ?? '';
// eslint-disable-next-line no-control-regex
const plain = (frame: string): string => frame.replace(/\x1b\[[0-9;]*m/g, '');
/** The first foreground-colour SGR in a frame (skips bold/underline attrs). */
// eslint-disable-next-line no-control-regex
const firstColor = (frame: string): string => frame.match(/\x1b\[(3[0-8]|9[0-7])m/)?.[0] ?? '';

const THEMES: Background[] = ['dark', 'light'];

// ---------------------------------------------------------------------------
// Heading levels are visually distinct (previously all `bold accent`).
// ---------------------------------------------------------------------------

describe.each(THEMES)('heading levels are distinct (%s theme)', (bg) => {
  it('H1 = bold+underline, H2 = bold only, H3 = plain — all in the accent hue', () => {
    setActiveTheme(bg);
    const h1 = frameOf(<Markdown text="# Title" depth="ansi16" />);
    const h2 = frameOf(<Markdown text="## Title" depth="ansi16" />);
    const h3 = frameOf(<Markdown text="### Title" depth="ansi16" />);

    // H1: bold AND underline.
    expect(h1).toContain(BOLD);
    expect(h1).toContain(UNDERLINE);
    // H2: bold, but NOT underline.
    expect(h2).toContain(BOLD);
    expect(h2).not.toContain(UNDERLINE);
    // H3: neither weight nor underline (was identical to H1/H2 before item 6).
    expect(h3).not.toContain(BOLD);
    expect(h3).not.toContain(UNDERLINE);

    // All three share ONE accent colour — depth is encoded by weight, not hue.
    const accent = firstColor(h3);
    expect(accent).not.toBe('');
    expect(h1).toContain(accent);
    expect(h2).toContain(accent);
  });
});

// ---------------------------------------------------------------------------
// Single-dim convention: `textDim` only, never stacked with Ink `dimColor`.
// ---------------------------------------------------------------------------

describe.each(THEMES)('single-dim convention (%s theme)', (bg) => {
  it('blockquote renders textDim only — no stacked dimColor', () => {
    setActiveTheme(bg);
    const frame = frameOf(<Markdown text="> quoted" depth="ansi16" />);
    expect(plain(frame)).toContain('│ quoted');
    expect(frame).not.toContain(DIM);
  });

  it('link URL renders textDim only — no stacked dimColor', () => {
    setActiveTheme(bg);
    const frame = frameOf(<Markdown text="see [docs](http://d.io)" depth="ansi16" />);
    expect(plain(frame)).toContain('(http://d.io)');
    expect(frame).not.toContain(DIM);
  });

  it('a committed reasoning line renders textDim only — no stacked dimColor', () => {
    setActiveTheme(bg);
    const msg: Msg = {
      id: 'r1',
      role: 'assistant',
      done: true,
      reasoning: 'weighing options',
      blocks: [],
    };
    const frame = frameOf(<Message msg={msg} depth="ansi16" />);
    expect(plain(frame)).toContain('✻ thought');
    expect(frame).not.toContain(DIM);
  });

  it('a notice block renders textDim only — no stacked dimColor', () => {
    setActiveTheme(bg);
    const msg: Msg = {
      id: 'n1',
      role: 'assistant',
      done: true,
      blocks: [{ kind: 'notice', id: 'n1:block:1', text: 'context compacted' }],
    };
    const frame = frameOf(<Message msg={msg} depth="ansi16" />);
    expect(plain(frame)).toContain('context compacted');
    expect(frame).not.toContain(DIM);
  });
});

// ---------------------------------------------------------------------------
// New inline constructs render.
// ---------------------------------------------------------------------------

describe('new inline markdown constructs render', () => {
  it('strikethrough (~~x~~) carries the SGR strike attribute', () => {
    const frame = frameOf(<Markdown text="~~gone~~" depth="ansi16" />);
    expect(plain(frame)).toContain('gone');
    expect(plain(frame)).not.toContain('~');
    expect(frame).toContain(STRIKE);
  });

  it('bold-italic (***x***) carries both bold and italic attributes', () => {
    const frame = frameOf(<Markdown text="***loud***" depth="ansi16" />);
    expect(plain(frame)).toContain('loud');
    expect(plain(frame)).not.toContain('*');
    expect(frame).toContain(BOLD);
    expect(frame).toContain(ITALIC);
  });

  it('task-list items render as checkbox glyphs, plain bullets untouched', () => {
    const frame = plain(frameOf(<Markdown text={'- [ ] todo\n- [x] done\n- plain'} depth="ansi16" />));
    expect(frame).toContain('☐ todo');
    expect(frame).toContain('☒ done');
    expect(frame).toContain('• plain');
  });

  it('inline code no longer collides with the heading accent hue', () => {
    // Both used `accent` before item 6; inline code moved to `info`.
    const heading = firstColor(frameOf(<Markdown text="### word" depth="ansi16" />));
    const code = firstColor(frameOf(<Markdown text="`word`" depth="ansi16" />));
    expect(heading).not.toBe('');
    expect(code).not.toBe('');
    expect(code).not.toBe(heading);
  });
});

// ---------------------------------------------------------------------------
// Table alignment measured in DISPLAY columns (string-width), not UTF-16 units.
// ---------------------------------------------------------------------------

describe.each(THEMES)('table alignment with emoji + CJK cells (%s theme)', (bg) => {
  it('every row places the column separator at the same DISPLAY column', () => {
    setActiveTheme(bg);
    // `中文字` (3 code units, 6 display cols) is the widest col-0 cell; `🍎🍎`
    // (2 units, 4 cols) and the ASCII cells are narrower. Under the old `.length`
    // pad these misalign; string-width lines them up.
    const md = '| id | v |\n| - | - |\n| 中文字 | a |\n| 🍎🍎 | b |\n| x | c |';
    const lines = plain(frameOf(<Markdown text={md} depth="ansi16" />))
      .split('\n')
      .filter((l) => l.includes('│'));
    expect(lines.length).toBe(4); // header + 3 data rows (delimiter row dropped)

    const preBarWidths = lines.map((l) => stringWidth(l.slice(0, l.indexOf('│'))));
    // All separators sit at one DISPLAY column.
    expect(new Set(preBarWidths).size).toBe(1);
    // …and that column is wide enough for the widest (CJK) cell.
    expect(preBarWidths[0]).toBeGreaterThanOrEqual(stringWidth('中文字'));
  });
});
