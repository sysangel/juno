# TEAM BRIEF — W1: `juno` TS/Ink Product Skeleton

You are writing the **build/runtime skeleton** for a terminal-UI product called **`juno`** (a TypeScript + React + Ink rewrite of an older Python agent loop). Your unit is **W1**. It gates almost every other unit, so its job is to establish a green, strict-typed substrate that everything else compiles into. You CANNOT browse the filesystem — all needed facts are inline below.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno` (Windows host; product must run under Windows Terminal + PowerShell 7).
- **Runtime:** Node 20 (set `engines.node: ">=20"`). ESM only (`"type": "module"`).
- **Language:** TypeScript, **strict mode on**.
- **UI:** React 18 + Ink 5.
- **Tests:** **vitest** (NOT pytest, NOT jest).
- **Dev runner:** `tsx` (zero build step; run `.tsx`/`.ts` directly).
- **Product bin name:** `juno`, entry `src/cli.ts`.

## Grounding: the proven `starter/` seed
A working ~1,246-line Ink starter already validated this stack. Reuse its exact tooling and config choices. Key facts extracted from it (embed/adapt these — do not invent a different stack):

**Starter `package.json` (authoritative versions to reuse, bump Node to >=20):**
```jsonc
{
  "type": "module",
  "scripts": {
    "start": "tsx src/app.tsx",      // adapt -> bin runs src/cli.ts
    "dev": "tsx watch src/app.tsx",
    "typecheck": "tsc --noEmit"
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
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

**Starter `tsconfig.json` (authoritative — reuse verbatim, then add `tests` to `include`):**
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
The starter runs offline with **no API key** via a deterministic mock (`fakeModel.ts`), proving the no-keys-needed pattern that W3's `fakeClient.ts` will carry forward. The starter uses `tsx` so there is **no build step**. Windows note carried forward: Windows Terminal + PowerShell 7 + UTF-8 code page for truecolor/glyphs.

## What W1 must produce (the skeleton)

W1 does NOT implement features. It creates: the package manifest, the strict tsconfig, the vitest config, the Ink entry point, the directory layout (with minimal compiling placeholders so `tsc --noEmit` and `vitest` both pass green), a `.gitignore`, and a decisions stub. Other units (W3 contracts, W4 components, W6 app shell, W7 tools, W8 permissions, W9 LLM adapters, W10 services) will fill the directories.

### Required directory layout (create these dirs; place a `.gitkeep` in any you leave empty)
```
src/
  cli.ts            # juno entry point (W1 writes a minimal working version)
  app.tsx           # Ink root (W1 writes a minimal placeholder that renders)
  core/             # W3 owns: events.ts, reducer.ts, contracts.ts, fakeClient.ts
  ui/               # W4 Ink components (.tsx)
  tools/            # W7 tool executor + tools
  providers/        # W9 streaming ModelClient adapters
  services/         # W10 config / catalog / persistence
  app/              # W6 coordinator (turnRunner, hooks, app shell glue)
tests/              # vitest specs (W3+ add their own)
docs/
  DECISIONS.md      # stub
package.json
tsconfig.json
vitest.config.ts
.gitignore
```
NOTE ON LAYOUT: This project pins contract files under **`src/core/`** (`events.ts`, `reducer.ts`, `contracts.ts`, `fakeClient.ts`) and groups UI under `src/ui/`, coordinator under `src/app/`, adapters under `src/providers/`, services under `src/services/`. Use exactly these directory names so the independently-written W3 unit composes. Do not use `src/state/`, `src/llm/`, `src/components/`, or `src/agent/`.

### Files to write (exact list)
1. **`package.json`** — name `juno`, `"type": "module"`, `"engines": { "node": ">=20" }`, `bin: { "juno": "src/cli.ts" }` (acceptable since `tsx` runs TS directly; if you prefer a JS shim, document it in NOTES). Dependencies/devDeps as in the starter block above, PLUS `vitest` (`^2.1.0` or newer) and `ink-testing-library` (`^4.0.0`) in devDependencies. Scripts: `start` (`tsx src/cli.ts`), `dev` (`tsx watch src/cli.ts`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch` (`vitest`).
2. **`tsconfig.json`** — exactly the starter config above with `"include": ["src", "tests"]`.
3. **`vitest.config.ts`** — `environment: 'node'`, `globals: true`, `include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']`. Keep minimal; no coverage gates.
4. **`.gitignore`** — `node_modules/`, `dist/`, `*.log`, `.env`, `.DS_Store`, `runs/`, `agent_workspace/`, `.hermes/`, `*.egg-info/`, `__pycache__/`, `.pytest_cache/`.
5. **`src/cli.ts`** — the `juno` entry. A minimal but real entry: parse `process.argv` for a future one-shot vs TUI split (a stub `--help`/`--version` is fine), then dynamically import and render the Ink app for the TUI path. Must compile under strict and run under `tsx` without throwing. Add a short shebang `#!/usr/bin/env -S tsx` comment-doc note in NOTES about bin execution on Windows.
6. **`src/app.tsx`** — a minimal Ink root that renders a single `<Text>` (e.g. "juno — skeleton") and exits cleanly on Ctrl+C via `useApp().exit`. This is a PLACEHOLDER; W6 replaces its internals. Keep it self-contained (no imports from `core/`, `ui/`, etc., which don't exist yet) so the skeleton compiles standalone.
7. **`docs/DECISIONS.md`** — short stub recording: stack (Node 20 / TS strict / React + Ink 5 / vitest / tsx no-build); D1 = CUT (full TS rewrite, no Python); D2 = privacy enforced account-side. Leave headed sections for later units to append to.
8. **One `.gitkeep` per empty dir** you create under `src/` (`core`, `ui`, `tools`, `providers`, `services`, `app`) and `tests/`, so the layout is real in git. (cli.ts/app.tsx live directly under `src/`.)
9. **`tests/skeleton.test.ts`** — one trivial vitest test (e.g. `expect(true).toBe(true)` plus an import-smoke of a tiny pure helper if you add one) so `npm test` is green out of the box and proves vitest is wired.

## Acceptance criteria (the green harness you must guarantee)
- `npm run typecheck` (`tsc --noEmit`) passes with **zero errors** under `strict`.
- `npm test` (`vitest run`) passes (at least the skeleton test).
- `npm start` launches the placeholder Ink UI without crashing.
- No file imports from a directory that W1 leaves empty (don't break the typecheck by referencing not-yet-written modules).
- Pin Ink at `^5.1.0` and React at `^18.3.1` so every downstream `.tsx` unit builds against the same versions.

## Seam you EXPOSE (downstream depends on this)
- The module layout above (esp. `src/core/`, `src/ui/`, `src/app/`, `src/providers/`, `src/services/`, `src/tools/`).
- A green `tsc --noEmit` + `vitest run` harness.
- The Ink/React/tsx version pins.
- The `juno` bin entry at `src/cli.ts`.
Do NOT define any `AgentEvent`/reducer/`ModelClient` types — those are W3's. Leave `src/core/` empty (`.gitkeep`).

---
Respond with a SINGLE markdown document. For every file you propose, put a line `=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block containing the full file contents. After all files, add a `=== NOTES ===` section (<200 words) explaining key design choices and the seams you expose or consume. Do NOT write to the filesystem — output only this document.
