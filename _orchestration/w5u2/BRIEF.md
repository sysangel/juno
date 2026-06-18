# BRIEF — juno Wave 5, Unit 5.2: Unified Command Palette

You are a WRITER producing a complete, self-contained set of code edits for the juno
repo (TypeScript + React + Ink TUI). Repo root: `C:/Users/Core/src/juno`. There is NO
git here. Output the FULL final contents of every file you create or change, in fenced
code blocks, each preceded by its exact repo-relative path as a `### path` heading.
Do NOT output diffs — output whole files. Where you only touch part of a large file,
still output the whole file so the synthesizer can apply it verbatim.

## The goal (one sentence)
Build ONE `src/ui/UnifiedCommandPalette.tsx` that is the single front door for every
command surface — slash commands, model picker, effort, skills, permission-mode — and
FOLD IN (delete + subsume) the existing `src/ui/SlashPalette.tsx` and
`src/ui/ModelPicker.tsx` so there are no dead duplicate components. Also fix a specific
Enter-routing edge case in `useKeybinds`/`app.tsx`. Keep tsc clean and all existing
tests green while adding new tests.

## NON-NEGOTIABLE: do not break the existing behavioral contract
There are baseline tests that drive the REAL UI seam through stdin and assert exact
behavior + exact rendered strings. Your edits MUST keep ALL of these green. Read them as
the spec:

1. `tests/app.smoke.test.tsx` (the "RUNTIME picker swap" test, ~line 157) drives:
   `'/'` (overlay none→slash) → `DOWN` (move selection clear→model) → `ENTER`
   (accept 'model' → opens model-picker) → `DOWN`×2 (move model selection over
   BUILTIN_MODELS order) and asserts the client is rebuilt for the newly-selected
   provider. THEREFORE the unified palette MUST preserve:
   - `/` opens a palette listing slash commands in order: `clear`, `model`, `effort`.
   - Up/Down arrows move the slash selection; Enter on `model` opens the model picker.
   - The model picker lists `BUILTIN_MODELS` in `catalog.list()` order; Down moves
     selection; selecting drives `selectedId`.
   The cleanest way to satisfy this: KEEP the existing overlay states (`'slash'`,
   `'model-picker'`) and the existing App state/callbacks (`selectedIndex`, `selectedId`,
   `openSlash`, `moveSlash`, `acceptSlash`, `openModelPicker`, `moveModel`, `acceptModel`)
   essentially as-is, and ONLY change WHICH COMPONENT renders them — route both overlays
   through `UnifiedCommandPalette` instead of `SlashPalette`/`ModelPicker`.

2. `tests/components.test.tsx` `describe('OverlayHost')` (~line 251) asserts:
   - slash overlay frame contains `"commands"`, `"/model"`, `"switch model"`.
   - model-picker overlay frame contains `"models"`, `"GPT X"`, `"gpt-x"`.
   So `UnifiedCommandPalette`, when rendering the slash surface, MUST still print the
   header `commands` and each command as `/<name>` + its description; when rendering the
   model surface it MUST still print the header `models` and each model's `label` + `id`.
   (You MAY update this test file's imports if a symbol moves, but the RENDERED STRINGS
   above must stay asserted and passing. Prefer not to weaken these tests.)

3. `tests/slashIntercept.test.tsx` — `parseSlashCommand` purity + the no-model-leak
   invariant (a leading-`/` submit reaches the model client ZERO times; a normal line
   once). Keep green.

4. `tests/permissionMode.ui.test.tsx` + `tests/components.test.tsx` StatusLine tests —
   `selectStatusLine` threads `permissionMode`; the `mode:acceptEdits` chip renders only
   for non-default. Keep green (do not change `selectors.ts` semantics).

## Current ground truth (exact shapes — confirm against the files)

### src/ui/SlashPalette.tsx (TO BE FOLDED IN / DELETED)
```
export interface SlashPaletteProps { commands: Array<{ name: string; description: string }>; selectedIndex?: number; depth?: ColorDepth; }
```
Renders a rounded Box, header Text `commands`, then for each command a row:
marker (`▸`/space) + `/<name>` (bold+accent when selected) + dim description.

