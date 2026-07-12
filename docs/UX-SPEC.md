# UX Spec — juno TUI presentation contract

A **testable** presentation spec for the juno terminal UI. Every clause below is
written so a machine can check it against real rendered screen frames, and every
clause names the scenario + invariant in the selftest harness
(`scripts/selftest.ts`, `tests/selftest.pty.test.ts`) that guards it.

The harness drives the **real** `tsx src/cli.ts` under a pseudo-terminal (node-pty)
against the scripted fake provider (`src/core/fakeClient.ts`, `JUNO_PROVIDER=fake`),
feeds the raw ANSI framebuffer through a headless VT parser (`@xterm/headless`), and
reconstructs two artifacts per scenario:

- **frame** — the visible viewport as plain text (`rows` lines at the buffer base):
  what a user *sees*.
- **scrollback** — the entire buffer (native scrollback + visible screen): what the
  user can still *reach by scrolling up*.

Determinism: `FORCE_COLOR=0` + `NO_COLOR=1` for stable plain-text frames; a
byte-reproducible fake turn with no network / keys / clock; and — per hard-won Ink
rules — **no fake timers** anywhere near a render (the clock is the real pty's).

Terminology used below:
- **composer** — the input box (`❯` prompt + `Message Juno` placeholder).
- **status line** — the bottom chrome (`model · cwd · … · effort`); the model chip
  (`claude-fable-5`) is the never-dropped anchor.
- **transcript** — the committed message history, rendered once into Ink `<Static>`.
- **agents dropdown** — the collapsible strip below the composer
  (`▾ agents (N done)` collapsed; one status row per subagent when expanded).
- **spawn card** — the condensed tool card for a `spawn_subagent` / `Agent` / `Task`
  call in the transcript, under which its subagents are summarized.

---

## R1 — Subagents present cleanly below their spawn card; no click-into-chat browsing

**Intent (Aiden, 2026-07-12):** subagents appear as clean *status rows* below the
spawn card — professional, no raw chat-transcript browsing anywhere. The only way to
survey agents is a **collapsible agents dropdown pinned at the bottom**.

**Testable clauses**

1. **R1.1 — Collapsed by default.** When a session has spawned subagents, a single
   dim one-liner `▾ agents (<summary>)` renders below the composer, where
   `<summary>` counts only non-empty buckets (`N running`, `N done`, `N failed`).
   With two settled subagents it reads exactly `▾ agents (2 done)`.
2. **R1.2 — Expands in place to status rows.** Focusing the dropdown (Down-arrow from
   the composer bottom) expands it into one status row per subagent —
   `<glyph> <description> <provider/model · step count>` — plus the browse hint
   `↑↓ select · enter open · esc back`. Rows are condensed status, never raw chat.
3. **R1.3 — Collapses back.** Esc collapses the dropdown back to the one-liner and
   returns focus to the composer; the app never exits behind the panel.
4. **R1.4 — Status rows carry no raw JSON.** No dropdown row contains a raw JSON
   fragment (see R2).

**Guarded by:** scenarios `two-subagents` (R1.1) and `agents-dropdown`
(R1.2/R1.3), invariants `two-subagents-in-dropdown`, `dropdown-expands`,
`dropdown-collapses`, and the global `no-raw-json` (R1.4).

---

## R2 — Agent tool args and results are condensed like every other tool card

**Intent:** an agent's tool args and results are condensed exactly like every other
tool card. Raw JSON such as `{"description":` (claude-cli `Agent`/`Task` args) or
`[{"type":"text"` (Anthropic content-block results) must **never** appear on screen.

**Testable clauses**

1. **R2.1 — No canonical raw-JSON leak.** No frame or scrollback in any scenario
   contains `{"description":` or `[{"type":`. These are the two canonical leak
   signatures the spec names; the harness asserts them globally.
2. **R2.2 — Non-agent tool cards condense args + results.** A `list_files` call
   renders as `list_files(.)` (not `{"dir":"."}`) and its result renders compact
   (`["a.txt","b.txt"]`); a `write_file` call renders `write_file(x.txt)` (not
   `{"path":…}`). No `{"dir":` / `{"path":` appears on the transcript frame.

**Guarded by:** the global `no-raw-json` invariant (R2.1, every scenario) and the
`basic-exchange` invariant `tool-args-condensed` (R2.2).

**Known gap at this fork tip (owned by the presentation layer, not this lane).**
The `spawn_subagent` / `Agent` / `Task` **spawn card** currently renders its args
raw — e.g. `spawn_subagent({"task":"summarize the repo","model":"fake"})` — because
those tools have no arg condenser yet (unlike `list_files`/`write_file`). This is
exactly the class of leak R2 forbids, and it is the presentation lane's fix (add an
agent-arg condenser so a spawn card reads `spawn_subagent(summarize the repo)`). The
harness's `no-raw-json` guard uses the two spec-named signatures today; once the
spawn card condenses, the `two-subagents` scenario's frame will drop the raw
`{"task":`/`{"description":` blob and the guard can be tightened to also forbid raw
agent-arg objects on the spawn card. The expanded **dropdown** already renders clean
condensed descriptions (`summarize the repo`), so R1 is met independently of this.

