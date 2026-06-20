# Forge Panel — Real Cross-Family Judge Wiring (implementation-ready design)

Goal: replace the Sonnet stand-in panel judges with REAL cross-family judges (Codex 5.5 via the
`codex` CLI + GLM 5.2 / DeepSeek via OpenRouter), by mirroring the writers' existing shell-out
mechanism (`run_triad.sh` patterns) instead of the Claude-only `agent()` primitive. Overriding
preference: **lean HARD on Codex** (Codex budget is expendable; Anthropic/Opus is the scarce budget),
so route as many judge/review roles to Codex as is sensible.

NO CODE IS CHANGED BY THIS DOC. It is the plan only.

---

## 1. Where the panel judges are currently spawned via `agent()`

- `forge-cycle.js:178-194` — `judgeAgent(j, ctx)`: the single Assay spawner. It calls
  `agent(... , { phase:'Panel', label:'assay:'+j.key, model: familyModel(j.family), schema: VERDICT })`
  at **`forge-cycle.js:189`**.
- The model is chosen by `familyModel(family)` at **`forge-cycle.js:141-151`**, which maps
  `cross|glm|codex` → `'sonnet'` (the stand-in) and logs the one-time degradation NOTE. `opus` stays opus.
- Call sites that drive judges:
  - Initial jury: **`forge-cycle.js:393`** — `parallel(active.map(j => () => judgeAgent(j, ctx)))`.
  - Re-judge after a bounded fix: **`forge-cycle.js:231`** — `parallel(reJudges.map(j => () => judgeAgent(j, ctx)))`.
- The judge registry (which family each judge wants) is `JUDGES` at **`forge-cycle.js:93-101`**:
  `correctness=cross`, `assumptions=opus`, `complexity=codex`, `scope=glm`, `goal=opus`,
  `architecture=opus(when core)`, `ui-cohesion=opus(when ui)`.
- Verdict schema the judges must satisfy: `VERDICT` at **`forge-cycle.js:83-86`**
  (`{ judge, verdict: PASS|BLOCK, mode: HARD|ADVISORY, citation, reason }`).

So **only `familyModel()` + `judgeAgent()` need to change** to route non-Opus judges to CLI/OpenRouter;
the two call sites (line 393, line 231) and the merge/resolve logic are untouched.

---

## 2. EXACT mechanism the writers use (codex CLI + OpenRouter) — file:line

The writers shell out from `run_triad.sh` (invoked by the Build agent, not by JS). The Forge JS invokes
it indirectly at **`forge-cycle.js:344-347`** (`bash "${TRIAD}" <brief> <outdir>`, with env
`OR_MODEL`, `CODEX_CWD`, `OPENROUTER_API_KEY`). The actual command shapes live in `run_triad.sh`:

### Codex CLI (Writer A) — `run_triad.sh:41-42`
```bash
codex exec --skip-git-repo-check -C "$CODEX_CWD" -s read-only -m "$CODEX_MODEL" \
    -o "$CODEX_OUT" "$(cat "$BRIEF_FILE")"  >"$OUT_DIR/codex.log" 2>&1
```
- `CODEX_MODEL` default `gpt-5.5` (`run_triad.sh:19`).
- `-C <dir>` sets the dir codex reads (here the worktree); `-s read-only` = read-only sandbox;
  `-o <file>` writes the final message to a file; the **prompt is the last positional arg**
  (`$(cat BRIEF_FILE)`), i.e. the whole brief passed on argv.
- Output is **captured from the `-o` file** (`$CODEX_OUT`). Success ≈ rc==0 AND file >50 bytes
  (`run_triad.sh:79`).

### OpenRouter (Writer B) — `run_triad.sh:47-67`
- Build the request body with `jq` from the brief file (`--rawfile`), `run_triad.sh:47-51`:
  ```json
  { "model": $OR_MODEL, "messages":[{"role":"user","content":<brief>}],
    "max_tokens": 48000, "temperature":0.2,
    "reasoning":{"max_tokens":8000},
    "provider":{"data_collection":"deny","allow_fallbacks":true} }
  ```
