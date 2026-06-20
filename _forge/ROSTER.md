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

> **Real cross-family judges (2026-06-20):** the panel no longer approximates with Sonnet.
> `shellJudge()` in `forge-cycle.js` runs a cheap Sonnet *courier* that shells out (the same
> `run_triad.sh` mechanism the writers use) so the ACTUAL judge is Codex 5.5 (`codex exec`,
> wrapped in `timeout 600`) or DeepSeek V4 Pro (OpenRouter, no-train `data_collection:"deny"`).
> **Lean HARD on Codex** — Codex budget is expendable, Anthropic/Opus is the scarce one — so
> Codex takes 3 of the always-on HARD judges (correctness, complexity, assumptions), OpenRouter
> takes 1 (scope) for genuine 3rd-family diversity, and Opus keeps only goal + the two
> conditional Juno-law judges + Arbiter. A CLI judge that returns empty/errored/non-JSON degrades
> (logged) to a real Sonnet verdict — never a silent PASS. GLM is NOT used (empty + burns retries).

| Judge | Model (backend) | Remit |
|---|---|---|
| Correctness Assay | **Codex 5.5** (`codex exec`) | correctness, edge cases, spec drift |
| Assumption Auditor | **Codex 5.5** (`codex exec`) | undeclared scope decisions / silent assumptions |
| Complexity Judge | **Codex 5.5** (`codex exec`) | minimal-solution senior-engineer inversion test |
| Scope Auditor | **DeepSeek V4 Pro** (OpenRouter, no-train) | changed-line traceability (3rd family for diversity) |
| Goal Verifier | Opus | `step -> verify` clauses pass; empty-diff guard |
| Architecture/Seam Assay | Opus (when core) | frozen-seam compliance, seam composition |
| UI-Cohesion Reviewer | Opus (when ui) | unified-palette / status-line / render cohesion |
| Arbiter | Opus | resolve splits; issue fix briefs; never overrides HARD-BLOCK |
| _Degrade fallback_ | real Sonnet verdict (logged) | any CLI judge empty/errored/non-JSON — never a silent PASS |

## Governor + safety roles (always on)

| Role | Mechanism | Remit |
|---|---|---|
| **Budget governor** | Workflow `budget` + rate detection | aggressive spend; back off on `five_hour` claude-cli rejections + reschedule; cap OpenRouter $/day |
| **Guardrails** | script | spend cap, failure-streak halt, `_forge/HALT` kill-switch check each cycle, no force-push/deploy/secrets |
| **Speculum** (observer) | `_forge/BOARD.md` | non-intervening status board: lanes (backlog / scoping / building / panel / merged / parked) |
