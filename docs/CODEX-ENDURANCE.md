# Codex CLI endurance certification

Juno's Codex CLI backend is deterministically certified for long-running turns
without requiring a Codex installation, network access, or credentials. The tests
inject a fake child process, scheduler, wall clock, and monotonic clock; the HTTP
bridge integration uses only the in-process MCP server.

## Timeout model

The stdout transport has two independent progress guards:

- `JUNO_CODEX_IDLE_TIMEOUT_MS` (default `180000`) is reset by every stdout
  chunk. It detects a completely silent stream between Codex items.
- `JUNO_CODEX_STALE_STREAM_MS` (default `300000`) is reset only by a parsed,
  non-empty NDJSON event. It detects whitespace or garbage keepalive traffic that
  is not real progress.

Only positive integer millisecond values are accepted. Invalid values fall back to
the defaults. Dependency-injected values take precedence over environment values
in tests and embedded clients.

Both guards are re-armed while a Codex item is active. `codex exec --json` is
item-granular, so command execution, file changes, MCP calls, and reasoning can be
legitimately silent between `item.started` and `item.completed`. The guards are
also re-armed while the in-process subagent bridge is active and during its short
response-transit grace period. The bridge pins Codex's own MCP call timeout to
`3600` seconds.

A wall-clock jump without a matching monotonic-clock jump is treated as host
sleep/wake, not a provider stall. The in-flight read is preserved and both guards
are re-armed. A real stall, where both clocks advance together, still terminates
the child and produces a retryable `timeout` envelope.

After child exit, Juno disables the progress guards and drains stdout briefly
(default `200ms`) so buffered terminal events can arrive. If a descendant inherited
stdout and keeps it open, the drain window bounds the wait and the original exit
code, signal, and bounded stderr tail are surfaced. When stdout closes before the
exit event, Juno waits up to `2000ms` for the exit status.

These last two bounds are dependency-injection seams (`postExitDrainMs` and
`exitWaitMs`), not public environment knobs.

## Deterministic certification matrix

| Behavior | Gate |
| --- | --- |
| Long silent command item | `codexCliClient.test.ts` — “does NOT reap a child while a tool ITEM is in flight” |
| Long silent reasoning item | `codexCliClient.test.ts` — “does NOT reap a child during a long silent reasoning ITEM” |
| Subagent bridge activity and response grace | `codexCliBridge.integration.test.ts` — “a fired idle guard is IGNORED during a spawn…” |
| Host sleep/wake and genuine-stall control | `codexCliClient.test.ts` — the two `(sleep)` cases |
| Child crash with inherited stdout | `codexCliClient.test.ts` — “surfaces a dead child holding stdout open…” |
| Resumed multi-turn thread and invalidation | `codexCliClient.test.ts` — `session reuse (exec resume closure)` |
| Context overflow and compaction interaction | stderr-only overflow classification in `codexCliClient.test.ts`, plus the one-shot reactive recovery gates in `coordinator.test.ts` |

The provider boundary preserves a context-overflow classification even when Codex
reports it only on stderr and exits nonzero. This is required for the turn runner's
bounded compact-and-retry path; all other unrecognized nonzero exits remain
`child-exit` failures.

## Certification boundary

The deterministic suite certifies Juno's lifecycle, timeout, event translation,
bridge, resume, and recovery behavior. It does not certify a particular Codex CLI
release, OpenAI service availability, OAuth state, model latency, OS signal delivery,
or the duration of an individual Codex-built-in command. Active items intentionally
have no Juno hard deadline: killing a healthy, silent command or reasoning item would
break long-session correctness. Cancellation remains available through the turn's
abort signal, and Codex or the invoked tool remains responsible for any item-specific
deadline.

The tested argv surface targets Codex CLI `0.144.x`. Re-certify the live argv and
NDJSON schema when upgrading that dependency; the regular suite remains the
credential-free regression gate.
