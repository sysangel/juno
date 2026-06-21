# Forge Ledger — durable audit trail of every cycle outcome

The Ledger is what keeps the loop convergent: it prevents re-proposing done/rejected
ideas (the Scout reads it every cycle) and makes every autonomous merge/park decision
auditable after the fact (PANEL.md Stage 4). Append-only; one row per cycle. Per-cycle
panel verdicts live in `cycle-<n>/PANEL_VERDICT.md`.

## Cycle outcomes

| cycle | item | outcome | branch | reason |
|-------|------|---------|--------|--------|
| 1 | Streaming health checks | escalated | - | frozen-seam change required:  |
| 2 | Streaming health checks | rejected | forge/streaming-health-checks | GOLD_HAT: FROZEN Constitution rule tripped: working tree is on branch `main`, not a `forge/*` branch (git branch --show-current = main). Add |
| 3 | Streaming health checks | merged | forge/streaming-health-checks |  |
| 4 | Context compression | merged | forge/context-compression |  |
| 5 | Iteration Budget + /steer Mid-Turn Inject | merged | forge/iteration-budget-steer-mid-turn-inject |  |
| 6 | ? | all-below-threshold | - |  |
| 1 | Session Resume + Palette Picker | merged | forge/session-resume-palette-picker |  |
| 7 | byte-stable prompt + ephemeral injection | merged | forge/byte-stable-prompt-ephemeral-injection |  |
| 8 | Memory injection into turns (bridge MemoryStore → prompt) | parked | forge/memory-injection-into-turns-bridge-memor | HARD-BLOCK persisted after 1 fix attempt(s): assumptions |
| 9 | Anthropic §3c trailing-message cache breakpoint | merged | forge/anthropic-3c-trailing-message-cache-brea |  |
| 10 | Session search / /find palette command | parked | forge/session-search-find-palette-command | HARD-BLOCK persisted after 3 fix attempt(s): correctness |
| 11 | Nested-subagent render completion | merged | forge/nested-subagent-render-completion |  |
| 1 | Per-turn token-cost ($) meter chip on StatusLine | merged | forge/per-turn-token-cost-meter-chip-on-status |  |
| 13 | Visual transcript section separators | merged | forge/visual-transcript-section-separators |  |
| 14 | Explicit `remember_fact` / `recall_facts` tools (tool-driven memory) | merged | forge/explicit-remember-fact-recall-facts-tool |  |
| 15 | Interactive ask_user_question tool + overlay picker | parked | forge/interactive-ask-user-question-tool-overl | HARD-BLOCK persisted after 3 fix attempt(s): assumptions |
<!-- appended by appendLedger() each cycle -->
