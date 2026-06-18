# SEAMS_W4 — Wave 4 pinned seams & build plan

**Status:** PLAN (no code yet). Scope locked 2026-06-17. Authored from the Wave-4 scoping pass (workflow `wa2ackjds`, 16 agents, every feature adversarially verified against the real files; load-bearing pins re-spot-checked by the conductor).
**Gate baseline (live-confirmed 2026-06-17):** `cd C:/Users/Core/src/juno && npx tsc --noEmit && npx vitest run` → tsc 0 errors, **vitest 269/269**.
**Green snapshot:** `_orchestration/wave3-green-snapshot-20260617/` (src 48 files + tests 18 + docs + config). This is the rollback net; the older `wave4-baseline-backup/` predates Wave 3 and is NOT current — do not use it.

> Companion to `SEAMS_W3.md`. Same discipline: pin the seams before building, additive-only on the frozen seam, the gate is the backstop, live-verify anything that touches the `claude -p` stream.

---

## 1. Locked scope (user decisions, 2026-06-17)

**IN — Wave 4 = three units, in this order:**
1. **Permission-mode parity (lean subset)** — `default` + `acceptEdits` only. `bypassPermissions` **CUT**. Rules = **deny + allow only** (no `ask`). Mode is **config-only** (no session toggle / no reducer event). **Suppressed on claude-cli** (mode is raw-API-only; no `--permission-mode` pass-through).
2. **Unit 3 — nested subagent activity render on the claude-cli backend** (the Wave-3 deferral). Capture a live multi-subagent stream FIRST. Option A (child tool cards nested, child text/reasoning dropped). The ONLY frozen-seam author in the whole wave.
3. **Managed Agents** — decision doc (**NO-GO** on the hosted Anthropic Managed Agents API) **+** the additive frontmatter slice (`disallowedTools`/`maxTurns`/`skills`/`effort` + an `/agents` chip).

**DEFER (recorded in §8, not built this wave):** MCP (XL), Hooks (security-negative), `bypassPermissions`, claude-cli `--permission-mode` pass-through, `ask` rules, per-agent `permissionMode` honoring.

**Why the lean permission-mode subset matters:** the scoping verifier flagged `permission-mode` `needs-revision` for three code-grounded reasons — all three are dissolved by the locked decisions:
- Cutting `ask` removes a net-new `StoredDecision` variant + new `evaluate` branch (the rule store `policy.ts:21` has no decision that yields `prompt` on match).
- Cutting pass-through + suppressing on claude-cli removes the additive-optional `permissionMode?` on the **frozen** `TurnInput` (`contracts.ts`) plus its 4-file thread (`useStreamingTurn` input literal + dep array, `AppDeps`, `app.tsx`).
- Config-only removes session-state/reducer cost.
→ **Net: locked permission-mode touches NO frozen seam and is fully fake-testable. Unit 3 becomes the sole frozen-seam change in all of Wave 4.**

---

## 2. Standing constraints (do not violate)

- **FROZEN seam = `src/core/{events.ts, reducer.ts, contracts.ts}`.** Changes must be **additive-only** (new optional fields / new variants), never breaking. `eventToAction` (`events.ts`, exhaustive, no `default`) and the reducer Action union will fail `tsc` if a variant is under-wired — that's a *loud* gate-caught failure, not a silent one.
- **THE GATE:** `npx tsc --noEmit && npx vitest run` stays tsc-0 + all-green. Tests deterministic: **no live network, no live `claude` subprocess in vitest** — inject fakes.
- **RENDER-ONLY SPLIT:** claude-cli runs subagents + auto-discovers skills/agents/MCP/hooks/permission-modes **natively**. juno never re-implements those on that backend, never passes `--agents`, suppresses its own systemPrompt there. The raw-API backends get juno's own ports.
- **tsconfig:** `strict:true`, but `exactOptionalPropertyTypes` OFF and `noUncheckedIndexedAccess` OFF (passing `undefined` to optional props is fine; `lines[i]` is `string`).
- **No git locally** → single-implementer build phases + the gate as backstop; rollback = the `_orchestration/` snapshot.
- **Live-verify pattern:** tiny `_tmp_*.ts` importing the real factories, `npx tsx _tmp_*.ts < /dev/null`, then delete. `claude.exe` at `C:\Users\Core\.local\bin\claude.exe` (on PATH); headless spawn sets child stdin to ignore.

