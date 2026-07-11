import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import type { Msg } from '../src/core/reducer';
import { Message } from '../src/ui/Message';
import { Markdown } from '../src/ui/MarkdownView';
import { parseInline, parseMarkdown } from '../src/ui/markdown';

const frameOf = (el: Parameters<typeof render>[0]): string => render(el).lastFrame() ?? '';

// ---------------------------------------------------------------------------
// parseMarkdown / parseInline — pure tokenizer (no terminal)
// ---------------------------------------------------------------------------

describe('parseMarkdown — block tokenizer', () => {
  it('tokenizes a heading with its level and stripped marker', () => {
    const [block] = parseMarkdown('## Hello world');
    expect(block).toMatchObject({ kind: 'heading', level: 2 });
    if (block?.kind === 'heading') {
      expect(block.spans).toEqual([{ kind: 'text', text: 'Hello world' }]);
    }
  });

  it('tokenizes a terminated fenced code block, preserving inner lines verbatim', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1; // * not bold #\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: 'code', lang: 'ts', lines: ['const x = 1; // * not bold #'] });
  });

  it('an UNTERMINATED fence does not throw and swallows the rest as code', () => {
    let blocks: ReturnType<typeof parseMarkdown> = [];
    expect(() => {
      blocks = parseMarkdown('```\nline a\nline b');
    }).not.toThrow();
    expect(blocks[0]).toEqual({ kind: 'code', lang: '', lines: ['line a', 'line b'] });
  });

  it('groups unordered and ordered lists distinctly', () => {
    const un = parseMarkdown('- one\n- two');
    expect(un[0]).toMatchObject({ kind: 'list', ordered: false });
    const or = parseMarkdown('1. first\n2. second');
    expect(or[0]).toMatchObject({ kind: 'list', ordered: true });
    if (or[0]?.kind === 'list') expect(or[0].items[1]?.marker).toBe('2.');
  });

  it('groups a blockquote and recognizes a horizontal rule', () => {
    expect(parseMarkdown('> quoted')[0]).toMatchObject({ kind: 'blockquote' });
    expect(parseMarkdown('---')[0]).toEqual({ kind: 'hr' });
  });

  // Item 6: `- [ ]` / `- [x]` task-list items carry a `checked` flag and swap the
  // bullet for a checkbox glyph; a plain bullet in the same list is untouched.
  it('parses task-list items into checkbox markers with a checked flag', () => {
    const blocks = parseMarkdown('- [ ] todo\n- [x] done\n- plain');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    if (blocks[0]?.kind === 'list') {
      expect(blocks[0].items[0]).toMatchObject({ marker: '☐', checked: false });
      expect(blocks[0].items[1]).toMatchObject({ marker: '☒', checked: true });
      expect(blocks[0].items[1]?.spans).toEqual([{ kind: 'text', text: 'done' }]);
      // A non-task bullet keeps `•` and carries no `checked` flag.
      expect(blocks[0].items[2]).toMatchObject({ marker: '•' });
      expect(blocks[0].items[2]?.checked).toBeUndefined();
    }
  });

  it('degrades a pipe table to rows', () => {
    const blocks = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(blocks[0]).toEqual({ kind: 'table', rows: [['a', 'b'], ['1', '2']] });
  });

  it('an empty string yields a single blank paragraph', () => {
    expect(parseMarkdown('')).toEqual([{ kind: 'paragraph', spans: [] }]);
  });

  // Regression: a `pipe | line` followed by a bare `---` must NOT be read as a
  // table (which silently swallowed the HR). It is a paragraph + a rule.
  it('does not treat a piped line + bare `---` as a table (HR survives)', () => {
    const blocks = parseMarkdown('a | b\n---');
    expect(blocks[0]).toEqual({ kind: 'paragraph', spans: [{ kind: 'text', text: 'a | b' }] });
    expect(blocks[1]).toEqual({ kind: 'hr' });
  });

  // Regression: a real table must stop at the first line that is not shaped like
  // a row instead of greedily consuming any following line containing a `|`.
  it('stops a table at a non-row line rather than swallowing it', () => {
    const blocks = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\nnote x | y | z extra');
    expect(blocks[0]).toEqual({ kind: 'table', rows: [['a', 'b'], ['1', '2']] });
    expect(blocks[1]).toEqual({
      kind: 'paragraph',
      spans: [{ kind: 'text', text: 'note x | y | z extra' }],
    });
  });

  // Regression: a one-line pseudo-fence (backtick in the info string) is not a
  // real fence opener — it must render visibly and must not swallow later lines.
  it('treats a one-line backtick pseudo-fence as text, not a code block', () => {
    const blocks = parseMarkdown('```bash echo hi```\nafter');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).not.toBe('code');
    expect(blocks[1]).toEqual({ kind: 'paragraph', spans: [{ kind: 'text', text: 'after' }] });
  });

  // Regression: nested-list indentation is preserved, `1)` keeps its delimiter,
  // and `+ ` lines (diff additions) are NOT converted into bullets.
  it('preserves nested-list indentation and the ordered delimiter', () => {
    const blocks = parseMarkdown('- top\n  - nested');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    if (blocks[0]?.kind === 'list') {
      expect(blocks[0].items[0]?.marker).toBe('•');
      expect(blocks[0].items[1]?.marker).toBe('  •');
    }
    const paren = parseMarkdown('1) first\n2) second');
    if (paren[0]?.kind === 'list') {
      expect(paren[0].items[0]?.marker).toBe('1)');
      expect(paren[0].items[1]?.marker).toBe('2)');
    }
  });

  it('does not bullet-convert `+ ` diff-addition lines', () => {
    const blocks = parseMarkdown('+ added line');
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      spans: [{ kind: 'text', text: '+ added line' }],
    });
  });

  it('keeps each source line its own paragraph (no re-flow of plain text)', () => {
    const blocks = parseMarkdown('line one\nline two');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: 'paragraph', spans: [{ kind: 'text', text: 'line one' }] });
  });
});

