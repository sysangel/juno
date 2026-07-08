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
      case 'code':
        return (
          <Text key={idx} color={token('accent', d)}>
            {span.text}
          </Text>
        );
      case 'link':
        return (
          <Text key={idx}>
            {span.text}{' '}
            <Text color={token('textDim', d)} dimColor>
              ({span.url})
            </Text>
          </Text>
        );
    }
  });
}

/** Pad table cells to per-column widths for aligned plain-text degradation. */
function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, c) => {
      widths[c] = Math.max(widths[c] ?? 0, cell.length);
    });
  }
  return widths;
}

function renderBlock(block: MdBlock, key: number, d: ColorDepth): ReactElement {
  switch (block.kind) {
    case 'heading':
      return (
        <Text key={key} bold color={token('accent', d)}>
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
      // Transcript-identity (E): code blocks render at NORMAL prose brightness
      // (`text`), never dimmer than surrounding prose. Flat colour — real syntax
      // highlighting is wave 2 — with the 2-space indent kept.
      return (
        <Box key={key} flexDirection="column" paddingLeft={2}>
          {block.lines.map((line, idx) => (
            <Text key={idx} color={token('text', d)}>
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
            <Text key={idx} color={token('textDim', d)} dimColor>
              <Text color={token('border', d)}>│ </Text>
              {renderSpans(spans, d)}
            </Text>
          ))}
        </Box>
      );

    case 'hr':
      return (
        <Text key={key} color={token('border', d)} dimColor>
          {'─'.repeat(RULE_WIDTH)}
        </Text>
      );

    case 'table': {
      const widths = columnWidths(block.rows);
      return (
        <Box key={key} flexDirection="column">
          {block.rows.map((row, idx) => (
            <Text key={idx} color={token('textDim', d)}>
              {row.map((cell, c) => cell.padEnd(widths[c] ?? 0)).join(' │ ')}
            </Text>
          ))}
        </Box>
      );
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
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <Box flexDirection="column">{blocks.map((block, idx) => renderBlock(block, idx, depth))}</Box>;
}

// Re-exported so tests and callers can reach the pure layer through one entry.
export { parseMarkdown, parseInline };
