// tests/clipText.test.ts
// Wave-9 lane: the consolidated display-width authority (src/ui/clipText.ts).
//   - displayWidth : measures in terminal cells (CJK/emoji = 2, combining = 0).
//   - clipCells    : single-line clip that never overflows the cell budget nor splits
//                    a surrogate pair / orphans a combining mark at the cut.
//   - wrapCells    : hard-wrap by cell width — the cell-correct replacement for the old
//                    UTF-16 `.slice()` hard-wrap; ASCII-identical, wide-char-safe.
//   - rowsForWidth : a HOMOGENEOUS (ASCII / char-cap) cell-budget row count — exact only
//                    when every cell is independently placeable; under-counts wide glyphs.
//   - rowsForText  : the TRUE wrapped-row count of real text, via wrapCells — wide-glyph
//                    and odd-column correct (the odd-glyph fix rowsForWidth can't express).
//
// Combining sequences are written with an explicit ́ (COMBINING ACUTE ACCENT) so the
// base+mark decomposition is unambiguous in source (a precomposed literal would be one
// scalar and never exercise the combining path).
import { describe, it, expect } from 'vitest';
import {
  displayWidth,
  clipCells,
  wrapCells,
  rowsForWidth,
  rowsForText,
  sanitizeForDisplay,
} from '../src/ui/clipText';