- POST with curl, 5-attempt retry, 600s timeout each, `run_triad.sh:54-67`:
  ```bash
  curl -sS --max-time 600 https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://localhost/triad" -H "X-Title: triad-orchestration" \
    -d @"$OUT_DIR/or_req.json" > "$OUT_DIR/or_raw.json"
  ```
- Verdict text extracted with `jq -rc '.choices[0].message.content // ""'` (`run_triad.sh:59-61`);
  empty/`null` content → retry with `sleep 20` backoff. Failure after 5 → writes `OPENROUTER_ERROR`.
- **Privacy non-negotiable:** `provider.data_collection:"deny"` + `allow_fallbacks:true`, NO geographic
  allowlist (no `only`/`ignore`) — this is the entire no-train screen. The judge path MUST replicate this
  verbatim.
- Key resolution: env `OPENROUTER_API_KEY` first, else grep a local `.env` (`run_triad.sh:25-34`). Note the
  Forge JS already prefers `loopy-engine/.env` (`forge-cycle.js:36`), whereas run_triad greps the dead
  `agent-loop/.env` — the judge shell-out should use the loopy-engine path.

---

## 3. Concrete change plan

The Workflow `agent()` primitive can only spawn Claude-family models, so a real CLI/OpenRouter judge must
be run by a **Bash-capable `agent()`** that shells out and returns the parsed verdict — exactly the pattern
the Build phase already uses for the writers. Two viable shapes; **Option A (recommended)** keeps all logic
inside the existing `agent()` machinery (no new shell script, schema-validated return); Option B adds a
dedicated `run_judge.sh`. Recommend A for the dry-run, B only if we later want judges fully script-driven.

### 3a. Add `shellJudge(j, ctx)` — a Bash-agent wrapper that mirrors the writers

New helper, sibling to `judgeAgent`. It spawns ONE Bash agent whose entire job is: assemble the judge
prompt as a brief, shell out to the right backend (codex CLI or OpenRouter curl), capture stdout/the `-o`
file, and **return the parsed VERDICT object** (the Bash agent does the JSON-extraction so the JS stays
fs-free, consistent with the rest of forge-cycle.js). Pseudocode:

