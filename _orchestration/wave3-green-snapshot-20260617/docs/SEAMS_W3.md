# SEAMS_W3 — Wave 3 (subagents + skills) pinned ground truth + build plan

Synthesized from 6 read-only seam scouts (2026-06-17), against the **current** post-Wave-2 tree.
Gate: `cd C:/Users/Core/src/juno && npx tsc --noEmit && npx vitest run` (was 239/239 green at scope time).

## Locked product decisions (from user, 2026-06-17)
1. **Subagent tools** — per-definition; default = **inherit parent MINUS `spawn_subagent`**.
2. **Recursion** — **depth 1** (subagents cannot spawn subagents).
3. **Skills source** — shared `~/.claude/skills/` then `<cwd>/.claude/skills/`.
4. **Skills injection** — **on-demand / progressive disclosure** (names+descriptions always; full body via a tool).

## The render-only split (the spine of Wave 3)
- **claude-cli (default) backend:** CLI runs subagents + auto-discovers skills NATIVELY. juno's job = (a) RENDER nested subagent activity it sees in the stream, (b) SHOW which skills loaded (`init.skills[]`), (c) pass `--agents` through. juno never re-runs anything here.
- **raw-API secondaries (anthropic/openai/openrouter):** juno provides its OWN portable `spawn_subagent` tool (nested turn → opaque, returns a summary string) + injects skill names/descriptions into the system prompt + a `load_skill` tool for the body.

## Pinned anchors (current line numbers)
### Tool / registry / executor (frozen, factory-friendly — NO contract changes)
- `Tool` `src/core/contracts.ts:100-105` = `{ name, risk: RiskLevel, spec: ToolSpec, run(args, ctx): Promise<ToolResult> }`
- `ToolCtx` `contracts.ts:70-81` = `{ cwd, signal, emit, awaitPermission, readonly state }` (DO NOT extend)
- `ToolSpec` `contracts.ts:48-52` = `{ name, description, inputSchema }`
- `ToolResult` `contracts.ts:84-88` = `{ ok, data?, error? }`
- `ToolExecutorDeps` `src/tools/executor.ts:12-19`; permission gate `executor.ts:54-95` (`policy.evaluate(name,args,risk)` → auto-allow/prompt/auto-deny). `risky` → prompt.
- Registry `src/tools/registry.ts:7-9` `createDefaultTools(): Tool[]` → extend to `[...createFileTools(), ...]`. `BUILTIN_TOOL_SPECS` also here.
- Module-level factory exemplar: `src/tools/fileTools.ts:115-136` (`createReadFileTool`), factory `fileTools.ts:377-385`.
- Risk levels `src/core/events.ts:8`; PermissionDecision `events.ts:10-14`.

### Turn execution (for nested spawn)
- `runTurn(input: TurnInput, deps: TurnRunnerDeps): Promise<void>` `src/agent/turnRunner.ts:74`. Returns void → dispatches `Action`s.
- `TurnRunnerDeps` `turnRunner.ts:33-40` = `{ client, executor, specs, dispatch:(Action)=>void, signal, registry }`.
- stopReason break gate `turnRunner.ts:220-223`: `if (stopReason !== 'tool_use') { clearStrandedPermissions(); break; }`.
- Client factory `src/providers/index.ts:29-42` `createModelClient(entry, deps)`.
- `ModelClient.streamTurn(input, tools: ToolSpec[], signal): AsyncIterable<AgentEvent>` `contracts.ts:95-97`.
- `PermissionRegistry` `src/agent/eventBus.ts:39-91` `createPermissionRegistry()` — **fresh instance per nested turn**; **SHARE the policy**; **independent AbortController**.
- Nested-summary capture: provide a custom `dispatch` that accumulates assistant text (or run a local reducer). Confirm `Action` text-carrying shape in `reducer.ts` at build time.

