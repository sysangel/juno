# Forge Panel — the autonomous merge jury (replaces human review)

Grounded in opus-magnum (The Assay, "disagreement = stop sign", GOLD_HAT pre-filter,
empty-diff guard, triage activation) + karpathy-skills (four orthogonal judge lenses,
`step -> verify` contract, cite-the-diff verdicts). The panel is the gate that decides
whether an implemented feature merges. No human in the loop; humans are notified async.

## Stage 0 — GOLD_HAT pre-filter (binary, cheap, runs BEFORE the panel convenes)

A single fast agent (or pure script checks) hard-rejects clear failures so we never
spend panel tokens on them. ANY of these = instant reject to LEDGER, no panel:
- Objective gate not green (tsc != 0, vitest red, build red). Re-run by the orchestrator.
- **Empty-diff guard:** green tests on an unchanged tree cannot pass. Must be a real diff.
- **Frozen-seam violation:** edits an existing field/signature in `contracts.ts`/events/
  reducer that isn't additive-optional (Constitution I.3). -> escalate, not silent reject.
- Constitution FROZEN rule tripped (`--bare`, per-token billing path, permission floor
  broken, not on a `forge/*` branch).

## Stage 1 — Triage (which judges activate; opus-magnum five-axis pattern)

A triage agent reads the diff and tags it: architecture-touching? UI-visible? new-
capability vs refactor? test-bearing? Only judges whose remit is touched are convened
(a pure refactor with full coverage doesn't wake the Architecture judge). Reduces cost
and noise. Triage outputs the active-judge set + a one-line read per axis.

## Stage 2 — The Panel (each judge = an Assay instance)

Every judge is a FRESH-CONTEXT agent given ONLY: the diff, the feature spec/PRD, and the
implementer's `step -> verify` chain. Each MUST output: `verdict: PASS | BLOCK`,
`mode: HARD | ADVISORY` (declared explicitly — silent degradation to advisory is a
documented failure mode), and a **cited artifact** (file:line) for every finding. No
impressionistic verdicts.

| Judge | Lens (source) | Mode | Activates when |
|---|---|---|---|
| **Correctness Assay** | correctness, missed edge cases, spec drift (opus-magnum Assay) | HARD | always |
| **Assumption Auditor** | undeclared scope decisions / silent assumptions (karpathy) | HARD | always |
| **Complexity Judge** | minimal solution? "would a senior eng call this overcomplicated?" inversion test (karpathy) | HARD | always |
| **Scope Auditor** | every changed line traces to the spec; no orthogonal edits (karpathy traceability) | HARD | always |
| **Goal Verifier** | each `step -> verify` clause independently passes; empty-diff guard (karpathy + opus-magnum TDD) | HARD | always |
| **Architecture/Seam Assay** | frozen-seam compliance, composes with Juno seams (Constitution) | HARD | touches src/core, providers, tools, contracts |
| **UI-Cohesion Reviewer** | unified-palette single-front-door wiring, status line, render pipeline cohesion (Juno law) | HARD | UI-visible diff |

**Cross-family diversity (the triad principle, applied to judging).** Judges are spread
across model families so they catch different failure modes. The Correctness Assay in
particular runs on a DIFFERENT family than whoever implemented the unit (if implemented
by the Opus synthesizer, the Assay runs on GLM or Codex). Same brief, isolated context.

## Stage 3 — Merge rule ("disagreement = stop sign", NOT majority vote)

- **Unanimous HARD-PASS** across all ACTIVE HARD judges -> merge to the `forge/*` branch.
  ADVISORY findings are logged to LEDGER but do not block.
- **Any HARD-BLOCK** -> merge halts. The blocker (with its cited artifact) becomes a
  precise fix brief; the **overseer drives a bounded auto-fix** (triad, N<=3 attempts),
  re-gates, and re-convenes ONLY the judges that blocked. This is the autonomy: it
  fixes rather than waits.
- **Still HARD-BLOCKed after N** -> the item is PARKED to LEDGER as `deferred-blocked`
  with the reason, a `PushNotification` fires (async, non-blocking), and the loop moves
  to the NEXT backlog item. The loop never stalls on a human.
- **Split that an Arbiter can resolve** -> an Opus Arbiter reviews dissent and either
  (a) issues a targeted fix brief, or (b) downgrades only ADVISORY-level dissent. The
  Arbiter may NEVER override a HARD-BLOCK — only a fix clears it.

## Stage 4 — Audit trail (opus-magnum Quintessence)

Every judge appends `verdict + mode + reasoning + cited artifact` to
`cycle-N/PANEL_VERDICT.md`, and the cycle outcome (merged / parked-blocked / rejected +
why) appends to `LEDGER.md`. The Ledger is what prevents re-proposing killed ideas and
makes every autonomous decision auditable after the fact.

## Why this is safe to leave unattended

Unanimous-HARD-PASS is stricter than majority vote: a single dissent from any lens stops
a bad merge, and a self-improving loop is exactly where a bad merge compounds. GOLD_HAT +
empty-diff + frozen-seam tripwire catch the cheap failures before the panel; the bounded
fix loop + park-and-move keep it autonomous without ever stalling; the Ledger makes it
auditable and convergent.