---

## 3. Build order & dependency map

| # | Unit | Effort | Frozen seam? | Live-verify? | Why this slot |
|---|------|--------|--------------|--------------|----------------|
| 1 | Permission-mode (subset) | S / low-M | **No** | No | Cheapest high-value win; settles the policy/executor gate shape before anything else touches it; fully deterministic. |
| 2 | Unit 3 (nested render) | L | **Yes** (additive `parentToolUseId?`) | **Yes (mandatory)** | Owns + lands the sole frozen-seam field first; the one item fakes can't prove → capture-first. |
| 3 | Managed Agents (doc + slice) | S doc / S-M slice | No (slice) | No (slice) | Independent additive slice; its *nested-render* piece folds into Unit 3 (shares the same `parentToolUseId?`), so Unit 3 lands first. |

**Each unit ends green** (`tsc` + `vitest`) before the next begins. Unit 2 requires the live capture/verify *in addition* to the gate.

---

## 4. Unit 1 — Permission-mode parity (lean subset)

**Locked scope:** modes `default` + `acceptEdits` (bypass CUT); deny+allow rules (no `ask`); config-only; suppress on claude-cli. Raw-API-only behavior; **no frozen-seam touch**.

### Seams (all juno-local)
| File:line | Change | Frozen? |
|---|---|---|
| `src/permissions/policy.ts` (`PermissionPolicyOptions` ~15; `evaluate` returns; `autoAllowSafe` branch `:73`; rule store `:21,:26`) | Add `mode?: 'default'\|'acceptEdits'` + seeded `allow`/`deny` rules to the juno-local options. Add the `acceptEdits` branch **before** the risk switch. `evaluate` keeps returning ONLY the existing 3 values (`auto-allow`/`auto-deny`/`prompt`). | No |
| `src/permissions/patterns.ts` (salient key `:48-62`, path/dir-only) | No change needed — `allow`/`deny` glob matching works as-is via `matchesPattern`. (Salient is path/dir-only; fine for the file-tool allow/deny rules we seed. Richer salients deferred with MCP.) | No |
| `src/services/config.ts` (interface, `DEFAULT_SETTINGS`, `parseSettings`, `mergeSettings`, `applyEnvOverrides` ~178-205) | Add `permissionMode` enum + `permissions: { allow: string[]; deny: string[] }` to Settings. **5-touch**, incl. a NEW string-allowlist guard in `applyEnvOverrides` for `JUNO_PERMISSION_MODE` (the env path has no enum-validating template today — a bad value would otherwise poison the mode). | No |
| `src/cli.ts:63` (`createPermissionPolicy({ autoAllowSafe: true })`) | Pass `mode` + seeded `allow`/`deny` into the single shared instance. One instance flows to both the executor and `SubagentDeps.policy` (`cli.ts:82` → `subagentTool.ts:39,166-175`). | No |
| `src/providers/claudeCliClient.ts` (`buildArgs` ~265-280) | **No change** (suppress stance). Mode is raw-API-only; document it. | No |
| `src/core/selectors.ts` + `src/ui/StatusLine.tsx` (chip ~34-36) | OPTIONAL static `mode:<m>` chip via `selectStatusLine` context (mirrors the `skills:N` chip). **No reducer touch** (config-only mode is static). | No |

### Mandatory correctness invariants (verifier-confirmed)
- **acceptEdits MUST be an explicit `{ write_file, edit_file }` name allow-set, checked BEFORE the risk switch.** `write_file`/`edit_file` are `risk:'risky'` (`fileTools.ts:297,329`) and **so is `spawn_subagent`** (`subagentTool.ts:107`). A naive "acceptEdits = auto-allow risky" would silently auto-allow `spawn_subagent` → an unattended nested turn. The allow-set is the only correct mechanism.
- **deny-wins precedence**, ahead of any mode auto-allow and ahead of `acceptEdits`. Seeded deny rules must still win under `acceptEdits`.
- Seeded `allow`/`deny` feed the SAME matcher as remembered always-allow patterns (the existing `#rules` map, `policy.ts:26`); deny-first precedence holds across seeded + remembered.

