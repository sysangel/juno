# Writer brief — juno Wave 5, Unit 5.1: Slash-command interception fix

You are one of two independent writers. Produce a complete, correct, minimal implementation
for the unit below. Another writer is solving the same brief in isolation; an Opus synthesizer
will merge the best of both, then a skeptical verifier + an objective gate (tsc + vitest) will
confirm it. Optimize for **correctness and minimalism**, not cleverness.

## Project

`juno` is a TypeScript + React + **Ink** terminal AI agent (a Claude-Code-style TUI).
Stack: TS strict, React 18, Ink, `ink-text-input`, Vitest + `ink-testing-library`.
Gate command (must pass): `npx tsc --noEmit && npx vitest run`.

## The bug (root cause — confirmed)

Typing `/` should open a command palette and a `/command` must be **dispatched locally, never
sent to the model**. Today:

1. `src/app.tsx` `submit()` forwards the raw input straight to `turn.submit()` with **no `/`
   interception** — so a `/`-prefixed line reaches the model (it replies "looks like you typed /").
2. On `Enter` while the slash overlay is open, BOTH handlers fire on the same keypress:
   - `useKeybinds` → `onAcceptSlash()` (runs the highlighted command), AND
   - `ink-text-input`'s `onSubmit` → `submit(value)` (currently leaks `/`-text to the model).
   This double-path must be made coherent (no double-dispatch, no leak).
3. The `/` keypress also lands in the text box (ink-text-input appends it), so `value` becomes
   `"/..."` while the palette is open.

NOTE: the palette **does** open on `/` today (an existing test drives `/` and navigates the
overlay) — so the headline defect is the **submit leak + Enter double-path**, not "palette never opens".

## Definition of done (exact)

- `/` reliably opens the palette (keep current behavior working).
- `submit()` **blocks any `/`-prefixed input from reaching the model** — it must NEVER call
  `turn.submit()` for a leading-`/` value.
- A bare typed `/command` (`/clear`, `/model`, `/effort`) is parsed and dispatched to the
  already-wired targets; unknown `/command` is dropped (cleared), never sent to the model.
- No double-dispatch: pressing Enter on a slash command runs it exactly once (critical for
  `/effort`, which CYCLES — running it twice is a visible bug).
- `npx tsc --noEmit` → 0 errors; `npx vitest run` → all green, INCLUDING a NEW test asserting a
  leading-`/` submit never calls `turn.submit()`.

## Frozen seams (do NOT violate)

- `src/core/contracts.ts` — untouched.
- `src/core/events.ts`, `src/core/reducer.ts` — **additive-only** (new optional fields / new
  enum variants only). Unit 5.1 should need NO reducer change — the dispatch targets already exist.
- Existing exported signatures of `App`, `useKeybinds`, `InputBox` must stay
  backward-compatible (other tests depend on them). You MAY add optional params.

## Already-wired dispatch targets (use these; do not invent new actions)

- clear:  `turn.dispatch({ t: 'clear' })`
- model:  open the model picker — call `openModelPicker()` (dispatches `{ t: 'set-overlay', overlay: 'model-picker' }`)
- effort: `turn.dispatch({ t: 'cycle-effort' })`
- close overlay: `turn.dispatch({ t: 'set-overlay', overlay: 'none' })`

The slash registry today (`app.tsx`):
```ts
const slashCommands: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'clear', description: 'Clear the transcript' },
  { name: 'model', description: 'Choose a model' },
  { name: 'effort', description: 'Cycle effort level' },
];
```

## Current source — `src/app.tsx` (relevant parts)

```tsx
export function App({ deps }: AppProps): ReactElement {
  const { columns } = useTerminalSize();
  const models = useMemo(() => deps.catalog.list(), [deps.catalog]);
  // ...
  const [value, setValue] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedId, setSelectedId] = useState(initialModelId);
  // ... client / turn / status set up ...

  const closeOverlay = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'none' });
  }, [turn]);

  const openSlash = useCallback((): void => {
    setSelectedIndex(0);
    turn.dispatch({ t: 'set-overlay', overlay: 'slash' });
  }, [turn]);

  const openModelPicker = useCallback((): void => {
    turn.dispatch({ t: 'set-overlay', overlay: 'model-picker' });
  }, [turn]);

  const moveSlash = useCallback((delta: number): void => {
    setSelectedIndex((current) => {
      if (slashCommands.length === 0) return current;
      return (current + delta + slashCommands.length) % slashCommands.length;
    });
  }, []);

  const acceptSlash = useCallback((): void => {
    const command = slashCommands[selectedIndex];
    if (command === undefined) { closeOverlay(); return; }
    switch (command.name) {
      case 'clear':  turn.dispatch({ t: 'clear' }); closeOverlay(); break;
      case 'model':  openModelPicker(); break;
      case 'effort': turn.dispatch({ t: 'cycle-effort' }); closeOverlay(); break;
      default:       closeOverlay(); break;
    }
  }, [closeOverlay, openModelPicker, selectedIndex, turn]);

  useKeybinds({
    overlay: turn.state.overlay,
    value,
    slashCommandCount: slashCommands.length,
    modelCount: models.length,
    onAbort: turn.abort,
    onCycleEffort: () => turn.dispatch({ t: 'cycle-effort' }),
    onOpenSlash: openSlash,
    onOpenModelPicker: openModelPicker,
    onCloseOverlay: closeOverlay,
    onMoveSlash: moveSlash,
    onAcceptSlash: acceptSlash,
    onMoveModel: moveModel,
    onAcceptModel: acceptModel,
  });

  const submit = useCallback(
    (nextValue: string): void => {
      if (nextValue.trim().length === 0) return;
      setValue('');
      void turn.submit(nextValue);
    },
    [turn],
  );

  // ... render: <InputBox value={value} onChange={setValue} onSubmit={submit} ... />
}
```

