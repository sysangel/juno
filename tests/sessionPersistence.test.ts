// tests/sessionPersistence.test.ts
// Session Resume — Unit 2C. Pure producer/formatting helpers: title derivation,
// SessionMeta building (exact-optional), and palette-entry mapping.
import { describe, it, expect } from 'vitest';
import type { Msg } from '../src/core/reducer';
import type { SessionMeta } from '../src/services/sessions';
import {
  deriveSessionTitle,
  formatRelativeTime,
  sessionMetaFor,
  toPaletteEntries,
} from '../src/services/sessionPersistence';
import { DEFAULT_SETTINGS } from '../src/services/config';
import { displayWidth } from '../src/ui/clipText';

// A lone (unpaired) UTF-16 surrogate — the `�` a raw `.slice()` emits when it cuts
// between the two code units of an astral glyph. The title cap must never yield one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function userMsg(text: string): Msg {
  return { id: 'u1', role: 'user', blocks: [{ kind: 'text', id: 'u1:block:1', text }], done: true };
}

function asstMsg(text: string): Msg {
  return { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', id: 'a1:block:1', text }], done: true };
}

describe('deriveSessionTitle', () => {
  it('uses the first user message text', () => {
    expect(deriveSessionTitle([userMsg('refactor the parser')])).toBe('refactor the parser');
  });

  it('skips leading assistant/system messages and reads the first USER message', () => {
    expect(deriveSessionTitle([asstMsg('hi'), userMsg('the real question')])).toBe('the real question');
  });

  it('concatenates a user message’s multiple text blocks and trims', () => {
    const msg: Msg = {
      id: 'u1',
      role: 'user',
      blocks: [
        { kind: 'text', id: 'u1:block:1', text: '  hello ' },
        { kind: 'text', id: 'u1:block:2', text: 'world  ' },
      ],
      done: true,
    };
    expect(deriveSessionTitle([msg])).toBe('hello world');
  });

  // Regression pin: the title renders on a SINGLE palette row, so every internal
  // whitespace run — newlines, tabs, CR/LF, or multi-space — must COLLAPSE to one
  // space (an embedded newline would otherwise break the one-line card layout).
  // The collapse rides on clipCells' `\s+ → ' '` normalization; deriveSessionTitle
  // routing through clipCells is what guarantees it. Left unpinned before this test.
  it('collapses an internal newline to a single space (single-line title guard)', () => {
    expect(deriveSessionTitle([userMsg('refactor the\nparser module')])).toBe(
      'refactor the parser module',
    );
  });

  it('collapses every internal whitespace run (tabs, CR/LF, blank lines, multi-space) to one space', () => {
    expect(deriveSessionTitle([userMsg('line1\n\n\nline2')])).toBe('line1 line2');
    expect(deriveSessionTitle([userMsg('foo\t\tbar')])).toBe('foo bar');
    expect(deriveSessionTitle([userMsg('foo     bar')])).toBe('foo bar');
    expect(deriveSessionTitle([userMsg('foo \t\n  bar')])).toBe('foo bar');
    expect(deriveSessionTitle([userMsg('a\r\nb')])).toBe('a b');
  });

  it('trims leading/trailing whitespace of any kind (newlines/tabs, not just spaces)', () => {
    expect(deriveSessionTitle([userMsg('\n\n\t hello world \t\n\n')])).toBe('hello world');
  });

  it('returns undefined for whitespace-only text of any kind (newlines/tabs)', () => {
    expect(deriveSessionTitle([userMsg('  \n\t  ')])).toBeUndefined();
  });

  it('clips past the 60-CELL budget with a trailing ellipsis', () => {
    const long = 'x'.repeat(80);
    const title = deriveSessionTitle([userMsg(long)]);
    // clipCells reserves one cell for the ellipsis: 59 glyphs + '…' = 60 cells
    // (was a raw UTF-16 slice of 60 chars + '…' = 61 chars before the wave-10 fix).
    expect(title).toBe(`${'x'.repeat(59)}…`);
    expect(displayWidth(title!)).toBe(60);
  });

  it('clips a WIDE CJK title to the cell budget instead of overflowing it', () => {
    // 40 CJK glyphs = 80 cells but only 40 UTF-16 units: the old `length > 60` gate
    // saw 40 ≤ 60 and returned all 80 cells, overflowing the palette. Cell-clipping
    // bounds it to 60 cells (29 glyphs = 58 cells + '…').
    const title = deriveSessionTitle([userMsg('字'.repeat(40))]);
    expect(title).toBe(`${'字'.repeat(29)}…`);
    expect(displayWidth(title!)).toBeLessThanOrEqual(60);
  });

  it('clips an astral-emoji title without stranding a surrogate at the cut', () => {
    // The leading ASCII char makes the old 60-UTF-16-unit cut land BETWEEN an
    // emoji's two surrogate halves; `.slice(0, 60)` stranded a lone high surrogate.
    const title = deriveSessionTitle([userMsg(`x${'😀'.repeat(40)}`)])!;
    expect(title).not.toMatch(LONE_SURROGATE);
    expect(displayWidth(title)).toBeLessThanOrEqual(60);
    // Proof the OLD slice garbled at this exact cut:
    expect(`x${'😀'.repeat(40)}`.slice(0, 60)).toMatch(LONE_SURROGATE);
  });

  it('returns undefined when there is no user message', () => {
    expect(deriveSessionTitle([asstMsg('only assistant')])).toBeUndefined();
  });

  it('returns undefined when the first user message has no text (tool-only / empty)', () => {
    const toolOnly: Msg = {
      id: 'u1',
      role: 'user',
      blocks: [{ kind: 'tool', id: 'u1:block:1', toolCallId: 'tc1' }],
      done: true,
    };
    expect(deriveSessionTitle([toolOnly])).toBeUndefined();
    expect(deriveSessionTitle([userMsg('   ')])).toBeUndefined();
  });

  it('returns undefined for an empty transcript', () => {
    expect(deriveSessionTitle([])).toBeUndefined();
  });
});

describe('sessionMetaFor', () => {
  it('builds a full meta with derived title + optional model/cwd', () => {
    const meta = sessionMetaFor({
      id: 's1',
      createdAt: '2026-06-20T10:00:00.000Z',
      model: DEFAULT_SETTINGS.defaultModel,
      cwd: '/work',
      messages: [userMsg('do the thing')],
    });
    expect(meta).toEqual({
      id: 's1',
      createdAt: '2026-06-20T10:00:00.000Z',
      model: DEFAULT_SETTINGS.defaultModel,
      cwd: '/work',
      title: 'do the thing',
    });
  });

  it('omits title when none can be derived (exact-optional clean)', () => {
    const meta = sessionMetaFor({ id: 's2', createdAt: 'now', messages: [] });
    expect(meta).toEqual({ id: 's2', createdAt: 'now' });
    expect('title' in meta).toBe(false);
  });

  it('omits model/cwd when not supplied', () => {
    const meta = sessionMetaFor({ id: 's3', createdAt: 'now', messages: [userMsg('hi')] });
    expect('model' in meta).toBe(false);
    expect('cwd' in meta).toBe(false);
    expect(meta.title).toBe('hi');
  });
});

describe('toPaletteEntries', () => {
  it('maps metas to entries (title ?? id, subtitle = createdAt) preserving order', () => {
    const metas: SessionMeta[] = [
      { id: 'a', createdAt: '2026-06-20T09:00:00.000Z', title: 'First chat' },
      { id: 'b', createdAt: '2026-06-20T10:00:00.000Z' }, // no title → falls back to id
    ];
    // F: newest-first ordering + relative subtitles (formatted against `now`).
    // `now` = one hour after 'b' → 'b' is `1h ago`; 'a' is two hours before now → `2h ago`.
    const now = Date.parse('2026-06-20T11:00:00.000Z');
    expect(toPaletteEntries(metas, now)).toEqual([
      { id: 'b', title: 'b', subtitle: '1h ago' },
      { id: 'a', title: 'First chat', subtitle: '2h ago' },
    ]);
  });

  it('maps an empty list to an empty array', () => {
    expect(toPaletteEntries([])).toEqual([]);
  });
});

describe('formatRelativeTime (F: sessions picker readability)', () => {
  const base = Date.parse('2026-07-07T12:00:00.000Z');

  it('reports sub-minute ages as `just now`', () => {
    expect(formatRelativeTime(base - 30_000, base)).toBe('just now');
    expect(formatRelativeTime(base, base)).toBe('just now');
  });

  it('reports minutes and hours with an `ago` suffix', () => {
    expect(formatRelativeTime(base - 2 * 60_000, base)).toBe('2m ago');
    expect(formatRelativeTime(base - 59 * 60_000, base)).toBe('59m ago');
    expect(formatRelativeTime(base - 3 * 3_600_000, base)).toBe('3h ago');
    expect(formatRelativeTime(base - 23 * 3_600_000, base)).toBe('23h ago');
  });

  it('reports the 24–48h window as `yesterday`', () => {
    expect(formatRelativeTime(base - 25 * 3_600_000, base)).toBe('yesterday');
    expect(formatRelativeTime(base - 47 * 3_600_000, base)).toBe('yesterday');
  });

  it('falls back to a lowercase `mon d` absolute date past 48h', () => {
    const then = new Date(base - 5 * 24 * 3_600_000); // 2026-07-02
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    expect(formatRelativeTime(then.getTime(), base)).toBe(
      `${months[then.getMonth()]} ${then.getDate()}`,
    );
  });

  it('clamps a future timestamp and a non-finite input to `just now`', () => {
    expect(formatRelativeTime(base + 10_000, base)).toBe('just now');
    expect(formatRelativeTime(Number.NaN, base)).toBe('just now');
  });
});

describe('toPaletteEntries — ordering + fallbacks (F)', () => {
  it('sorts newest-first regardless of input order', () => {
    const now = Date.parse('2026-07-07T12:00:00.000Z');
    const metas: SessionMeta[] = [
      { id: 'old', createdAt: '2026-07-01T12:00:00.000Z' },
      { id: 'new', createdAt: '2026-07-07T11:00:00.000Z' },
      { id: 'mid', createdAt: '2026-07-05T12:00:00.000Z' },
    ];
    expect(toPaletteEntries(metas, now).map((entry) => entry.id)).toEqual(['new', 'mid', 'old']);
  });

  it('shows an unparseable createdAt verbatim and sorts it last', () => {
    const now = Date.parse('2026-07-07T12:00:00.000Z');
    const metas: SessionMeta[] = [
      { id: 'bad', createdAt: 'not-a-date' },
      { id: 'good', createdAt: '2026-07-07T11:00:00.000Z' },
    ];
    const entries = toPaletteEntries(metas, now);
    expect(entries.map((entry) => entry.id)).toEqual(['good', 'bad']);
    expect(entries[1]).toEqual({ id: 'bad', title: 'bad', subtitle: 'not-a-date' });
  });
});
