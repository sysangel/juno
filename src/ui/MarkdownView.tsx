// src/ui/MarkdownView.tsx
// Ink renderer for the tolerant markdown tokenizer in `markdown.ts`. Presentational
// and pure: given assistant text it maps block/inline nodes to themed <Text>/<Box>.
// Colours come ONLY from theme tokens (no hardcoded hex).
//
// Live-markdown (D): Message.tsx renders this for assistant text in BOTH states —
// streaming and committed — so the live turn already reads as its final form (no
// re-snap on commit). The tokenizer is total and tolerant of half-written markup
// (a truncated fence still renders, a dangling emphasis marker stays literal), so
// parsing mid-stream prose is safe; the parse is memoized on `text` below so a
// spinner/elapsed tick that leaves the text unchanged does not re-tokenize.

import { Box, Text } from 'ink';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { token, type ColorDepth } from './theme';
import { parseInline, parseMarkdown, type InlineSpan, type MdBlock } from './markdown';
import { RULE_CHAR } from './glyphs';
import { displayWidth, rowsForText, sanitizeForDisplay } from './clipText';

const RULE_WIDTH = 40;

/** Render inline spans as nested <Text> that inherit the parent colour. */
function renderSpans(spans: InlineSpan[], d: ColorDepth): ReactNode[] {
  return spans.map((span, idx) => {
    switch (span.kind) {
      case 'text':
        return <Text key={idx}>{span.text}</Text>;
      case 'bold':
        return (
          <Text key={idx} bold>
            {span.text}
          </Text>
        );
      case 'italic':
        return (
          <Text key={idx} italic>
            {span.text}
          </Text>
        );
      case 'bolditalic':
        return (
          <Text key={idx} bold italic>
            {span.text}
          </Text>
        );
      case 'strike':
        return (
          <Text key={idx} strikethrough>
            {span.text}
          </Text>
        );
      case 'code':
        // De-collided from headings (which own `accent`): inline code renders in
        // `info` so a bare-`accent` H3 and an inline span never read identically.
        return (
          <Text key={idx} color={token('info', d)}>
            {span.text}
          </Text>
        );
      case 'link':
        // Single-dim convention (item 6): the URL is `textDim` only — no stacked
        // Ink `dimColor` (which used to render it "very dim" vs other dim chrome).
        return (
          <Text key={idx}>
            {span.text}{' '}
            <Text color={token('textDim', d)}>({span.url})</Text>
          </Text>
        );
    }
  });
}

/**
 * Pad table cells to per-column widths for aligned plain-text degradation. Widths
 * are measured with `string-width` (terminal DISPLAY columns), not `.length`
 * (UTF-16 code units), so emoji/CJK cells — 2 columns wide but 1–2 code units —
 * still line up.
 */
export function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, c) => {
      widths[c] = Math.max(widths[c] ?? 0, displayWidth(cell));
    });
  }
  return widths;
}

/** Right-pad `cell` to `width` DISPLAY columns (string-width-aware `padEnd`). */
function padCell(cell: string, width: number): string {
  const deficit = width - displayWidth(cell);
  return deficit > 0 ? cell + ' '.repeat(deficit) : cell;
}

function renderBlock(block: MdBlock, key: number, d: ColorDepth): ReactElement {
  switch (block.kind) {
    case 'heading':
      // Differentiate levels (previously all `bold accent`, indistinguishable):
      //   H1 → bold + underline   H2 → bold   H3+ → plain accent.
      // All share the `accent` hue for a coherent heading family; weight/underline
      // encode depth.
      return (
        <Text
          key={key}
          bold={block.level <= 2}
          underline={block.level === 1}
          color={token('accent', d)}
        >
          {renderSpans(block.spans, d)}
        </Text>
      );

    case 'paragraph':
      // Empty line = a blank row (preserves vertical spacing of plain text).
      if (block.spans.length === 0) return <Box key={key} height={1} />;
      return (
        <Text key={key} color={token('text', d)}>
          {renderSpans(block.spans, d)}
        </Text>
      );

    case 'code':
      // Transcript-identity (E): the code BODY renders at NORMAL prose brightness
      // (`text`), never dimmer than surrounding prose. Flat colour — real syntax
      // highlighting is wave 2. Affordance without dimming the body: a dim language
      // label (only when the fence carried one) above the block, plus a `│ ` gutter
      // prefix per line (the exact blockquote pattern), so the block is visually
      // distinct from prose while its text stays full-brightness.
      return (
        <Box key={key} flexDirection="column">
          {block.lang !== '' && (
            <Text key="lang" color={token('textDim', d)}>
              {block.lang}
            </Text>
          )}
          {block.lines.map((line, idx) => (
            <Text key={idx} color={token('text', d)}>
              <Text color={token('border', d)}>│ </Text>
              {line.length === 0 ? ' ' : line}
            </Text>
          ))}
        </Box>
      );

    case 'list':
      return (
        <Box key={key} flexDirection="column">
          {block.items.map((item, idx) => (
            <Text key={idx} color={token('text', d)}>
              <Text color={token('textDim', d)}>{item.marker} </Text>
              {renderSpans(item.spans, d)}
            </Text>
          ))}
        </Box>
      );

    case 'blockquote':
      return (
        <Box key={key} flexDirection="column">
          {block.lines.map((spans, idx) => (
            // Single-dim convention (item 6): `textDim` only, no stacked `dimColor`.
            <Text key={idx} color={token('textDim', d)}>
              <Text color={token('border', d)}>│ </Text>
              {renderSpans(spans, d)}
            </Text>
          ))}
        </Box>
      );

    case 'hr':
      return (
        <Text key={key} color={token('border', d)} dimColor>
          {RULE_CHAR.repeat(RULE_WIDTH)}
        </Text>
      );

    case 'table': {
      const widths = columnWidths(block.rows);
      return (
        <Box key={key} flexDirection="column">
          {block.rows.map((row, idx) => (
            <Text key={idx} color={token('textDim', d)}>
              {row.map((cell, c) => padCell(cell, widths[c] ?? 0)).join(' │ ')}
            </Text>
          ))}
        </Box>
      );
    }
  }
}

