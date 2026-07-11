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
  | { readonly kind: 'bolditalic'; readonly text: string }
  | { readonly kind: 'strike'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly url: string };

/**
 * A list item — one line of inline spans plus its rendered marker. `checked` is
 * present only for a task-list item (`- [ ]` / `- [x]`): the renderer swaps the
 * bullet for a checkbox glyph and the flag records the box state.
 */
export interface MdListItem {
  readonly marker: string;
  readonly spans: InlineSpan[];
  readonly checked?: boolean;
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
// Only `-`/`*` open a bullet; `+ ` is intentionally excluded so diff lines
// (`+ added`) stay plain text. Leading whitespace is captured to preserve
// nested-list indentation; the ordered delimiter (`.` vs `)`) is captured so
// `1)` renders as `1)` rather than being normalized to `1.`.
const UNORDERED = /^(\s*)[-*]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)([.)])\s+(.*)$/;
const TABLE_DELIM_CELL = /^\s*:?-+:?\s*$/;
// A GitHub task-list marker at the head of a bullet's content: `[ ]` / `[x]` /
// `[X]` followed by whitespace. The renderer swaps the bullet for a checkbox.
const TASK_MARKER = /^\[([ xX])\]\s+(.*)$/;

/**
 * Above this length, inline parsing is skipped and the line is emitted as a
 * single verbatim text span. Emphasis matching is worst-case superlinear (each
 * failing opener rescans to end-of-line), so a pathological delimiter-heavy
 * line could stall the render. Plain text is always a byte-identical fallback
 * and no human-authored inline run comes anywhere near this many characters.
 */
const INLINE_MAX = 2000;

/**
 * A `[text](url)` link only fires when the URL is recognizably a URL: an
 * explicit `scheme://`, a `www.` host, or an absolute `/path`. This keeps
 * bracket/paren code such as `arr[i](cb)` byte-identical instead of eating
 * characters into a bogus link.
 */
const LINK_URL = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|www\.|\/)/;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Index of the start of the next run of EXACTLY `n` backticks at or after
 * `from`, or -1. A run longer than `n` is not a valid closer for an n-length
 * opener, so it is skipped whole. Linear in the length scanned.
 */
