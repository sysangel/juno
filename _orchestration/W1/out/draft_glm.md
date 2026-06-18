# W1 — `juno` TS/Ink Product Skeleton

=== FILE: package.json ===
```json
{
  "name": "juno",
  "version": "0.0.0-skeleton",
  "description": "Terminal agent UI — TypeScript + React + Ink rewrite (W1 skeleton).",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "bin": {
    "juno": "src/cli.ts"
  },
  "scripts": {
    "start": "tsx src/cli.ts",
    "dev": "tsx watch src/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ink": "^5.1.0",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1",
    "supports-color": "^9.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^18.3.12",
    "ink-testing-library": "^4.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.0"
  }
}
```

=== FILE: tsconfig.json ===
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

=== FILE: vitest.config.ts ===
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
```

=== FILE: .gitignore ===
```gitignore
node_modules/
dist/
*.log
.env
.DS_Store
runs/
agent_workspace/
.hermes/
*.egg-info/
__pycache__/
.pytest_cache/
```

=== FILE: src/cli.ts ===
```ts
#!/usr/bin/env -S tsx
//
// juno — CLI entry point (W1 skeleton)
//
// Windows note: npm's global bin shim (.cmd) invokes `node`, which cannot run
// .ts directly. On Windows, prefer `npm start` or `tsx src/cli.ts`. A JS shim
// can be introduced later if a global `juno` command is required on Windows.
// See NOTES.

interface CliOptions {
  help: boolean;
  version: boolean;
}

const VERSION = '0.0.0-skeleton';

const HELP_TEXT = `juno — terminal agent UI (skeleton)

Usage:
  juno              launch the TUI
  juno --help       show this help
  juno --version    print version
`;

function parseArgs(argv: string[]): CliOptions {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (opts.version) {
    process.stdout.write(`juno ${VERSION}\n`);
    return;
  }

  // TUI path — dynamic imports keep --help/--version light and leave a seam
  // for a future one-shot (non-TUI) branch that won't load Ink at all.
  const { render } = await import('ink');
  const React = (await import('react')).default;
  const { App } = await import('./app');

  render(React.createElement(App));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`juno: ${message}\n`);
  process.exit(1);
});
```

=== FILE: src/app.tsx ===
```tsx
import React from 'react';
import { Text, useApp, useInput } from 'ink';

/**
 * Minimal Ink root (W1 placeholder).
 *
 * W6 will replace the internals of this component with the real app shell
 * (turnRunner wiring, permission prompts, tool approval, streaming output).
 * Until then, this renders a single line and exits on `q` or Ctrl+C.
 */
export function App(): React.ReactElement {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  return <Text>juno — skeleton</Text>;
}
```

=== FILE: docs/DECISIONS.md ===
```markdown
# DECISIONS

> Append-only log. Each unit records its decisions under a dated heading.

## Stack (pinned by W1)

- **Runtime:** Node 20+ (ESM only, `"type": "module"`).
- **Language:** TypeScript, `strict: true`, `noEmit` (typecheck only).
- **UI:** React 18 + Ink 5.
- **Tests:** vitest (`environment: node`, `globals: true`).
- **Dev runner:** `tsx` — no build step; `.ts`/`.tsx` run directly.
- **Host:** Windows Terminal + PowerShell 7, UTF-8 code page for truecolor.

## D1 — CUT: full TypeScript rewrite

The older Python agent loop is retired. `juno` is a clean TypeScript / React /
Ink rewrite. There is no Python runtime, no shared cross-language type surface,
and no `pytest` / `__pycache__` artifacts (retained in `.gitignore` only to
prevent stale Python files from leaking back in).

## D2 — Privacy enforced account-side

No local secret store. Privacy guarantees are enforced on the account /
provider side. Local artifacts (logs, run transcripts) are opt-in and
ephemeral by default. Downstream units must not persist user data without
explicit opt-in.

## Open decisions (later units append here)

- Tool execution sandboxing — W7
- Permission model surface — W8
- Streaming adapter contracts — W9
- Persistence shape — W10
- App shell / turnRunner lifecycle — W6
```

=== FILE: src/core/.gitkeep ===
```
# W3 owns: events.ts, reducer.ts, contracts.ts, fakeClient.ts
```

=== FILE: src/ui/.gitkeep ===
```
# W4 owns: Ink components (.tsx)
```

=== FILE: src/tools/.gitkeep ===
```
# W7 owns: tool executor + tool implementations
```

=== FILE: src/providers/.gitkeep ===
```
# W9 owns: streaming ModelClient adapters
```

=== FILE: src/services/.gitkeep ===
```
# W10 owns: config / catalog / persistence
```

=== FILE: src/app/.gitkeep ===
```
# W6 owns: coordinator (turnRunner, hooks, app shell glue)
```

=== FILE: tests/skeleton.test.ts ===
```ts
import { describe, it, expect } from 'vitest';

describe('skeleton', () => {
  it('vitest is wired', () => {
    expect(true).toBe(true);
  });

  it('node version is >= 20', () => {
    const [major] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
```

=== NOTES ===

**Bin execution on Windows.** `bin.juno` points at `src/cli.ts` with a `#!/usr/bin/env -S tsx` shebang. On Unix this works directly. On Windows, npm's `.cmd` shim invokes `node`, which cannot run `.ts`; use `npm start` or `tsx src/cli.ts`. A JS shim (`bin/juno.js` spawning `tsx`) can be added if a global `juno` command is needed — deferred until requested.

**Dynamic imports in `cli.ts`.** Ink, React, and `./app` are loaded only on the TUI path, so `--help`/`--version` stay light and a future one-shot branch can avoid Ink entirely.

**`app.tsx` is self-contained** — no imports from `core/`, `ui/`, `app/`, etc. — so the skeleton typechecks standalone. W6 replaces its internals.

**Seams exposed:** directory layout (`src/core`, `src/ui`, `src/app`, `src/providers`, `src/services`, `src/tools`); green `tsc --noEmit` + `vitest run`; version pins (Ink `^5.1.0`, React `^18.3.1`, tsx `^4.19.2`, vitest `^2.1.0`); `juno` bin at `src/cli.ts`.

**Seams consumed:** none — W1 depends on no other unit. `src/core/` is intentionally empty (`.gitkeep`); W3 will define `AgentEvent`/reducer/`ModelClient`/`fakeClient` there. W1 does not reference those modules.

**tsconfig** is the starter verbatim (`types: ["node"]`); tests import `{describe,it,expect}` explicitly, so no `vitest/globals` type entry is needed.
