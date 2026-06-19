# Forge Roster — role -> model tier -> remit (agent-selection registry)

The loop selects agents from this table per phase. Model tiers: Opus = judgment/synthesis/
architecture; Sonnet = fast research/triage (Fable when available); GLM 5.2 + Codex 5.5 =
cross-family writers/judges via `run_triad.sh` (different families = the diversity that
makes synthesis and the panel worth it). Prompt style (karpathy): open with a compressed
axiom, expand in bullets, demand cited-artifact output.

> **Writer-B note (2026-06-18):** the OpenRouter writer is **DeepSeek V4 Pro**, not GLM 5.2.
> GLM 5.2 is a reasoning model — slow, and in the cycle-2 dry run it returned empty content and
> burned run_triad's 5×600s retry loop. DeepSeek V4 Pro (the house fast coder, no-train-verified)
> is non-reasoning and reliable; Codex 5.5 stays Writer A, so OpenAI×DeepSeek cross-family holds.
> Wired as `OR_WRITER` in `forge-cycle.js` (overrides run_triad's `OR_MODEL` default).

## Build roles (Loop A Scout + Loop B Forge)

| Role | Model | Remit | Prompt axiom |
|---|---|---|---|
| **Ouroboros** (loop orchestrator) | script + Opus conductor | pull top unblocked backlog item; AFK vs escalate; drive the cycle | "Advance the Target State by exactly one vetted unit; never stall." |
| **Scout / Researcher** | Sonnet (fast) | read Hermes/Juno code + web docs + KNOWLEDGE; surface candidates | "Ground every claim in a source; distill, never dump." |
| **Fit-Scorer / Critic** | Opus | score candidates on the Constitution 6-axis rubric; rank backlog | "Reject ambition that fights the design; >=3 every axis, >=4 Constitution+UI." |
| **Grill** | Opus | interrogate ambiguous spec; auto-answer from Constitution/Target-State where possible | "Resolve intent before cost is sunk; one question at a time." |
| **Architect / Scoper** | Opus | turn the backlog item into a pinned `SEAMS_*.md` (frozen seams first) | "Pin the seams before fanning out; a bad seam poisons every unit." |
| **Writers (triad)** | DeepSeek V4 Pro (`deepseek/deepseek-v4-pro`) + Codex 5.5 | draft the unit independently, isolated, different families | (per `triad` brief contract) |
| **Synthesizer** | Opus | merge best-of-both into the accepted artifact | "Take the stronger half of each; return lean." |
| **Alembic** (executor) | Opus + worktree | apply on a `forge/*` branch in an isolated git worktree; produce a reviewable diff | "Isolated context, reviewable diff, nothing orthogonal." |

## Panel roles (Loop B gate — see PANEL.md; each = a fresh-context Assay)

| Judge | Model (cross-family) | Remit |
|---|---|---|
| Correctness Assay | GLM or Codex (NOT the implementer's family) | correctness, edge cases, spec drift |
| Assumption Auditor | Opus | undeclared scope decisions |
| Complexity Judge | Codex | minimal-solution inversion test |
| Scope Auditor | GLM | changed-line traceability |
| Goal Verifier | Opus | `step -> verify` clauses pass; empty-diff guard |
| Architecture/Seam Assay | Opus | frozen-seam compliance, seam composition |
| UI-Cohesion Reviewer | Opus | unified-palette / status-line / render cohesion |
| Arbiter | Opus | resolve splits; issue fix briefs; never overrides HARD-BLOCK |

## Governor + safety roles (always on)

| Role | Mechanism | Remit |
|---|---|---|
| **Budget governor** | Workflow `budget` + rate detection | aggressive spend; back off on `five_hour` claude-cli rejections + reschedule; cap OpenRouter $/day |
| **Guardrails** | script | spend cap, failure-streak halt, `_forge/HALT` kill-switch check each cycle, no force-push/deploy/secrets |
| **Speculum** (observer) | `_forge/BOARD.md` | non-intervening status board: lanes (backlog / scoping / building / panel / merged / parked) |
