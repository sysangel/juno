# TEAM BRIEF — W4: Ink UI components (`src/ui/`)

You are writing the **UI component layer** for a TypeScript + React + Ink terminal product called **`juno`** (a fresh TS/Node20/ESM port of a Python agent harness). Your unit is **W4**: pure, controlled React+Ink components that render the reducer `State` using the done W5 theme. **Wave 1 is done and green.** You CANNOT browse the filesystem — all context is inline. Components are **pure**: data in via props, no store, no provider calls, no data fetching, no clock.

## Project facts (pinned, do not change)
- **Repo root:** `C:\Users\Core\src\juno`. **Runtime:** Node 20. **TypeScript strict, no `any`**, exhaustive switches. **ESM only**.
- **UI:** React 18 + **Ink 5**. Import from `'ink'` (`Box`, `Text`, `Static`, `useInput`) and `'react'`. `ink-text-input` (`TextInput`) and `ink-spinner` (`Spinner`) are available. Ink `<Text color={...}>`/`<Box borderColor>` accept a hex (`'#A6E22E'`), a 256-index string, or a named-16 colour — exactly what the theme returns.
- **jsx:** `react-jsx` (no `import React` needed for JSX, but import named hooks). Files are `.tsx`.
- **Tests:** vitest + **`ink-testing-library`** (`render` → `lastFrame()`), already a devDependency. Deterministic; no real input loop in assertions on output.

## The exact files you must write (all under `src/ui/`)
`Transcript.tsx`, `Message.tsx`, `StreamingMessage.tsx`, `ToolCallCard.tsx`, `ModeBadge.tsx`, `StatusLine.tsx`, `InputBox.tsx`, `SlashPalette.tsx`, `ModelPicker.tsx`, `PermissionPrompt.tsx`, `OverlayHost.tsx`, and `tests/components.test.tsx`.

Self-contained: import ONLY from `'react'`, `'ink'`, `'ink-text-input'`, `'ink-spinner'`, `'../core/reducer'` (State/Msg/ToolState types), `'../core/selectors'`, `'../core/events'` (RiskLevel/PermissionDecision/ToolStatus types), `'../services/catalog'` (ModelEntry type, for ModelPicker), and `'./theme'`. Do NOT import W6/W7/W8/W9 or any not-yet-written module.

## Consumed Wave-1 API — `src/ui/theme.ts` (done/green; import, do not redefine)
```ts
export type Hex = `#${string}`;
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16';
export const theme: Theme;                       // theme.text, theme.accent, theme.modeBadge.plan, theme.toolRunning, …
export function token(name: FlatTokenName, depth?: ColorDepth): string;   // -> ready for <Text color={...}>
export function downsample(hex: Hex, depth: ColorDepth): string;
export function detectColorDepth(): ColorDepth;
// FlatTokenName = keyof Theme (minus modeBadge) | `modeBadge.${'normal'|'plan'|'ultracode'}`
// Tokens: text textDim textInverse background border accent success warning error info
//         toolPending toolRunning toolResult toolError roleUser roleAssistant roleSystem
//         modeBadge.normal modeBadge.plan modeBadge.ultracode
```
Prefer `token('accent')` for a pre-downsampled string, or read `theme.accent` and pass to `downsample`. Detect depth ONCE at module top (`const DEPTH = detectColorDepth()`), or accept an optional `depth` prop defaulting to it — do not detect per render in a hot loop.

## Consumed Wave-1 API — FROZEN W3 `State`/selectors (from `src/core/reducer.ts` + `selectors.ts`)
```ts
export type Block = { kind:'text'; id:string; text:string } | { kind:'tool'; id:string; toolCallId:string };
export interface ToolState { status:'pending'|'running'|'result'|'error'; name:string; args:unknown; result?:unknown; error?:string; argsText?:string }
export interface Msg { id:string; role:'user'|'assistant'|'tool'|'system'; blocks:Block[]; done:boolean; reasoning?:string; toolSnapshot?:Record<string,ToolState> }
export interface State {
  committed: Msg[]; live: Msg | null; tools: Record<string, ToolState>;
  phase: 'idle'|'streaming'|'awaiting-permission'|'running-tool'|'error';
  overlay: 'none'|'slash'|'permission'|'model-picker';
  mode: 'normal'|'plan'|'ultracode';
  tokens: { in:number; out:number };
  pendingPermissionToolCallId: string | null;
  errorMessage: string | null;
}
// selectors.ts
export interface StatusLineState { model:string; cwd:string; tokens:{in:number;out:number;total:number}; contextFraction:number; mode:State['mode']; overlay:State['overlay']; phase:State['phase']; statusText:string; pendingPermissionToolCallId:string|null }
export function selectStatusLine(state: State, ctx?: { model?:string; cwd?:string; maxContext?:number }): StatusLineState;
```

## Pinned Wave-2 seam — component props (implement EXACTLY these shapes)
All components are **pure/controlled**. Names + the load-bearing props are frozen; internal layout is yours.
```ts
// PermissionPrompt.tsx — the W4↔W8 decoupling point. W8 has ZERO UI; you own the prompt.
import type { PermissionDecision, RiskLevel } from '../core/events';
export interface PermissionRequest { toolCallId:string; name:string; args:unknown; risk:RiskLevel }
export interface PermissionPromptProps { request: PermissionRequest; onDecision: (d: PermissionDecision) => void }
export function PermissionPrompt(props: PermissionPromptProps): React.ReactElement;

