# Forge Target State — "Hermes-quality Juno" (the North Star)

The goal: Juno robust enough to match the quality of the Hermes Agent Console. This
file makes that measurable. Forge's job every cycle = shrink the GAP between Juno's
current state and this checklist. The backlog is derived from the open gaps below,
ranked by the Constitution fit-score. When all P0/P1 gaps are CLOSED, Forge parks.

Status legend: ✅ done · 🟡 partial/in-progress · ⬜ open gap · 🔒 deferred (Constitution III)

## Capability checklist (derived from the Hermes architecture analysis)

### Robustness (the difference between a demo and a harness that survives long runs)
- ⬜ **P0 — Context compression / session continuation.** Auto-summarize + rebuild
  session at a context threshold instead of failing near token limits. *Hermes: triggers
  ~50% context.* The single biggest robustness gap for autonomous/orchestration runs.
- ⬜ **P0 — Iteration budget + mid-turn interrupt (`/steer`).** Per-turn tool-call ceiling
  (Hermes default ~90) + inject guidance without restarting the turn. Runaway-loop guard
  + live control.
- ⬜ **P1 — Streaming health checks.** Stale-stream detection + read timeout so a hung
  `claude -p` is caught early instead of hanging the UI.
- ⬜ **P2 — Provider fallback chain.** Anthropic -> OpenRouter -> next with rate-limit
  tracking. (Gated: only if multi-provider becomes a goal; subscription-only today.)

### Performance / cost
- ⬜ **P1 — Byte-stable system prompt + ephemeral injection.** Build the prompt once;
  inject volatile data (memory, context) into the user message at API time to keep
  upstream prompt caching warm. ~2-3x cost/latency win on long turns. Pairs with claude-cli.
- ⬜ **P2 — Tool parallelization w/ conflict detection.** Read-only tools always parallel;
  writes only when paths don't overlap.
- ⬜ **P1 — Reduce tool & subagent render latency.** Tool-call and subagent output render
  noticeably slowly; cut render/update latency for snappier streaming without dropping frames.
- ⬜ **P2 — Per-turn token-cost ($) meter.** Real token `usage` is already mined into
  `state.tokens.{in,out}`; the only gap is dollars. Add catalog pricing + a pure `selectCost`
  selector + a StatusLine cost chip. No reducer/provider risk.

### Capability
- 🟡 **P1 — Nested-subagent render.** ~40% done (additive `parentToolUseId?` seam +
  `ToolCallCard nested?` landed). Remaining: adapter un-drop of the 3 `parent_tool_use_id`
  guards, `Message.tsx` grouping, ~9 tests, live multi-subagent capture. CAPTURE-FIRST.
- ⬜ **P1 — Wire the native MemoryStore into the prompt + `remember` tool.** Juno already
  has a byte-bounded JSON `MemoryStore` (`src/services/memory.ts`) wired to NOTHING. Fold it
  into the system prompt's volatile tier at `cli.ts` and add a `remember` tool so the agent
  persists/recalls across turns. NATIVE local store — Supabase is RETIRED, do NOT reintroduce
  it. The literal "hermes-style brain," scoped additive on existing seams.
- ⬜ **P2 — Toolset gating with memoized spec resolution.** Group tools into named sets with
  per-tool `check` availability fns (TTL-cached), resolved & memoized ONCE per session via a
  `getToolDefinitions` filter (Hermes pattern). Only relevant tools load -> smaller context.
- ⬜ **P1 — Restore interactive question-menu rendering.** AskUserQuestion-style selection
  menus fail to render in the TUI, breaking guided/clarifying prompts; restore reliable render
  + keyboard selection. Live UX breakage.
- ⬜ **P2 — Visually separate transcript sections.** Output reads as a uniform wall; add clear
  visual separation (rules / spacing / grouping) between message and tool-call sections so the
  session is scannable.
- ⬜ **P3 — Session persistence + resume (history store + search).** Audit/replay/resume
  across restarts.
- 🔒 **Hooks/plugins** (`pre_llm_call`, `post_tool_call`, …) — deferred per Constitution III.
- 🔒 **MCP support** — deferred per Constitution III.

### Quality bars (already strong — maintain, don't regress)
- ✅ Render resilience (Wave 5: width-threaded StatusLine + EffortBadge nowrap).
- ✅ Unified command palette as single front door (Wave 5).
- ✅ Permission policy default/acceptEdits + runtime enforcement (permmode-live, 2026-06-18).
- ✅ Effort control medium/high/xhigh.
- ✅ Subagents (depth-1) + skills (progressive disclosure).

## Ranked entry order (what Forge tackles first; re-derived each cycle from fit-score)

1. **Context compression (P0)** — highest robustness ROI, no frozen-seam touch likely.
2. **Iteration budget + interrupt (P0)** — small-medium, high control value.
3. **Finish nested-subagent render (P1)** — already in flight; capture-first; the only
   frozen-seam-adjacent item (additive-optional only).
4. **Prompt caching / ephemeral injection (P1)** — cost win, pairs with claude-cli.
5. **Streaming health checks (P1)** — small robustness hardening.
6. **Persistent brain (P1)** — ambitious; gets its own multi-cycle design arc.

## Done = North Star reached when

All P0 + P1 gaps ✅, each shipped through the full Forge pipeline (Constitution-clean,
objective-gate green, UI-Cohesion gate passed, panel FREEZE), with no Ledger regressions.
