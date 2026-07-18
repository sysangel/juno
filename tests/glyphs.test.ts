// tests/glyphs.test.ts
// The regression guard for the centralized glyph module (src/ui/glyphs.ts).
//
// WHY the locked value is 1: juno measures width in exactly one place — `displayWidth`
// (src/ui/clipText.ts), the sole string-width call site — and BOTH its layout budget
// (liveBudget.ts, clipText) and its render route through it. So a glyph that this module
// owns MUST measure 1 cell for juno's INTERNAL accounting to stay consistent: a width-2
// glyph dropped into a layout slot budgeted for one cell is precisely the one-column
// "jiggle" InputBox.tsx:58-59 documents as a shipped bug. We assert width via juno's OWN
// authority (not a fresh string-width import) because internal self-consistency is the
// property under test.
//
// OUT OF SCOPE: whether a given terminal draws an East-Asian-AMBIGUOUS glyph like
// '●'/'◌'/'◐' as 2 cells is a terminal-config concern, not juno's. string-width resolves
// these to 1 and juno budgets for 1, so we assert 1 — we deliberately do NOT "future
// proof" to 2, which would only desync the test from what juno actually measures.

import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { displayWidth } from '../src/ui/clipText';
import {
  ABORTED,
  FAIL,
  OK,
  PROMPT_LINE,
  RUNNING_HALF,
  SINGLE_CELL_GLYPHS,
  SPINNER_DOTS_FRAMES,
} from '../src/ui/glyphs';

describe('glyphs — width invariant', () => {
  it('every owned static glyph measures exactly one cell', () => {
    for (const [name, glyph] of Object.entries(SINGLE_CELL_GLYPHS)) {
      expect(`${name}=${JSON.stringify(glyph)} width ${displayWidth(glyph)}`).toBe(
        `${name}=${JSON.stringify(glyph)} width 1`,
      );
    }
  });

  it('every owned static glyph is a single, non-empty grapheme', () => {
    for (const [name, glyph] of Object.entries(SINGLE_CELL_GLYPHS)) {
      expect(glyph.length, `${name} must be non-empty`).toBeGreaterThan(0);
      // Array spread splits by code point: exactly one code point, never a stray
      // combining mark or a two-glyph string sneaking into a single-cell slot.
      expect([...glyph].length, `${name} must be one code point`).toBe(1);
    }
  });

  it('the ABORTED (cancel) glyph is one cell AND visually distinct from OK / FAIL / RUNNING_HALF', () => {
    // The whole point of the cancel glyph is that it reads differently from success, failure,
    // and in-flight — so an aborted subagent is never confused for any of them.
    expect(displayWidth(ABORTED)).toBe(1);
    expect(ABORTED).toBe('⊘');
    expect(new Set([ABORTED, OK, FAIL, RUNNING_HALF]).size).toBe(4);
  });

  it('the prompt LINE keeps its trailing space (two cells, marker + gap)', () => {
    // Guards edge-case (b): both '❯ ' sites share this one constant, so no call site
    // can lose or gain the trailing column that the composer layout budgets for.
    expect(PROMPT_LINE).toBe('❯ ');
    expect(displayWidth(PROMPT_LINE)).toBe(2);
  });
});

describe('glyphs — spinner frame set invariant', () => {
  it('all dots frames share one width, and that width is 1 (animation never reflows)', () => {
    expect(SPINNER_DOTS_FRAMES.length).toBeGreaterThan(0);
    const first = displayWidth(SPINNER_DOTS_FRAMES[0]);
    for (const frame of SPINNER_DOTS_FRAMES) {
      expect(displayWidth(frame)).toBe(first);
    }
    expect(first).toBe(1);
  });
});

describe('glyphs — dependency drift guard (cli-spinners)', () => {
  // ink-spinner's `type="dots"` frames come from cli-spinners (bundled by ink-spinner).
  // If that package is directly resolvable, assert its dots frames still all measure one
  // cell AND still match the set we mirror, so an ink-spinner/cli-spinners bump that
  // changed frame width or content fails loudly here. Optional: skipped if cli-spinners
  // is not directly resolvable.
  let cliDots: { frames: string[] } | undefined;
  try {
    const req = createRequire(import.meta.url);
    cliDots = (req('cli-spinners') as { dots: { frames: string[] } }).dots;
  } catch {
    cliDots = undefined;
  }

  const maybe = cliDots === undefined ? it.skip : it;

  maybe("cli-spinners' dots frames all measure one cell and match our mirror", () => {
    const frames = cliDots!.frames;
    for (const frame of frames) {
      expect(displayWidth(frame)).toBe(1);
    }
    expect(frames.join('')).toBe(SPINNER_DOTS_FRAMES.join(''));
  });
});