describe('parseInline — fidelity of non-markdown text', () => {
  it('strips matched bold / italic / code markers', () => {
    expect(parseInline('**b**')).toEqual([{ kind: 'bold', text: 'b' }]);
    expect(parseInline('*i*')).toEqual([{ kind: 'italic', text: 'i' }]);
    expect(parseInline('`c`')).toEqual([{ kind: 'code', text: 'c' }]);
  });

  it('parses a link into text + url', () => {
    expect(parseInline('[Anthropic](https://x.dev)')).toEqual([
      { kind: 'link', text: 'Anthropic', url: 'https://x.dev' },
    ]);
  });

  it('leaves a lone `*` with spaces and word-internal `_` untouched', () => {
    expect(parseInline('a * b')).toEqual([{ kind: 'text', text: 'a * b' }]);
    expect(parseInline('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }]);
  });

  // Item 6: `***x***` is bold+italic, `~~x~~` is strikethrough, but a LONE `~`
  // (home paths `~/foo`, `a ~ b`, a single-marker `~x~`) must stay literal.
  it('parses ***bold-italic*** and ~~strike~~, but leaves a lone ~ literal', () => {
    expect(parseInline('***x***')).toEqual([{ kind: 'bolditalic', text: 'x' }]);
    expect(parseInline('~~x~~')).toEqual([{ kind: 'strike', text: 'x' }]);
    expect(parseInline('run ~/foo now')).toEqual([{ kind: 'text', text: 'run ~/foo now' }]);
    expect(parseInline('a ~ b')).toEqual([{ kind: 'text', text: 'a ~ b' }]);
    expect(parseInline('~x~')).toEqual([{ kind: 'text', text: '~x~' }]);
  });

  it('leaves an unterminated marker literal', () => {
    expect(parseInline('`unclosed')).toEqual([{ kind: 'text', text: '`unclosed' }]);
    expect(parseInline('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }]);
  });

  // Regression: multi-backtick code spans match on run length. Degenerate or
  // unmatched runs pass through verbatim (no dropped/relocated backticks).
  it('handles multi-backtick and degenerate code spans verbatim', () => {
    expect(parseInline('``a`b``')).toEqual([{ kind: 'code', text: 'a`b' }]);
    expect(parseInline('```js')).toEqual([{ kind: 'text', text: '```js' }]);
  });

  // Regression: only well-formed `[text](url)` with a URL-shaped target links;
  // `arr[i](cb)` (code) is left byte-identical instead of eating characters.
  it('only linkifies URL-shaped targets, leaving code untouched', () => {
    expect(parseInline('if (arr[i](cb)) return;')).toEqual([
      { kind: 'text', text: 'if (arr[i](cb)) return;' },
    ]);
    expect(parseInline('[d](/path)')).toEqual([{ kind: 'link', text: 'd', url: '/path' }]);
  });

  // Regression / perf guard: a pathological asterisk-heavy 60KB line (every `*`
  // a failing emphasis opener) must tokenize near-instantly, degrading to one
  // verbatim text span rather than rescanning to end-of-line per marker.
  it('tokenizes a 60KB asterisk-heavy line in well under 100ms', () => {
    const line = '*a '.repeat(20000); // 60KB
    const start = performance.now();
    const spans = parseInline(line);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(spans).toEqual([{ kind: 'text', text: line }]);
  });
});

// ---------------------------------------------------------------------------
// Markdown renderer — Ink frames render each construct distinctly
// ---------------------------------------------------------------------------

describe('Markdown renderer', () => {
  it('renders a heading without its `#` marker', () => {
    const frame = frameOf(<Markdown text="# Title" depth="ansi16" />);
    expect(frame).toContain('Title');
    expect(frame).not.toContain('# Title');
  });

  it('renders bold/italic/code content with markers stripped', () => {
    const frame = frameOf(<Markdown text="say **bold** and *soft* and `code`" depth="ansi16" />);
    expect(frame).toContain('bold');
    expect(frame).toContain('code');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`code`');
  });

  it('renders a fenced code block verbatim (including * and # inside)', () => {
    const frame = frameOf(<Markdown text={'```\nx = a * b # note\n```'} depth="ansi16" />);
    expect(frame).toContain('x = a * b # note');
  });

  it('renders list bullets, a blockquote bar, and a horizontal rule', () => {
    expect(frameOf(<Markdown text={'- alpha\n- beta'} depth="ansi16" />)).toContain('• alpha');
    expect(frameOf(<Markdown text="> quoted" depth="ansi16" />)).toContain('│');
    expect(frameOf(<Markdown text="---" depth="ansi16" />)).toContain('─');
  });

  it('renders a link as text plus a dim URL', () => {
    const frame = frameOf(<Markdown text="see [docs](http://d.io)" depth="ansi16" />);
    expect(frame).toContain('docs');
    expect(frame).toContain('(http://d.io)');
  });

  it('passes plain, non-markdown text through unmangled', () => {
    const plain = 'total = a * b and flag = c_d_e; # not a heading';
    const frame = frameOf(<Markdown text={plain} depth="ansi16" />);
    expect(frame).toContain(plain);
  });

  it('does not throw on an unterminated fence and still shows the tail', () => {
    let frame = '';
    expect(() => {
      frame = frameOf(<Markdown text={'```\nhalf written'} depth="ansi16" />);
    }).not.toThrow();
    expect(frame).toContain('half written');
  });
});

// ---------------------------------------------------------------------------
// Message integration — markdown on ALL assistant text (live-markdown, item D)
// ---------------------------------------------------------------------------

describe('Message — markdown gating by role', () => {
  const withText = (over: Partial<Msg>): Msg => ({
    id: 'm1',
    role: 'assistant',
    done: true,
    blocks: [{ kind: 'text', id: 'm1:block:1', text: '# Heading' }],
    ...over,
  });

  it('formats a completed assistant message (heading marker gone)', () => {
    const frame = frameOf(<Message msg={withText({})} depth="ansi16" />);
    expect(frame).toContain('Heading');
    expect(frame).not.toContain('# Heading');
  });

  // Item D inverts the old gate: a STREAMING assistant message now renders markdown
  // too (no `&& msg.done`), so the `#` marker is styled away exactly as when committed.
  it('formats a STREAMING assistant message the same as committed (marker gone)', () => {
    const frame = frameOf(<Message msg={withText({ done: false })} depth="ansi16" />);
    expect(frame).toContain('Heading');
    expect(frame).not.toContain('# Heading');
  });

  it('keeps a USER message raw even when done', () => {
    const frame = frameOf(<Message msg={withText({ role: 'user' })} depth="ansi16" />);
    expect(frame).toContain('# Heading');
  });

  // Tolerance while streaming: half-written constructs must render without throwing.
  it('renders a streaming assistant message with an unclosed fence without throwing', () => {
    let frame = '';
    expect(() => {
      frame = frameOf(
        <Message
          msg={withText({ done: false, blocks: [{ kind: 'text', id: 'm1:block:1', text: '```\nhalf written' }] })}
          depth="ansi16"
        />,
      );
    }).not.toThrow();
    // The tail renders as code (the fence marker itself is consumed, not shown raw).
    expect(frame).toContain('half written');
  });

  it('renders a streaming assistant message with a half-written bold without throwing', () => {
    let frame = '';
    expect(() => {
      frame = frameOf(
        <Message
          msg={withText({ done: false, blocks: [{ kind: 'text', id: 'm1:block:1', text: 'say **bo' }] })}
          depth="ansi16"
        />,
      );
    }).not.toThrow();
    // A dangling emphasis opener stays literal until its closer streams in.
    expect(frame).toContain('**bo');
  });
});
