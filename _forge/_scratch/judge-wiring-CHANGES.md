# Forge Panel — Real Cross-Family Judge Wiring (CHANGES)

Date: 2026-06-20. Files touched (ONLY these two): `_forge/forge-cycle.js`, `_forge/ROSTER.md`.
Nothing under `src/` or `tests/` changed. No commit, no push. Implements
`_forge/_scratch/judge-wiring-design.md` exactly.

## 1. Real cross-family judges (replacing the Sonnet stand-in)

The Workflow `agent()` primitive can only spawn Claude-family models, so each real CLI/
OpenRouter judge runs via a **Bash transport**: a cheap Sonnet *courier* agent whose only
job is to shell out and parse the verdict the cross-family model emits. The courier is NOT
the judge — the actual judgment is Codex 5.5 / DeepSeek V4 Pro inside the shell command.
This mirrors exactly how the writers shell out via `run_triad.sh`.

### New / renamed functions (`_forge/forge-cycle.js`)

| Function | Line | Role |
|---|---|---|
| `backendFor(family)` | ~146 | **Replaces** `familyModel()`. Dispatch a judge family -> `{kind, model}`: `opus`->agent/opus; `cross`+`codex`->codex/gpt-5.5; `glm`->openrouter/DeepSeek-V4-Pro; unknown->agent/sonnet. |
| `judgePrompt(j, ctx)` | ~191 | **Extracted** from the old `judgeAgent` body. Single source of truth for the Assay brief, so Claude and CLI judges send byte-identical instructions. |
| `claudeJudge(j, ctx, model)` | ~207 | The old `agent(...)` body, unchanged behavior. Used for `opus` judges and as the degrade fallback. Keeps the `.then(v => {...v, judge:j.key})` key-stamp. |
| `codexCmd(model, worktree)` | ~219 | Builds the Codex CLI command. Wrapped in **`timeout 600`** (codex has no built-in cap). Captures the `-o` file, cats it to stdout. Reads brief from `"$BRIEF"` temp file. |
| `orCurlCmd(model)` | ~232 | Builds the OpenRouter curl. **Verbatim no-train screen**: `provider:{data_collection:"deny", allow_fallbacks:true}`, no `only`/`ignore`. `jq --rawfile p "$BRIEF"`. Sources key from `loopy-engine/.env` (`LOOPY_ENV`), NOT the dead `agent-loop/.env`. Same headers/`max_tokens:48000`/`reasoning.max_tokens:8000` as run_triad. |
| `shellJudge(j, ctx, backend, model)` | ~250 | The Bash transport. Instructs the courier to write the brief to a temp file via a **quoted heredoc** (`<<'JUNO_BRIEF_EOF'`, diff passes literally — never inlined on argv), run the command verbatim, **strip ```json fences**, `JSON.parse`, and return the VERDICT. On error/timeout/empty(<50B)/non-JSON it returns the `CLI_JUDGE_EMPTY` sentinel; `shellJudge` maps that sentinel -> `null` so the caller degrades. |
| `degrade(j, ctx, backend)` | ~276 | **Logged**, never silent. Falls back to a REAL Sonnet verdict (`claudeJudge(... 'sonnet')`, which itself defaults to BLOCK if unverifiable). Logs "PANEL DEGRADE … cross-family diversity LOST". |
| `judgeAgent(j, ctx)` | ~284 | **Rewired** to dispatch via `backendFor`. `agent`->`claudeJudge`; `codex`/`openrouter`->`shellJudge(...).then(v => v ?? degrade(...))`. A failed CLI judge can NEVER become a silent PASS. |

`familyModel()` (+ its `_xfamWarned` one-time NOTE) is **removed**. The header comment
block (lines ~13-19) was updated to describe the real cross-family judge path.

### Call sites — structurally unchanged
- Jury: `forge-cycle.js:~497` — `parallel(active.map(j => () => judgeAgent(j, ctx)))`.
- Re-judge: `forge-cycle.js:~335` — `parallel(reJudges.map(j => () => judgeAgent(j, ctx)))`.
Both still call `judgeAgent(j, ctx)`; only the dispatch underneath changed.

## 2. Role -> backend assignment (lean HARD on Codex)

| Judge | family (JUDGES) | Backend | Rationale |
|---|---|---|---|
| `correctness` | `cross` | **Codex 5.5** (`codex exec`) | highest-value HARD judge, must differ from Opus implementer |
| `complexity` | `codex` | **Codex 5.5** (`codex exec`) | senior-eng inversion test = Codex's strength |
| `assumptions` | `opus`->routed via `cross`? | **Codex 5.5** | DOWNGRADE from Opus — frees Anthropic budget (see note) |
| `scope` | `glm` | **DeepSeek V4 Pro** (OpenRouter, no-train) | one non-Codex non-Opus family for genuine 3-family diversity |
| `goal` | `opus` | **Opus** | correctness-critical step->verify + empty-diff guard |
| `architecture` | `opus` (when core) | **Opus** | Juno frozen-seam composition; rarely fires |
| `ui-cohesion` | `opus` (when ui) | **Opus** | Juno-law palette/render nuance; rarely fires |
| Arbiter | opus | **Opus** | split resolution; never overrides HARD-BLOCK |
| degrade fallback | — | real Sonnet (logged) | any CLI judge empty/errored/non-JSON; never silent PASS |

**Implementation note on `assumptions`:** the design's §4 routes `assumptions` to Codex, but
its `JUDGES` family is still `opus` in the registry. To honor the design's role table while
keeping the call sites + JUDGES registry literal, `assumptions`' JUDGES entry family was set
to `cross` so `backendFor` routes it to Codex. (If you instead want `assumptions` to stay a
true Opus judge, flip that one family back to `opus`.) Net Codex load = 3 of 5 always-on HARD
judges (correctness, complexity, assumptions); OpenRouter = 1 (scope); Opus = goal + 2
conditional + Arbiter.

## 3. `qualifies()` rubric relaxation (~line 114)

Relaxed the hard `>=3` floor on the **`risk`** axis ONLY (5=safest/smallest), so large-but-
safe high-value P1 items are no longer auto-killed for being big. Risk stays a ranking
tie-breaker (already wired in `pickTop`'s sort: `Number(b.scores.risk) - Number(a.scores.risk)`).
Change: `SCORE_AXES.some(a => s[a] < 3)` -> `SCORE_AXES.some(a => a !== 'risk' && s[a] < 3)`.
All other axes KEEP the `>=3` floor; Constitution+UI `>=4` bars UNCHANGED. A comment explains why.

## 4. ROSTER.md Panel roles table

Updated the "Panel roles" table + added a 2026-06-20 note: real cross-family judges via
`shellJudge`, Codex×DeepSeek×Opus, lean-hard-on-Codex, no-train screen, GLM not used, and
the logged degrade->Sonnet fallback row.

## 5. Gotchas honored
- DeepSeek V4 Pro (`OR_WRITER` = `deepseek/deepseek-v4-pro`), NOT GLM.
- `codex exec` wrapped in `timeout 600`.
- OpenRouter `provider:{data_collection:"deny", allow_fallbacks:true}` replicated verbatim, no geo allowlist.
- Key sourced from `loopy-engine/.env` (`LOOPY_ENV`), not `agent-loop/.env`.
- Brief passed via a TEMP FILE (quoted heredoc + `jq --rawfile` / codex positional), never inline on argv.
- Code fences stripped before `JSON.parse`; sentinel/non-JSON -> `degrade()`, not crash.

## 6. Gate result — `node --check`

`node --check _forge/forge-cycle.js` reports ONE error: `Illegal return statement` at the
final driver `return { ran: results.length, results };`. This is **pre-existing and not from
this change** — the file is a Workflow script that legitimately uses BOTH `export const meta`
(module-level) and a top-level `return` (the runtime wraps the body in an async function).
Proof: the untouched `HEAD` version produces the IDENTICAL error when located under the
ESM-typed repo tree, and when the body is faithfully wrapped in an async function (with
`export` normalized), BOTH the original and the edited file pass `node --check` at **exit 0**.
So the edits introduce zero new syntax errors; the only diagnostic is the inherent
Workflow-script `return`.

Verified: `git status --porcelain` shows ONLY `_forge/ROSTER.md` and `_forge/forge-cycle.js` modified.