### src/ui/ModelPicker.tsx (TO BE FOLDED IN / DELETED)
```
export interface ModelPickerProps { models: ReadonlyArray<ModelEntry>; selectedId?: string; depth?: ColorDepth; }
```
Renders a rounded Box, header Text `models`, then for each model a row:
marker + `model.label` (bold+accent when selected by id) + dim `model.id`.
`ModelEntry` = `{ id; provider; label; contextWindow; aliases?; default? }` from
`src/services/catalog.ts`.

### src/ui/OverlayHost.tsx (current)
```
export interface OverlayHostProps { overlay: State['overlay']; slash?: SlashPaletteProps; modelPicker?: ModelPickerProps; permission?: PermissionPromptProps; }
```
switch on `props.overlay`: 'none'→null; 'slash'→<SlashPalette {...slash}/> if defined;
'model-picker'→<ModelPicker {...modelPicker}/> if defined; 'permission'→<PermissionPrompt/>.
NOTE: this switch is EXHAUSTIVE over the overlay union (no default) — TS will error if you
add a new overlay variant to the union and don't handle it here. If you add a new overlay
variant, handle it in this switch.

### src/ui/theme.ts
Exports `detectColorDepth()`, `token(name, depth)`, type `ColorDepth`. Both palettes do
`const DEPTH = detectColorDepth()` at module scope and accept an optional `depth` prop
override (used so tests are deterministic). Preserve this pattern in UnifiedCommandPalette.

### src/app.tsx (the Unit-5.1 slash flow — keep behavior; change rendering + fix edge case)
- `parseSlashCommand(value): string|null` — exported pure parser. KEEP unchanged.
- `systemPromptForProvider(...)` — KEEP unchanged (tested).
- `slashCommands` registry (module const): `[{clear,'Clear the transcript'},
  {model,'Choose a model'},{effort,'Cycle effort level'}]`. You will EXTEND this with
  new entries for skills + permissions (see below) but the first three must stay first,
  in that order (smoke test depends on index 0=clear, 1=model).
- State: `value`, `selectedIndex`, `selectedId` (useState). `turn = useStreamingTurn(...)`.
- Callbacks: `closeOverlay`, `openSlash` (sets selectedIndex 0 + overlay 'slash'),
  `openModelPicker` (overlay 'model-picker'), `moveSlash(delta)` (mod over
  slashCommands.length), `moveModel(delta)` (mod over models), `runSlashCommand(command)`
  (switch on name: clear→dispatch clear+close; model→openModelPicker; effort→dispatch
  cycle-effort+close; default→close), `acceptSlash` (prefers typed `/command` parsed from
  `value`, else `slashCommands[selectedIndex]`, then runSlashCommand), `acceptModel`
  (closeOverlay).
- `useKeybinds({...})` wiring (see hook below).
- `submit(nextValue)`: empty→return; if trimmed startsWith '/': setValue('') then if
  overlay==='slash' return (acceptSlash handles dispatch on the same Enter), else
  runSlashCommand(findSlashCommand(parseSlashCommand(nextValue))) then return; else
  setValue('') + turn.submit(nextValue). KEEP the no-leak guarantee.
- `status = selectStatusLine(turn.state, { model, cwd, maxContext, skills, permissionMode })`.
  TODAY `permissionMode: deps.settings.permissionMode`. CHANGE to read the EFFECTIVE,
  runtime-selectable mode from reducer state (see new action) falling back to settings.
- Render: `<OverlayHost overlay={effectiveOverlay} slash={...} modelPicker={...}
  permission={...} />`. You will route these through the unified palette.

### src/hooks/useKeybinds.ts (THE EDGE CASE LIVES HERE)
```
export interface UseKeybindsOptions { overlay; value; slashCommandCount; modelCount; onAbort; onCycleEffort; onOpenSlash; onOpenModelPicker; onCloseOverlay; onMoveSlash; onAcceptSlash; onMoveModel; onAcceptModel; }
```
useInput handler:
- Esc: if overlay permission|none → onAbort(); else onCloseOverlay().
- overlay 'permission': return (prompt owns keys).
- overlay 'slash': Up→onMoveSlash(-1); Down→onMoveSlash(1); **return (Enter)→onAcceptSlash()**; else return.
- overlay 'model-picker': Up/Down→onMoveModel; Enter→onAcceptModel; else return.
- overlay 'none': Tab→onCycleEffort; `input==='/' && value.length===0`→onOpenSlash;
  Ctrl+M→onOpenModelPicker.

