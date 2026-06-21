# Forge Board — live status (Speculum / non-intervening observer)

Lanes track each item's position in the pipeline. Updated by `appendLedger()` at the
end of each cycle. This board never gates anything — it is read-only situational
awareness (ROSTER.md Speculum role).

## backlog
- Persistent brain (P1)

## scoping
_(none)_

## building
_(none)_

## panel
_(none)_

## escalated
_(none)_

## rejected
_(none)_

## merged
- Explicit `remember_fact` / `recall_facts` tools (tool-driven memory) — cycle 14; forge/explicit-remember-fact-recall-facts-tool
- Visual transcript section separators (P2) — cycle 13; forge/visual-transcript-section-separators
- Per-turn token-cost ($) meter chip on StatusLine — cycle 1; forge/per-turn-token-cost-meter-chip-on-status
- Nested-subagent render completion (P1) — cycle 11; forge/nested-subagent-render-completion
- Streaming health checks (P1) — cycle 3; forge/streaming-health-checks
- Context compression (P0) — cycle 4; forge/context-compression
- Iteration Budget + /steer Mid-Turn Inject (P0) — cycle 5; forge/iteration-budget-steer-mid-turn-inject
- Session Resume + Palette Picker (P3) — cycle 1; forge/session-resume-palette-picker
- Byte-stable prompt + ephemeral injection (P1) — cycle 7; forge/byte-stable-prompt-ephemeral-injection
- Anthropic §3c trailing-message cache breakpoint — cycle 9; forge/anthropic-3c-trailing-message-cache-brea

## all-below-threshold
- ? — cycle 6

## parked
- Interactive ask_user_question tool + overlay picker — cycle 15; forge/interactive-ask-user-question-tool-overl
- Memory injection into turns (bridge MemoryStore → prompt) — cycle 8; forge/memory-injection-into-turns-bridge-memor
- Session search / /find palette command — cycle 10; forge/session-search-find-palette-command

---
_Last update: 2026-06-21 (cycle 15 audit)._
