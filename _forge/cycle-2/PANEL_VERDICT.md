{
  "n": 2,
  "item": {
    "title": "Streaming health checks",
    "gap": "P1 TARGET_STATE gap: readLines() in claudeCliClient.ts iterates stdout with no idle deadline. A hung or stalled claude subprocess blocks the UI indefinitely — the for-await never resolves, the AbortController is the only escape but requires user action. Hermes fires stale-stream detection at 90s + a 60s read timeout. Previous cycle escalated because the proposed implementation tried to add a new AgentEvent type to events.ts (a FROZEN seam); a clean approach uses the existing 'error' event path with no schema changes."
  },
  "outcome": "rejected",
  "kind": "reject",
  "reason": "GOLD_HAT: FROZEN Constitution rule tripped: working tree is on branch `main`, not a `forge/*` branch (git branch --show-current = main). Additionally the diff is not applied to the tree — git status shows only _forge/* modified, and grep for idleTimeoutMs|StreamStallError in src/providers/claudeCliClient.ts returns zero matches, so the claimed green gate cannot be verified against this diff (empty-diff / unchanged-tree risk on the relevant file). The diff itself is otherwise clean and additive-optional (new optional ClaudeCliDeps fields idleTimeoutMs/setTimer/clearTimer, new StreamStallError class, readLines watchdog; no contracts.ts/events/reducer frozen-seam touch, no per-token billing, no --bare, no permission-floor change), but the non-forge branch is a hard reject on its own.",
  "branch": "forge/streaming-health-checks"
}
