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
);
