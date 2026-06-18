# Forge Ledger — durable audit trail of every cycle outcome

The Ledger is what keeps the loop convergent: it prevents re-proposing done/rejected
ideas (the Scout reads it every cycle) and makes every autonomous merge/park decision
auditable after the fact (PANEL.md Stage 4). Append-only; one row per cycle. Per-cycle
panel verdicts live in `cycle-<n>/PANEL_VERDICT.md`.

## Cycle outcomes

| cycle | item | outcome | branch | reason |
|-------|------|---------|--------|--------|
<!-- appended by appendLedger() each cycle -->
