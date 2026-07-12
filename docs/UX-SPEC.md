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

3. **R2.3 — Spawn cards condense their agent args _and results_.** A `spawn_subagent`
   / `Agent` / `Task` call's card renders a condensed one-liner (`spawn_subagent(summarize
   the repo)`), never a raw agent-arg object — no `spawn_subagent({"`, `Agent({"`, or
   `Task({"` on any frame, covering both juno's `{"task":…}` and claude-cli's
   `{"description":…}` arg shapes — **and** its result is condensed, never a raw Anthropic
   content-block (`[{"type":`) on the spawn-card line. The gap covers args **and** results.

**Guarded by:** the global `no-raw-json` invariant (R2.1, every scenario, for raw JSON
**off** the spawn card), the `basic-exchange` invariant `tool-args-condensed` (R2.2),
and the `spawn-card-args-condensed` **known-gap** invariant (R2.3) on every
spawn-card scenario (`two-subagents`, `agents-dropdown`, `codex-parent-subagents`).

**Known gap at this fork tip (owned by the presentation layer, not this lane) — now
REPORTED, not silently green.** The spawn card still renders its args raw — e.g.
`spawn_subagent({"task":"summarize the repo","model":"fake"})` and, for a claude-cli
parent, `spawn_subagent({"description":"audit dependencies",…})` — because those tools
have no arg condenser yet (unlike `list_files`/`write_file`). The presentation lane's
fix is an agent-arg condenser so the card reads `spawn_subagent(summarize the repo)`.
Until then the harness does **not** pretend R2.3 passes: the `MULTI_SUBAGENT_SCRIPT`
fixture deliberately emits BOTH the juno (`{"task":`) and the real claude-cli
(`{"description":`) arg shapes, and the `spawn-card-args-condensed` invariant genuinely
**VIOLATES** on them — reported as `KNOWN-GAP` in the printout and listed under
`knownGaps` in `summary.json` (the run still exits 0; see "Known-gap invariants" below).
The moment the condenser lands, that invariant **XPASSes** and the run goes red, forcing
the marker to be removed and R2.3 promoted to a hard clause. The `no-raw-json` guard
owns SURPRISING raw JSON **off** the spawn card and exempts the spawn-card line (the
`Task({"` arg prefix makes that line-based exemption fire). Because that exemption would
otherwise **silently tolerate** an Anthropic content-block result (`[{"type":`) leaking
onto the same spawn-card line, `spawn-card-args-condensed` **also owns the result side**:
the `CODEX_SUBAGENT_SCRIPT` fixture emits a realistic content-block result
(`[{ type: 'text', text: 'done' }]`) on parent-1, and the invariant flags the `[{"type":`
leak just as it flags the raw args (both reported as `KNOWN-GAP`, run still exits 0). The
day the condenser removes the `Task({"` exemption prefix, `no-raw-json` **auto-hardens** on
the surviving `[{"type":` result. The expanded **dropdown** already renders clean condensed
descriptions (`summarize the repo`), so R1 is met independently of this.

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

**Guarded by:** the dedicated **`codex-parent-subagents`** scenario drives a
codex-shaped parent turn — the parent tool is named `Task` (a non-juno,
claude-cli/codex-style spawn name) with the `{ description, prompt, subagent_type }`
arg shape, children chained via `parentToolUseId` — and asserts the same surface as a
claude/juno parent: `codex-parent-in-dropdown` (`▾ agents (2 done)`), the global
R4/R2.1 invariants, and the shared `spawn-card-args-condensed` guard (over a
`Task({"description":…}` card). Because the surface derives purely from `state.tools`,
this is exactly R3.1's provider-agnostic claim, now machine-checked rather than
argued-by-construction.

**Honest caveat.** `codexCliClient` currently **gates** a codex PARENT spawning
children (its `codexToolArgs` seam defers codex-hosted `spawn_subagent` behind an MCP
bridge), so no real codex client emits this turn today. The fake
`CODEX_SUBAGENT_SCRIPT` stands in for the provider-agnostic **selection** path only —
which is all R3.1 asserts — and needs no `codexCliClient.ts` changes.

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
| `no-raw-json` | R2.1 | every scenario | no `{"description":` / `[{"type":` **off the spawn card** in any frame/scrollback |
| `status-mode-chrome` | (chrome) | every scenario | model chip present in final frame |
| `tool-args-condensed` | R2.2 | `basic-exchange` | `list_files(.)` shown; no `{"dir":`/`{"path":` |
| `spawn-card-args-condensed` ⚠︎ | R2.3 | `two-subagents`, `agents-dropdown`, `codex-parent-subagents` | no `spawn_subagent({"` / `Agent({"` / `Task({"` args **nor** a `[{"type":` content-block result on any spawn-card frame — **known gap** |
| `history-in-native-scrollback` | R4.3 | `long-overflow` | early line in scrollback, off-screen; last line on-screen |
| `two-subagents-in-dropdown` | R1.1 | `two-subagents` | `▾ agents (2 done)` |
| `codex-parent-in-dropdown` | R3.1 | `codex-parent-subagents` | a codex-shaped `Task` parent surfaces `▾ agents (2 done)` |
| `overlay-opens` / `overlay-closes` | (ctrl+o) | `ctrl-o-overlay` | Ctrl+O opens the tool-detail overlay; Esc restores the composer |
| `chord-char-not-leaked-open` ⚠︎ | (ctrl+o) | `ctrl-o-overlay` | composer empty while overlay open (no `❯ o`) — **known gap** |
| `chord-char-cleared-after-close` | (ctrl+o) | `ctrl-o-overlay` | composer empty/placeholder after the overlay closes |
| `dropdown-expands` / `dropdown-collapses` | R1.2/R1.3 | `agents-dropdown` | Down expands to status rows + hint; Esc collapses |

⚠︎ = **known-gap** invariant (see below): currently VIOLATED, owned by another lane,
reported but tolerated.

## Known-gap invariants (the anti-theater escape hatch)

Some clauses name a real render wart whose FIX belongs to another lane (the presentation
lane's spawn-card condenser for R2.3; the composer/app lane's Ctrl+O chord echo). Rather
than silently green-lighting these — the exact test-theater this loop exists to prevent —
they are marked `knownGap` and handled thus:

- A `knownGap` invariant that **fails** is reported as `KNOWN-GAP` in the printout and
  listed under `summary.json`'s top-level `knownGaps` array. It does **not** fail the run
  (exit 0 / vitest green) — it is an acknowledged cross-lane gap, made visible, never
  green.
- A `knownGap` invariant that **passes** is an `XPASS`: the owning lane fixed the gap.
  That **blocks** the run (non-zero exit / vitest red), forcing the `knownGap` marker to
  be removed and the clause promoted to a hard invariant. This keeps the escape hatch from
  rotting into a permanent silent pass.

So `summary.json`'s `ok: true` with a non-empty `knownGaps` means "all hard invariants
hold; these named cross-lane gaps are still open" — not "everything is clean."

## Running the loop

- `npm run selftest` — drive every scenario, write frames + `summary.json` under
  `.selftest/` for human/agent critics, exit non-zero on any BLOCKING invariant failure
  (a hard invariant that failed, or a `knownGap` invariant that unexpectedly passed).
  Known-gap violations are printed `KNOWN-GAP` and listed under `summary.json.knownGaps`
  but do not change the exit code. `JUNO_REQUIRE_PTY=1` makes an unavailable pty a hard
  failure instead of a skip; `JUNO_SELFTEST_OUT=<dir>` redirects the artifact directory.
- `FORCE_COLOR=0 npx vitest run tests/selftest.pty.test.ts` — the same scenarios +
  invariants under vitest, with honest pty skips.
