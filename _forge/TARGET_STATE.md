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

### Capability
- 🟡 **P1 — Nested-subagent render.** ~40% done (additive `parentToolUseId?` seam +
  `ToolCallCard nested?` landed). Remaining: adapter un-drop of the 3 `parent_tool_use_id`
  guards, `Message.tsx` grouping, ~9 tests, live multi-subagent capture. CAPTURE-FIRST.
- ⬜ **P1 — Persistent cross-session memory ("the brain").** Agent reviews & persists
  memory at end of turn; injected into the volatile prompt tier. Substrate = gbrain/Supabase.
  This is the headline ambitious item — the literal "hermes-style brain." Its own design pass.
- ⬜ **P2 — Toolset grouping + dynamic availability.** Tools grouped into named sets with
  per-tool availability checks (TTL-cached); scope capabilities per mode.
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
