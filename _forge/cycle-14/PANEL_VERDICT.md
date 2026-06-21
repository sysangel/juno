{
  "n": 14,
  "item": {
    "title": "Explicit `remember_fact` / `recall_facts` tools (tool-driven memory)",
    "gap": "Wire the native MemoryStore + remember tool (P1, TARGET_STATE open gap — tool-driven half only). The parked cycle-8 item was specifically the auto-injection-into-prompt approach ('bridge MemoryStore → volatile tier'), which hard-blocked on assumptions. This candidate implements only the OTHER half of the same TARGET_STATE sentence: 'add a `remember` tool so the agent persists/recalls across turns.' Two tools backed by the existing, fully-tested MemoryStore at src/services/memory.ts: `remember_fact({key, value})` writes to the store; `recall_facts()` returns all entries as a JSON list. No system prompt architecture changes. No volatile-tier injection. The MemoryStore persists to ~/.config/juno/memory/memory.json across sessions. This is not a re-proposal of the parked item — it is a distinct mechanism (explicit tool calls vs. auto-injection)."
  },
  "outcome": "merged",
  "branch": "forge/explicit-remember-fact-recall-facts-tool",
  "writerPath": "triad",
  "verdicts": [
    {
      "judge": "correctness",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/providers/anthropicClient.ts:246; src/providers/anthropicClient.ts:264",
      "reason": "No hard correctness finding from the authoritative diff. The change applies the trailing breakpoint post-merge, handles empty messages, non-empty strings, non-empty arrays, and empty arrays per SEAMS, and leaves system construction untouched."
    },
    {
      "judge": "assumptions",
      "verdict": "BLOCK",
      "mode": "HARD",
      "citation": "src/tools/memoryTools.ts:57, src/tools/memoryTools.ts:103",
      "reason": "`recall_facts` declares that results are sorted by `updatedAt` then `key`, but the implementation only delegates to the injected `store.list()` and maps its returned order. From the provided diff/seams alone, that ordering guarantee for every `MemoryStore` implementation is not verifiable, so the tool-level sorted-output contract depends on an undeclared assumption."
    },
    {
      "judge": "complexity",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/tools/memoryTools.ts:123; src/tools/registry.ts:42; src/tools/registry.ts:45; src/cli.ts:89",
      "reason": "No complexity blocker. The solution stays minimal: one small tool factory over the existing MemoryStore, one optional registry dependency with ordering preserved after the subagent snapshot, and one CLI wiring point. It does not introduce new core seams or extra abstractions beyond the existing tool-factory pattern."
    },
    {
      "judge": "scope",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/tools/registry.ts:1 deletion (removal of old tool registration line) is a necessary adjustment to insert remember/forget tools after skills and before subagent block, directly traceable to Unit 2 spec.",
      "reason": "All 442 insertions and the single deletion in registry.ts align with the SEAMS spec: memory injection into user message, memory tools with risky permission, and clock wiring. The deletion is required to reposition the tool block as specified. No orthogonal changes; frozen seams untouched; all tests pass."
    },
    {
      "judge": "goal",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/tools/memoryTools.ts:124 (createMemoryTools returns [remember_fact, recall_facts]); src/tools/registry.ts:42-46 (memory pushed after subagent); src/cli.ts:88 (createMemoryStore wired); src/services/memory.ts:12-15,183 (MemoryStore + createInMemoryMemoryStore exist as the tools/tests consume them)",
      "reason": "Empty-diff guard: PASS — diff is non-empty (402 insertions across 4 files: new src/tools/memoryTools.ts, additive registry.ts, cli.ts wiring, new tests). Each step->verify clause was re-run from the worktree and confirmed, not taken on the implementer's word. Step 1: `npx tsc --noEmit` exits 0 (TSC_EXIT=0) — PASS. Step 2: `npx vitest run tests/memoryTools.test.ts` = 8/8 green in 1 file — PASS. Step 3: `npx vitest run` full suite = 445 passed across 28 files (445/445) — PASS, matching the claimed 437 baseline + 8 new. Spec conformance spot-checked against the DIFF: memory tools are pushed AFTER the subagent block (registry.ts) so they stay out of childTools; remember_fact pinned risk='risky', recall_facts risk='safe'; clock injected via deps.now (no Date.now in tool body); args narrowed with isRecord + non-empty string guard returning {ok:false,error:'invalid args'}; store errors wrapped, never thrown; bytesWritten via Buffer.byteLength utf8. The consumed memory.ts exports (MemoryStore.set/list, MemoryEntry, createInMemoryMemoryStore:183, createMemoryStore:148) all exist in-tree, so the tool/test references resolve. No frozen-seam edits in the diff (contracts.ts/events.ts/reducer.ts untouched). All clauses verifiable; no unverifiable claim forced a default-BLOCK."
    },
    {
      "judge": "architecture",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/tools/memoryTools.ts:34-46,99-124; src/tools/registry.ts:42-46,51; src/core/contracts.ts:100-105 (Tool iface); src/core/events.ts:8 (RiskLevel); src/services/memory.ts:6-19,148,183; src/cli.ts:87-94",
      "reason": "Frozen-seam compliance confirmed by inspection, not just the diff. The diff touches only src/cli.ts, src/tools/registry.ts, new src/tools/memoryTools.ts, and new tests/memoryTools.test.ts — the three frozen files (contracts.ts, events.ts, reducer.ts) are NOT in the diff and remain unmodified. Composition with Juno seams is clean: (1) both new tools implement the EXISTING Tool contract exactly — contracts.ts:100-105 defines `{ name; risk: RiskLevel; spec: ToolSpec; run(args,ctx): Promise<ToolResult> }` and memoryTools.ts:99-124 matches field-for-field with no added/altered fields; (2) risk values 'risky'/'safe' are valid members of the unchanged RiskLevel union (events.ts:8), so the existing permission policy (deny>allow>acceptEdits>risk) and tool-status lifecycle carry them with no new event/action/state — reducer untouched; (3) MemoryStore/MemoryEntry consumed as-is (memory.ts:12-19, set(key,value,updatedAt) clock injected, list() returns the same shape recall_facts maps); (4) registry edit is the additive optional-field pattern already used for skills/subagent (registry.ts:42-46) and BUILTIN_TOOL_SPECS = createDefaultTools() with no opts (registry.ts:51) so the 5-file-tool builtin set and all fixtures stay stable — independently asserted by the test and verified by full-suite green; (5) memory tools pushed AFTER the subagent block (registry.ts:42-46), so they are excluded from the childTools snapshot — depth-1 main-agent ownership of persisted state preserved (Constitution I.4); (6) store owns its own path + byte bound, ctx.cwd untouched — no workspace-jail interaction. Step->verify chain independently re-run and reproduced: tsc --noEmit = 0 errors; new suite 8/8; full suite 445/445 across 28 files. No frozen-contract drift, no seam violation, additive-only."
    },
    {
      "judge": "assumptions",
      "verdict": "PASS",
      "mode": "HARD",
      "citation": "src/tools/registry.ts:39",
      "reason": "No undeclared scope decision found in the provided diff/seams/verify chain. The only scope-sensitive decision, excluding memory tools from sub-agent childTools by appending them after spawn_subagent, is explicitly declared in SEAMS and implemented at registry push order."
    }
  ],
  "advisories": []
}
