// tests/collapse.test.ts
// Wave-10 lane text-width: the collapse preview cap must never split an astral
// surrogate pair at the maxChars cut (the seam that shipped untested). collapse's
// maxChars is a UTF-16 CODE-UNIT budget (kept coupled to liveWindow.reasoningRows,
// which reserves rowsForWidth(THINKING_MAX_CHARS, cols)) and preserves the shown
// lines' newlines — so the fix is a code-point-boundary cut, not a cell clip.
import { describe, it, expect } from 'vitest';
import { collapse, collapseIndicator } from '../src/ui/collapse';

// A lone (unpaired) UTF-16 surrogate — the `�` garble a raw `.slice()` emits when it
// cuts between the two code units of an astral glyph. No correct cap may produce one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('collapse — line + char caps', () => {
  it('passes a short input through unchanged (nothing hidden, not truncated)', () => {
    expect(collapse('hi there', { maxLines: 10, maxChars: 100 })).toEqual({
      text: 'hi there',
      hiddenLines: 0,
      truncated: false,
    });
  });

  it('drops lines past maxLines and counts them in hiddenLines', () => {
    const c = collapse('l1\nl2\nl3\nl4\nl5', { maxLines: 2, maxChars: 100 });
    expect(c.text).toBe('l1\nl2');
    expect(c.hiddenLines).toBe(3);
    expect(c.truncated).toBe(false);
  });

  it('caps to maxChars for pure ASCII (byte-identical to the old UTF-16 slice)', () => {
    const c = collapse('x'.repeat(80), { maxLines: 10, maxChars: 50 });
    expect(c.text).toBe('x'.repeat(50));
    expect(c.truncated).toBe(true);
  });

  it('preserves newlines among the shown lines when capping characters', () => {
    // 'a','a','\n','b','b' = 5 UTF-16 units → 'aa\nbb'; the '\n' is not flattened.
    const c = collapse('aa\nbb\ncc\ndd', { maxLines: 10, maxChars: 5 });
    expect(c.text).toBe('aa\nbb');
    expect(c.text).toContain('\n');
    expect(c.truncated).toBe(true);
  });
});

describe('collapse — surrogate / wide-glyph safety (the untested seam)', () => {
  it('never strands a surrogate half when the maxChars cut lands mid-pair', () => {
    // '👍' is 2 UTF-16 units; after 'x' only 1 unit of a maxChars=2 budget remains,
    // so the emoji is dropped whole rather than halved. The old `.slice(0, 2)` kept
    // 'x' + a lone HIGH surrogate → 'x�'.
    const c = collapse('x👍y', { maxLines: 10, maxChars: 2 });
    expect(c.truncated).toBe(true);
    expect(c.text).toBe('x');
    expect(c.text).not.toMatch(LONE_SURROGATE);
    // Proof the OLD code produced garble at this exact cut:
    expect('x👍y'.slice(0, 2)).toMatch(LONE_SURROGATE);
  });

  it('keeps a whole emoji when the budget admits both of its code units', () => {
    // budget 3 units: 'x'(1) + '👍'(2) = 3 fit exactly; 'y' would be unit 4 → dropped.
    const c = collapse('x👍y', { maxLines: 10, maxChars: 3 });
    expect(c.text).toBe('x👍');
    expect(c.text).not.toMatch(LONE_SURROGATE);
    expect(c.truncated).toBe(true);
  });

  it('caps CJK on whole glyphs (each is one UTF-16 unit) with no garble', () => {
    const c = collapse('字'.repeat(10), { maxLines: 10, maxChars: 4 });
    expect(c.text).toBe('字'.repeat(4));
    expect(c.text).not.toMatch(LONE_SURROGATE);
    expect(c.truncated).toBe(true);
  });
});

describe('collapseIndicator', () => {
  it('formats hidden-lines, truncation, both, or empty', () => {
    expect(collapseIndicator({ text: '', hiddenLines: 120, truncated: false })).toBe('… +120 lines');
    expect(collapseIndicator({ text: '', hiddenLines: 1, truncated: false })).toBe('… +1 line');
    expect(collapseIndicator({ text: '', hiddenLines: 0, truncated: true })).toBe('… truncated');
    expect(collapseIndicator({ text: '', hiddenLines: 3, truncated: true })).toBe('… +3 lines, truncated');
    expect(collapseIndicator({ text: '', hiddenLines: 0, truncated: false })).toBe('');
  });
});
