import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
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

  it('degrades a pipe table to rows', () => {
    const blocks = parseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(blocks[0]).toEqual({ kind: 'table', rows: [['a', 'b'], ['1', '2']] });
  });

  it('an empty string yields no blocks', () => {
    expect(parseMarkdown('')).toEqual([{ kind: 'paragraph', spans: [] }]);
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

  it('leaves an unterminated marker literal', () => {
    expect(parseInline('`unclosed')).toEqual([{ kind: 'text', text: '`unclosed' }]);
    expect(parseInline('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }]);
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
// Message integration — markdown only on COMPLETED assistant messages
// ---------------------------------------------------------------------------

describe('Message — markdown gating by role + done', () => {
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

  it('keeps a STREAMING assistant message raw (marker preserved)', () => {
    const frame = frameOf(<Message msg={withText({ done: false })} depth="ansi16" />);
    expect(frame).toContain('# Heading');
  });

  it('keeps a USER message raw even when done', () => {
    const frame = frameOf(<Message msg={withText({ role: 'user' })} depth="ansi16" />);
    expect(frame).toContain('# Heading');
  });
});
