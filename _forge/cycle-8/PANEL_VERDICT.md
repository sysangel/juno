{
  "n": 8,
  "item": {
    "title": "Memory injection into turns (bridge MemoryStore → prompt)",
    "gap": "memory.ts (src/services/memory.ts) implements a full file-backed MemoryStore with get/set/list/delete and a 64 KiB eviction policy, but nothing reads from it and injects its content into the model's turns. The Hermes pattern is: at session start, read all entries and inject as a fenced `<memory>` block into the volatile tier of the user message (not the system prompt, to keep the byte-stable cache prefix intact). At turn end, the model can call a `remember` / `forget` tool to write back. This bridges the substrate (already done) to the model. Pre-requisite for the full brain (P1)."
  },
  "outcome": "parked",
  "kind": "blocked",
  "reason": "HARD-BLOCK persisted after 1 fix attempt(s): assumptions",
  "branch": "forge/memory-injection-into-turns-bridge-memor"
}