### Build steps
1. Pin the acceptEdits allow-set + the config schema shape (enum + `allow`/`deny` lists, juno's existing `name:path` glob grammar — NOT Claude Code's `Tool(arg)` grammar).
2. Extend `PermissionPolicyOptions` with `mode` + seeded rules; add the `acceptEdits` allow-set branch before the risk switch; keep `evaluate` to the 3 returns.
3. Thread `allow`/`deny` seeding through the existing `#rules` path; assert deny-first precedence across seeded + remembered.
4. Add the config fields (interface, defaults, parse-with-enum-whitelist, merge, env-override-with-new-string-guard); wire into the single `createPermissionPolicy(...)` at `cli.ts:63`.
5. (Optional) static `mode:<m>` chip.
6. Vitest: `default` unchanged; `acceptEdits` auto-allows `write_file`/`edit_file` but STILL prompts `spawn_subagent`; deny rule wins under `acceptEdits`; allow/deny precedence (deny > allow > risk-fallback); subagent inherits the mode via the shared instance.
7. Gate green. (No live-verify — suppress stance means no claude-cli behavior change.)

### Definition of done
tsc-0 + vitest green with the above coverage; no frozen-seam edit; acceptEdits provably does NOT auto-allow `spawn_subagent`.

---

## 5. Unit 2 — Unit 3: nested subagent render on claude-cli

**Locked scope:** un-drop + ATTRIBUTE the CLI's native subagent activity; render child **tool cards** nested under the parent. **Option A: drop child text/reasoning** (the parent's summarized answer stays authoritative). Render-and-attribution ONLY — juno never re-executes the CLI's tools. **Capture the live stream FIRST.**

### Seams
| File:line | Change | Frozen? |
|---|---|---|
| `src/core/events.ts` (variants; `eventToAction` `:59-86` exhaustive, no `default`) | Add optional `parentToolUseId?: string` to the tool-call, tool-call-delta, tool-status (and, only if ever surfacing child text, text/reasoning-delta) variants. Thread through each `eventToAction` case **only when you choose to propagate it** (adding an optional field to existing variants compiles WITHOUT an `eventToAction` edit until you flow it). | **Yes** (additive) |
| `src/core/reducer.ts` (`Block` tool variant `:17`; tool filing; `snapshotTools` `:301-310`; commit `:234`) | Add `parentToolUseId?` to the matching Action variants + to `ToolState` (carries through `snapshotTools` into `toolSnapshot`). Reducer keys `state.tools` by the globally-unique `tool_use_id` string (`reducer.ts:55,157,174`) so the **reducer never collides** — the linkage is just an extra optional field. Additive-only. | **Yes** (additive) |
| `src/core/contracts.ts` | **No change** (verified: `ModelClient.streamTurn`/`TurnInput`/`Tool`/`ToolExecutor` none need the field). | (frozen, untouched) |
| `src/providers/claudeCliClient.ts` (guards `:154,:173,:193`; `Map<number,ToolAccumulator>` `:109`; block-mode `let index = toolCalls.size` `:334`; emits stamp `id: input.id` `:344,349,358,413,418`; `cliStopReason` `:542-558` (re-EXECUTE warning comment `:533-541`)) | Un-drop the 3 guards; **partition the accumulators by parent id** so child `index:0` can't overwrite parent `index:0`. MUST cover BOTH `emitFromStreamEvent`'s delta Map AND `emitFromContentBlocks`' shared-size index counter. Stamp `parentToolUseId` onto emitted child events. Keep `sawStreamEvent` semantics; keep `tool_use`→`end`. | No (adapter-internal) |
| `src/ui/ToolCallCard.tsx` (`Props {tool; depth?}` `:8-11`) | Add an additive optional indent prop (marginLeft + dimmer border). NOTE `depth?` is a *color* `ColorDepth`, not a layout indent — add a separate nesting prop. | No |
| `src/ui/Message.tsx` (`toolSnapshot?.[id]` `:50-57`; `msg.blocks.map` `:74`) | Group child tool blocks under their parent (read `parentToolUseId` off `ToolState`/`Block`) and render indented beneath the parent's card. This is a **`blocks.map` restructure** (needs sibling visibility), not just an indent prop. | No |
| `tests/claudeCliClient.test.ts` | Scripted interleaved parent+child NDJSON fixture (both at `index:0`, child carrying `parent_tool_use_id`) asserting no accumulator cross-contamination + correct attribution. | No |

