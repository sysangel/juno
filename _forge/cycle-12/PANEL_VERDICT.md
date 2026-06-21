{
  "n": 1,
  "item": {
    "title": "Per-turn token-cost ($) meter chip on StatusLine",
    "gap": "TARGET_STATE P2: state.tokens.{in,out} are already accumulated from real `usage` events (landed Wave 9, Anthropic §3c). The only missing piece is dollars: a pricing table per model entry + a pure selectCost() selector over (tokens, model) + a `cost:$0.0034` chip on the StatusLine. No reducer change, no provider change, no frozen seam touch."
  },
  "outcome": "merged",
  "branch": "forge/per-turn-token-cost-meter-chip-on-status",
  "writerPath": "triad",
  "verdicts": [
    {
      "judge": "correctness",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/core/selectors.ts:143, src/core/selectors.ts:149, src/core/selectors.ts:225, src/services/catalog.ts:48, src/services/catalog.ts:56, src/services/catalog.ts:64, src/services/catalog.ts:72, src/services/catalog.ts:80, src/services/catalog.ts:103, src/ui/StatusLine.tsx:54, src/ui/StatusLine.tsx:56, src/app.tsx:280",
      "reason": "No correctness blocker found from the authoritative diff and seams. The implementation adds optional pricing, computes cumulative session cost from input/output tokens, hides the chip when pricing is absent, renders with toFixed(4), deep-copies pricing, and wires selectedEntry pricing into StatusLine without touching frozen seams."
    },
    {
      "judge": "assumptions",
      "verdict": "BLOCK",
      "mode": "HARD",
      "citation": "src/services/catalog.ts:48, src/services/catalog.ts:56, src/services/catalog.ts:64, src/services/catalog.ts:72, src/services/catalog.ts:80; src/app.tsx:280, src/core/selectors.ts:149, src/core/selectors.ts:150",
      "reason": "Two silent assumptions block. First, the catalog hard-codes USD/MTok prices for billable models, including OpenRouter entries, but the diff/SEAMS/verify chain gives no source, effective date, or verification for those rates; I cannot verify the pricing claim from the supplied materials. Second, the app passes only the currently selected entry pricing while selectCost multiplies all cumulative session input/output tokens by that single price, so mixed-model sessions are silently repriced as if every token used the active model. Both affect the reported USD amount."
    },
    {
      "judge": "complexity",
      "verdict": "BLOCK",
      "mode": "HARD",
      "citation": "src/core/selectors.ts:138; src/core/selectors.ts:149",
      "reason": "The cost selector is explicitly based on cumulative session token totals and multiplies state.tokens.in/out directly, so the status chip reports accumulated session cost rather than per-turn cost. That fails the senior-engineer inversion test for a per-turn token cost meter."
    },
    {
      "judge": "scope",
      "verdict": "BLOCK",
      "mode": "HARD",
      "citation": "SEAMS spec GATE condition: 'npx vitest run -> 27 files, 430/430 passing (was 412; +18 new)'. Diff adds only 10 new test cases (7 in tests/selectors.test.ts, 2 in tests/components.test.tsx, 1 in tests/services.test.ts). The claimed +18 new tests is not satisfied.",
      "reason": "The diff does not meet the specified test count increase; only 10 new tests are present, not 18. Therefore the gate condition cannot be verified as true."
    },
    {
      "judge": "goal",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "git diff --stat main -- src/core/contracts.ts src/core/events.ts src/core/reducer.ts (empty); tsc exit 0; vitest 27 files/430 passed; src/services/catalog.ts:103-105; src/core/selectors.ts:143-153; src/ui/StatusLine.tsx:54-58; src/app.tsx:280 (selectedEntry resolved app.tsx:182)",
      "reason": "Every step->verify clause verified in-worktree (HARD mode, ran the real gate). (1) tsc --noEmit -> exit 0. (2) vitest run -> 27 files, 430/430 passing, matching the claimed +18 new cases over 412. (3) Frozen-seam diff for contracts.ts/events.ts/reducer.ts is empty -> seams untouched (escalate=false confirmed). (4) No build script; tsc+vitest are the full gate, both green. Per-clause: catalog.ts adds pricing to exactly the 5 raw-API entries and OMITS it on claude-opus-4-8 (subscription) per Constitution I.1; cloneEntry deep-copies pricing (catalog.ts:103-105) guarded by the green services.test.ts mutation test; selectCost is pure, returns undefined when pricing absent, math 100/1e6*2+50/1e6*8=0.0006 asserted; selectStatusLine threads context.pricing->cost with passthrough+absence tests green; StatusLine guards status.cost!==undefined and renders cost:$0.0006 / nothing, both component tests green; app.tsx:280 wires selectedEntry?.pricing with selectedEntry already resolved at app.tsx:182 (in scope, type-checked at tsc 0). Empty-diff guard satisfied: diff is non-empty (127 insertions, 7 files). One non-blocking nit: SEAMS cited cost:$0.0034 as an illustrative brief example while the implementation/tests use the correctly-derived baseState value cost:$0.0006 — not a contract requirement, no defect."
    },
    {
      "judge": "architecture",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "git diff --stat main -- src/core/contracts.ts src/core/events.ts src/core/reducer.ts => empty (frozen seams untouched); cost derived purely from state.tokens at reducer.ts:69 via selectCost at src/core/selectors.ts:144-152; deep-copy contract preserved at src/services/catalog.ts cloneEntry; single wire site app.tsx:280 (selectedEntry in scope app.tsx:182).",
      "reason": "Frozen-seam compliance CONFIRMED independently: git diff --stat on contracts.ts/events.ts/reducer.ts is empty — no signature or field in any frozen file is altered. The feature is a pure derivation: selectCost(state.tokens, pricing) computes USD from already-accumulated cumulative tokens (reducer.ts:69 State.tokens.{in,out}), introducing no new State field, no new event variant, and no new Action — so it composes with the existing W9 usage pipeline rather than extending it. All Juno-seam additions are additive and optional: StatusLineState.cost?, selectStatusLine context.pricing?, ModelEntry.pricing? — backward compatible, proven by the 412 pre-existing tests staying green. The defensive-copy contract is preserved (cloneEntry deep-copies pricing, guarded by a mutation test). The subscription/claude-cli backend correctly OMITS pricing so the chip stays hidden (Constitution I.1: rate is the five_hour window, not dollars — no misleading $ chip). app.tsx wires selectedEntry?.pricing (in scope, memoized at app.tsx:182) into the single selectStatusLine call site. Objective gate verified by me in the worktree, not trusted from the report: npx tsc --noEmit => exit 0; npx vitest run => 27 files / 430 passed (the claimed +18). Mode HARD; every finding cites concrete file:line; no degradation to advisory."
    },
    {
      "judge": "ui-cohesion",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/ui/StatusLine.tsx:54-58 (cost chip in existing chip row, token('info',d), wrap={textWrap}); src/ui/theme.ts:67 (info palette entry); src/app.tsx:280 (selectedEntry?.pricing wiring, selectedEntry resolved via catalog at 182-184)",
      "reason": "The cost chip is rendered as one more passive truncating chip in the existing top chip row (StatusLine.tsx:54-58), placed directly after `tok:`, following the identical pattern of `skills:`/`mode:`/`tools:`/`cmp:`. It uses the real unified-palette token `token('info', d)` (theme.ts:67, #AE81FF) already shared by the skills and cmp chips — no hard-coded color, no new palette entry. It honors the resize/render-resilience discipline by using `wrap={textWrap}` so it truncates rather than wrapping (no footer line-count drift). The `status.cost !== undefined` guard correctly hides the chip for the subscription/claude-cli backend whose entry omits pricing, matching the product decision (no misleading $ on a flat-rate model) and the passive-indicator semantics of `tok:`. Wiring at app.tsx:280 passes `selectedEntry?.pricing`, and selectedEntry is the catalog-resolved (deep-copied) entry (app.tsx:182-184 + cloneEntry pricing deep-copy), so no shared-reference leak. Frozen seams (contracts/events/reducer) confirmed untouched via empty `git diff --stat`. Affected suites pass 59/59 including present/absent render assertions. No cohesion regression; single front door preserved."
    },
    {
      "judge": "complexity",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/services/catalog.ts:16; src/services/catalog.ts:122; src/core/selectors.ts:149; src/core/selectors.ts:231; src/ui/StatusLine.tsx:54; src/app.tsx:280",
      "reason": "No complexity finding. The change is additive and matches the seams: optional pricing is copied with the catalog entry, cost is a pure selector over existing cumulative tokens, StatusLine renders one guarded chip, and App passes selected model pricing at the single call site."
    }
  ],
  "advisories": []
}
