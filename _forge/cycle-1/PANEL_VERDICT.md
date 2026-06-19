{
  "n": 1,
  "item": {
    "title": "Streaming health checks",
    "gap": "The `readLines()` async generator in `src/providers/claudeCliClient.ts` has no idle timeout. A hung `claude -p` subprocess (network stall, CLI freeze, OAuth redirect) blocks the UI forever — the `for await` loop never yields, no error event fires, the phase stays `streaming` indefinitely."
  },
  "outcome": "escalated",
  "kind": "escalate",
  "reason": "frozen-seam change required: ",
  "branch": null
}