### Mandatory correctness invariants (verifier-confirmed — these are the silent traps)
- **INVARIANT TEST (the single most important addition):** un-dropped child tool-calls must **NEVER** change the terminal `stopReason` away from `'end'`. `cliStopReason` maps `tool_use`→`end` (`claudeCliClient.ts:542-558`); if `tool_use` ever leaked, `turnRunner` (`src/agent/turnRunner.ts:220` break — re-entry fires only when `stopReason === 'tool_use'`) would re-EXECUTE the CLI's already-run tool and re-spawn `claude -p` in a loop. This is the only thing between render-only and an infinite re-spawn. Pin it.
- **Option A is effectively MANDATORY, not optional.** Every emit stamps `id: input.id` = the PARENT turn id (`:344,349,358,413,418`); the reducer's text-delta (`:133`) and reasoning-delta (`:149`) match `live.id === action.id` and append to the PARENT. Un-dropping child text WITHOUT re-routing is **active corruption** of the authoritative answer. v1 drops child text/reasoning.
- **Partition BEFORE un-dropping.** If the `Map<number,ToolAccumulator>` isn't partitioned by parent id first, the moment the guards come off, parent/child `index:0` collide and tool-arg JSON cross-contaminates. Cover both the delta map and the block-mode counter (`:334`).
- **LIVE-RENDER GAP (the renderer trap):** during streaming, `Message.renderBlock` reads `msg.toolSnapshot?.[id]` which is undefined until assistant-done commits (`reducer.ts:234`), so live tool blocks render as bare `[tool {id}]` text (`Message.tsx:50-57`) — even PARENT cards aren't live `ToolCallCard`s today. **v1 decision: nesting is committed-only** (matches today's behavior; cheap). A live-tools render path is explicitly out of scope for v1. A "nested card" snapshot test would pass on committed state while a live stream still shows `[tool]` text — so the live verify below is mandatory, not the fake test.

### Build steps
1. **Capture ground truth FIRST** (see §7). Do not design from assumptions.
2. From the real capture, lock the partition-key shape + confirm the child-text drop (Option A).
3. Frozen-seam additive plumbing (`events.ts` + `reducer.ts` + `snapshotTools`); gate stays green (field optional/unset everywhere existing).
4. Adapter surgery in `claudeCliClient.ts`: partition both accumulators by parent id; un-drop the 3 guards; stamp `parentToolUseId`; preserve `sawStreamEvent` + `tool_use`→`end`.
5. Reducer filing: record the parent linkage on the child's `ToolState`/`Block`.
6. Renderer: `ToolCallCard` indent prop + `Message` `blocks.map` restructure to nest children (flat one-level indent for any non-null parent).
7. Deterministic tests: interleaved-NDJSON adapter fixture + reducer child-under-parent filing + committed nested-card snapshot + **the stopReason invariant test**.
8. **LIVE verify (mandatory):** replay the captured stream AND run a fresh live multi-subagent `claude -p`; confirm child cards nest correctly, no arg cross-contamination, no double-render, no re-execution, parent summary still lands.
9. Full gate green; reconcile any test-count delta intentionally.

### Definition of done
tsc-0 + vitest green INCLUDING the stopReason invariant; live multi-subagent `claude -p` renders nested child tool cards with no cross-contamination/re-execution; contracts.ts untouched; only additive `parentToolUseId?` on the frozen seam.

---

## 6. Unit 3 — Managed Agents (decision doc + frontmatter slice)

**Locked scope:** (A) decision doc recommending **NO-GO** on the hosted Anthropic Managed Agents API; (B) the additive frontmatter slice + `/agents` chip. Per-agent `permissionMode` honoring DEFERRED.

