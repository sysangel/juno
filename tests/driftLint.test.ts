// tests/driftLint.test.ts
// Regression guard for the Wave-14 drift-lint block in eslint.config.js.
//
// These rules turn two classes of visual-drift regression into build errors:
//   (a) a raw color literal in a color/backgroundColor/borderColor prop
//       (colors must resolve through token() from src/ui/theme.ts), and
//   (b) a raw lifecycle glyph (● ◌ ◐ ✓ ✗ ⊘) spelled by hand instead of
//       imported from src/ui/glyphs.ts.
//
// We drive the REAL project config (no overrideConfigFile) through the ESLint
// Node API so the test breaks if the config's scope or selectors drift. Using
// eslint.lintText with a virtual filePath means no files are written to disk —
// flat-config `files`/`ignores` matching is applied to the given path string.
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Repo root = parent of tests/. eslint.config.js lives here; cwd must point at
// it so ESLint resolves the project config (no overrideConfigFile).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// One instance, reused across probes. cwd → the project eslint.config.js.
const eslint = new ESLint({ cwd: repoRoot });

async function countDriftErrors(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('drift lint (no-restricted-syntax)', () => {
  it('flags a raw color literal AND a raw lifecycle glyph on a render surface', async () => {
    const code = `const A = <Text color="#F92672">x</Text>;\nconst B = <Text>{'● x'}</Text>;\n`;
    const n = await countDriftErrors(code, 'src/ui/__probe.tsx');
    // Color literal + glyph literal → at least two drift errors.
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('does NOT flag a token() color prop (no false positive on theme tokens)', async () => {
    const code = `const A = <Text color={token('textDim')}>ok</Text>;\n`;
    const n = await countDriftErrors(code, 'src/ui/__probe.tsx');
    expect(n).toBe(0);
  });

  it('exempts the glyph home file src/ui/glyphs.ts', async () => {
    const code = `export const X = '✓';\n`;
    const n = await countDriftErrors(code, 'src/ui/glyphs.ts');
    expect(n).toBe(0);
  });

  it('SCOPE GUARD: does not touch src/services notice strings', async () => {
    // backgroundAgents.ts legitimately renders `✓ agent … done` / `✗ agent …`.
    // The block is scoped to src/ui/** precisely so service notices (and the
    // glyph-asserting tests/) stay out of scope. A future broadening that starts
    // flagging these breaks here.
    const code = 'const s = `✓ done`;\n';
    const n = await countDriftErrors(code, 'src/services/backgroundAgents.ts');
    expect(n).toBe(0);
  });

  it('flags a stacked dimColor on a render surface', async () => {
    // The single-dim convention: color={token('textDim')} alone, never stacked with
    // Ink's dimColor. The ratchet turns a leftover dimColor into a build error.
    const code = `const A = <Text color={token('textDim')} dimColor>x</Text>;\n`;
    const n = await countDriftErrors(code, 'src/ui/__probe.tsx');
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('catches the variable-color dimColor form, not just literal textDim', async () => {
    // The blanket JSXAttribute[name.name='dimColor'] selector matches even when the
    // color is a variable (color={dim}) — the many sweep sites use that form, which a
    // literal-textDim esquery selector would miss. This locks that advantage.
    const code = `const A = <Text color={dim} dimColor>x</Text>;\n`;
    const n = await countDriftErrors(code, 'src/ui/__probe.tsx');
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('exempts the two documented dimColor keepers', async () => {
    // Message.tsx's `❯ ` composer-continuity marker and MarkdownView's dimmed hr keep
    // their dimColor by FILE-SCOPED config exemption (Block B), not an inline disable.
    const code = `const A = <Text color={token('textDim')} dimColor>x</Text>;\n`;
    expect(await countDriftErrors(code, 'src/ui/Message.tsx')).toBe(0);
    expect(await countDriftErrors(code, 'src/ui/MarkdownView.tsx')).toBe(0);
  });

  it('still lints color/glyph on the keeper files (dimColor-only exemption)', async () => {
    // The keeper exemption is dimColor-ONLY, not whole-file: Block B keeps the color
    // and glyph selectors, so a raw color literal + a raw glyph still fire there.
    const code = `const A = <Text color="#fff">{'●'}</Text>;\n`;
    const n = await countDriftErrors(code, 'src/ui/Message.tsx');
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
