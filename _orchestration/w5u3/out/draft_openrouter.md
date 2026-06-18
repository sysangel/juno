## `src/ui/StatusLine.tsx`

**Rationale:** Thread an explicit `width` into the outer Box and lock inner rows to `flexWrap="nowrap"` + `overflow="hidden"` so the rendered line count is fully determined by structure, never by wrap-driven drift.

**Change 1 — Props interface** (add `width?: number`):

```tsx
// FIND:
export interface StatusLineProps {
  status: StatusLineState;
}

// REPLACE WITH:
export interface StatusLineProps {
  status: StatusLineState;
  width?: number;
}
```

**Change 2 — Destructure `width`**:

```tsx
// FIND:
export function StatusLine({ status }: StatusLineProps) {

// REPLACE WITH:
export function StatusLine({ status, width }: StatusLineProps) {
```

**Change 3 — Outer Box** (the root `<Box flexDirection="column" borderStyle="single" …>` of the returned JSX). Add `width={width}` and `overflow="hidden"` alongside the existing props:

```tsx
// FIND (pattern — exact props may vary):
<Box flexDirection="column" borderStyle="single"

// REPLACE WITH:
<Box flexDirection="column" borderStyle="single" width={width} overflow="hidden"
```

(Keep every other prop that was already on this Box — just insert `width={width} overflow="hidden"` after `borderStyle="single"`.)

**Change 4 — Chip row** (the first inner `<Box` that has `gap={1}`). Add `flexWrap="nowrap"` and `overflow="hidden"`:

```tsx
// FIND (pattern):
<Box gap={1}

// REPLACE WITH:
<Box gap={1} flexWrap="nowrap" overflow="hidden"
```

**Change 5 — Second content row** (the other inner `<Box>` that is a direct child of the outer column Box, i.e. the non-chip row). Add `flexWrap="nowrap"` and `overflow="hidden"`:

```tsx
// FIND (pattern — the second inner <Box> child of the outer column Box):
// It will look something like:  <Box ...>  (without gap={1})
// Add flexWrap="nowrap" overflow="hidden" to its props.
```

For every `<Box>` that is a **direct child** of the outer column Box and does **not** already have `flexWrap`, add `flexWrap="nowrap" overflow="hidden"`.

---

## `src/app.tsx`

**Rationale:** Thread the live terminal width into `StatusLine` so it is width-constrained every frame.

```tsx
// FIND (around line 319):
<StatusLine status={status} />

// REPLACE WITH:
<StatusLine status={status} width={columns} />
```

(`columns` is already in scope from `const { columns } = useTerminalSize();` at line 108.)

---

## `src/hooks/useTerminalSize.ts`

**No change.** The width-threading fix alone resolves the root cause. Adding a debounce risks breaking the synchronous-first-read contract for marginal benefit.

---

## `tests/components.test.tsx`

**Rationale:** Regression test that directly validates the root-cause property: StatusLine's line count must not grow when width shrinks.

Add the following test inside the existing `describe('StatusLine', …)` block (alongside the existing `'gpt-x'` test):

```tsx
it('line count does not grow when width shrinks (resize resilience)', () => {
  const status = selectStatusLine(baseState, {
    model: 'gpt-x',
    cwd: '/work',
    maxContext: 200,
  });

  const narrow = render(<StatusLine status={status} width={10} />).lastFrame() ?? '';
  const wide = render(<StatusLine status={status} width={80} />).lastFrame() ?? '';

  const narrowLines = narrow.split('\n').length;
  const wideLines = wide.split('\n').length;

  // Line count must be identical regardless of width.
  // Without flexWrap="nowrap" on the inner rows, the width={10} constraint
  // forces chips to wrap to multiple lines, making narrowLines > wideLines.
  expect(narrowLines).toEqual(wideLines);
});
```

---

## Why the test is non-tautological

If you **revert only the `flexWrap="nowrap"` / `overflow="hidden"` additions** on the inner rows (keeping the `width` prop), the `width={10}` constraint shrinks the usable inner width to ~8 chars. The chip row (`gpt-x` + gap + `/work` + gap + tokens + …) far exceeds 8 chars, so Yoga's default `flexWrap="wrap"` splits chips across multiple lines. `narrow.split('\n').length` becomes 5–8+ while `wide.split('\n').length` stays at 4 (or whatever the fixed structure height is). The `toEqual` assertion fails.

If you **revert the `width` prop entirely**, the test doesn't compile (`Property 'width' does not exist on type 'StatusLineProps'`), which fails the `tsc --noEmit` gate.

The test therefore validates the **active mechanism** (`flexWrap="nowrap"` preventing wrap-driven line-count growth under a width constraint), not merely the presence of a prop. It would not pass if the fix were incomplete or absent.
