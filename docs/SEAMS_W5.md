# SEAMS — Wave 5: Command UX + Render Resilience

Extends `PORT_SPEC-claude-code-features.md`. Same convention as `SEAMS_W3.md` /
`SEAMS_W4.md`: scope + lock + plan, frozen seams, per-unit definition-of-done.

**Date scoped:** 2026-06-17. **Gate baseline at scope time:** tsc 0, vitest 307/307.

---

## 0. Why this wave exists (the gap it closes)

Waves 0A–4 landed features at the **capability level** but repeatedly left the
**UX-surface layer half-wired** — the feature works, but the *user* can't reach it
through one consistent front door:

- Slash palette (`SlashPalette.tsx`) was **built but never triggers** (see 5.1).
- Effort works but is **Tab-cycle only** — no selectable menu.
- Permission-mode **parses** but has **no UI selector** (config/env only).
- Skills are invokable **by the model** (`load_skill` tool) but **not browsable by the user**.

**Governing principle for Wave 5:** *every capability gets a command-palette entry;
the palette is the single front door.* No more bespoke per-feature surfaces.

---

## 1. Scope

**IN:**
- **5.1 Slash-command interception fix** — `/` opens the palette and never reaches the model.
- **5.2 Unified command palette** — one component all capabilities plug into (skills, effort, model, permission-mode).
- **5.3 Render resilience** — fix the bottom-bar duplication on terminal resize + a regression test.

**OUT / DEFERRED:**
- The **hermes-style brain** — its own design pass after harness functionality is locked (see §6).
- New capabilities themselves (this wave wires *existing* ones into the palette; it does not add features).
- Permission-mode *session toggle* semantics beyond a simple selector (honor existing Wave-4 config-only model).

**SEQUENCING NOTE:** The Wave 4 nested-render unit is **still in flight (~40%)** — the
additive `parentToolUseId?` seam + `ToolCallCard` `nested?` prop landed, but the adapter
un-drop/stamp (`claudeCliClient.ts`), the committed-render grouping (`Message.tsx`),
the ~9 tests, and live-verify are outstanding. Wave 5 touches **different files** and may
proceed in parallel, BUT both waves touch `reducer.ts` overlay/event types — coordinate so
all edits stay **additive-only** and don't collide.

---

## 2. Unit breakdown + definition-of-done

### Unit 5.1 — Slash-command interception (the bug)
**Goal:** typing `/` opens the palette; a bare `/command` is parsed and dispatched, never sent to the model.
**Ground truth (current state):**
- `src/hooks/useKeybinds.ts:83` — opens the palette only if `/` is pressed when `options.value.length === 0`. By the time the keybind sees `/`, `InputBox` has already appended it, so `value.length === 1` → the trigger **never fires**.
- `src/app.tsx:212-221` (`submit()`) — forwards raw text to `turn.submit()` with **no `/` interception**; this is why the *model* replies "looks like you typed /".
- Existing registry: `src/app.tsx:70-74` (`clear`, `model`, `effort`). Palette UI: `src/ui/SlashPalette.tsx`. Host: `src/ui/OverlayHost.tsx:14-25` (renders when `overlay === 'slash'`). Overlay enum: `src/core/reducer.ts:64` = `'none' | 'slash' | 'permission' | 'model-picker'`.
**DoD:** `/` reliably opens the palette; `submit()` blocks `/`-prefixed text from reaching the model; tsc 0 + vitest green incl. a new test asserting a leading-`/` submit never calls `turn.submit()`.