// An unpaired UTF-16 surrogate — the `�` garble a raw `.slice()` emits when it cuts
// between the two code units of an astral glyph. No correct helper may ever produce one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Grapheme clusters that span MULTIPLE code points and must never be split by clip/wrap.
// Written with explicit code-point escapes so the internal ZWJ (U+200D) and the two
// regional indicators are unambiguous in source (a pasted glyph hides them).
const ZWJ = '\u200D';
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`; // 👨‍👩‍👧, width 2, five code points
const FLAG_US = '\u{1F1FA}\u{1F1F8}'; // 🇺🇸, a regional-indicator PAIR, width 2

describe('displayWidth', () => {
  it('counts ASCII as one cell each', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('')).toBe(0);
  });

  it('counts CJK and emoji as two cells each', () => {
    expect(displayWidth('字')).toBe(2);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('👍')).toBe(2);
  });

  it('counts a combining mark as zero (it renders onto its base)', () => {
    expect(displayWidth('é')).toBe(1); // e + combining acute = one cell
    expect(displayWidth('áb́')).toBe(2);
  });
});

describe('clipCells — cell-correct single-line clip', () => {
  it('passes short text through untouched (whitespace-collapsed + trimmed)', () => {
    expect(clipCells('  hello   world  ', 40)).toBe('hello world');
  });

  it('max <= 0 ⇒ empty', () => {
    expect(clipCells('anything', 0)).toBe('');
    expect(clipCells('anything', -3)).toBe('');
  });

  it('clips CJK on a whole-glyph boundary, never overflowing the budget', () => {
    const out = clipCells('字'.repeat(10), 5); // 20 cells → clip to 5 (incl. the …)
    expect(out).toBe('字字…');
    // The old `.slice(0, max - 1)` would keep 4 UTF-16 units = 4 CJK = 8 cells + … = 9.
    expect(displayWidth(out)).toBe(5);
  });

  it('clips emoji at an ODD budget without splitting a surrogate pair', () => {
    // max-1 = 3 lands mid-way through the second 👍 for a raw UTF-16 slice; the cell
    // clip stops a glyph early instead of emitting a lone surrogate.
    const out = clipCells('👍'.repeat(10), 4);
    expect(out).toBe('👍…');
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(displayWidth(out)).toBeLessThanOrEqual(4);
  });

  it('keeps a combining mark attached to its base at the cut', () => {
    const out = clipCells('áb́ć', 2); // 3 base+mark cells → clip to 2
    expect(out).toBe('á…'); // the acute rides with its 'a', not orphaned onto …
    expect(displayWidth(out)).toBe(2);
  });

  it('clips a run of ZWJ families / flags on cluster edges — no half-family, no dangling ZWJ', () => {
    // A code-point clip would cut INSIDE a family (dropping members, orphaning a ZWJ onto …);
    // the grapheme-cluster clip stops on a whole-cluster boundary. Four width-2 clusters = 8
    // cells; budget 5 keeps two whole clusters (4 cells) + the … (1) and never mid-cluster.
    const out = clipCells(FAMILY + FLAG_US + FAMILY + FLAG_US, 5);
    expect(out).toBe(`${FAMILY}${FLAG_US}…`);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out).not.toMatch(LONE_SURROGATE); // no split flag / half surrogate pair
    expect(out.includes(`${ZWJ}…`)).toBe(false); // the … never rides on a bare ZWJ
    expect(out.endsWith(ZWJ)).toBe(false);
  });
});

describe('wrapCells — cell-correct hard-wrap', () => {
  const lossless = (line: string, max: number): void => {
    expect(wrapCells(line, max).join('')).toBe(line); // wrap drops nothing
  };

  it('is byte-identical to the old UTF-16 hard-wrap for pure ASCII', () => {
    expect(wrapCells('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrapCells('abc', 3)).toEqual(['abc']); // exactly the budget → one row
    expect(wrapCells('ab', 5)).toEqual(['ab']); // under budget → one row
    expect(wrapCells('', 5)).toEqual(['']); // empty line is still one (empty) row
  });

  it('wraps CJK on whole-glyph rows, never overflowing max', () => {
    const rows = wrapCells('字'.repeat(4), 3); // 8 cells, budget 3
    // The old `.length`-based slice gave ['字字字','字'] — a 6-cell first row that
    // overflows the panel and visually wraps, corrupting the scroll math.
    expect(rows).toEqual(['字', '字', '字', '字']);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(3);
    lossless('字'.repeat(4), 3);
  });

  it('never splits an emoji surrogate pair across rows', () => {
    const rows = wrapCells('x' + '👍'.repeat(3), 5);
    expect(rows).toEqual(['x👍👍', '👍']);
    for (const r of rows) {
      expect(r).not.toMatch(LONE_SURROGATE);
      expect(displayWidth(r)).toBeLessThanOrEqual(5);
    }
    lossless('x' + '👍'.repeat(3), 5);
  });

  it('keeps combining marks with their base glyph when wrapping', () => {
    const rows = wrapCells('á'.repeat(4), 2); // 4 base+mark cells, budget 2
    for (const r of rows) {
      expect(displayWidth(r)).toBeLessThanOrEqual(2);
      expect(r.startsWith('́')).toBe(false); // no row opens on an orphaned mark
    }
    lossless('á'.repeat(4), 2);
  });

  it('gives an over-wide lone glyph its own row rather than dropping it', () => {
    expect(wrapCells('字', 1)).toEqual(['字']); // 2 cells, budget 1 → own row, not lost
  });

  it('keeps a ZWJ emoji family whole when a wrap falls right after it', () => {
    // 'xx' (2 cells) + 👨‍👩‍👧 (2 cells) = 4 > budget 3, so the loop MUST run (a family alone
    // would hit wrapCells' early-return). The break lands after 'xx'; the family — five code
    // points joined by ZWJ — moves to the next row WHOLE, never split into 👨👩👧 or a bare ZWJ.
    expect(displayWidth(FAMILY)).toBe(2);
    const rows = wrapCells('xx' + FAMILY, 3);
    expect(rows).toEqual(['xx', FAMILY]);
    for (const r of rows) {
      expect(r).not.toMatch(LONE_SURROGATE);
      expect(r.startsWith(ZWJ)).toBe(false); // no row opens on a bare ZWJ
      expect(r.endsWith(ZWJ)).toBe(false); // nor ends dangling on one
    }
    expect(wrapCells('xx' + FAMILY, 3).join('')).toBe('xx' + FAMILY); // wrap drops nothing
  });

  it('keeps a regional-indicator flag whole — never split into two indicators', () => {
    // A code-point wrap would emit ['xx🇺', '🇸'] — two lone regional indicators; the cluster
    // wrap keeps the PAIR (the one rendered flag) intact on its own row.
    const rows = wrapCells('xx' + FLAG_US, 3);
    expect(rows).toEqual(['xx', FLAG_US]);
    expect(rows[1]).toBe(FLAG_US);
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(3);
  });
});

describe('rowsForWidth — homogeneous cell-budget row count (ASCII / char caps)', () => {
  it('ceils width / columns, floored at one row', () => {
    expect(rowsForWidth(10, 5)).toBe(2);
    expect(rowsForWidth(11, 5)).toBe(3);
    expect(rowsForWidth(5, 5)).toBe(1);
    expect(rowsForWidth(0, 5)).toBe(1); // empty still occupies a row
  });

  it('falls back to one row when columns is non-finite / non-positive', () => {
    expect(rowsForWidth(100, 0)).toBe(1);
    expect(rowsForWidth(100, -5)).toBe(1);
    expect(rowsForWidth(100, Number.POSITIVE_INFINITY)).toBe(1);
    expect(rowsForWidth(100, Number.NaN)).toBe(1);
  });

  it('is exact for a 1-cell-per-column (ASCII) budget — its only valid input', () => {
    // The synthetic char caps liveWindow feeds it (RESULT_LINE_MAX_CHARS / THINKING_MAX_CHARS)
    // are ASCII cell budgets: every cell is independently placeable, so ceil is the true count.
    expect(rowsForWidth(displayWidth('x'.repeat(200)), 80)).toBe(3);
    expect(rowsForWidth(displayWidth('日本語'), 80)).toBe(1); // 6 cells / 80 = 1 (even, packs)
  });

  it('UNDER-counts wide glyphs at ODD columns — why real text must use rowsForText', () => {
    // 4 CJK = 8 cells, but wrapCells packs ONE 2-cell glyph per 3-col row (a cell wasted
    // each row) → 4 rows. A bare-width ceil sees 8/3 → 3. THAT gap is the odd-glyph bug.
    expect(wrapCells('字'.repeat(4), 3)).toHaveLength(4); // ground truth from the wrap authority
    expect(rowsForWidth(displayWidth('字'.repeat(4)), 3)).toBe(3); // under-counts by a row
    expect(rowsForText('字'.repeat(4), 3)).toBe(4); // the accurate replacement agrees with wrapCells
  });
});

describe('rowsForText — TRUE wrapped-row count (wide-glyph / odd-column correct)', () => {
  it('always equals wrapCells(text, columns).length', () => {
    for (const [text, cols] of [
      ['abcdefgh', 3],
      ['字'.repeat(4), 3],
      ['👍'.repeat(5), 5],
      ['x' + '👍'.repeat(3), 5],
      ['日本語', 80],
    ] as const) {
      expect(rowsForText(text, cols)).toBe(wrapCells(text, cols).length);
    }
  });

  it('an empty line still occupies one row', () => {
    expect(rowsForText('', 5)).toBe(1);
  });

  it('falls back to one row when columns is non-finite / non-positive', () => {
    expect(rowsForText('字'.repeat(9), 0)).toBe(1);
    expect(rowsForText('字'.repeat(9), -4)).toBe(1);
    expect(rowsForText('字'.repeat(9), Number.POSITIVE_INFINITY)).toBe(1);
    expect(rowsForText('字'.repeat(9), Number.NaN)).toBe(1);
  });

  it('CJK at ODD columns: counts the wasted trailing cell rowsForWidth drops', () => {
    // columns 3 holds one 2-cell 字 per row (1 cell wasted each row) → N glyphs = N rows.
    expect(rowsForText('字'.repeat(4), 3)).toBe(4);
    expect(rowsForWidth(displayWidth('字'.repeat(4)), 3)).toBe(3); // the under-count it fixes
    // columns 5 holds two 字 (4 cells) per row → 5 glyphs span 3 rows.
    expect(rowsForText('字'.repeat(5), 5)).toBe(3);
    expect(rowsForWidth(displayWidth('字'.repeat(5)), 5)).toBe(2); // under-counts again
  });

  it('emoji at ODD columns: a surrogate-pair glyph is never packed into the wasted cell', () => {
    // 5 👍 (2 cells each) at 5 cols → two per row → 3 rows; ceil(10/5)=2 under-counts.
    expect(rowsForText('👍'.repeat(5), 5)).toBe(3);
    expect(rowsForWidth(displayWidth('👍'.repeat(5)), 5)).toBe(2);
    // 3 👍 at 3 cols → one per row → 3 rows; ceil(6/3)=2 under-counts.
    expect(rowsForText('👍'.repeat(3), 3)).toBe(3);
    expect(rowsForWidth(displayWidth('👍'.repeat(3)), 3)).toBe(2);
  });

  it('EVEN columns / ASCII: identical to the old rowsForWidth(displayWidth(line)) count', () => {
    // Wide glyphs pack perfectly at even columns, so no discrepancy there — the fix changes
    // ONLY the odd-column wide-glyph case, leaving the former call sites' behavior intact.
    expect(rowsForText('字'.repeat(80), 80)).toBe(2); // 160 cells / 80 = 2 (even, exact)
    expect(rowsForText('日本語', 80)).toBe(1);
    expect(rowsForText('abcdefgh', 3)).toBe(3); // ASCII 8/3 → 3, matches ceil
  });
});

describe('sanitizeForDisplay — scrub terminal-unsafe chars from untrusted rendered text', () => {
  it('strips a raw ESC / CSI / OSC run so no escape byte reaches the terminal', () => {
    for (const evil of ['\x1b[2J', '\x1b]0;pwn\x07', 'a\x1b[31mred\x1b[0m']) {
      expect(sanitizeForDisplay(evil).includes('\x1b')).toBe(false); // the arming ESC is gone
    }
    expect(sanitizeForDisplay('\x1b[2J')).toBe(''); // whole CSI swallowed, no literal [2J tail
    expect(sanitizeForDisplay('\x1b]0;pwn\x07')).toBe(''); // whole OSC swallowed up to its BEL
  });

  it('strips bidi controls used for Trojan-Source / spoofing (override, isolates, LRM/RLM, ALM)', () => {
    expect(sanitizeForDisplay('a\u202Eb')).toBe('ab'); // RLO override (the Trojan-Source char)
    expect(sanitizeForDisplay('a\u2066b\u2069c')).toBe('abc'); // LRI … PDI isolates
    expect(sanitizeForDisplay('a\u2067b\u2068c')).toBe('abc'); // RLI / FSI isolates
    expect(sanitizeForDisplay('a\u200Eb\u200Fc')).toBe('abc'); // LRM / RLM
    expect(sanitizeForDisplay('a\u061Cb')).toBe('ab'); // ALM
  });

  it('strips zero-width space and BOM/ZWNBSP', () => {
    expect(sanitizeForDisplay('a\u200Bb')).toBe('ab'); // ZWSP
    expect(sanitizeForDisplay('a\uFEFFb')).toBe('ab'); // BOM / ZWNBSP
  });

  it('strips C0 (except TAB/LF), DEL, and C1 controls', () => {
    expect(sanitizeForDisplay('a\x00\x07\x08b')).toBe('ab'); // NUL / BEL / BS
    expect(sanitizeForDisplay('a\x7Fb')).toBe('ab'); // DEL
    expect(sanitizeForDisplay('a\x9Bb')).toBe('ab'); // C1 (single-byte CSI)
  });

  it('PRESERVES the layout-critical TAB and LF', () => {
    expect(sanitizeForDisplay('a\nb\tc')).toBe('a\nb\tc');
  });

  it('PRESERVES U+200D ZWJ (and U+200C ZWNJ) — load-bearing for emoji / shaping', () => {
    // The rank-7 interaction guard: stripping ZWJ would shatter 👨‍👩‍👧 into 👨👩👧, undoing
    // the grapheme-cluster clip/wrap. The scrubber must leave the family byte-for-byte intact.
    expect(sanitizeForDisplay(FAMILY)).toBe(FAMILY);
    expect(sanitizeForDisplay(FAMILY).includes(ZWJ)).toBe(true);
    expect(sanitizeForDisplay('a\u200Cb')).toBe('a\u200Cb'); // ZWNJ (script shaping) kept
  });

  it('returns plain ASCII/BMP prose UNCHANGED (fast-path identity) and is idempotent', () => {
    const clean = 'The quick brown fox — 日本語 café 👍';
    expect(sanitizeForDisplay(clean)).toBe(clean); // identity: nothing unsafe to strip
    for (const s of [clean, '\x1b[2Jmixed\u202Ejunk\uFEFF', FAMILY, 'a\nb\tc']) {
      expect(sanitizeForDisplay(sanitizeForDisplay(s))).toBe(sanitizeForDisplay(s));
    }
  });
});
