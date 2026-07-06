// src/ui/markdown.ts
// Pure, tolerant markdown tokenizer for assistant message text. NO React, NO
// I/O, NO throw — a total function of its input string. The Ink renderer lives
// in `Markdown.tsx`; this module only produces a data structure so it can be
// unit-tested without a terminal.
//
// Design notes (see docs/ARCHITECTURE.md, docs/DECISIONS.md — minimal-deps):
//   * Hand-rolled line-based blocks + a conservative inline scanner. No parser
//     dependency: the surface we render is small and the fidelity rules (never
//     mangle non-markdown text) are easier to guarantee in-house than to bolt
//     onto a general CommonMark lib.
//   * FIDELITY FIRST. Emphasis (`*`/`_`) only fires on well-flanked, matched
//     delimiters, so pasted code (`a * b`, `snake_case`, `# not-a-heading`)
//     passes through byte-identical. Unmatched markers stay literal.
//   * TOLERANT. An unterminated fence swallows the rest of the input as a code
//     block; an unterminated inline marker degrades to literal text. Never throws.
//   * Paragraphs are ONE source line each (no soft-wrap re-flow) so multi-line
//     plain text keeps its newlines exactly.

/** Inline run inside a block. `text` is already delimiter-stripped. */
export type InlineSpan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly url: string };

/** A list item — one line of inline spans plus its rendered marker. */
export interface MdListItem {
  readonly marker: string;
  readonly spans: InlineSpan[];
}

/** Block-level node. `paragraph` with an empty span list = a blank line. */
export type MdBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly spans: InlineSpan[] }
  | { readonly kind: 'paragraph'; readonly spans: InlineSpan[] }
  | { readonly kind: 'code'; readonly lang: string; readonly lines: string[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: MdListItem[] }
  | { readonly kind: 'blockquote'; readonly lines: InlineSpan[][] }
  | { readonly kind: 'hr' }
  | { readonly kind: 'table'; readonly rows: string[][] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)(.*)$/;
const HR = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
const UNORDERED = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_DELIM_CELL = /^\s*:?-+:?\s*$/;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Try to match an emphasis run of delimiter `delim` (length 1 = italic, 2 =
 * bold) starting at `open` in `src`. Returns the closing delimiter's start
 * index, or -1 when there is no valid, well-flanked close. Conservative on
 * purpose: an opener followed by whitespace, or a `_` glued to a word, never
 * opens — so `a * b` and `snake_case` stay literal.
 */
function matchEmphasis(src: string, open: number, delim: string): number {
  const len = delim.length;
  const afterOpen = src[open + len];
  if (afterOpen === undefined || /\s/.test(afterOpen)) return -1;
  if (delim[0] === '_' && isAlnum(src[open - 1])) return -1;
  for (let i = open + len; i <= src.length - len; i++) {
    if (src.startsWith(delim, i) && src[i - 1] !== undefined && !/\s/.test(src[i - 1] as string)) {
      // For `_`, the close must sit at a word boundary too (no `foo_bar_baz`).
      if (delim[0] === '_' && isAlnum(src[i + len])) continue;
      if (i === open + len) continue; // empty content — not emphasis
      return i;
    }
  }
  return -1;
}

/**
 * Parse inline runs. Total & tolerant: any marker that does not form a complete
 * construct is emitted as literal text, so arbitrary input round-trips.
 */
export function parseInline(src: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf.length > 0) {
      spans.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Inline code — highest precedence; inner text is literal.
    if (ch === '`') {
      const close = src.indexOf('`', i + 1);
      if (close > i) {
        flush();
        spans.push({ kind: 'code', text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // Link [text](url)
    if (ch === '[') {
      const closeText = src.indexOf(']', i + 1);
      if (closeText > i && src[closeText + 1] === '(') {
        const closeUrl = src.indexOf(')', closeText + 2);
        if (closeUrl > closeText) {
          flush();
          spans.push({
            kind: 'link',
            text: src.slice(i + 1, closeText),
            url: src.slice(closeText + 2, closeUrl),
          });
          i = closeUrl + 1;
          continue;
        }
      }
    }

    // Bold (**/__) before italic (*/_).
    if (ch === '*' || ch === '_') {
      const isDouble = src[i + 1] === ch;
      const delim = isDouble ? ch + ch : ch;
      const close = matchEmphasis(src, i, delim);
      if (close > i) {
        flush();
        const text = src.slice(i + delim.length, close);
        spans.push({ kind: isDouble ? 'bold' : 'italic', text });
        i = close + delim.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return spans;
}

function isTableDelimiter(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_DELIM_CELL.test(c));
}

/** Split a table row on unescaped `|`, trimming the optional leading/trailing pipe. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Tokenize `src` into block nodes. Total, tolerant, never throws. The renderer
 * (Markdown.tsx) maps these to Ink elements with theme colours.
 */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // Fenced code — tolerant: an unterminated fence eats the rest of the input.
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] as string;
      const fenceChar = marker[0] as string;
      const lang = (fence[2] as string).trim();
      const closeRe = new RegExp(`^\\s*\\${fenceChar}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] as string;
        if (closeRe.test(l)) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }

    // Horizontal rule.
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Heading.
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        spans: parseInline(heading[2] as string),
      });
      i++;
      continue;
    }

    // Blockquote — group consecutive `>` lines.
    const bq = BLOCKQUOTE.exec(line);
    if (bq !== null) {
      const quoteLines: InlineSpan[][] = [];
      while (i < lines.length) {
        const m = BLOCKQUOTE.exec(lines[i] as string);
        if (m === null) break;
        quoteLines.push(parseInline(m[1] as string));
        i++;
      }
      blocks.push({ kind: 'blockquote', lines: quoteLines });
      continue;
    }

    // Table — header row + delimiter row, then following pipe rows.
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1] as string)) {
      const rows: string[][] = [splitRow(line)];
      i += 2; // skip header + delimiter
      while (i < lines.length && (lines[i] as string).includes('|')) {
        rows.push(splitRow(lines[i] as string));
        i++;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }

    // List — group consecutive item lines of the same ordering.
    const un = UNORDERED.exec(line);
    const or = ORDERED.exec(line);
    if (un !== null || or !== null) {
      const ordered = or !== null;
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const u = UNORDERED.exec(lines[i] as string);
        const o = ORDERED.exec(lines[i] as string);
        if (ordered && o !== null) {
          items.push({ marker: `${o[2]}.`, spans: parseInline(o[3] as string) });
          i++;
        } else if (!ordered && u !== null && o === null) {
          items.push({ marker: '•', spans: parseInline(u[2] as string) });
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Paragraph — exactly one source line (empty line = blank paragraph). This
    // keeps multi-line plain text newline-for-newline identical.
    blocks.push({ kind: 'paragraph', spans: parseInline(line) });
    i++;
  }

  return blocks;
}