### Unit 5.2 — Unified command palette
**Goal:** one `src/ui/UnifiedCommandPalette.tsx` enumerating all capabilities; fold `SlashPalette` + `ModelPicker` patterns into it.
**Ground truth (data already available to enumerate):**
- **Skills:** `deps.skills` (name + description) — `src/app.tsx:45`; full metadata via `src/services/skills.ts` `list()`.
- **Effort:** enum `'medium' | 'high' | 'xhigh'` — `src/core/reducer.ts:65,98`; `set-effort` action `reducer.ts:92`.
- **Models:** `deps.catalog.list()` — `src/services/catalog.ts:1-18`; existing `src/ui/ModelPicker.tsx`.
- **Permission-mode:** enum `'default' | 'acceptEdits'` — `src/services/config.ts:15` (currently config/env only: `config.ts:45,276-279`).
**Commands to expose:** `/clear`, `/model`, `/effort`, `/load_skill <name>`, `/permissions`.
**Already-wired dispatch targets:** clear (`app.tsx:176`), cycle-effort (`app.tsx:183`), set-overlay model-picker (`app.tsx:180`).
**NEW dispatch needed:** a skill-select action (or direct `load_skill` invocation) — none exists; a permission-mode selector + `set-permission-mode` action — none exists (config/env only today).
**DoD:** all four surfaces reachable + selectable from the one palette; tsc 0 + vitest green incl. enumeration tests (palette lists the right entries from live data).

### Unit 5.3 — Render resilience (resize)
**Goal:** the bottom status bar no longer duplicates/accumulates on terminal resize.
**Ground truth:**
- `src/ui/StatusLine.tsx:22-46` — plain `Box`, `borderStyle="single"`, **no explicit width/height**; relies on Ink flex auto-size.
- `src/app.tsx:258` — StatusLine is the penultimate child of the column (`app.tsx:232`, root `width={columns}`).
- `src/hooks/useTerminalSize.ts:21-33` — subscribes to stdout `'resize'`, re-renders the whole tree on every event.
- `src/cli.ts:102` — `render()` called with no `fullScreen`/alt-screen, no manual clear.
**Hypothesis (CONFIRM on implementation, not proven):** non-`<Static>` footer + no explicit width → incomplete layout cache-bust on rapid resize → footer repainted in place and accumulates above the (final-child) InputBox.
**Fix direction (lowest-risk):** give `StatusLine` an explicit `width={columns}` (thread from root); optionally debounce `useTerminalSize` `onResize` (~50ms). Avoid wrapping in `<Static>` (clips on width change).
**DoD:** resize is stable (no accumulation); tsc 0 + vitest green incl. a regression test simulating repeated resize events.

---

## 3. Frozen seams (Wave-wide)

- `src/core/contracts.ts` — **untouched**, all waves.
- `src/core/events.ts`, `src/core/reducer.ts` — **additive-only** (new optional fields / new overlay-enum variants). If 5.x adds an overlay type (e.g. `'command-palette'`) it must be additive; coordinate with the in-flight Wave 4 nested-render edits to the same file.

---

## 4. Wave definition-of-done

Each unit ends green (tsc 0 + vitest) before the next begins; `/` never reaches the model;
all four capability surfaces reachable via the unified palette; resize stable; snapshot
reconciliation after each green unit. **Required artifacts:** new tests per unit (5.1 interception,
5.2 enumeration, 5.3 resize regression); a green snapshot at wave end.

---

## 5. Status pointer (honesty marker)

At scope time, Wave 5 = **NOT STARTED**. Wave 4 nested-render = **IN PROGRESS (~40%, scaffolding only)**.
Do not read the green 307/307 gate as "Wave 4 done" — it is green because no new behavior/tests
have landed since the Unit-1 freeze. (Also reconcile the Wave-4 unit-numbering drift: the brief
calls nested-render "Unit 2"; `wave4-in-scopes.json` calls it "Unit 3" — same work.)

---

## 6. Separate track — hermes-style brain (Wave 6+, own design pass)

A "hermes-style brain" attached to juno is its own architecture problem — how orchestration
patterns get **captured from runs, stored, recalled, and fed back** into orchestration. Built on
the existing substrate: the `gbrain` engine (Supabase) + the orchestration-pattern-capture vision
(the brain accumulates reusable multi-agent patterns, not just chat memory). **Do not design inline.**
**Open question to pin first:** what does *"hermes-style"* mean concretely (a specific
architecture? a routing/messaging pattern?) — design to intent, not a guess.