```js
// backend: 'codex' | 'openrouter'; model: concrete id
function shellJudge(j, ctx, backend, model) {
  const brief = judgePrompt(j, ctx);              // SAME prompt text as judgeAgent (see 3c)
  const reqHint = backend === 'codex' ? codexCmd(model, ctx) : orCurlCmd(model);
  return agent(
    `You are a SHELL RUNNER, not the judge. Run the command below EXACTLY, capture its full output, ` +
    `then extract the judge's JSON verdict and return it as your structured result. Do NOT add your own ` +
    `opinion — you are a transport. If the command errors, times out, or yields empty/again-non-JSON ` +
    `output, return {"judge":"${j.key}","verdict":"BLOCK","mode":"ADVISORY","reason":"CLI_JUDGE_EMPTY",` +
    `"citation":""} so the caller can detect degradation.\n\n` +
    `=== JUDGE BRIEF (write to a temp file, pass to the model) ===\n${brief}\n\n` +
    `=== COMMAND ===\n${reqHint}\n` +
    `Require the model to answer with ONLY a JSON object matching: ` +
    `{judge, verdict:PASS|BLOCK, mode:HARD|ADVISORY, citation, reason}.`,
    { phase: 'Panel', label: `assay:${j.key}:${backend}`, model: 'sonnet', schema: VERDICT })
    // NOTE: model:'sonnet' here is the cheap *transport* agent (it only runs a shell cmd + parses JSON);
    // the ACTUAL judgment is done by `model` (Codex/GLM/DeepSeek) inside the shell command. This is the
    // crux: the cross-family judge runs in the CLI, the Claude agent is just the courier.
    .then(v => v ? { ...v, judge: j.key } : null);
}
```

Command builders (mirror run_triad.sh exactly, incl. the privacy screen):

```js
function codexCmd(model, ctx) {
  // brief already written to $BRIEF by the agent; verdict captured from -o file then cat'd back
  return `BRIEF=$(mktemp); cat > "$BRIEF" <<'EOF'\n<brief>\nEOF\n` +
    `OUT=$(mktemp); codex exec --skip-git-repo-check -C "${ctx.worktree}" -s read-only ` +
    `-m "${model}" -o "$OUT" "$(cat "$BRIEF")" >/dev/null 2>&1; cat "$OUT"`;
}
function orCurlCmd(model) {
  // identical body + headers + provider.data_collection:deny as run_triad.sh:47-67
  return `... jq -n --rawfile p "$BRIEF" --arg m "${model}" ` +
    `'{model:$m,messages:[{role:"user",content:$p}],max_tokens:48000,temperature:0.2,` +
    `reasoning:{max_tokens:8000},provider:{data_collection:"deny",allow_fallbacks:true}}' > req.json; ` +
    `curl -sS --max-time 600 https://openrouter.ai/api/v1/chat/completions ` +
    `-H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" ` +
    `-d @req.json | jq -r '.choices[0].message.content // ""'`;
}
```

(In practice it's cleaner to write a tiny `run_judge.sh` alongside `run_triad.sh` that takes
`<backend> <model> <brief_file> <worktree>` and emits the raw judge text — then `shellJudge` just invokes
it the way Forge invokes `run_triad.sh` at line 344. Same privacy block, one retry loop reused. This is
Option B and is the better long-term home; for the dry-run, inline is acceptable.)

### 3b. Replace `familyModel()` with a router; rewire `judgeAgent`

Change `judgeAgent` (line 178) to dispatch by family:

```js
function backendFor(family) {
  if (family === 'opus')  return { kind: 'agent',      model: 'opus' };
  if (family === 'codex' || family === 'cross')        // cross defaults to Codex (lean-hard-on-codex)
                          return { kind: 'codex',      model: 'gpt-5.5' };
  if (family === 'glm')   return { kind: 'openrouter', model: 'deepseek/deepseek-v4-pro' }; // see §5 re GLM
  return { kind: 'agent', model: 'sonnet' };           // unknown → safe Claude fallback
}

