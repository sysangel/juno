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

Keyboard and overlay conventions: dismissing an overlay preserves any composer
draft, except cancelling the slash palette (whose `/query` is overlay-owned).
Windowable lists clamp at their first/last row. Arrow overflow markers (`↑/↓ N
more`) are reserved for content those keys reveal; non-navigable truncation uses
an ellipsis (`… +N`). Only the slash palette advertises type-to-filter.

---

## R1 — Agent Workspace: compact roster with durable per-agent inspection

**Intent (Aiden, 2026-07-12):** subagents appear as clean *status rows* below the
spawn card and in a **collapsible agent roster pinned at the bottom**. The roster stays
compact by default and opens a focused, recorder-backed tool transcript on demand.

**Testable clauses**

1. **R1.1 — Collapsed by default.** When a session has spawned subagents, a single
   dim one-liner `▾ agents (<summary>)` renders below the composer, where
   `<summary>` counts only non-empty buckets (`N running`, `N done`, `N failed`).
   With two settled subagents it reads exactly `▾ agents (2 done)`.
2. **R1.2 — Expands in place to status rows.** Focusing the dropdown (Down-arrow from
   the composer bottom) expands it into one status row per subagent —
   `<glyph> <description> <provider/model · step count>` — capped by the
   `↑↓ select · enter open · m message · x cancel · esc collapse` hint. Rows are
   condensed status, never raw chat. Selection follows the visible window; Enter opens
   the recorder-backed agent workspace, `m` steers a still-running agent at a safe turn
   boundary, and `x` cancels only the selected live agent. Unavailable lifecycle actions
   produce an explicit notice rather than silently succeeding.
3. **R1.3 — Collapses back.** Esc collapses the dropdown back to
   the one-liner and returns focus to the composer; the app never exits behind the panel.
4. **R1.4 — Status rows carry no raw JSON.** No dropdown row contains a raw JSON
   fragment (see R2).
5. **R1.5 — Durable detail.** The focused viewer derives child cards from the same
   live-wins merge used by the roster: in-memory events override recorder JSONL, while a
   resumed session can still inspect disk-only agents. Empty agents say “No tool activity
   recorded”; long transcripts window within terminal height; Esc returns to the roster.

**Guarded by:** scenarios `two-subagents` (R1.1) and `agents-dropdown`
(R1.2/R1.3), invariants `two-subagents-in-dropdown`, `dropdown-expands`,
`dropdown-collapses`, and the global `no-raw-json` (R1.4). The **edge scenarios**
extend this under adverse conditions: `three-subagents-expand-collapse` drives 3
concurrent spawns and a full expand→collapse cycle MID-stream
(`three-concurrent-spawns`, `expand-collapse-midrun`); `cjk-emoji-subagents` proves
double-width CJK + astral-emoji descriptions render one row each
(`cjk-emoji-dropdown`); and `errored-subagent` proves a FAILED subagent surfaces
cleanly — failed bucket in the collapsed strip, `✗` glyph in the expanded row, and
the spawn card's inline error tail (`errored-subagent-surfaces`).

---

## R2 — Agent tool args and results are condensed like every other tool card

**Intent:** an agent's tool args and results are condensed exactly like every other
tool card. Raw JSON such as `{"description":` (claude-cli `Agent`/`Task` args) or
`[{"type":"text"` (Anthropic content-block results) must **never** appear on screen.

**Testable clauses**

1. **R2.1 — No canonical raw-JSON leak.** No frame or scrollback in any scenario
   contains `{"description":`, `[{"type":`, or `{"summary":`. The last is juno's own
   `spawn_subagent` result object (`{ summary, model }`), guarded so a regressed
   `{summary}` unwrap (`ToolCallCard.toDisplay`) can't leak a raw `{"summary":"done",…}`
   blob onto the spawn card. These are the canonical leak signatures the spec names; the
   harness asserts them globally.