### System prompt + AppDeps + skills (HOOK END ALREADY DONE)
- DONE: `StreamingTurnDeps.systemPrompt?` `useStreamingTurn.ts:47`; threaded to TurnInput `:277`; dep array `:304`. Both raw-API providers consume `input.systemPrompt` (`anthropicClient.ts:244-250`, `openaiCompatClient.ts:217-219`). `TurnInput.systemPrompt` `contracts.ts:41`.
- MISSING: `AppDeps.systemPrompt?` (`app.tsx:23-38`), pass it in `app.tsx` hook call (~:77-84), populate in `cli.ts` (:56-72), and `src/services/skills.ts` (does not exist; follow `config.ts`/`catalog.ts` pattern).
- **claude-cli double-load guard:** verify whether `claudeCliClient` forwards `input.systemPrompt`; if it does, do NOT forward the skills block (CLI auto-discovers) — else double-load.

### Events / reducer / UI (FROZEN seam — additive-optional only)
- `AgentEvent` union `src/core/events.ts:34-46`; `ToolStatus` `:6`; `StopReason` `:22`.
- `State` `reducer.ts:52-66`; `ToolState` `reducer.ts:20-31`; `Block` `reducer.ts:14-17`; `Action` `reducer.ts:72-89`.
- `selectStatusLine` / `StatusLineState` `selectors.ts:12-23,52-65`.
- `ToolCallCard` `src/ui/ToolCallCard.tsx`; placement `src/ui/Message.tsx:41-77`; badge exemplar `src/ui/EffortBadge.tsx`; StatusLine `src/ui/StatusLine.tsx:22-40`; theme `src/ui/theme.ts:20-53`.

### claude-cli rendering
- `claudeCliClient.ts` parent_tool_use_id filters at ~`153-156, 172-175, 193-195` (each `if (parent_tool_use_id != null) break;`).
- init/system handler no-op ~`138-140`; `buildArgs` appends `--effort` ~`278`.
- Emitters: `emitFromContentBlocks` / `emitFromStreamEvent` / `emitFromUserEcho` / `cliStopReason`.

### On-disk format
- SKILL.md frontmatter union: `name`, `description` (always), `version`, `triggers` (4/5). v1 HONOR `name`+`description` (+ keep `version` if present); IGNORE allowed-tools/model/effort/context for now. Tolerate minimal frontmatter + missing dirs + malformed YAML.
- `--agents '<json>'` shape: `{ "<name>": { "description": "...", "prompt": "..." }, ... }`. Agent defs dir `.claude/agents/` (does NOT exist yet → graceful absent).

## Build plan (3 units, sequential single-implementer, GATE after each — no git → no parallel writers)
**Unit 1 — Skills (raw-API injection + progressive disclosure).**
`src/services/skills.ts` (discover+parse, `loadSkillBody`), `assembleSystemPrompt`, `src/tools/skillTool.ts` (`load_skill`, risk:safe, factory over skills). Wire AppDeps.systemPrompt + app.tsx + cli.ts. `skillsLoaded` display (prefer deriving from deps.skills at the StatusLine call site to avoid reducer churn; fall back to additive `State.skillsLoaded`). Tests.

**Unit 2 — `spawn_subagent` (raw-API; opaque nested turn → summary).**
`src/tools/subagentTool.ts` `createSubagentTool(deps)` (risk:risky), args `{ task, agent?, model? }`. Fresh registry + AbortController, SHARED policy, child toolset = base MINUS spawn (⇒ depth-1 for free). Per-definition `tools` override = intersect base by name. Optional `.claude/agents/` defs (graceful absent). `registry.ts` → `createDefaultTools(subagentDeps?)`; cli.ts injects deps; specs updated. Tests (nested turn w/ fake client, summary, depth-1, shared policy, abort isolation).