### src/core/reducer.ts (ADDITIVE ONLY)
- `State.overlay: 'none' | 'slash' | 'permission' | 'model-picker'`.
- `State.effort: 'medium' | 'high' | 'xhigh'`.
- State does NOT currently carry permissionMode.
- Action union variants (existing — DO NOT modify any): user-submit, assistant-start,
  text-delta, reasoning-delta, tool-call, tool-call-delta, tool-status, permission-open,
  permission-resolved, assistant-done, usage, aborted, set-effort, cycle-effort,
  set-overlay, error, clear.
- `initialState()` returns the full State.
- `reducer` is a PURE switch over `action.t` with NO `default` case (exhaustive) — so
  every new action variant you add MUST get its own `case`, or tsc fails.

### src/core/events.ts — FROZEN. `AgentEvent` is the adapter seam. The new UI actions
(`skill-select`, `set-permission-mode`) are LOCAL UI actions with NO corresponding event
— DO NOT touch events.ts at all. (Existing UI-only actions like `set-effort`/`clear`
already have no event; follow that precedent.)

### src/services
- `skills.ts`: `deps.skills?: ReadonlyArray<{ name: string; description: string }>` is on
  AppDeps (app.tsx). Full service `SkillsService.list(): ReadonlyArray<Skill>` where
  `Skill = { name; description; version?; path; source }`. For the palette use
  `deps.skills` (already name+description). There is a `load_skill` TOOL the model calls;
  there is NO user-facing skill invocation today.
- `catalog.ts`: `ModelCatalog.list()/resolve()/byProvider()/default()`; `ModelEntry` above.
- `config.ts`: `Settings.permissionMode?: 'default' | 'acceptEdits'` (config/env only).
  `parsePermissionMode` allowlists the two values. No setter exists.

## WHAT TO BUILD

### A) `src/ui/UnifiedCommandPalette.tsx` (NEW — the one front door)
A single presentational component that can render any command surface. Design it so the
SAME component renders BOTH the slash-command list AND the model list AND (new) the skills
list AND (new) the permission-mode list, switching on a discriminated `mode`/`kind` prop.
Requirements:
- Keep the `detectColorDepth()` module-scope default + optional `depth` prop pattern.
- Rounded Box, a header Text, a list of marker + primary + dim-secondary rows, exactly
  like the two folded components, so the existing OverlayHost component tests still match.
- For the slash surface: header MUST be `commands`; each row primary MUST be `/<name>`;
  secondary = description; selection by index. (Matches components.test.tsx + smoke test.)
- For the model surface: header MUST be `models`; each row primary = `label`; secondary =
  `id`; selection by id. (Matches components.test.tsx.)
- For the skills surface: header e.g. `skills`; rows primary = skill name; secondary =
  description; selection by index. (New — assert its render in a new test.)
- For the permission-mode surface: header e.g. `permission mode`; rows = `default` and
  `acceptEdits`; selection by the current mode. (New.)
- Export a clean props type (a discriminated union is ideal). Keep it dependency-light.
- Re-export or define the legacy `SlashPaletteProps`/`ModelPickerProps` shapes ONLY if it
  reduces churn — but the SlashPalette.tsx and ModelPicker.tsx FILES must be removed and
  not imported anywhere. No dead components left importable-but-unused.

### B) `src/ui/OverlayHost.tsx` (route through the unified palette)
Replace the `<SlashPalette>` and `<ModelPicker>` renders with `<UnifiedCommandPalette>` in
the appropriate mode. Keep the `slash?`/`modelPicker?` prop names if convenient, OR
restructure cleanly — but the OverlayHost component tests (the rendered strings) MUST stay
green. Keep the switch exhaustive over the overlay union.

