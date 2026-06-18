# Forge Backlog — derived from TARGET_STATE.md ranked order

Re-derived each cycle from the Constitution fit-score. This is the seeded ordering;
the Scout re-scores live every cycle and the Ledger removes done/rejected items.

Status: ⬜ open · 🟡 in-flight · ✅ merged · ⛔ parked-blocked · 🔝 escalated

| # | Item | Priority | Frozen-seam risk | Status | Notes |
|---|------|----------|------------------|--------|-------|
| 1 | Context compression / session continuation | P0 | low | ⬜ | highest robustness ROI |
| 2 | Iteration budget + mid-turn interrupt (`/steer`) | P0 | low | ⬜ | runaway guard + live control |
| 3 | Finish nested-subagent render | P1 | **additive-optional** (`parentToolUseId?`) | 🟡 ~40% | capture-first; only frozen-seam-adjacent item |
| 4 | Byte-stable system prompt + ephemeral injection | P1 | low | ⬜ | prompt-caching cost win |
| 5 | **Streaming health checks** | P1 | none | 🟡 dry-run | **calibration item (cycle 1)** |
| 6 | Persistent cross-session memory ("the brain") | P1 | medium | ⬜ | own multi-cycle design arc |

## Dry-run note (2026-06-18)
Cycle 1 forces item #5 (**Streaming health checks**) as the panel calibration run — smallest,
no frozen-seam touch. Self-chaining + cron stay OFF until the panel is validated. After the
dry run, normal ranking resumes (P0 items #1/#2 lead).
