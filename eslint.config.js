// eslint.config.js — flat config, deliberately minimal.
//
// Scope: this config lints ONLY the react-hooks rules — `rules-of-hooks` and
// `exhaustive-deps`. Those two catch real correctness bugs (a hook called
// conditionally, or a memo/callback/effect that closes over a stale value),
// which is exactly the class of defect worth a hard gate. Stylistic and broad
// type-aware rulesets (eslint:recommended, typescript-eslint recommended,
// eslint-plugin-react) are intentionally NOT enabled here: turning them on
// would flag dozens of files cosmetically and drown the signal. Layer those in
// deliberately later if wanted; keep this gate tight.
//
// TypeScript + React: files are parsed with the typescript-eslint parser and
// JSX enabled, so .ts and .tsx both lint. The `@typescript-eslint` and `react`
// plugins are REGISTERED (not that their rules are enabled) so that the
// `eslint-disable` directives the tree already stages for those namespaces
// (react/no-array-index-key, @typescript-eslint/no-empty-function) resolve to a
// real rule definition instead of erroring with "rule not found". A later wave
// can turn those rules on by adding them to `rules` — the plugins are already
// wired.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

// ── Shared drift-lint selectors ──────────────────────────────────────────────
// Hoisted so the color/glyph selectors can be reused across BOTH the general
// src/ui block AND the keeper-file block (Message.tsx / MarkdownView.tsx), which
// keep color/glyph lint but are exempt from the dimColor ban. flat-config merges
// same-name rules by REPLACEMENT, so the two blocks are made NON-OVERLAPPING (via
// `ignores`) to avoid one clobbering the other's `no-restricted-syntax`.
const RAW_COLOR = {
  selector:
    "JSXAttribute[name.name=/^(color|backgroundColor|borderColor)$/] Literal[value=/^(#[0-9a-fA-F]{3,8}|black|red|green|yellow|blue|magenta|cyan|white|gray|grey|blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|cyanBright|whiteBright)$/i]",
  message:
    "Raw color literal in a color prop. Colors live in src/ui/theme.ts — use token(...) (e.g. color={token('textDim')}).",
};
const GLYPH_LITERAL = {
  selector: 'Literal[value=/[●◌◐✓✗⊘]/]',
  message:
    'Raw lifecycle-glyph literal. Glyphs live in src/ui/glyphs.ts — import the named constant (TOOL_PENDING/TOOL_WAITING/RUNNING_HALF/OK/FAIL/ABORTED).',
};
const GLYPH_TEMPLATE = {
  selector: 'TemplateElement[value.cooked=/[●◌◐✓✗⊘]/]',
  message: 'Raw lifecycle-glyph literal in a template string. Import the named constant from src/ui/glyphs.ts.',
};
const GLYPH_JSXTEXT = {
  selector: 'JSXText[value=/[●◌◐✓✗⊘]/]',
  message: 'Raw lifecycle-glyph literal in JSX text. Import the named constant from src/ui/glyphs.ts.',
};
const COLOR_GLYPH_SELECTORS = [RAW_COLOR, GLYPH_LITERAL, GLYPH_TEMPLATE, GLYPH_JSXTEXT];

// A BLANKET ban on Ink's `dimColor` across src/ui (catches the `color={dim}`
// variable form too, which a literal-textDim esquery selector would miss). juno
// renders ONE dim tier: color={token('textDim')} alone. The two deliberate
// keepers are exempted by FILE SCOPE (Block B below), never by inline disable.
const DIM_STACK = {
  selector: "JSXAttribute[name.name='dimColor']",
  message:
    "Stacked/loose `dimColor`. juno renders ONE dim tier — use color={token('textDim')} alone and drop Ink's dimColor. The two deliberate keepers (Message.tsx ❯ marker, MarkdownView hr) are the only file-scoped exceptions.",
};

export default tseslint.config(
  {
    // Global ignores (first, ignores-only object = applies to the whole run).
    // node_modules is a symlink into the shared install in worktrees — never
    // descend into it.
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'runs/**',
      '.selftest/**',
      'agent_workspace/**',
      '.hermes/**',
      '.claude/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      // Registered for rule-definition resolution only; no rules enabled below.
      react,
      '@typescript-eslint': tseslint.plugin,
    },
    linterOptions: {
      // The tree stages `eslint-disable` directives for rules this minimal
      // config does not (yet) enable — react/no-array-index-key,
      // @typescript-eslint/no-empty-function, no-await-in-loop, no-control-regex.
      // Those are legitimate future-facing suppressions, not dead code, so we do
      // not report them as "unused". A misplaced react-hooks/* disable still
      // surfaces: its underlying error fires unsuppressed (rules are `error`).
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Wave-14 drift lint (zero-dep, core no-restricted-syntax). Colors live in
    // theme.ts and glyphs live in glyphs.ts; forbid re-spelling them by hand on a
    // render surface, AND ban Ink's stacked `dimColor` (juno renders ONE dim tier).
    // Scoped to src/ui/** so it never touches tests/ (which assert on rendered
    // glyphs) or src/services (notice strings legitimately use ✓/✗). glyphs.ts and
    // theme.ts are the homes, so they are exempted; Message.tsx / MarkdownView.tsx
    // are the two deliberate dimColor keepers (Block B) — ignored here so they match
    // exactly one block (flat-config merges same-name rules by REPLACEMENT, so
    // overlapping no-restricted-syntax blocks would clobber; non-overlapping via
    // `ignores` avoids that). Block A carries the FULL rule incl. the dimColor ban.
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: [
      'src/ui/glyphs.ts',
      'src/ui/theme.ts',
      'src/ui/Message.tsx',
      'src/ui/MarkdownView.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...COLOR_GLYPH_SELECTORS, DIM_STACK],
    },
  },
  {
    // Block B — the two deliberate dimColor keepers: Message.tsx's `❯ ` composer-
    // continuity marker and MarkdownView's dimmed `hr` border. They keep the full
    // color/glyph lint but are EXEMPT from the dimColor ban (the exemption is
    // dimColor-only, not whole-file). Non-overlapping with Block A (which ignores
    // exactly these two paths), so neither block's rule clobbers the other.
    files: ['src/ui/Message.tsx', 'src/ui/MarkdownView.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...COLOR_GLYPH_SELECTORS],
    },
  },
);
