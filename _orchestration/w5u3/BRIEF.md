# Triad Brief — juno Wave 5, Unit 5.3: Render Resilience (resize footer duplication)

You are one of two independent writers. Produce a complete, minimal patch for the bug below, plus a regression test. Output a unified description of EVERY file you change with the full new content of each changed region (clear enough that a synthesizer can apply it verbatim). Target repo: `C:/Users/Core/src/juno`. TypeScript + React 18 + Ink 5. No new dependencies.

## The bug
The bottom status bar (`StatusLine`) DUPLICATES / accumulates above the input box when the terminal is resized (especially rapid resize). Stale footer lines pile up.

## Root cause (CONFIRMED — do not re-litigate)
- App is rendered ONCE via Ink `render()` (`src/cli.ts:102`); the tree re-renders purely through React state when `useTerminalSize` calls `setSize` on stdout `'resize'`.
- `src/ui/StatusLine.tsx` renders a `<Box flexDirection="column" borderStyle="single" ...>` with a row of gap'd `<Text>` chips and a second row — **with NO explicit width**. It relies on Ink flex auto-size.
- Ink 5's non-fullscreen renderer redraws via `log-update`, which erases `previousLineCount` lines where `previousLineCount = output.split('\n').length` from the PRIOR frame. When the terminal WIDTH shrinks, StatusLine's unconstrained chip row wraps to MORE lines than the prior frame. Ink erases the old (smaller) line count, writes the new (taller) frame, and the extra wrapped lines are left as residue → the footer appears duplicated/accumulated.
- Root `Box` in `src/app.tsx:293` already has `width={columns}` (from `useTerminalSize`), but that width is NOT threaded down to `StatusLine`, so the footer has no width constraint of its own.

## The fix (direction is fixed; you choose the cleanest implementation)
Give `StatusLine` an explicit width threaded from the root so its layout is fully width-determined every frame (no wrap-driven line-count drift). Concretely:

1. **`src/ui/StatusLine.tsx`** — add an optional `width?: number` prop to `StatusLineProps`. Apply it to the outer `<Box>` as `width={width}` (only when provided — keep it optional so existing isolated tests that render `<StatusLine status={...} />` with no width still pass and don't crash). Additionally constrain the chip row so chips do NOT wrap unpredictably: the inner content row(s) should clip rather than reflow into extra lines — prefer giving the row(s) `flexWrap="nowrap"` and/or threading the width down. The non-negotiable property: **for a fixed `status`, StatusLine's rendered line count must be STABLE / monotonic across width changes — it must not grow extra lines when width shrinks.** Avoid `<Static>` (it clips on width change — explicitly disallowed). Do not change the visible chip set or their colors/labels.

2. **`src/app.tsx`** — thread the live width: change `<StatusLine status={status} />` (line ~319) to `<StatusLine status={status} width={columns} />`. `columns` is already in scope (`const { columns } = useTerminalSize();` at line 108).

3. **`src/hooks/useTerminalSize.ts`** (OPTIONAL, only if it strengthens the fix) — you MAY add a small (~50ms) debounce to the `onResize` handler to coalesce rapid resize bursts, but ONLY if you keep the existing public contract intact: the hook still returns `{ columns, rows }`, still fires an immediate `onResize()` once on mount (so first paint is correct with no delay), and cleans up both the listener AND any pending timer on unmount. If a debounce adds risk or complexity, SKIP it — the width fix alone is the primary fix. Do not break the synchronous-first-read behavior.

## Regression test (REQUIRED) — testability constraint, read carefully
`ink-testing-library@4` exposes a **read-only** `columns` getter on its fake stdout and **cannot simulate a real terminal resize** (no setter, no meaningful `'resize'` reflow). So you CANNOT write a test that resizes a live `<App>` and diffs frames. Instead write a deterministic regression test that targets the actual root cause. Pick the strongest of these (you may do more than one):

- **(Preferred) StatusLine width/line-count stability test** in `tests/components.test.tsx` (the existing StatusLine `describe` block — match its idiom: `import { render } from 'ink-testing-library'`, build `status` via `selectStatusLine(baseState, {...})`). Render `<StatusLine status={status} width={N}/>` at a SMALL width (e.g. 20) with a `status` whose chips' combined length far EXCEEDS that width (e.g. a long `model`/`cwd`), and assert the rendered frame's line count is bounded/stable (e.g. `frame.split('\n').length` equals the count at a WIDE width, OR ≤ a small constant like 4). The test MUST FAIL against the current code (no width prop → chips wrap → more lines) and PASS after the fix. Confirm this non-tautology yourself in the writeup.
- **AND/OR a `useTerminalSize` unit test** in a new `tests/useTerminalSize.test.tsx` (or fold into components): mount a host component using the hook with a FAKE stdout that is a real `EventEmitter` with mutable `columns`/`rows`; emit several `'resize'` events with changing columns; assert the hook tracks the latest size and (if you added debounce) coalesces. Clean up listeners.

Whichever you choose, the test must be NON-TAUTOLOGICAL: state explicitly in your writeup why it fails when the StatusLine fix is reverted.

### Existing test idiom to match (do not break these)
`tests/components.test.tsx` StatusLine block:
```tsx
const status = selectStatusLine(baseState, { model: 'gpt-x', cwd: '/work', maxContext: 200 });
const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
expect(frame).toContain('gpt-x');
```
`StatusLineState` (from `src/core/selectors.ts`): `{ model, cwd, tokens, contextFraction, effort, overlay, phase, statusText, pendingPermissionToolCallId, skills?, permissionMode? }`. `selectStatusLine(state, { model, cwd, maxContext?, skills?, permissionMode? })`.

## Frozen seams — DO NOT TOUCH / additive-only
- `src/core/contracts.ts` — untouched.
- `src/core/events.ts`, `src/core/reducer.ts` — do NOT edit (this unit needs no reducer/event change). If you think you need one, you are off-track.
- Public signature of `App` and `useKeybinds` must not break. Adding an OPTIONAL `width?` prop to `StatusLine` is fine (additive). The `useTerminalSize` return type `{ columns, rows }` must stay identical.
- No new npm dependencies.

## Gate (the synthesizer will run this; design to pass it)
`cd C:/Users/Core/src/juno && npx tsc --noEmit && npx vitest run`
Baseline: tsc 0 errors, vitest 310/310 passing. Your new test(s) should RAISE the passing count. Do not break any existing test.

## Deliverable format
For each changed/new file: the path, then the full content of the changed region (or whole file if small/new). A one-line rationale per file. Then a short "why the test is non-tautological" note. Keep it tight.
