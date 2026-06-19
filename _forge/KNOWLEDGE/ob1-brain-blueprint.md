# KNOWLEDGE — OB1 "Open Brain" as a blueprint for the persistent brain (P1)

Evaluated 2026-06-18. Repo: https://github.com/NateBJones-Projects/OB1 (FSL-1.1-MIT —
**internal use permitted**; only barred from shipping a competing product; auto-converts
to MIT 2y after each release). Mature-early: 3.8k★, multi-maintainer, last updated
2026-05-22; the brain integration ships 75 unit tests.

## Relevance: borrow-and-reimplement for the TARGET_STATE P1 "brain" — NOT adopt
OB1 is a **persistent shared-memory layer** (Supabase/Postgres + pgvector + MCP gateway),
not a harness. Nothing in it maps to the Juno harness, the Forge loop, or our triad/loopy
orchestration (it's deliberately single-agent-biased — philosophically counter to triad).
The ONE high-value asset is its memory design, and it aligns with us more than first
appears: our brain substrate is already **gbrain/Supabase**, exactly OB1's stack — so the
schema/patterns port cleanly even though Juno itself is TS/Ink local-first.

## What to mine (two paths) when Forge tackles the brain item
- `integrations/hermes-agent-memory` (Python) — a `MemoryProvider` that does **auto-recall
  before each turn** + **auto-writeback after**, with governance worth stealing wholesale:
  - memories land `pending_review` / `requires_user_confirmation` (a promotion gate);
  - `use_policy` separates `[instruction]` (binding) vs `[evidence]` (context);
  - recalled memory injected as a distinct `<ob1-context>` system-prompt block;
  - session-end extraction of structured findings (decisions/lessons/constraints) that
    **survive context compression** — pairs directly with our P0 context-compression item;
  - 7 tools: recall / writeback / search / report_usage / list_review_queue /
    review_memory / get_recall_trace; embeddings = `text-embedding-3-small`,
    `match_thoughts(threshold=0.7)`, recency-boosted.
  - sharp safety detail: **auto-disables writeback in subagent/cron contexts** (steal this).
- `schemas/agent-memory` (PLpgSQL) — provenance chains, use-policy, recall-trace,
  thought-audit, typed reasoning edges. A governed-memory data model, not a dumb log.

## Bonus (free, no license concern)
- `skills/n-agentic-harnesses` — a *design checklist* (not code) of 9 harness subsystems
  (tool boundaries, permission/approval, workflow durability, context assembly, memory,
  evals, operator visibility, multi-agent, deployment). Thesis: "products break at the
  harness layer, not the model." = a ready-made hardening checklist for Juno's roadmap;
  the evals/replay/acceptance framing is also an input to Forge's Assay/Panel design.

## Gotchas
- Their repo's **"Hermes" is an unrelated agent runtime** — do NOT confuse with our
  internal "Hermes-quality" North Star.
- Stack: the brain integration is Python 3.11 + Supabase Edge Functions — a
  re-implementation in TS (or a gbrain-side port), not a drop-in.
- Forge cross-link: the brain item is `[[TARGET_STATE]]` P1 ("its own multi-cycle design
  arc"); when scoped, this file is the starting design input. Do not auto-propose adopting
  OB1 wholesale — borrow patterns + schema only.
