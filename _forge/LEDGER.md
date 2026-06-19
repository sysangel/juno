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
<!-- appended by appendLedger() each cycle -->