### C) Skills surface wired through the palette (NEW additive action `skill-select`)
Expose skills as a selectable surface reachable from the palette. Add:
- A `/load_skill` (or `/skills`) entry to the slash registry (AFTER clear/model/effort, so
  the smoke test's index 0/1 stays correct) that opens a skills overlay/surface.
- A NEW overlay variant if needed (additive to the union, e.g. `'skill-picker'`), handled
  in OverlayHost + reducer's `set-overlay` path (set-overlay already accepts any
  `State['overlay']`, so widening the union is enough — no reducer case change needed for
  set-overlay; but a NEW overlay variant must be handled in OverlayHost's switch).
- A NEW additive reducer Action `{ t: 'skill-select'; name: string }` with its own
  `case 'skill-select'`. What it does: it is a UI action; minimally it can close the
  overlay (the actual model-side `load_skill` is the model's tool, not user-invoked). If
  you can cleanly surface the selected skill (e.g. record a "pending skill" or no-op +
  close), do the SIMPLEST additive thing that is testable and does not touch existing
  cases. The test will assert the reducer handles `skill-select` without altering
  unrelated state. KEEP it additive — new variant + new case ONLY.

### D) Permission-mode selector (NEW additive action `set-permission-mode`)
Make permission-mode runtime-selectable via the palette:
- Add `permissionMode: 'default' | 'acceptEdits'` to reducer `State` (ADDITIVE field),
  initialized to `'default'` in `initialState()`.
- Add `{ t: 'set-permission-mode'; mode: 'default' | 'acceptEdits' }` to the Action union
  with its own `case 'set-permission-mode'` that sets `state.permissionMode`.
- Add a `/permissions` entry to the slash registry (after the first three) that opens the
  permission-mode surface; selecting a mode dispatches `set-permission-mode`.
- In app.tsx, seed the effective mode from `deps.settings.permissionMode ?? 'default'`
  and pass the STATE mode to `selectStatusLine` so the status chip reflects runtime
  changes. (Seeding: since reducer initialState hardcodes 'default', either (a) dispatch
  `set-permission-mode` once on mount from settings, or (b) compute the effective mode in
  App as `turn.state.permissionMode` falling back to settings when state is still default.
  Pick the cleaner one; do NOT change existing reducer cases. Keep permissionMode chip
  tests green — they call selectStatusLine directly, so they are unaffected.)

### E) THE BACKSPACE EDGE CASE FIX (in `useKeybinds.ts` + `app.tsx`)
Bug: while `overlay==='slash'`, `useKeybinds` routes EVERY Enter to `onAcceptSlash`. So if
the user opens the palette with `/`, backspaces to empty, then types a NON-slash line and
presses Enter, they get a spurious extra command (the default-highlighted `clear` fires
via `acceptSlash`→`slashCommands[selectedIndex]`) AND the typed line still sends. Two
wrongs: a phantom command + a send.
Fix so that when the palette is open (`overlay==='slash'`) but the current input is NO
LONGER a slash command (i.e. `parseSlashCommand(value) === null`, e.g. value is empty or a
plain line), Enter does the RIGHT SINGLE thing:
- It must NOT fire a phantom highlighted command.
- The desired single behavior: when in slash overlay and input is not a slash command,
  Enter should close the palette and submit the typed (non-slash) line normally if there
  is one (or just close if empty). Decide the precise single action and implement it so
  exactly ONE thing happens.
RECOMMENDED implementation (keep public signatures stable; additive only):
- `acceptSlash` in app.tsx already prefers the typed command but FALLS BACK to the
  highlighted index. Change the fallback so that when `parseSlashCommand(value) === null`,
  it does NOT run the highlighted command. Instead it closes the overlay and, if `value`
  is a non-empty non-slash line, submits it via the normal `turn.submit` path (reuse the
  existing `submit`/`turn.submit` logic; do NOT leak a `/` line). Ensure no double-fire:
  only ONE of {phantom command, normal send} happens — i.e. exactly the normal send (or a
  clean close if empty).
- You MAY pass an extra callback to `useKeybinds` or branch inside `acceptSlash` — prefer
  branching inside `acceptSlash` so `useKeybinds`'s public `UseKeybindsOptions` shape does
  not change (existing useKeybinds usage/tests must not break). If you must extend
  `UseKeybindsOptions`, make the new field OPTIONAL so existing callers/tests compile.
- Be careful: the smoke test opens slash, DOWN, ENTER on 'model' WITH value==='' — wait:
  in that test `value` stays '' (it types via stdin '/' which opens the overlay but the
  InputBox is real there? No — that test uses the REAL InputBox and writes '/' to stdin;
  the '/' opens the overlay via the keybind BEFORE InputBox appends because value.length
  must be 0 to trigger... but Unit 5.1 changed the trigger). CRITICAL: verify your fix
  does NOT break the smoke test where ENTER selects 'model' from the slash menu. In that
  test, after pressing '/', is `value` empty or '/'? If your fix keys off
  `parseSlashCommand(value)===null` and value is '' there, ENTER would NOT select 'model'
  and the test breaks. THEREFORE: the fix must only suppress the highlighted command when
  the user has actively typed a NON-slash, NON-empty line into the palette — OR, more
  robustly, gate on: "value is non-empty AND parseSlashCommand(value)===null" → treat
  Enter as a normal submit+close; otherwise (empty value OR a slash value) keep the
  current behavior (highlighted/typed command). Confirm against the smoke test's actual
  `value` state at ENTER time — READ how Unit 5.1 wired the '/' trigger and whether the
  InputBox value holds '/'. Make the new regression test assert BOTH: (1) phantom command
  suppressed, (2) the existing "Enter selects highlighted model command" path still works.

## NEW TESTS YOU MUST AUTHOR (in `tests/`, vitest + ink-testing-library + React `act`)
Follow the existing conventions in `tests/components.test.tsx` and
`tests/slashIntercept.test.tsx` (mock InputBox to capture/drive onSubmit; use `tick()`;
use `createRecordingClient` for no-leak assertions; use the `depth` prop for deterministic
palette rendering where needed). Add a file e.g. `tests/unifiedPalette.test.tsx` (and/or
extend `tests/reducer.test.ts`):
1. UnifiedCommandPalette renders the slash surface: header `commands`, each `/<name>` +
   description, selected row marked. (Enumeration from live `slashCommands`-shaped data.)
2. UnifiedCommandPalette renders the model surface: header `models`, each label + id.
3. UnifiedCommandPalette renders the skills surface: header `skills`, each skill name +
   description, FROM live `deps.skills`-shaped data (enumeration test — assert the right
   entries appear, NOT a hardcoded snapshot).
4. UnifiedCommandPalette renders the permission-mode surface: both `default` and
   `acceptEdits` listed, the active one marked.
5. reducer: `set-permission-mode` sets `state.permissionMode` and leaves other fields
   untouched (returns a new state; effort/tokens/committed unchanged).
6. reducer: `skill-select` is handled (no throw; whatever minimal additive effect you
   chose), other fields untouched.
7. THE EDGE CASE regression (the load-bearing one): mount `<App>` with the mocked
   InputBox + a recording client. Open slash overlay, set the input value to a non-slash
   non-empty line, press Enter (drive via the captured InputBox onSubmit AND/OR the
   keybind path as appropriate), and assert: (a) NO phantom slash command fired — e.g.
   the transcript was NOT cleared (clear is index 0 / default highlight) and effort did
   NOT cycle; (b) the line was sent to the model exactly once OR cleanly handled per your
   chosen single behavior; (c) it is NON-TAUTOLOGICAL — it must actually go red against
   the CURRENT buggy code (where the highlighted `clear` fires + the line also sends).
   Document in a comment WHY it would fail pre-fix.
8. A test (or extend smoke) confirming the EXISTING slash→model selection still works
   after the fix (Enter on highlighted 'model' opens model-picker) so the fix didn't
   over-suppress.

## Frozen-seam rules (violating = the synthesizer will reject your draft)
- `src/core/contracts.ts`: DO NOT TOUCH.
- `src/core/events.ts`: DO NOT TOUCH (no new events; these are UI-only actions).
- `src/core/reducer.ts`: ADDITIVE ONLY — new `State.permissionMode` field (with
  initialState init), new Action variants `skill-select` + `set-permission-mode`, new
  `case` for each, widen `State['overlay']` union additively if you add an overlay
  variant. DO NOT modify any existing action's shape or any existing case's logic. (A
  parallel Wave-4 effort also edits reducer.ts — keep edits purely additive so they don't
  collide.)
- Public signatures of `App`/`useKeybinds`/exported palette functions that existing tests
  import must not break. New `UseKeybindsOptions` fields must be optional.

## The gate (the synthesizer runs this; write code that passes it)
From `C:/Users/Core/src/juno`: `npx tsc --noEmit && npx vitest run`.
Baseline before this unit: tsc 0 errors, vitest 311 passing. Your new tests must RAISE the
count; ALL prior tests must stay green. No `any`-casts to dodge tsc; no skipped/`.only`
tests; no tautological assertions.

## Output format
For EACH file you create or modify, emit:
### <repo-relative path>
```tsx
<full final file contents>
```
List every changed/new/deleted file. For deletions, state `### DELETE: src/ui/SlashPalette.tsx`
(and ModelPicker) explicitly with a one-line reason. Then a short "who-touched-what" map.