function judgeAgent(j, ctx) {
  const b = backendFor(j.family);
  if (b.kind === 'agent')      return claudeJudge(j, ctx, b.model);       // current agent() body
  if (b.kind === 'codex')      return shellJudge(j, ctx, 'codex', b.model)
                                      .then(v => v ?? degrade(j, ctx, 'codex'));
  /* openrouter */             return shellJudge(j, ctx, 'openrouter', b.model)
                                      .then(v => v ?? degrade(j, ctx, 'openrouter'));
}
```

`claudeJudge` = today's `agent(...)` block at lines 179-193 (extracted, unchanged). The two call sites
(line 393 jury, line 231 re-judge) stay literally the same — they just call the new `judgeAgent`.
`familyModel()` (141-151) is deleted/folded into `backendFor`.

### 3c. Shared judge prompt — extract `judgePrompt(j, ctx)`

Pull the prompt string from lines 179-188 into `judgePrompt(j, ctx)` so BOTH `claudeJudge` and
`shellJudge` send byte-identical instructions (same DIFF / SEAMS / step→verify, same "cite file:line",
same "default BLOCK if unverifiable"). This guarantees the verdicts are comparable across families and is
the single source of truth for the Assay contract.

### 3d. Graceful Sonnet fallback with logged degradation

```js
async function degrade(j, ctx, backend) {
  log(`cycle: PANEL DEGRADE — ${backend} judge '${j.key}' returned empty/errored; ` +
      `falling back to Sonnet stand-in (cross-family diversity LOST for this judge).`);
  return claudeJudge(j, ctx, 'sonnet');   // never null → caller still gets a verdict
}
```

Detection of "empty": `shellJudge` returns `null`/`CLI_JUDGE_EMPTY` sentinel when the CLI rc!=0, the `-o`
file is <50 bytes, or the OpenRouter content is empty/`null` (same >50-byte / non-null test as
run_triad.sh:60,79). The fallback is ADVISORY-noisy in the log so the BOARD/LEDGER shows degraded cycles.
Crucially: a CLI judge that *errors* must NOT silently become a PASS — it falls back to a real Sonnet
verdict (which itself defaults to BLOCK if it can't verify), preserving the "un-run verification is not a
pass" invariant the re-judge loop already enforces (lines 232-236).

### 3e. Worktree/key plumbing
- `shellJudge`'s Bash agent needs `OPENROUTER_API_KEY` and codex auth in env. Reuse the Forge convention:
  source it from `loopy-engine/.env` (`forge-cycle.js:36`), not the dead `agent-loop/.env`. Pass
  `CODEX` read dir = `ctx.worktree` so a Codex judge that inspects the tree sees the forge/* changes (the
  diff in the prompt is still authoritative, per line 187).
- No new schema needed — judges still return `VERDICT` (lines 83-86). The stamp `.then(v => {...v, judge:j.key})`
  (line 193) stays, since CLI models also emit free-text judge names.

---

## 4. Role → backend assignment ("lean HARD on Codex")

Anthropic/Opus is the scarce budget; Codex is expendable. Push the HARD always-on judges that don't
require Juno-internal seam judgment onto Codex, keep Opus only where deep architectural/Juno-law judgment
genuinely pays, use OpenRouter for the one judge we want a *third* family on for diversity.

| Judge (forge-cycle.js JUDGES) | Current family | **New backend** | Rationale |
|---|---|---|---|
| `correctness` (`cross`) | sonnet stand-in | **Codex 5.5 (CLI)** | Highest-value HARD judge; must differ from Opus implementer; Codex is strong + cheap-to-us. |
| `complexity` (`codex`) | sonnet stand-in | **Codex 5.5 (CLI)** | Already specced Codex; the senior-eng inversion test is exactly Codex's strength. |
| `scope` (`glm`) | sonnet stand-in | **OpenRouter — DeepSeek V4 Pro** (or GLM, see §5) | Keep ONE non-Codex non-Opus family for genuine 3-family diversity; traceability is mechanical, fine for DeepSeek. |
| `assumptions` (`opus`) | opus | **Codex 5.5 (CLI)** *(downgrade from Opus)* | Lean-hard-on-Codex: silent-assumption auditing doesn't need Opus; frees Anthropic budget. Keep Opus only if dry-run shows Codex misses. |
| `goal` (`opus`) | opus | **Opus** (keep) | step→verify + empty-diff guard is correctness-critical and cheap (1 call); keep the strongest model. |
| `architecture` (`opus`, when core) | opus | **Opus** (keep) | Frozen-seam / Juno-seam composition = Juno-internal judgment Opus is best at; rarely fires. |
| `ui-cohesion` (`opus`, when ui) | opus | **Opus** (keep) | Unified-palette/render-cohesion is Juno-law nuance; rarely fires. |
| Arbiter (ROSTER, not yet in JUDGES) | opus | **Opus** (keep) | Split-resolution is the one place we want our best judgment; never overrides HARD-BLOCK. |

Net: Codex takes 3 of the 5 always-on HARD judges (correctness, complexity, assumptions); OpenRouter takes
1 (scope); Opus keeps only goal + the two conditional Juno-law judges + Arbiter. This maximizes Codex load
and minimizes Anthropic spend while preserving genuine cross-family diversity (Codex × DeepSeek × Opus).
NOTE: this updates ROSTER.md's "Panel roles" table — keep that doc in sync (Constitution maintenance rule).

---

## 5. Risks / gotchas

1. **GLM returns empty + burns retries (known).** GLM 5.2 is a reasoning model; in the cycle-2 dry-run it
   returned `content:null` and burned run_triad's 5×600s loop (ROSTER.md:9-13, forge-cycle.js:37-40). So the
   default OpenRouter judge model is **DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro`), the house fast
   non-reasoning coder, NOT GLM — same decision the writers already made. If GLM is ever wanted as a judge,
   it needs `max_tokens≥48000` + `reasoning.max_tokens≈8000` (already the run_triad defaults) and MUST keep
   the empty-content retry + degrade path, or it silently drops a HARD judge.