2. **R2.2 — Non-agent tool cards communicate intent and outcome.** The default transcript
   uses calm semantic copy (`Reading src/app.tsx`, `Searching for “TODO”`, `Writing a.ts`,
   `Running tests`, `Calling brain.recall`) rather than provider function syntax. Settled
   lines add only facts present in the result (`12 matches`, `2 files · 1 updated`,
   `tests passed · exit 0 · 240ms`). Unknown tools keep a compact name/arg fallback and
   unknown result shapes never trigger guessed claims. Raw names, full args, stdout/results,
   errors, and diffs remain available in Ctrl+O detail. Subagent spawn calls remain owned by
   Agent Workspace and are never folded into generic tool-family presentation.

3. **R2.3 — Structured values never leak onto compact rows.** A `list_files` call
   renders as `Exploring .` (not `{"dir":"."}`) and its result renders as a count;
   a `write_file` call renders `Writing x.txt` (not `{"path":…}`). No `{"dir":` /
   `{"path":` appears on the transcript frame.

4. **R2.4 — Spawn cards condense their agent args _and results_.** A `spawn_subagent`
   / `Agent` / `Task` call's card renders a condensed one-liner (`spawn_subagent(summarize
   the repo)`), never a raw agent-arg object — no `spawn_subagent({"`, `Agent({"`, or
   `Task({"` on any frame, covering both juno's `{"task":…}` and claude-cli's
   `{"description":…}` arg shapes — **and** its result is condensed, never a raw Anthropic
   content-block (`[{"type":`) on the spawn-card line. This is a **hard** clause: it holds
   for args **and** results, on the spawn card exactly as everywhere else.

**Guarded by:** the global `no-raw-json` invariant (R2.1 **and** R2.3, every scenario),
which now owns spawn-card lines too — it matches `spawn_subagent({"` / `Agent({"` /
`Task({"` raw args and a `[{"type":` content-block result on **any** rendered line, spawn
card or otherwise — plus the `basic-exchange` invariant `tool-args-condensed` (R2.2). The
`two-subagents`, `agents-dropdown`, and `codex-parent-subagents` scenarios each drive a
real spawn card through it.

**Resolved (main landed the arg condenser + `{summary}`-result unwrap).** The spawn card
now reads `spawn_subagent(summarize the repo)  done · via claude cli` — no raw args, no raw
result. The `MULTI_SUBAGENT_SCRIPT` fixture (which deliberately emits BOTH juno's `{"task":`
and the real claude-cli `{"description":` arg shapes) and the `CODEX_SUBAGENT_SCRIPT` fixture
(a realistic `[{ type: 'text', text: 'done' }]` content-block result on parent-1) both render
clean. The former `spawn-card-args-condensed` **known-gap** invariant and the `no-raw-json`
spawn-card **exemption** have therefore been **retired**: `no-raw-json` now hard-guards
spawn-card lines directly (folding in the `spawn_subagent({"`/`Agent({"`/`Task({"` signatures
so juno's own `{"task":` shape is caught too), so any regression back to raw args or a
content-block result on a spawn card fails the run outright rather than being tolerated.

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
R4/R2.1 invariants, and the global `no-raw-json` guard — which now owns spawn-card lines —
over the `Task({"description":…}` args and the parent-1 content-block result. Because the
surface derives purely from `state.tools`,
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
history stays reachable by scrolling up. Erase-scrollback (`\x1b[3J`) must **never** be
emitted by *rendering* — the tall-output full-repaint that would destroy native
scrollback. The ONE sanctioned `\x1b[3J` is the deliberate transcript-replacement wipe
on clear / compact / resume (see R4.2): those replace `committed` wholesale and remount
`<Static>`, which reprints the entire transcript, so the stale copy above must be erased
first or it stacks a duplicate. That wipe is emitted through the single `wipeScrollback`
authority (`src/ui/wipeScrollback.ts`), never from the render path.

**Testable clauses**

1. **R4.1 — Composer pinned at bottom.** In the final frame of every scenario, the
   composer prompt (`❯` / placeholder) sits on the last content rows (a status line
   may sit just below it).
2. **R4.2 — Native scrollback preserved, never erased by rendering.** No scenario emits
   `\x1b[3J` through the render path (Ink's bounded-live-window guards keep the
   tall-output full-repaint unreachable). The sole sanctioned emitter is the deliberate
   transcript-replacement wipe (clear / compact / resume) via `wipeScrollback`; a scenario
   that exercises it asserts EXACTLY ONE wipe (see `compaction-dedupe` — zero means the
   wipe regressed away, more than one means a double-fire erased the freshly reprinted
   transcript), and every other scenario asserts zero. The opt-out is hard-constrained
   in the harness (`SKIPPABLE_CORE_INVARIANTS`): only `no-erase-scrollback` is skippable,
   and only by a scenario declaring the compensating exactly-once check
   (`sanctioned-wipe-emitted`) — an unknown or uncompensated skip throws at load/assembly,
   so no future scenario can silently exempt itself from any core invariant.
3. **R4.3 — Overflow flows into reachable scrollback.** When a turn overflows a small
   terminal, an early committed line (`line 1 of 40`) is **absent from the visible
   frame** but **present in the scrollback dump** — proof the top scrolled into native
   scrollback and is still reachable, while the newest line (`line 40 of 40`) and the
   composer stay on screen.

**Guarded by:** the global `composer-pinned-bottom` (R4.1) and `no-erase-scrollback`
(R4.2) invariants on every scenario, plus the `long-overflow` invariant
`history-in-native-scrollback` (R4.3). Two edge scenarios stress R4.2 hardest: the
`narrow-agents-streaming` scenario expands the agents dropdown over a long streaming
turn at an ultra-narrow **32 cols** (each panel row + chrome line must clip to one
terminal row, never wrapping into the erase branch — `narrow-dropdown-expands-streaming`),
and `three-subagents-expand-collapse` toggles the expanded 3-row panel mid-stream; both
must hold `no-erase-scrollback` while the tall live region and the expanded panel coexist.

**Constraint the harness respects.** `app.tsx` reserves `LIVE_TURN_CHROME_RESERVE`
(12) rows below the live turn; a viewport at or below that reserve cannot fit the
bounded live window and Ink falls back to the erase-scrollback full-repaint. The
`long-overflow` scenario therefore uses `rows: 16` — small enough to overflow ~2.5×
(exercising R4.3) yet above the reserve (the regime `tests/autoscroll.pty.test.ts`
proves safe at `rows: 24`). Sizing a scenario at/under the reserve is a harness
mis-configuration, not a UI regression.

---

## R5 — Concurrent tool calls render as ONE grouped, live unit; not a serial list of cards

**Intent (Aiden, verbatim):** a burst of parallel tool calls rendered "in series" —
`ToolSearch(…)`, then `✗ mcp__brain__recall(…)`, then `Grep(juno)`, `Glob({…})`,
`Grep(juno)`, `Read({…})` — each an independent card in stream order. "The way that the
tools load looks rudimentary… it just loads them in series… how could we make the agents
and tools look more professional?" Concurrent tools must present as one grouped unit in the
same visual language as the **agents dropdown** (spinner / `✓` / `✗` glyphs, dim status
rows, newest-row windowing), not N stream-order cards.

**What "concurrent" means here (from the runtime).** juno's reducer stamps each TOP-LEVEL
tool call with a `concurrencyGroupId` at dispatch: a call joins the batch of the earliest
sibling top-level call still **non-terminal** (`pending`/`running`) at that instant — they
are *in flight together* — else it opens its own batch. This is the honest signal on BOTH
runtime paths: the raw-API executor runs one assistant message's tool calls **sequentially**,
but they all land `pending` before any runs (so each later call sees the earlier ones still
non-terminal → one batch); the claude-cli stream lands parallel `tool_use`s `pending`
together, while a **sequential** round resolves before the next call's `tool-call` arrives
(→ distinct batches). A batch of **≥ 2** adjacent same-id top-level plain-tool cards
(subagent spawns are excluded — they keep their spawn-card + status-row surface) is a
concurrent group; a lone id stays a single card. The id freezes into `toolSnapshot` at
commit, so the committed render groups identically. The pure logic is `src/ui/toolGroups.ts`
(`planConcurrentToolGroups` + `summarizeToolGroup`); the presentation is
`src/ui/GroupedToolRows.tsx`, wired in `src/ui/Message.tsx:renderBlocks`.

**Testable clauses**

1. **R5.1 — Live groups render as ONE unit, with TRUTHFUL buckets.** While ≥ 1 member of a
   concurrent batch is non-terminal, the batch renders as a single **expanded** unit: a
   header `<spinner> N tools active · <buckets>` above one status row per member — `<glyph>
   semantic activity · <detail>` — where the glyph is a running **spinner** / `●`
   (queued) / `◌` (waiting on permission) / `✓` / `✗` and the detail is the elapsed clock
   (running), the condensed result tail (done), or the failure reason (error). NOT N
   independent cards. The header buckets are exactly `N running`, `N queued`,
   `N waiting on permission`, `N done`, `N failed` — non-zero only (the agents-strip
   summary idiom) and each counted **truthfully** by what the member is actually doing:
   a member issued with the batch but not yet executing is **queued**, never folded into
   "running" (the raw-API executor runs a batch sequentially, so mid-execution the state is
   1 running + N queued — a folded "N running" header would contradict the one spinner + N
   pending glyphs on the rows directly beneath it); and a member whose **permission prompt
   is open** presents as `waiting on permission` — its row renders the amber
   `◌ name(args) · waiting on permission` (the solo `ToolCallCard`'s honest state mapping,
   wave-1 item C) and it is never counted running or queued. A settled status always wins
   over a stale waiting flag. And when **nothing is executing** and the batch is blocked solely
   on the user's permission decision (0 running, 0 queued, ≥ 1 waiting on permission), the
   HEADER glyph itself is the static amber `◌`, not a spinner — a spinner would falsely imply
   work in flight (parity with `LiveTurn` / the solo card); any running or queued member (even
   alongside a failure) restores it.
2. **R5.2 — Condenses on completion.** Once every member has settled, the unit condenses to
   ONE committed line — `✓ N tools · <explicit aggregate facts>` (or `completed` when no
   additive facts exist) — instead of flooding scrollback with N
   full cards. On a **delegate-CLI backend** the line carries the same ` · via <x> cli` runtime
   tag the solo `ToolCallCard` appends (`via claude cli` / `via codex cli`; unmarked on the
   raw-API path) — the grouped form is not a place the runtime attribution goes silent. Full
   per-tool args + results stay reachable in the existing **Ctrl+O** tool-detail overlay (which
   already lists every session tool call); the grouped unit integrates with it rather than
   duplicating it. (Committed messages live in `<Static>` and are printed once, so a committed
   group is inherently non-interactive — Ctrl+O is the detail path, by construction.)
3. **R5.3 — A failure is surfaced with its reason on both forms.** A failed member shows a
   `✗ name(args) · <reason>` row in the expanded live group, and the condensed committed
   line reads `✗ N tools · M failed · <name>: <reason>` — the reason is NEVER dropped to a
   bare count that reads like a clean finish (mirrors R1's errored-subagent row).
4. **R5.4 — Single / sequential calls are unchanged.** A lone top-level call, or two calls
   where the first settled before the second was issued, each render as today's single
   condensed `ToolCallCard`. Grouping is for concurrency only (`basic-exchange`'s two
   sequential cards are untouched).
5. **R5.5 — The live group respects the scroll model.** Each member row is clipped to one
   terminal row in DISPLAY CELLS (never wrapped) and the expanded list windows to its newest
   rows (an `↑ N earlier` head), so the grouped unit stays within the live budget and never
   drives Ink's scrollback-erasing full-repaint (`no-erase-scrollback` holds). Condensed args
   keep the batch off the raw-JSON path (`no-raw-json` holds) — this also fixed the
   complaint's `Glob({…})` / `Read({…})` cards: `humanizeArgs` now condenses any tool's first
   string arg (a path/pattern/query), so claude-cli's PascalCase `Read`/`Glob`/`Edit`/`LS`
   render `Read(app.tsx)` / `Glob(src/**)`, never a raw `{"file_path":…}` blob.
6. **R5.6 — Transcript vertical rhythm is one-sided by design.** Exactly ONE blank line
   PRECEDES each top-level tool group when something already rendered above it — between
   consecutive top-level tool groups AND at a text→tool boundary — and there is NEVER a blank
   line AFTER a tool group, NEVER one before the FIRST block, and NEVER one between a tool group
   and prose that continues after it: prose butted directly against a tool reads as its
   continuation (the Claude-Code-minimal aesthetic). Nested/descendant cards carry NO inter-card
   gap. The rule is a PURE function of block ORDER + KIND — identical on the live (`tools` map)
   and committed (`toolSnapshot`) paths — so a turn's spacing is byte-identical live and
   committed and never reflows at the commit boundary (append-only, R4). A symmetric after-gap is
   deliberately REJECTED: it would inject extra `<Box height={1}>` rows into the live region,
   perturbing the measurement-truth height budget (`src/ui/liveWindow.ts` renderedRows/caps) and
   re-opening the R4.2 `no-erase-scrollback` edge on tall turns — a real regression risk for a
   purely cosmetic symmetry. Machine-checkable against a rendered frame: a top-level tool group is
   preceded by a blank line (once something rendered above it), and text immediately following a
   tool group has no blank line between. Encoded in `src/ui/Message.tsx:renderBlocks` (the
   grouped-anchor gap and the solo-tool gap, both guarded by `rendered.length > 0`).

**Guarded by:** the **`concurrent-tools`** scenario (a 3-tool burst whose third member is
GATED behind a mid-batch permission prompt) asserts the truthful-bucket live header
(`2 running, 1 waiting on permission`) + per-tool rows (`concurrent-tools-grouped`), the
gated member's amber `◌ … · waiting on permission` row with no folded "3 running" header
(`concurrent-tools-permission-honest`), the condensed committed line with no
running/waiting residue (`concurrent-tools-condense-on-completion`), and that same condensed
line carrying the runtime tag `· via claude cli` exactly like a solo card
(`concurrent-tools-condensed-via-cli`); the
**`concurrent-tools-failure`** scenario (one call fails mid-flight) asserts the `✗` reason
row in the expanded group (`concurrent-tools-failure-live-row`) and the condensed
`✗ N tools · M failed · name: reason` line (`concurrent-tools-failure-condensed`). Both hold
the global `no-erase-scrollback`, `composer-pinned-bottom`, and `no-raw-json` core
invariants. The grouping STATE machine (ids → rows) and the header/condensed summary —
including the sequential-execution pin (1 running + 2 pending must read `1 running, 2
queued`, never "3 running") and the permission-gated bucket — are additionally unit-tested
apart from any pty (`tests/toolGroups.test.ts`, `tests/groupedToolRows.test.tsx`), so the
seam is not pty-only.

---

## Machine-checkable invariants (summary)

| Invariant | Clause | Scope | Assertion |
| --- | --- | --- | --- |
| `no-erase-scrollback` | R4.2 | every scenario | `\x1b[3J` never in raw pty bytes |
| `composer-pinned-bottom` | R4.1 | every scenario | `❯`/placeholder on last content rows of final frame |
| `no-raw-json` | R2.1 / R2.3 | every scenario | no `spawn_subagent({"` / `Agent({"` / `Task({"` args, `{"description":`, `[{"type":`, or `{"summary":` result on **any** line (spawn card or otherwise) in any frame/scrollback |
| `status-mode-chrome` | (chrome) | every scenario | model chip present in final frame |
| `tool-args-condensed` | R2.2 | `basic-exchange` | `list_files(.)` shown; no `{"dir":`/`{"path":` |
| `history-in-native-scrollback` | R4.3 | `long-overflow` | early line in scrollback, off-screen; last line on-screen |
| `two-subagents-in-dropdown` | R1.1 | `two-subagents` | `▾ agents (2 done)` |
| `codex-parent-in-dropdown` | R3.1 | `codex-parent-subagents` | a codex-shaped `Task` parent surfaces `▾ agents (2 done)` |
| `overlay-opens` / `overlay-closes` | (ctrl+o) | `ctrl-o-overlay` | Ctrl+O opens the tool-detail overlay; Esc restores the composer |
| `chord-char-not-leaked-open` ⚠︎ | (ctrl+o) | `ctrl-o-overlay` | composer empty while overlay open (no `❯ o`) — **known gap** |
| `chord-char-cleared-after-close` | (ctrl+o) | `ctrl-o-overlay` | chord character is absent after close; any pre-existing draft is preserved |
| `dropdown-expands` / `dropdown-collapses` | R1.2/R1.3 | `agents-dropdown` | Down expands to status rows + hint; Esc collapses |
| `narrow-dropdown-expands-streaming` | R1.2/R4.2 | `narrow-agents-streaming` | dropdown expands to clipped one-row entries at 32 cols mid-stream |
| `cjk-emoji-dropdown` | R1.2/R2 | `cjk-emoji-subagents` | CJK + emoji descriptions render one row each; args condensed |
| `errored-subagent-surfaces` | R1.1/R1.2 | `errored-subagent` | failed bucket + `✗` expanded-row glyph + inline error tail, no raw JSON |
| `three-concurrent-spawns` | R1.1 | `three-subagents-expand-collapse` | `▾ agents (3 running)` for 3 concurrent spawns |
| `expand-collapse-midrun` | R1.2/R1.3 | `three-subagents-expand-collapse` | Down expands / Esc collapses the 3-row panel mid-stream |
| `concurrent-tools-grouped` | R5.1 | `concurrent-tools` | 3 concurrent tools render one live truthful-bucket header (`2 running, 1 waiting on permission`) + a row per tool |
| `concurrent-tools-permission-honest` | R5.1 | `concurrent-tools` | the mid-batch gated member shows the amber `◌ … · waiting on permission` row; header never claims "3 running" |
| `concurrent-tools-condense-on-completion` | R5.2 | `concurrent-tools` | on completion the group condenses to one `✓ N tools · …` committed line, no running/waiting residue |
| `concurrent-tools-condensed-via-cli` | R5.2 | `concurrent-tools` | the grouped condensed line carries the runtime tag `· via claude cli` (never `via codex cli`), parity with the solo card |
| `concurrent-tools-failure-live-row` | R5.3 | `concurrent-tools-failure` | the failed member shows `✗ name(args) · <reason>` in the expanded group |
| `concurrent-tools-failure-condensed` | R5.3 | `concurrent-tools-failure` | condensed `✗ N tools · M failed · name: reason` (reason never dropped) |
| `transcript-rhythm-one-sided` | R5.6 | (rendered frame) | one blank line precedes each top-level tool group, never after it; spacing byte-identical live vs committed (pure fn of block order+kind) |

⚠︎ = **known-gap** invariant (see below): currently VIOLATED, owned by another lane,
reported but tolerated.

## Known-gap invariants (the anti-theater escape hatch)

Some clauses name a real render wart whose FIX belongs to another lane — currently the
composer/app lane's Ctrl+O chord echo (`chord-char-not-leaked-open`). (R2.3's spawn-card
condenser gap was one of these until main landed the condenser + result unwrap; its marker
has since been retired and the clause promoted to the hard `no-raw-json` guard.) Rather
than silently green-lighting a live gap — the exact test-theater this loop exists to
prevent — it is marked `knownGap` and handled thus:

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
