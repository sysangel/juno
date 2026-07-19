// tests/renderedRows.test.tsx
// W3 item 2 — MarkdownView.renderedRows must count the DECORATION the renderer adds (the 2-cell
// `│ ` code/blockquote gutter, the dim code lang label, the `marker ` list prefix, table cell
// padding + separators, the empty-paragraph blank row, the fixed hr rule) so the live-window
// height estimator (src/ui/liveWindow.ts) never UNDER-counts a prose/code/table-heavy turn and
// re-triggers Ink's scrollback-erasing full repaint. Each case renders the REAL <Markdown> at a
// fixed width and pins renderedRows to the ACTUAL rendered row count: renderedRows must be an
// UPPER bound (>=), and for these deterministic (non-word-wrapping) fixtures it is EXACT (===).
import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { Markdown, renderedRows, parseMarkdown } from '../src/ui/MarkdownView';
import { sanitizeForDisplay } from '../src/ui/clipText';

/** Rendered row count of a frame (an empty frame is 0 rows). */
const rowCount = (frame: string): number => (frame.length === 0 ? 0 : frame.split('\n').length);

/** The estimator's total for a whole markdown source — the SAME parse the renderer uses. */
const estimateRows = (text: string, columns: number): number =>
  parseMarkdown(sanitizeForDisplay(text)).reduce((n, b) => n + renderedRows(b, columns), 0);

/** Render <Markdown> inside a fixed-width Box so wrapping is deterministic, and return the frame. */
const frameAt = (text: string, width: number): string =>
  render(
    <Box width={width}>
      <Markdown text={text} depth="ansi16" />
    </Box>,
  ).lastFrame() ?? '';

describe('renderedRows — per-block markdown decoration parity with the real <Markdown> render', () => {
  // Each fixture is chosen so Ink's word-wrap and the cell-wrap authority agree (content fits, or
  // an unbroken run), making the rendered height deterministic. The DECORATION each carries is the
  // point: a raw source-line count would miss the lang label / gutter / marker / padding / blank.
  const cases: ReadonlyArray<readonly [string, string, number]> = [
    ['heading', '## Hello world', 80],
    ['paragraph', 'just a short paragraph', 80],
    ['empty paragraph → a full blank row', 'above\n\nbelow', 80],
    ['fenced code WITH a lang label + `│ ` gutter', '```ts\nconst x = 1;\nconst y = 2;\n```', 80],
    ['fenced code with NO lang label', '```\nabc\ndef\n```', 80],
    ['unordered list markers', '- one\n- two\n- three', 80],
    ['blockquote gutter', '> quoted line\n> second line', 80],
    ['horizontal rule (fixed 40-char)', 'a\n\n---\n\nb', 80],
    ['table cell padding + separators', '| a | b |\n| - | - |\n| 1 | 2 |', 80],
  ];

  it.each(cases)('counts %s exactly', (_label, text, width) => {
    const actual = rowCount(frameAt(text, width));
    const estimate = estimateRows(text, width);
    // The load-bearing safety direction: the estimate is an UPPER bound (an under-count fires
    // Ink's \x1b[3J scrollback erase).
    expect(estimate).toBeGreaterThanOrEqual(actual);
    // …and for these deterministic fixtures it is EXACT — proving the decoration is counted, not
    // approximated (a raw source-line count would be smaller for the code/quote/list/table/hr).
    expect(estimate).toBe(actual);
  });

  it('a code line wider than the `│ ` gutter allows wraps to TWO rendered rows (columns-2), not one', () => {
    // The gutter is a 2-cell prefix, so code content wraps at columns-2. A 39-cell unbroken run at
    // 40 cols exceeds columns-2 (38) and renders on two rows — the exact under-count a raw count
    // (1 row) would cause. renderedRows measures at columns-2, so it matches the real 2 rows.
    const width = 40;
    const text = '```\n' + 'x'.repeat(39) + '\n```';
    const actual = rowCount(frameAt(text, width));
    expect(actual).toBe(2);
    expect(estimateRows(text, width)).toBeGreaterThanOrEqual(actual);
    expect(estimateRows(text, width)).toBe(2);
  });

  it('sums decoration across a mixed prose+code+table message (>= the real height, decoration counted)', () => {
    const width = 60;
    const text = [
      '# Heading',
      '',
      'A paragraph of prose.',
      '',
      '```js',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '- alpha',
      '- beta',
      '',
      '| col1 | col2 |',
      '| ---- | ---- |',
      '| 1    | 2    |',
    ].join('\n');
    const actual = rowCount(frameAt(text, width));
    const estimate = estimateRows(text, width);
    expect(estimate).toBeGreaterThanOrEqual(actual);
    // The decorated total is strictly greater than a naive raw source-line count would suggest for
    // the code block (the lang label adds a row the source lines do not).
    expect(estimate).toBe(actual);
  });
});

// The list branch must measure the EXACT string renderBlock paints — `${marker} ${spans}` in ONE
// <Text> — because the marker WIDTH varies: '1.'/'10.' ordered, nested '  •' with leading indent.
// A fixed `columns - 2` (assumed 2-cell marker) UNDER-counts a wider marker, so at a knife-edge
// width the item wraps to a second rendered row the estimate missed — an under-count re-triggers
// Ink's scrollback-erasing repaint (see liveWindow.ts).
describe('renderedRows — list markers of varying width are measured renderer-true', () => {
  const firstBlock = (text: string) => {
    const blocks = parseMarkdown(sanitizeForDisplay(text));
    expect(blocks.length).toBeGreaterThan(0);
    return blocks[0]!;
  };

  const listCases: ReadonlyArray<readonly [string, string, number]> = [
    // '1. ' (3 cells) + 38 = 41 > 40 → wraps to 2 rows; a `columns - 2` count would say 1.
    ['ordered 1-digit marker at the knife edge', `1. ${'x'.repeat(38)}`, 40],
    // '10. ' (4 cells) + 37 = 41 > 40 → 2 rows.
    ['ordered 2-digit marker at the knife edge', `10. ${'x'.repeat(37)}`, 40],
    // nested bullet '  •' (indent 2 + bullet) + ' ' + 37 = 41 > 40 → 2 rows.
    ['nested bullet with leading indent', `  - ${'x'.repeat(37)}`, 40],
  ];

  it.each(listCases)('%s: estimate >= the real rendered rows (and the marker pushes it to 2)', (_label, text, width) => {
    const block = firstBlock(text);
    const actual = rowCount(frameAt(text, width));
    // The marker tips each fixture past the width so it wraps to a SECOND row — the exact case the
    // old `columns - 2` (2-cell marker) approximation under-counted to one.
    expect(actual).toBe(2);
    expect(renderedRows(block, width)).toBeGreaterThanOrEqual(actual);
  });
});