2. **Codex CLI timeout / no per-call cap.** `codex exec` has no `--max-time`; a hung Codex stalls the panel.
   Wrap the codex invocation in a shell `timeout 600 codex exec ...` (the run_triad path relies on the JS
   agent's own wall-clock; a judge should be explicitly bounded). On timeout → empty → degrade to Sonnet.
3. **Empty / non-JSON returns.** CLI models won't always emit clean JSON for the VERDICT schema. The
   transport agent must (a) instruct "ONLY a JSON object", (b) tolerate fenced ```json blocks (strip
   fences), (c) on parse failure return the `CLI_JUDGE_EMPTY` sentinel → degrade. Mirror run_triad's
   `>50 bytes` + non-`null` test (run_triad.sh:60,79) as the emptiness gate.
4. **Windows shell quoting (Git-Bash vs cmd).** The whole Forge path already runs through Git-Bash
   (run_triad.sh, the mklink `cmd //c`, heredocs). Keep judge shell-outs in **bash heredocs** (`<<'EOF'`)
   so the diff/SEAMS text (which contains backticks, `$`, quotes, newlines) is passed literally — never
   interpolate the diff into a double-quoted argv. Codex takes the prompt as a positional arg
   (`"$(cat BRIEF)"`); write the brief to a temp file first (as the writers do) rather than inlining a
   multi-KB diff on the command line (ARG_MAX / quoting hell). OpenRouter uses `jq --rawfile` from that
   same temp file — never string-concatenate JSON.
5. **Privacy screen must be replicated verbatim.** Any OpenRouter judge MUST send
   `provider:{data_collection:"deny",allow_fallbacks:true}` with NO `only`/`ignore` allowlist
   (run_triad.sh:50; the no-train account policy is the whole screen). A judge that forgets this leaks the
   diff to a training provider — treat it as a hard review item.
6. **Key path drift.** run_triad greps the *dead* `agent-loop/.env` (run_triad.sh:27); Forge uses
   `loopy-engine/.env` (forge-cycle.js:36). The judge shell-out should source the loopy-engine path to
   avoid a silent "no key → FATAL" only on the judge leg.
7. **Cost asymmetry is intended but watch OpenRouter $/day.** Leaning on Codex is free-to-scarce-budget,
   but the one OpenRouter judge per cycle still hits the OpenRouter $/day cap the Budget governor enforces
   (ROSTER.md:45). One DeepSeek call/cycle is negligible; fine.
8. **Diversity invariant.** Don't let degradation collapse all judges to Sonnet silently — if BOTH Codex
   and OpenRouter judges degrade in a cycle, the panel is effectively all-Claude and the "cross-family
   diversity" guarantee (PANEL.md:44-47) is void. Log a single CYCLE-LEVEL "panel ran degraded (N/5
   cross-family judges fell back)" line so the Ledger/BOARD reflect reduced assurance for that merge.

---

### Definition of done (for the eventual implementer)
- `familyModel()` removed; `backendFor()` + `judgePrompt()` + `shellJudge()` (+ optional `run_judge.sh`)
  added; `judgeAgent()` dispatches by family; `claudeJudge()` holds the old agent() body.
- Call sites at forge-cycle.js:393 and :231 unchanged.
- Codex judges bounded by `timeout 600`; OpenRouter judges carry the verbatim no-train provider block and
  the empty-content retry+degrade.
- Every CLI judge has a logged Sonnet fallback that can never resolve to a silent PASS.
- ROSTER.md Panel-roles table updated to match §4.