## Current source — `src/hooks/useKeybinds.ts` (the slash + global parts)

```ts
export function useKeybinds(options: UseKeybindsOptions): void {
  useInput((input, key) => {
    if (key.escape) { /* abort or close overlay */ ... }
    if (options.overlay === 'permission') return;

    if (options.overlay === 'slash') {
      if (key.upArrow && options.slashCommandCount > 0) { options.onMoveSlash(-1); return; }
      if (key.downArrow && options.slashCommandCount > 0) { options.onMoveSlash(1); return; }
      if (key.return) { options.onAcceptSlash(); return; }
      return;
    }
    if (options.overlay === 'model-picker') { /* up/down/return -> model */ ... return; }

    // overlay === 'none': global bindings.
    if (key.tab) { options.onCycleEffort(); return; }
    if (input === '/' && options.value.length === 0) { options.onOpenSlash(); return; }
    if (key.ctrl && input.toLowerCase() === 'm') { options.onOpenModelPicker(); }
  });
}
```

## Required design (follow this — it resolves the Enter double-path coherently)

1. **`submit()` is the single guard against leaking `/` to the model.** Rewrite it as:
   - if `nextValue.trim().length === 0` → return (unchanged);
   - let `trimmed = nextValue.trimStart()`;
   - **if `trimmed.startsWith('/')`**: clear the input (`setValue('')`) and **return WITHOUT
     calling `turn.submit()`**. If the slash overlay is currently OPEN
     (`turn.state.overlay === 'slash'`), do nothing else here — `acceptSlash` will dispatch the
     command (avoids double-dispatch). If the overlay is NOT 'slash', parse the typed command
     yourself (`/clear|/model|/effort`) and dispatch it (clear/openModelPicker/cycle-effort);
     unknown → just clear. Either branch must `closeOverlay()` as appropriate.
   - else → `setValue('')` then `void turn.submit(nextValue)` (unchanged path).
2. **`acceptSlash()` prefers the typed command, falling back to the highlighted index.** Parse a
   leading `/word` out of `value`; if it names a known command, run THAT; otherwise run
   `slashCommands[selectedIndex]`. This makes a typed `/effort` + Enter cycle exactly once
   (submit() defers to acceptSlash when overlay==='slash', so only acceptSlash dispatches).
3. Keep the `/`-keypress open trigger in `useKeybinds` as-is (it works). Do not add a
   reducer/contract change.
4. Add a small pure helper to parse a slash command name from an input string (exported so it is
   unit-testable), e.g. `parseSlashCommand(value: string): string | null` returning the lowercased
   command word (without the leading `/`) or null.

Rationale for the no-double-dispatch invariant: on Enter with overlay==='slash', BOTH
`acceptSlash` (via useKeybinds) and `submit` (via ink-text-input.onSubmit) fire in the same tick;
both read the SAME render-closure `turn.state.overlay === 'slash'`. acceptSlash dispatches; submit
sees overlay==='slash' and only clears. Exactly one dispatch. ✓

## Required NEW test (add to `tests/app.smoke.test.tsx` or a new `tests/slashIntercept.test.tsx`)

Assert the load-bearing invariant directly: a leading-`/` submit NEVER calls `turn.submit()`.
Prefer a focused test that does not depend on Ink stdin timing — e.g. spy on the model client's
turn entrypoint (the fake client) and drive the input via the rendered InputBox `onSubmit`, OR
unit-test the `submit` behavior by asserting the fake client receives NO request for a `/`-prefixed
line but DOES for a normal line. Also add a unit test for `parseSlashCommand`. Keep it deterministic
(no real network/keys; use `createFakeModelClient`/`createFakeConfigService` as the existing smoke
test does).

Study how the EXISTING `tests/app.smoke.test.tsx` and `tests/components.test.tsx` mount `<App>`
and drive stdin (the `tick()` macrotask pattern, the Ink key byte sequences `'[B'` = down, `'\r'`
= enter). Match that style.

## Output format (MANDATORY)

Return ONLY the changed/new files, each as a fenced code block preceded by its exact repo-relative
path on its own line, like:

`src/app.tsx`
```tsx
<COMPLETE file contents>
```

`src/hooks/useKeybinds.ts`
```ts
<COMPLETE file contents>
```

`tests/slashIntercept.test.tsx`
```tsx
<COMPLETE file contents>
```

Give COMPLETE file contents for every file you change or add (not diffs). Do not change any file
not required by this unit. No prose outside the code blocks except a 3-line summary at the very top.