function findBacktickRun(src: string, from: number, n: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === '`') {
      let len = 1;
      while (src[i + len] === '`') len++;
      if (len === n) return i;
      i += len;
    } else {
      i++;
    }
  }
  return -1;
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
  // Perf + safety guard: pathological delimiter-heavy lines make emphasis
  // matching superlinear. Above a generous threshold, emit the whole line as
  // one verbatim text span — always byte-identical, never slow. (See INLINE_MAX.)
  if (src.length > INLINE_MAX) {
    return src.length > 0 ? [{ kind: 'text', text: src }] : [];
  }

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

    // Inline code — highest precedence; inner text is literal. A code span is a
    // run of N backticks closed by a run of EXACTLY N backticks. An unmatched or
    // degenerate run passes through as literal backticks (never dropped or moved,
    // so ``a`b`` is a span around `a`b` and ```js with no closer stays verbatim).
    if (ch === '`') {
      let runLen = 1;
      while (src[i + runLen] === '`') runLen++;
      const close = findBacktickRun(src, i + runLen, runLen);
      if (close !== -1) {
        flush();
        spans.push({ kind: 'code', text: src.slice(i + runLen, close) });
        i = close + runLen;
        continue;
      }
      buf += src.slice(i, i + runLen);
      i += runLen;
      continue;
    }

    // Link [text](url) — only when `url` looks like a URL (see LINK_URL), so
    // non-link code such as `arr[i](cb)` stays byte-identical.
    if (ch === '[') {
      const closeText = src.indexOf(']', i + 1);
      if (closeText > i && src[closeText + 1] === '(') {
        const closeUrl = src.indexOf(')', closeText + 2);
        if (closeUrl > closeText) {
          const url = src.slice(closeText + 2, closeUrl);
          if (LINK_URL.test(url)) {
            flush();
            spans.push({
              kind: 'link',
              text: src.slice(i + 1, closeText),
              url,
            });
            i = closeUrl + 1;
            continue;
          }
        }
      }
    }

    // Emphasis: match the LONGEST well-flanked delimiter run (capped at 3), so
    // `***x***` reads as bold+italic, `**x**` bold, `*x*` italic. A run that does
    // not close well-flanked falls through to the shorter attempts on the next
    // char, exactly as before (no regression for the single/double cases).
    if (ch === '*' || ch === '_') {
      const runLen = src[i + 1] === ch ? (src[i + 2] === ch ? 3 : 2) : 1;
      const delim = ch.repeat(runLen);
      const close = matchEmphasis(src, i, delim);
      if (close > i) {
        flush();
        const text = src.slice(i + delim.length, close);
        const kind = runLen === 3 ? 'bolditalic' : runLen === 2 ? 'bold' : 'italic';
        spans.push({ kind, text });
        i = close + delim.length;
        continue;
      }
    }

    // Strikethrough (`~~x~~`). Only the DOUBLE marker fires; a lone `~` (home
    // paths like `~/foo`, `a ~ b`) stays literal via the same well-flanked rule.
    if (ch === '~' && src[i + 1] === '~') {
      const close = matchEmphasis(src, i, '~~');
      if (close > i) {
        flush();
        spans.push({ kind: 'strike', text: src.slice(i + 2, close) });
        i = close + 2;
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
  // A real separator row MUST contain a pipe (so a bare `---` reads as an HR,
  // not a table delimiter) and every cell must be dashes/colons only.
  if (!line.includes('|')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_DELIM_CELL.test(c));
}

/**
 * Does `line` structurally continue a table body? A row either carries an outer
 * `|` border or splits into the same number of cells as the header. Prose that
 * merely contains a stray `|` (a different shape) ends the table instead of
 * being greedily swallowed.
 */
function looksLikeTableRow(line: string, headerCells: number): boolean {
  if (!line.includes('|')) return false;
  const t = line.trim();
  if (t.startsWith('|') || t.endsWith('|')) return true;
  return splitRow(line).length === headerCells;
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
      // CommonMark: a backtick fence's info string may not contain a backtick.
      // A line like ```` ```bash echo hi``` ```` is a one-line pseudo-fence, not
      // a real opener — pass it through as plain text so it renders visibly and
      // does not swallow the lines that follow.
      if (fenceChar === '`' && lang.includes('`')) {
        blocks.push({ kind: 'paragraph', spans: parseInline(line) });
        i++;
        continue;
      }
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
      const header = splitRow(line);
      const rows: string[][] = [header];
      i += 2; // skip header + delimiter
      while (i < lines.length && looksLikeTableRow(lines[i] as string, header.length)) {
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
          // Preserve indentation and the author's delimiter (`1.` vs `1)`).
          items.push({ marker: `${o[1]}${o[2]}${o[3]}`, spans: parseInline(o[4] as string) });
          i++;
        } else if (!ordered && u !== null && o === null) {
          // Unordered bullets are normalized to `•` (renderer + tests depend on
          // this) but the leading indentation is preserved so nested lists keep
          // their shape. A `- [ ]` / `- [x]` task item swaps the bullet for a
          // checkbox glyph (`☐`/`☒`) and records the box state.
          const indent = u[1] as string;
          const content = u[2] as string;
          const task = TASK_MARKER.exec(content);
          if (task !== null) {
            const checked = (task[1] as string).toLowerCase() === 'x';
            items.push({
              marker: `${indent}${checked ? '☒' : '☐'}`,
              spans: parseInline(task[2] as string),
              checked,
            });
          } else {
            items.push({ marker: `${indent}•`, spans: parseInline(content) });
          }
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
