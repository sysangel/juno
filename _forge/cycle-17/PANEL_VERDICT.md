{
  "n": 17,
  "item": {
    "title": "Render latency reduction: batch tool-status and tool-call-delta dispatches",
    "gap": "Tool-call-delta events fire on every JSON character streamed; each fires a dispatch -> useReducer -> React re-render cycle. With long argument payloads (e.g. a write_file with a large file body) this produces hundreds of renders that stall the UI. The same 16ms batching that text-delta already has in useStreamingTurn (the existing `deltaBuffer` + `flushDelta` pattern) should be extended to tool-call-delta events. Tool-status events (running/result/error) are low-frequency and don't need batching, but the tool-call-delta stream is the bottleneck."
  },
  "outcome": "merged",
  "branch": "forge/render-latency-reduction-batch-tool-stat",
  "writerPath": "triad",
  "verdicts": [
    {
      "judge": "correctness",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/hooks/useStreamingTurn.ts:40, src/hooks/useStreamingTurn.ts:96, src/hooks/useStreamingTurn.ts:174, src/hooks/useStreamingTurn.ts:184, tests/streamingTurn.test.ts:482",
      "reason": "No correctness finding. The diff widens the buffered delta union to include tool-call-delta, routes it through the existing delta queue, branches coalescing by discriminant so tool-call-delta uses toolCallId/argsDelta while text/reasoning use id/delta, and adds coverage for interleaved tool-call deltas without cross-tool argsText bleed."
    },
    {
      "judge": "assumptions",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/hooks/useStreamingTurn.ts:42; src/hooks/useStreamingTurn.ts:96; src/hooks/useStreamingTurn.ts:175; tests/streamingTurn.test.ts:519",
      "reason": "No undeclared scope decision or silent assumption found from the authoritative diff/seams/verify chain. The implementation only widens batching to the declared tool-call-delta seam, keys coalescing by toolCallId for that variant, and the added test verifies final per-tool argsText without cross-tool bleed."
    },
    {
      "judge": "complexity",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/hooks/useStreamingTurn.ts:41-42, src/hooks/useStreamingTurn.ts:95-98, src/hooks/useStreamingTurn.ts:157-187, src/events.ts:39, src/events.ts:69-70, src/reducer.ts:31, src/reducer.ts:211",
      "reason": "Minimal local change: it only widens the existing delta batching seam to include the pre-existing tool-call-delta action, then adds type-specific coalescing keyed by toolCallId without touching frozen contracts/events/reducer seams. The implementation avoids a broader reducer or protocol rewrite, and the stated test targets the key inversion risk: interleaved deltas for different tool calls must not bleed across IDs."
    },
    {
      "judge": "scope",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "diff src/hooks/useStreamingTurn.ts:39-43 (SEAMS 2.1), :95-103 (SEAMS 2.2), :160-187 (SEAMS 2.3), tests/streamingTurn.test.ts:482-527 (SEAMS 4.3); all changes trace to the spec, no orthogonal edits, and the implementer's objective gate (tsc, vitest) passed.",
      "reason": "Every changed line implements the design described in the SEAMS document: widening the batched-action union, extending isDeltaAction, and branching coalesceDeltas keying per variant. The new test verifies the invariant. The implementation is bounded and does not touch any frozen seam. The diff is authoritative and matches the spec exactly."
    },
    {
      "judge": "goal",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/hooks/useStreamingTurn.ts:174-188 (coalesceDeltas variant-branched keying); useStreamingTurn.ts:268 (isDeltaAction routes tool-call-delta into buffered branch); useStreamingTurn.ts:279 (non-delta flush-first ordering); src/core/reducer.ts:205-212 (frozen, byte-identical argsText concat); tests/streamingTurn.test.ts:482-526 (interleaved-tool-call coalesce guard)",
      "reason": "Independently re-verified every step->verify clause from the diff + tree, not the implementer's word. CRITICAL keying (2.3): coalesceDeltas at useStreamingTurn.ts:174-188 branches on action.t==='tool-call-delta' and merges by toolCallId/argsDelta, only reading .id/.delta on the text/reasoning path — no cross-tool bleed; the new test (i) (lines 482-526) asserts tcA->{\\\"a\\\":1}, tcB->{\\\"b\\\":2} under tcA/tcB/tcA interleave and passes. 2.1/2.2 union+isDeltaAction widened so tool-call-delta routes into the 16ms buffered branch (line 268). 2.4 ordering preserved: non-delta path flushes before dispatchNow (line 279); adjacent-only merge keeps stream order. Frozen seams untouched — git diff --name-only for contracts.ts/events.ts/reducer.ts returned empty; reducer concat (205-212) makes coalescing byte-identical. Empty-diff guard: diff non-empty (2 files, +72/-3, matching reported diffstat). Objective gate re-run by me: npx tsc --noEmit exit 0; npx vitest run 449/449 passed across 28 files (streamingTurn.test.ts 9 tests incl. new (i)). No build script exists (typecheck+test is the gate) — confirmed. All clauses pass."
    }
  ],
  "advisories": []
}
