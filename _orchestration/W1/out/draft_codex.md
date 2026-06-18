=== FILE: package.json ===
```json
{
  "name": "juno",
  "version": "0.0.0",
  "private": true,
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
```json
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
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']
  }
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

type CliCommand = 'help' | 'version' | 'tui';

const VERSION = '0.0.0';

function parseCommand(argv: readonly string[]): CliCommand {
  if (argv.includes('--help') || argv.includes('-h')) {
    return 'help';
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    return 'version';
  }

  return 'tui';
}

function printHelp(): void {
  process.stdout.write(`juno

Usage:
  juno [options]

Options:
  -h, --help       Show this help message
  -v, --version    Show the current version

`);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));

  switch (command) {
    case 'help':
      printHelp();
      return;

    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return;

    case 'tui': {
      const [{render}, {default: App}, React] = await Promise.all([
        import('ink'),
        import('./app.js'),
        import('react')
      ]);

      render(React.createElement(App));
      return;
    }
  }
}

await main();
```

=== FILE: src/app.tsx ===
```tsx
import {Text, useApp, useInput} from 'ink';

export default function App(): JSX.Element {
  const {exit} = useApp();

  useInput((_input, key) => {
    if (key.ctrl && key.name === 'c') {
      exit();
    }
  });

  return <Text>juno - skeleton</Text>;
}
```

=== FILE: src/core/.gitkeep ===
```text
```

=== FILE: src/ui/.gitkeep ===
```text
```

=== FILE: src/tools/.gitkeep ===
```text
```

=== FILE: src/providers/.gitkeep ===
```text
```

=== FILE: src/services/.gitkeep ===
```text
```

=== FILE: src/app/.gitkeep ===
```text
```

=== FILE: tests/.gitkeep ===
```text
```

=== FILE: tests/skeleton.test.ts ===
```ts
import {describe, expect, it} from 'vitest';

describe('skeleton harness', () => {
  it('runs vitest', () => {
    expect(true).toBe(true);
  });
});
```

=== FILE: docs/DECISIONS.md ===
```md
# Juno Decisions

## Stack

- Runtime: Node 20+
- Module system: ESM only
- Language: TypeScript with strict mode enabled
- UI: React 18 + Ink 5
- Tests: vitest
- Dev runner: tsx with no build step

## D1: CUT

Full TypeScript rewrite. The Python runtime is not carried forward into this product skeleton.

## D2: Privacy

Privacy enforcement is account-side.

## Later Decisions

Future units should append dated decisions here.
```

=== NOTES ===

This skeleton keeps W1 limited to build/runtime substrate only: strict TypeScript, ESM, `tsx`, Ink 5, React 18, and vitest. The `juno` bin points directly at `src/cli.ts`; the shebang supports POSIX-style direct execution through `tsx`, while Windows users should rely on `npm start`, `tsx src/cli.ts`, or npm-generated shims.

`src/cli.ts` exposes the future one-shot/TUI split without importing downstream modules. The TUI path dynamically imports Ink and `src/app.tsx`, keeping startup simple and avoiding compile-time coupling to W3/W4/W6 files. Empty owned directories are preserved with `.gitkeep`; no W3 contracts, reducers, events, model clients, providers, services, tools, or coordinator types are defined here.