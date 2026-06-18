# TEAM BRIEF — W5: Semantic-token theme (`src/ui/theme.ts`)

You are writing the **theme layer** for a TypeScript + React + Ink terminal product called **`juno`**. Your unit is **W5**. You replace an old Python `theme.py` (rainbow/galaxy cosmetics) with a small set of **named semantic tokens** plus colour-depth downsampling. W4 (the UI components) imports your tokens **by name** and never sees raw cosmetics. You CANNOT browse the filesystem — all needed context is inline.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **Language:** TypeScript, **strict mode on**. **ESM only** (`"type": "module"`; use ESM `import`/`export`, no `require`, no `module.exports`).
- **UI:** React 18 + Ink 5. Ink renders colour via the `color` prop on `<Text>`/`<Box>`, which accepts a hex string (`'#A6E22E'`), a 256-palette index as a string, or a named-16 colour (`'red'`, `'green'`, `'cyan'`, `'gray'`, `'whiteBright'`, …).
- **Tests:** vitest (`import { describe, it, expect } from 'vitest'`) — NOT pytest, NOT jest.
- **Colour-depth detection:** the dependency **`supports-color`** (`^9.4.0`) is available. Its default export exposes `{ level: 0|1|2|3 }` on `supportsColor.stdout` (3 = truecolor, 2 = 256, 1 = 16, 0 = none). Import as `import supportsColor from 'supports-color'`.
- **tsconfig:** `moduleResolution: "Bundler"`, `strict`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `target/lib ES2022`. No `any`. Exhaustive switches.

## The exact file you must write
1. `src/ui/theme.ts` — the entire W5 unit (tokens + accessor + downsampling).
2. `tests/theme.test.ts` — a vitest suite (see requirements below).

Self-contained: `theme.ts` may import ONLY `supports-color` and types from `../core/events` (see below). It must NOT import React/Ink, any W4 component, or any not-yet-written module.

## FROZEN W3 types your token names key off (already exist; import the types, do not redefine)
From `src/core/events.ts`:
```ts
export type ToolStatus = 'pending' | 'running' | 'result' | 'error';
```
From `src/core/reducer.ts` (the `State` shape — for reference; you key the mode badge off this):
```ts
mode: 'normal' | 'plan' | 'ultracode';
```
Your `toolPending/toolRunning/toolResult/toolError` tokens correspond 1:1 to `ToolStatus` values, and `modeBadge.{normal,plan,ultracode}` correspond 1:1 to the `mode` values, so W4 can do `theme.modeBadge[state.mode]` and pick a tool colour from `state.tools[id].status`. (You don't have to import `ToolStatus` if you don't reference the type directly, but the names MUST line up.)

## The interface THIS unit must EXPOSE (pinned in SEAMS.md — implement EXACTLY)
```ts
export type Hex = `#${string}`;
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16';

export interface Theme {
  text: Hex; textDim: Hex; textInverse: Hex; background: Hex; border: Hex;
  accent: Hex; success: Hex; warning: Hex; error: Hex; info: Hex;
  toolPending: Hex; toolRunning: Hex; toolResult: Hex; toolError: Hex;   // 1:1 with ToolStatus
  roleUser: Hex; roleAssistant: Hex; roleSystem: Hex;
  modeBadge: { normal: Hex; plan: Hex; ultracode: Hex };                  // 1:1 with State['mode']
}

export const theme: Theme;

/** Pure, deterministic. 'truecolor' -> hex unchanged; 'ansi256' -> palette index as string;
 *  'ansi16' -> a named-16 color string usable by Ink (e.g. 'green','cyan','gray','redBright'). */
export function downsample(hex: Hex, depth: ColorDepth): string;

/** Detect terminal colour depth once, wrapping supports-color. */
export function detectColorDepth(): ColorDepth;

export type FlatTokenName =
  | Exclude<keyof Theme, 'modeBadge'>
  | `modeBadge.${keyof Theme['modeBadge']}`;

/** Read a token already downsampled for `depth` (defaults to detectColorDepth()).
 *  Returns a string ready for Ink's <Text color={...}>. */
export function token(name: FlatTokenName, depth?: ColorDepth): string;
```

## Implementation requirements
- **`theme`**: pick tasteful, distinct, readable hex values for every token (dark-terminal palette). Tool lifecycle should read intuitively: `toolPending` dim/gray, `toolRunning` an active accent (e.g. cyan/blue), `toolResult` green, `toolError` red. `modeBadge.normal` neutral, `plan` blue-ish, `ultracode` a hot/intense colour. Values are yours; **names are frozen**.
- **`downsample(hex, depth)`** must be PURE and deterministic (no I/O, no global reads). Parse the `#RRGGBB` hex to r,g,b.
  - `truecolor`: return the hex unchanged.
  - `ansi256`: convert r,g,b to the xterm-256 6×6×6 colour cube index using the standard formula `16 + 36*round(r/255*5) + 6*round(g/255*5) + round(b/255*5)`; return it as a **string**. (Grayscale special-casing is optional; the cube formula is acceptable and is what to ship.)
  - `ansi16`: map to the nearest of the 16 named colours. A simple, deterministic approach: compute brightness; pick from `{black, red, green, yellow, blue, magenta, cyan, white}` by which channel(s) dominate, and append `Bright` (Ink supports `redBright`, `greenBright`, … and `gray`) when the colour is light. Keep it deterministic and total — every hex maps to exactly one name.
- **`detectColorDepth()`**: read `supportsColor.stdout`; map level 3→`'truecolor'`, 2→`'ansi256'`, ≥1→`'ansi16'` (treat level 0/none as `'ansi16'` so colour names still render). This is the ONLY impure function; everything else is pure.
- **`token(name, depth)`**: resolve a dotted `FlatTokenName` (`'text'`, `'modeBadge.plan'`, …) to its `Hex` off `theme`, then return `downsample(hex, depth ?? detectColorDepth())`. Handle the `modeBadge.*` split deterministically (no `any`; narrow via a check on the `'modeBadge.'` prefix).
- Validate hex inputs defensively enough not to crash on a malformed string, but you may assume `theme` values are well-formed `#RRGGBB`.

## `tests/theme.test.ts` requirements (vitest)
- `downsample` returns the hex unchanged for `'truecolor'`.
- `downsample` returns a numeric-looking string within 16..255 for `'ansi256'` for a few known colours.
- `downsample` returns a valid Ink colour name (from a fixed allow-list you assert against) for `'ansi16'`, for several inputs, and is **total** (never throws).
- `token('modeBadge.plan', 'truecolor')` equals `theme.modeBadge.plan`.
- `token('text', 'truecolor')` equals `theme.text`.
- Every `ToolStatus` value (`pending|running|result|error`) has a corresponding token reachable via `token('tool' + Capitalized, ...)` (assert the four tool tokens exist on `theme`).
- Purity: calling `downsample` twice with the same args returns the same value.

## Seam you EXPOSE / what consumes it
- **W4 (UI)** imports `{ theme, token, downsample, detectColorDepth }`. `ToolCallCard` maps `state.tools[id].status` → the matching `tool*` token; `ModeBadge` maps `state.mode` → `theme.modeBadge[mode]`; `StatusLine`/`Message`/`Transcript` use `text`/`textDim`/`accent`/role tints. **Token NAMES are frozen** — colour VALUES may change behind them.
- You expose NO React hook/context: the accessor is the plain `token()` function plus the exported `theme` object (theme is process-static; depth is detected once). Do not add Ink context wiring.

---
Respond with a SINGLE markdown document. For every file, a line `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.