export interface TranscriptProps { committed: Msg[]; depth?: ColorDepth }                       // wraps Ink <Static>
export interface MessageProps { msg: Msg; depth?: ColorDepth }
export interface StreamingMessageProps { live: Msg | null; depth?: ColorDepth }
export interface ToolCallCardProps { tool: ToolState; depth?: ColorDepth }
export interface ModeBadgeProps { mode: State['mode']; depth?: ColorDepth }
export interface StatusLineProps { status: StatusLineState; depth?: ColorDepth }
export interface InputBoxProps { value: string; onChange:(v:string)=>void; onSubmit:(v:string)=>void; placeholder?:string; depth?:ColorDepth }
export interface SlashPaletteProps { commands: Array<{ name:string; description:string }>; selectedIndex?:number; depth?:ColorDepth }
export interface ModelPickerProps { models: ReadonlyArray<ModelEntry>; selectedId?:string; depth?:ColorDepth }
export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  permission?: PermissionPromptProps;   // present when overlay==='permission'
}
export function OverlayHost(props: OverlayHostProps): React.ReactElement | null;   // null when overlay==='none'
```

## Behaviour / mapping requirements
- **Transcript**: render `committed` inside Ink `<Static items={committed}>` so committed lines print once and never redraw; each item → `<Message msg={...}/>`. (Use a stable React `key` = `msg.id`.)
- **Message**: render role-tinted (`roleUser`/`roleAssistant`/`roleSystem`). Render each `block`: `kind:'text'` → `<Text>`; `kind:'tool'` → a `<ToolCallCard tool={msg.toolSnapshot?.[block.toolCallId]}/>` if present. Render `reasoning` (if set) dim + visually separated (e.g. a "thinking" label in `textDim`).
- **StreamingMessage**: same as Message but for the single `live` msg (the high-frequency redraw path); render nothing when `live === null`. May show a `<Spinner>` while streaming.
- **ToolCallCard**: pick the colour from `status` → `toolPending|toolRunning|toolResult|toolError` token. Show the tool `name`, a status glyph/word, and (on `result`/`error`) a one-line summary of `result`/`error` (stringify compactly; the structured shape is W7's — you just display it). A bordered `<Box borderStyle="round" borderColor={...}>`.
- **ModeBadge**: `theme.modeBadge[mode]` background-ish tint; label the mode; use `textInverse` for the text on the badge.
- **StatusLine**: render `status.model`, `status.cwd`, `status.tokens.total`, a context bar from `status.contextFraction` (0..1 → e.g. a short `[####----]`), `status.mode`, and `status.statusText`. Use `text`/`textDim`/`accent`.
- **InputBox**: wrap `ink-text-input` `TextInput` (controlled: `value`/`onChange`/`onSubmit`); show `placeholder` in `textDim`; a leading prompt glyph in `accent`.
- **SlashPalette**: list `commands`, highlight `selectedIndex` (accent). **ModelPicker**: list `models` (label + id), highlight `selectedId`.
- **PermissionPrompt**: show `request.name`, a compact `request.args`, and the `risk` (tint by risk: safe→`success`/neutral, risky→`warning`, dangerous→`error`). Offer the choices and call `onDecision(d)` exactly once with the chosen `PermissionDecision` (`'allow-once'|'deny'|'always-allow-pattern'|'dangerous-bypass'`). Wire choices via Ink `useInput` (e.g. y=allow-once, a=always-allow, d=deny, !=dangerous-bypass) — list the keybindings on screen. Focus-stealing is fine; keep it a pure controlled component (no policy logic — the *type* of decision is all you produce; W6 wires `onDecision`→policy/dispatch).
- **OverlayHost**: switch on `overlay`: `'none'`→`null`; `'slash'`→`<SlashPalette {...slash}/>`; `'model-picker'`→`<ModelPicker {...modelPicker}/>`; `'permission'`→`<PermissionPrompt {...permission}/>`. Exhaustive switch.

## Hard requirements
- **Pure/controlled**: no `useState` for app data (local UI cursor state for a list is OK), no store subscription, no provider/network/fs calls, no `Date.now`/`Math.random`. All data arrives via props.
- No `any`; narrow `unknown` (`tool.result`/`args`) before display. Strict ESM. Exhaustive switches over `role`/`block.kind`/`overlay`/`status`.

## `tests/components.test.tsx` (vitest + ink-testing-library)
- `render(<Transcript committed={[userMsg, asstMsg]} />)`; `lastFrame()` contains both messages' text.
- `ToolCallCard` with `status:'result'` shows a result summary; with `status:'error'` shows the error; different statuses pick different (asserted-present) output.
- `ModeBadge` renders the mode label for each of `normal|plan|ultracode`.
- `StatusLine` from `selectStatusLine(state,{model:'m',cwd:'/c'})` shows model + cwd + a context bar.
- `PermissionPrompt`: simulate the "allow-once" key via `stdin.write(...)`; assert `onDecision` called once with `'allow-once'`. Assert the rendered frame shows the tool name + risk.
- `OverlayHost` returns null for `'none'` and renders the permission prompt for `'permission'`.
- Build small fixture `State`/`Msg`/`ToolState` literals inline; no real reducer needed.

---
Respond with a SINGLE markdown document. For every file, `=== FILE: <repo-relative-path> ===` then a fenced code block with full contents. End with `=== NOTES ===` (<150 words). Do NOT write to the filesystem.

## Gate (must pass)
```
cd /c/Users/Core/src/juno && npx tsc --noEmit && npx vitest run tests/components.test.tsx
```