---

## R3 — Codex-parent agents spawn and display below the card exactly like Claude parents

**Intent:** a Codex-provider parent agent spawns and displays its subagents below the
spawn card identically to a Claude parent — same collapsed dropdown, same expanded
status rows, same condensation.

**Testable clauses**

1. **R3.1 — Provider-agnostic subagent surface.** The subagent surface (spawn card +
   agents dropdown) is derived purely from `state.tools` via `selectSubagents`
   (`parentToolUseId` chain), independent of which provider produced the parent turn.
   Therefore every R1/R2 clause holds identically for a codex-parent turn.

**Guarded by:** the `two-subagents` / `agents-dropdown` scenarios exercise the
provider-agnostic path via the fake provider; the same invariants (R1, R2) apply to a
codex-parent turn by construction. (A dedicated codex-parent fake turn is a
future harness extension; the selection logic under test is already
provider-independent.)

---

## R4 — Claude-Code scroll model (composer pinned, history in native scrollback)

**Intent:** the composer is pinned at the bottom; the transcript fills top-down; when
the screen fills, the top flows into **native** terminal scrollback and the **entire**
history stays reachable by scrolling up. Erase-scrollback (`\x1b[3J`) must **never**
be emitted.

**Testable clauses**

1. **R4.1 — Composer pinned at bottom.** In the final frame of every scenario, the
   composer prompt (`❯` / placeholder) sits on the last content rows (a status line
   may sit just below it).
2. **R4.2 — Native scrollback preserved, never erased.** No scenario emits `\x1b[3J`
   anywhere in the raw pty byte stream.
3. **R4.3 — Overflow flows into reachable scrollback.** When a turn overflows a small
   terminal, an early committed line (`line 1 of 40`) is **absent from the visible
   frame** but **present in the scrollback dump** — proof the top scrolled into native
   scrollback and is still reachable, while the newest line (`line 40 of 40`) and the
   composer stay on screen.

**Guarded by:** the global `composer-pinned-bottom` (R4.1) and `no-erase-scrollback`
(R4.2) invariants on every scenario, plus the `long-overflow` invariant
`history-in-native-scrollback` (R4.3).

**Constraint the harness respects.** `app.tsx` reserves `LIVE_TURN_CHROME_RESERVE`
(12) rows below the live turn; a viewport at or below that reserve cannot fit the
bounded live window and Ink falls back to the erase-scrollback full-repaint. The
`long-overflow` scenario therefore uses `rows: 16` — small enough to overflow ~2.5×
(exercising R4.3) yet above the reserve (the regime `tests/autoscroll.pty.test.ts`
proves safe at `rows: 24`). Sizing a scenario at/under the reserve is a harness
mis-configuration, not a UI regression.

---

## Machine-checkable invariants (summary)

| Invariant | Clause | Scope | Assertion |
| --- | --- | --- | --- |
| `no-erase-scrollback` | R4.2 | every scenario | `\x1b[3J` never in raw pty bytes |
| `composer-pinned-bottom` | R4.1 | every scenario | `❯`/placeholder on last content rows of final frame |
| `no-raw-json` | R2.1 | every scenario | no `{"description":` / `[{"type":` in any frame or scrollback |
| `status-mode-chrome` | (chrome) | every scenario | model chip present in final frame |
| `tool-args-condensed` | R2.2 | `basic-exchange` | `list_files(.)` shown; no `{"dir":`/`{"path":` |
| `history-in-native-scrollback` | R4.3 | `long-overflow` | early line in scrollback, off-screen; last line on-screen |
| `two-subagents-in-dropdown` | R1.1 | `two-subagents` | `▾ agents (2 done)` |
| `overlay-opens` / `overlay-closes` | (ctrl+o) | `ctrl-o-overlay` | Ctrl+O opens the tool-detail overlay; Esc restores the composer |
| `dropdown-expands` / `dropdown-collapses` | R1.2/R1.3 | `agents-dropdown` | Down expands to status rows + hint; Esc collapses |

## Running the loop

- `npm run selftest` — drive every scenario, write frames + `summary.json` under
  `.selftest/` for human/agent critics, exit non-zero on any invariant failure.
  `JUNO_REQUIRE_PTY=1` makes an unavailable pty a hard failure instead of a skip;
  `JUNO_SELFTEST_OUT=<dir>` redirects the artifact directory.
- `FORCE_COLOR=0 npx vitest run tests/selftest.pty.test.ts` — the same scenarios +
  invariants under vitest, with honest pty skips.
