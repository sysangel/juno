# Forge Constitution — Juno's design law (the autonomous filter rubric)

Forge is Juno's autonomous self-improvement loop. This file is the **filter**: every
candidate feature is scored against it, and every implemented change is gated against
it before the panel may merge. A proposal that violates a FROZEN rule is auto-rejected
or escalated; a proposal that scrapes a PRINCIPLE loses fit-score. This document is
read at the start of every cycle. It is the one thing the loop may NOT rewrite without
a human (changing the constitution is a human-level gate).

## I. FROZEN invariants (violation = auto-reject or escalate-to-human)

1. **Subscription-driven.** The default backend is `claude-cli` on the Max 5x
   subscription (`claude -p` headless). NEVER per-token API billing for the primary
   loop. NEVER pass `--bare` (it disables OAuth). Rate is the `five_hour` window, not
   dollars.
2. **Render-only claude-cli.** On the claude-cli backend Juno RENDERS the CLI's
   autonomous run; it never re-executes or re-loops its tools. Terminal stopReason can
   never be `tool_use` on that backend (the sole interlock against a re-spawn loop).
3. **Frozen seams.** `src/core/contracts.ts`, the events schema, and the reducer are
   ADDITIVE-OPTIONAL only. Any change to an existing field/signature there is a
   human-level gate — Forge may add optional fields, never alter or remove.
4. **Permission floor.** `spawn_subagent` ALWAYS prompts (it is excluded from
   `ACCEPT_EDITS_TOOLS` by name, not by risk). Evaluate order deny > allow >
   acceptEdits > risk is law. No `bypassPermissions`-style mode. Nested subagents keep
   the `awaitPermission -> 'deny'` floor.
5. **Objective gate is non-negotiable.** Nothing merges without `tsc --noEmit` = 0,
   full `vitest` green, and `build` green — re-run by the orchestrator, never trusted
   from an agent's self-report.
6. **Privacy.** OpenRouter routing is NO-TRAIN only (`data_collection:"deny"`, no
   geographic allowlist). GLM 5.2 needs `max_tokens >= 48000`. Loopy teams = all-DeepSeek.
7. **Isolation.** Forge implements on a dedicated `forge/*` branch in a git worktree,
   never directly on the working/main branch.

## II. PRINCIPLES (graded, not binary — they drive fit-score)

- **UI = single front door.** The unified command palette is the one entryway; EVERY
  capability gets a real palette entry. No bolt-on UI. (Wave 5 law.) A feature that
  isn't coherently wired into palette / status line / render pipeline FAILS the
  UI-Cohesion gate even if it works.
- **Lean ethos.** Delegate expensive work to fresh-context subagents; the conductor
  holds distilled results, never raw bulk.
- **Simplicity is clarity.** Over-delete by default. Redesign before you preserve.
  Carry-forward is expensive. A feature that adds net complexity without proportional
  capability loses fit-score.
- **Capture-first for live seams.** Anything touching the live claude-cli stream
  (e.g. nested-subagent render) must be designed against a REAL captured stream, never
  fakes — fakes miss interleave/index-collision bugs (the Wave-2 failure mode).
- **Effort model.** medium | high | xhigh (default medium); cycle medium->high->xhigh.

## III. DEFERRED (do not propose unless the human re-opens scope)

- MCP support (XL; explicitly deferred).
- Hooks (security-negative surface; deferred until scoped).
- Multi-provider session migration (subscription-only for now).
- Multi-platform messaging gateways (Telegram/Discord/Slack) — out of scope; Juno is
  a terminal harness.

## IV. Fit-score rubric (0-5 each; the panel and the Scout both use this)

| Axis | 0 | 5 |
|---|---|---|
| **Constitution compliance** | violates a FROZEN rule | clean, additive |
| **Target-State value** | no gap closed | closes a high-priority North-Star gap |
| **UI cohesion** | bolt-on / no palette entry | fully unified front-door wiring |
| **Architectural fit** | fights Juno's design | composes with existing seams |
| **Simplicity** | net complexity, carry-forward | net-simpler or cleanly bounded |
| **Risk/size** | frozen-seam / unbounded | additive, bounded, gated |

A candidate must score >= 3 on every axis and >= 4 on Constitution+UI to enter the
implementable backlog. Anything scoring 0 on Constitution is auto-rejected to the Ledger.