### Part A — decision doc (no code)
Write `docs/DECISION-managed-agents-hosted-api.md` recommending **NO-GO for v1**, grounded:
- It's a **different, non-Messages API** (beta, coordinator rosters/multiagent/session threads) → cannot ride `ModelClient.streamTurn` (`contracts.ts:95-97`); would only enter as a whole new provider backend.
- **Hosted execution runs outside juno's workspace jail** (SEC spine: no-train + workspace-jail + permission-gate) → security defer, not just cost.
- juno already shipped the portable `spawn_subagent` (PORT_SPEC's chosen v1 answer).
- Restate the actual Wave-4B split (PORT_SPEC still frames 4B as decision-only; Unit 3 is a code build folded in) so reviewers aren't misled by stale framing.

### Part B — frontmatter slice (additive, fake-testable)
| File:line | Change | Frozen? |
|---|---|---|
| `src/services/agents.ts` (`:58-70` keeps only name/description/prompt/model/tools; drops the rest) | Extend `AgentDefinition` + `discoverInRoot` to parse `disallowedTools`, `maxTurns`, `skills`, `effort` via the existing `parseScalars`/`extractList` (`frontmatter.ts`). All new fields optional. | No |
| `src/tools/subagentTool.ts` (`selectChildTools` `:91-101` allow-list intersect only) | `disallowedTools` → **deny-subtraction** in `selectChildTools` (it currently only intersects an allow-list); `maxTurns` → nested-loop cap; `skills`/`effort` → into the nested `TurnInput`. Module-level factory, no contract change. | No |
| `src/app.tsx` + `src/core/selectors.ts` + `src/ui/StatusLine.tsx` | Optional `/agents` listing slash command + `agents:N` chip mirroring the `skills:N` chip (`StatusLine.tsx:34-36`), fed via `selectStatusLine` context (no reducer). | No |
| `src/providers/claudeCliClient.ts` (`buildArgs`) | **No change** — never pass `--agents` (CLI auto-discovers `.claude/agents/` natively; double-define trap, same as the skills double-load guard). juno-side fields govern ONLY the raw-API `spawn_subagent` path. | No |

### Invariants / tripwires (verifier-confirmed)
- **DEFER per-agent `permissionMode` honoring.** It's inert today: the nested `awaitPermission` floor hard-denies every nested prompt (`subagentTool.ts:174`). **Tripwire:** do NOT honor a stored `permissionMode` until that deny-floor is deliberately redesigned — a previously-stored `bypassPermissions` would silently activate a guardrail bypass if a later wave makes nested prompts interactive. Parse-and-store at most as documentation; do not apply.
- **Nested-render piece folds into Unit 3** (shares the additive `parentToolUseId?` + the live-verify gate). Do NOT author a parallel nested-render here.
- `registry.ts` `BUILTIN_TOOL_SPECS` is test-pinned to the 5 file tools — the slice adds NO tools, so the pin is safe.

### Build steps
1. Write Part A decision doc (NO-GO).
2. Extend `AgentDefinition`/`discoverInRoot` for the dropped fields (all optional).
3. Thread into `spawn_subagent`: `disallowedTools` deny-subtraction; `maxTurns` cap; `skills`/`effort` into nested `TurnInput`.
4. Optional `/agents` chip + slash command.
5. Vitest (fully fake-testable): frontmatter parse of each new field; `disallowedTools` subtracts from child tools; `maxTurns` caps the nested loop; `agents:N` chip. Gate green.

### Definition of done
Decision doc committed with NO-GO + rationale; frontmatter slice green; `permissionMode` parsed-but-not-honored with the tripwire documented; no `--agents` passed; no frozen-seam touch.

---

## 7. Unit 3 live-capture protocol (mandatory, blocks Unit 2)

Unit 2 **cannot** start coding until a real interleaved stream is captured — fakes did not catch either Wave-2 bug and won't catch the interleave/index-collision/text-routing here.

1. Ensure ≥1 real `.claude/agents/*.md` the CLI will delegate to (user or project scope).
2. Run a prompt that **reliably triggers delegation** under:
   `claude -p "<delegating prompt>" --output-format stream-json --verbose --include-partial-messages`
3. Record the raw NDJSON to a fixture file. This is the ONLY source of truth for how `parent_tool_use_id`, content-block indices, and child events actually interleave.
4. From it: confirm the partition-key shape, the child-text drop, and build the deterministic adapter fixture.
5. Keep the capture under `_orchestration/` (not shipped) for replay.

**Prereqs to confirm with the user before Unit 2:** a logged-in Max `claude` binary that spawns native subagents; a real agent def; a delegation-triggering prompt.

---

## 8. Out of scope this wave (deferred — with why)

| Deferred | Why | If revisited |
|---|---|---|
| **MCP** (tools-only stdio bridge) | XL: from-scratch JSON-RPC/stdio subsystem + sync→async composition-root change + a real data-egress posture (no-train covers model providers, not MCP endpoints). claude-cli already renders native MCP cards → value is raw-API-only. | tools-only + stdio-only + default risk `'risky'` (never `'safe'`) + ship the `patterns.ts` salientPath extension WITH it (deferring it means always-allowing one MCP url silently always-allows EVERY url for that tool). |
| **Hooks** (lifecycle interception) | Punctures SECURITY.md's "no shell"; the exec primitive fires UPSTREAM of the only permission gate (`executor` before `policy.evaluate`) so the gate can't contain it; juno has zero `'dangerous'`-risk tooling. The draft's `cli.ts` wiring is also wrong — the gate must be computed in `app.tsx` (like `systemPromptForProvider`) and threaded through `useStreamingTurn.ts:262-269`, and the existing `SpawnImpl` ignores stdin so it can't carry a command-hook's JSON-to-stdin contract. claude-cli runs settings.json hooks natively. | NON-exec handlers only for v1, behind explicit opt-in, after a SECURITY.md posture amendment. |
| **`bypassPermissions` mode** | Deletes the SEC-foundational interactive gate and propagates to every subagent via the single shared policy instance (`cli.ts:63`). On claude-cli (if pass-through) it's enforced 100% by the unverifiable CLI subprocess with zero juno residual gate. | Only in an isolated container, with a loud indicator + explicit opt-in. |
| **claude-cli `--permission-mode` pass-through** | Requires an additive-optional `permissionMode?` on the **frozen** `TurnInput` (`contracts.ts`) + a 4-file thread, is not fake-verifiable, and re-introduces the unverifiable-bypass hole. Mode is documented as raw-API-only instead. | Scope the `TurnInput` addition as its own line item if CLI-backend mode parity is ever wanted. |
| **`ask` rules** | The rule store (`StoredDecision`, `policy.ts:21`) has no decision that yields `prompt` on match → net-new mechanism (new internal rule-decision + new `evaluate` branch), not "already expressible". | Add a policy-internal `force-prompt` rule-decision kept OUT of the frozen `PermissionDecision` union. |
| **Per-agent `permissionMode` honoring** | Blocked on permission-mode parity AND inert under the nested `awaitPermission`→`'deny'` floor (`subagentTool.ts:174`). | Honor only after the deny-floor is deliberately redesigned (tripwire above). |

---

## 9. Shared-seam conflicts & ordering (verifier-confirmed)

- **FROZEN `events.ts`/`reducer.ts` (`parentToolUseId?`):** Unit 3 and managed-agents nested-render want the SAME additive field. **Unit 3 OWNS and lands it first; managed-agents render is a dependent, not a parallel author.** → build order #2 before #3's render piece (which is deferred/folded anyway).
- **FROZEN `contracts.ts` (`TurnInput`):** the ONLY thing that would force a `contracts.ts` touch is permission-mode pass-through — **CUT** → `contracts.ts` stays out of Wave 4 entirely; Unit 3 is the sole frozen-seam author.
- **`executor.ts` / `policy.evaluate`:** permission-mode lands the gate shape; hooks (deferred) would wrap around it later. No conflict this wave.
- **`config.ts`:** only permission-mode adds Settings fields this wave (MCP/hooks deferred). No multi-feature contention.
- **`registry.ts` / `BUILTIN_TOOL_SPECS`:** test-pinned to the 5 file tools; managed-agents adds no tools → pin safe.

---

## 10. Notes / reconciliations

- **Stale-doc:** PORT_SPEC still frames Wave-4B as decision-only and lists plan-mode (CUT). Unit 3 is a CODE build folded into 4B by the W3-close decision. The managed-agents decision doc (§6A) restates the real split.
- **Test-count:** the W3 doc mentions 260; the live gate is **269** and clean — that's the real baseline, not a regression.
- **Snapshot:** rollback net is `_orchestration/wave3-green-snapshot-20260617/`. Re-snapshot after each green unit if desired.