**Unit 3 — claude-cli rendering + `--agents` + `init.skills[]`.**
Remove the 3 parent_tool_use_id filters → surface nested events with additive optional `parentToolUseId?` (events + ToolState); `ToolCallCard` indents nested. Parse `init.skills[]` → skillsLoaded. `buildArgs` add `--agents` (TurnInput.agents?). Guard the Wave-2 double-emit (keep `sawStreamEvent`). Tests (filters surface, init.skills parsed, --agents present).

**Then:** adversarial verify (parallel skeptics) + a LIVE subscription run I drive myself. Snapshot already at `_orchestration/wave4-baseline-backup`.

---

## BUILD OUTCOME (2026-06-17)
**Wave 3 shipped = Units 1 + 2. Gate GREEN: tsc clean + vitest 260/260** (239 baseline + 11 skills + 10 subagent/agents).

**Unit 1 — Skills (DONE, green, live-verified).**
- `src/services/frontmatter.ts` (NEW, shared parser: splitFrontmatter / parseScalars / normalizeWs / extractList — no YAML dep).
- `src/services/skills.ts` (NEW: discover ~/.claude/skills + <cwd>/.claude/skills, user-wins dedupe, lazy `loadBody`, `assembleSystemPrompt` = names+descriptions + load_skill instruction, undefined when empty).
- `src/tools/skillTool.ts` (NEW: `load_skill`, risk:safe, on-demand body).
- Wiring: `registry.ts` `createDefaultTools({skills})` (no-arg path unchanged → BUILTIN_TOOL_SPECS stable); `app.tsx` AppDeps += `systemPrompt?`/`skills?`, **provider-gated systemPrompt** (suppressed when selected provider === 'claude-cli' to avoid double-load — claudeCliClient folds systemPrompt into the prompt, lines 283-292); `selectors.ts`+`StatusLine.tsx` skills chip (static, from deps.skills — works on ALL backends incl. CLI); `cli.ts` builds skills + prompt + tools, derives specs from the built array.
- Tests: `tests/skills.test.ts` (11).

**Unit 2 — spawn_subagent (DONE, green, LIVE-verified via real `claude -p`).**
- `src/services/agents.ts` (NEW: load `.claude/agents/*.md`, graceful-absent, per-def model/tools/prompt).
- `src/tools/subagentTool.ts` (NEW: `spawn_subagent`, risk:risky; nested `runTurn` with custom-dispatch summary capture; fresh registry + own AbortController w/ one-way parent→child abort cascade; SHARED policy; nested prompts→deny; **depth-1 structurally** via child toolset excluding spawn; per-definition tool allow-list intersect).
- Wiring: `registry.ts` `createDefaultTools({subagent})` (childTools = base assembled so far, excludes spawn); `cli.ts` builds shared policy + client factory first, loads agents, passes subagent deps.
- Tests: `tests/subagent.test.ts` (10, incl. depth-1, re-entry, per-def, error/abort, agents loader).

**Live verification (the real ground truth):** 11 real skills discovered + parsed; `load_skill` read a 10,098-char body; system prompt 6,722 chars; **`spawn_subagent` spawned a real `claude -p` subscription subagent (no API key) that returned the exact expected token in 3s** — the whole nested-turn machinery confirmed against the live subscription.

## Unit 3 — DEFERRED to Wave 4B (user decision 2026-06-17)
Nested subagent activity rendering on the claude-cli backend is NOT shipped. Reasons: (a) the high-value CLI items are already covered — skills chip works on CLI (same dirs), and `--agents` passthrough is unnecessary because the CLI auto-discovers `.claude/agents/` natively (passing it would double-define, same trap as the skills double-load guard); (b) correct nested rendering needs additive `parentToolUseId` on the FROZEN events/reducer seam AND must solve interleaved parent/subagent stream index-collision + subagent-text routing — which can only be implemented safely against a LIVE multi-subagent `claude -p` stream (fakes won't catch it; both Wave-2 bugs proved this). The 3 `parent_tool_use_id` filters in claudeCliClient.ts (~154-156, 173-175, 193-195) remain in place (subagent activity is summarized into the CLI's final answer — fine for v1).