/**
 * Rendered TEXT of one inline span, in the width it occupies on screen — the same string
 * {@link renderSpans} paints. A `link` span renders as `text (url)` (renderSpans emits the
 * URL in parens after the text), so its width is that whole run; every other span is its
 * bare `text`. Used only for width/row counting (never for rendering).
 */
function spanWidthText(span: InlineSpan): string {
  return span.kind === 'link' ? `${span.text} (${span.url})` : span.text;
}

/** The full rendered text of a span list, concatenated — for measuring wrapped rows. */
function plainText(spans: InlineSpan[]): string {
  return spans.map(spanWidthText).join('');
}

/**
 * TRUE rendered ROW count of ONE parsed markdown block at `columns` wide, mirroring
 * {@link renderBlock}'s layout so the live-window height estimator (src/ui/liveWindow.ts)
 * counts the DECORATION renderBlock adds — the 2-cell `│ ` code/blockquote gutter, the dim
 * code lang label, the `marker ` list prefix, table cell padding, a full blank row for an
 * empty paragraph — that a raw source-line count ignores. UPPER-bound faithful: an under-
 * count re-triggers Ink's scrollback-erasing full repaint (see liveWindow.ts), so a gutter/
 * marker branch measures its content at the SAME reduced width the renderer wraps at
 * (`columns - 2`). `rowsForText` returns 1 for a non-finite / ≤ 0 width, so `columns - 2`
 * at Infinity / tiny columns is safe. Pairs with the same `parseMarkdown(sanitizeForDisplay
 * (text))` the renderer uses, so summing this over a message's blocks equals the rendered
 * height.
 */
export function renderedRows(block: MdBlock, columns: number): number {
  switch (block.kind) {
    case 'heading':
      return rowsForText(plainText(block.spans), columns);
    case 'paragraph':
      // An empty paragraph renders as a full blank row (renderBlock: `<Box height={1} />`).
      return block.spans.length === 0 ? 1 : rowsForText(plainText(block.spans), columns);
    case 'code': {
      // A dim lang label above the block (only when the fence carried one), then each code
      // line prefixed with the 2-cell `│ ` gutter — so content wraps at `columns - 2`. An
      // empty code line still renders one row (renderBlock substitutes a single space).
      const label = block.lang !== '' ? 1 : 0;
      let rows = 0;
      for (const line of block.lines) rows += rowsForText(line.length === 0 ? ' ' : line, columns - 2);
      return label + rows;
    }
    case 'list': {
      // renderBlock paints `${item.marker} ${spans}` in ONE <Text>, so measure that EXACT string
      // at full `columns`. The marker width VARIES — '1.'/'10.' ordered, nested '  •', task '☐'
      // with leading indent — which a fixed `columns - 2` (2-cell marker) approximation under-
      // counts (e.g. '1. ' + 38 chars at 40 cols renders 2 rows, not 1). Measuring the painted
      // string is strictly renderer-true and covers every marker width.
      let rows = 0;
      for (const item of block.items) rows += rowsForText(`${item.marker} ${plainText(item.spans)}`, columns);
      return rows;
    }
    case 'blockquote': {
      // Each quote line carries the 2-cell `│ ` gutter, so it wraps at `columns - 2`.
      let rows = 0;
      for (const spans of block.lines) rows += rowsForText(plainText(spans), columns - 2);
      return rows;
    }
    case 'hr':
      // A fixed RULE_WIDTH-char rule — wraps only on a terminal narrower than the rule.
      return rowsForText(RULE_CHAR.repeat(RULE_WIDTH), columns);
    case 'table': {
      // Each row is padded per-column and joined with ` │ ` — the EXACT string renderBlock
      // builds (same `columnWidths` + `padCell`), so its wrapped-row count is measured true.
      const widths = columnWidths(block.rows);
      let rows = 0;
      for (const row of block.rows) {
        const rowString = row.map((cell, c) => padCell(cell, widths[c] ?? 0)).join(' │ ');
        rows += rowsForText(rowString, columns);
      }
      return rows;
    }
  }
}

export interface MarkdownProps {
  text: string;
  depth: ColorDepth;
}

/** Render assistant text as themed markdown. Pure & total (safe on partial input). */
export function Markdown({ text, depth }: MarkdownProps): ReactElement {
  // Live-markdown (D): parseMarkdown is O(n) over the whole message and Markdown now
  // renders on every streaming frame. Memoize on `text` so tick-only re-renders (the
  // 250ms elapsed clock, spinner frames) that don't change the prose skip the reparse.
  // Sanitize the RAW model text once BEFORE parsing — the single point that covers spans,
  // code, and tables in one shot. The scrubbed chars (C0/C1, bidi, zero-width) never carry
  // markdown structure, so pre-parse scrubbing is safe; its ASCII fast path is near-free.
  const blocks = useMemo(() => parseMarkdown(sanitizeForDisplay(text)), [text]);
  return <Box flexDirection="column">{blocks.map((block, idx) => renderBlock(block, idx, depth))}</Box>;
}

// Re-exported so tests and callers can reach the pure layer through one entry.
export { parseMarkdown, parseInline };
