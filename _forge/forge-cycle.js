// forge-cycle.js — the Forge orchestration spine (Workflow script).
//
// Self-chaining until budget. One invocation runs cycles back-to-back until the
// token target is spent (autonomous mode), then returns; a conductor-level cron
// re-invokes for perpetual operation. Reads its agenda fresh from _forge/*.md every
// cycle, so the trigger is static but the work is state-driven (the self-prompt).
//
// SUPERVISED DRY-RUN MODE: pass args = { maxCycles: 1, forceItem: '<title>', maxFix: 1 }
// to run exactly ONE cycle on a chosen item regardless of budget. Used to calibrate
// the panel before self-chaining + cron are enabled. (Constitution: never self-chain
// before the panel is validated.)
//
// ZERO-TOKEN PLAN MODE: pass args = { dryRun: true } (optionally forceItem for the slug)
// to run NO cycle at all — the driver resolves the platform paths and returns the EXACT
// worktree create / node_modules link / unlink / worktree remove command sequence for
// this OS, invoking no agent() and touching no files. A supervisor executes that plan to
// prove the platform branch of link/unlink + worktree create/remove works end-to-end on
// the host before the loop is trusted (see _forge/_tests/dryrun-darwin.mjs).
//
// Cross-family writers (DeepSeek V4 Pro / Codex 5.5) run via run_triad.sh invoked by the
// Bash-capable Build agent inside a real git worktree; Claude-family roles use agent()
// directly. The PANEL judges are now ALSO real cross-family: shellJudge() runs a cheap
// Sonnet "courier" agent whose only job is to shell out (codex exec / OpenRouter curl) and
// parse the verdict the cross-family model emits — so the actual judgment is Codex 5.5 /
// DeepSeek V4 Pro, not Sonnet. A CLI judge that returns empty/errored/non-JSON degrades
// (logged) to a real Sonnet verdict — never a silent PASS. See backendFor() for routing.

export const meta = {
  name: 'forge-cycle',
  description: 'Autonomous self-improvement cycles for Juno: Scout -> Filter -> Forge -> Gate -> Panel -> Merge/Park -> self-schedule',
  phases: [
    { title: 'Scout', detail: 'research + rank candidates vs Target State' },
    { title: 'Filter', detail: 'Constitution fit-score; pick top unblocked item' },
    { title: 'Forge', detail: 'scope SEAMS -> triad implement on a forge/* worktree' },
    { title: 'Gate', detail: 'tsc 0 + vitest + build (re-run by orchestrator)' },
    { title: 'Panel', detail: 'GOLD_HAT pre-filter -> triage -> Assay jury' },
    { title: 'Resolve', detail: 'merge on unanimous HARD-PASS, else bounded fix or park' },
  ],
};

// --- paths & platform (cross-platform; DERIVED, never hardcoded) -------------
// The block between the markers is self-contained: it depends ONLY on `process`
// (no import/require, so it survives the Workflow runner's function-wrapping of
// this module). tests/forge-crossplatform.test.ts extracts it verbatim and evals
// it with a fake `process` to assert POSIX (darwin/linux) and win32 both resolve.
// <forge:paths>
const posix = (p) => String(p).replace(/\\/g, '/');   // → forward slashes (git-bash safe)
const winPath = (p) => String(p).replace(/\//g, '\\'); // → backslashes (cmd/mklink)
// The runner sets cwd to the PARENT of the repo (the "src" dir); everything hangs
// off that + $HOME + process.platform, so no absolute path is baked in. Env
// overrides (JUNO_SRC / JUNO_REPO / JUNO_TRIAD / JUNO_LOOPY_ENV) allow relocation.
const SRC = posix(process.env.JUNO_SRC ?? process.cwd());          // the Workflow cwd (parent of the repo)
const REPO = posix(process.env.JUNO_REPO ?? `${SRC}/juno`);        // the juno checkout (sibling of the worktrees)
const FORGE = `${REPO}/_forge`;
const HOME = posix(process.env.HOME ?? process.env.USERPROFILE ?? '');
const TRIAD = posix(process.env.JUNO_TRIAD ?? `${HOME}/.claude/skills/triad/run_triad.sh`);
const LOOPY_ENV = posix(process.env.JUNO_LOOPY_ENV ?? `${SRC}/loopy-engine/.env`); // OpenRouter key fallback (agent-loop/.env is gone)
const IS_WIN = process.platform === 'win32';
// SINGLE source of truth for a cycle's worktree path — the build step (create) and
// cleanupWorktree (remove) MUST derive the identical path from the slug, or a
// git-worktree add/remove drift would strand worktrees. Sibling of REPO.
const worktreeFor = (sl) => `${SRC}/juno-forge-${sl}`;
// node_modules link: a Windows junction (mklink /J) or a POSIX symlink (ln -s) — the
// gate needs node_modules and it is gitignored in the worktree. The teardown below
// MUST match so it removes ONLY the link, never recursing into the shared target.
const linkNodeModulesCmd = (wt) => IS_WIN
  ? `cmd //c mklink /J "${winPath(wt)}\\node_modules" "${winPath(REPO)}\\node_modules"`
  : `ln -s "${REPO}/node_modules" "${wt}/node_modules"`;
const unlinkNodeModulesCmd = (wt) => IS_WIN
  // plain rmdir (NO /S) deletes the junction reparse point only — NEVER recurse.
  ? `if [ -d "${wt}/node_modules" ]; then MSYS_NO_PATHCONV=1 cmd /c rmdir "$(cygpath -w "${wt}")\\node_modules"; fi`
  : `rm -f "${wt}/node_modules"`; // removes the symlink itself (no -r → never follows into REPO/node_modules)
// </forge:paths>
// Writer B (OpenRouter) model. GLM 5.2 is a reasoning model — slow + returned empty
// content here (burned the 5x600s retry loop). DeepSeek V4 Pro is the house fast coder
// (non-reasoning, no-train-verified); Codex 5.5 stays writer A, so cross-family holds.
const OR_WRITER = 'deepseek/deepseek-v4-pro';

// --- schemas (agents return validated objects) -------------------------------
const SCORE_AXES = ['constitution', 'targetValue', 'ui', 'architecture', 'simplicity', 'risk'];
const SCORES = {
  type: 'object',
  properties: Object.fromEntries(SCORE_AXES.map(a => [a, { type: 'number', minimum: 0, maximum: 5 }])),
  required: SCORE_AXES,
};
const CANDIDATES = { type: 'object', properties: { candidates: { type: 'array', items: {
  type: 'object', properties: {
    title: { type: 'string' }, gap: { type: 'string' }, sketch: { type: 'string' },
    deps: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'boolean' },              // deps not yet satisfied (Scout reads the Ledger)
    scores: SCORES,                            // 6-axis fit-score per CONSTITUTION.md IV
  }, required: ['title', 'gap', 'scores'] } } }, required: ['candidates'] };

// Architect output is STRUCTURED — escalate is a boolean, never regexed from prose
// (a naive /FROZEN-SEAM-ESCALATE/ test false-matches the word inside a negation).
const SEAMS = { type: 'object', properties: {
  escalate: { type: 'boolean' },            // true ONLY if it must ALTER/REMOVE an existing
  escalateReason: { type: 'string' },       // field/signature in contracts.ts/events/reducer
  seams: { type: 'string' }, stepVerify: { type: 'string' },
  files: { type: 'array', items: { type: 'string' } },
}, required: ['escalate', 'seams'] };

const BUILT = { type: 'object', properties: {
  branch: { type: 'string' }, worktree: { type: 'string' },
  writerPath: { enum: ['triad', 'degraded', 'opus-fallback'] },
  diff: { type: 'string' }, diffStat: { type: 'string' },
  stepVerify: { type: 'string' }, summary: { type: 'string' },
}, required: ['branch', 'worktree', 'writerPath', 'diff'] };

const GATE = { type: 'object', properties: {
  tsc: { type: 'number' }, vitest: { enum: ['green', 'red'] }, build: { enum: ['green', 'red', 'skip'] },
  diffPresent: { type: 'boolean' }, diffStat: { type: 'string' }, raw: { type: 'string' },
}, required: ['tsc', 'vitest', 'build', 'diffPresent'] };

const TRIAGE = { type: 'object', properties: {
  touchesCore: { type: 'boolean' }, touchesUi: { type: 'boolean' },
  newCapability: { type: 'boolean' }, note: { type: 'string' },
}, required: ['touchesCore', 'touchesUi'] };

const VERDICT = { type: 'object', properties: {
  judge: { type: 'string' }, verdict: { enum: ['PASS', 'BLOCK'] },
  mode: { enum: ['HARD', 'ADVISORY'] }, citation: { type: 'string' }, reason: { type: 'string' },
}, required: ['judge', 'verdict', 'mode', 'reason'] };

const GOLDHAT = { type: 'object', properties: {
  pass: { type: 'boolean' }, reason: { type: 'string' }, escalate: { type: 'boolean' },
}, required: ['pass', 'reason'] };

// --- judges (see PANEL.md / ROSTER.md). family != implementer for the Assay ---
const JUDGES = [
  { key: 'correctness', family: 'cross', always: true,  brief: 'correctness, missed edge cases, spec drift' },
  { key: 'assumptions', family: 'cross', always: true,  brief: 'undeclared scope decisions / silent assumptions' }, // -> Codex (lean-hard-on-codex, design §4)
  { key: 'complexity',  family: 'codex', always: true,  brief: 'minimal solution? senior-engineer inversion test' },
  { key: 'scope',       family: 'glm',   always: true,  brief: 'every changed line traces to the spec; nothing orthogonal' },
  { key: 'goal',        family: 'opus',  always: true,  brief: 'each step->verify clause passes; empty-diff guard' },
  { key: 'architecture',family: 'opus',  when: 'core',  brief: 'frozen-seam compliance; composes with Juno seams' },
  { key: 'ui-cohesion', family: 'opus',  when: 'ui',    brief: 'unified-palette / status-line / render cohesion' },
];

// ============================================================================
// helpers (the build-time seams)
// ============================================================================

function slug(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function totalScore(c) { return SCORE_AXES.reduce((n, a) => n + (Number(c.scores?.[a]) || 0), 0); }

// CONSTITUTION IV: >=3 every axis, >=4 on Constitution+UI; auto-reject constitution==0.
// EXCEPTION (approved 2026-06-20): the `risk` axis (5=safest/smallest) is NOT a hard
// gate — it stays ONLY a ranking tie-breaker (see pickTop's sort at risk-tiebreak). A
// large-but-safe, high-value P1 item should not be auto-killed merely for being big, so
// we exempt `risk` from the >=3 floor. Every OTHER axis keeps its >=3 floor, and the
// Constitution+UI >=4 bars are unchanged.
function qualifies(c) {
  const s = c.scores || {};
  if (SCORE_AXES.some(a => typeof s[a] !== 'number')) return false;
  if (SCORE_AXES.some(a => a !== 'risk' && s[a] < 3)) return false;
  return s.constitution >= 4 && s.ui >= 4;
}

// Deterministic: drop blocked + sub-threshold, rank by total score, then safer
// (higher risk axis = lower size/risk), then title for a stable order. forceItem
// (supervised dry-run) overrides ranking but still requires an unblocked match.
function pickTop(cands, forceItem) {
  const open = (cands || []).filter(c => !c.blocked);
  if (forceItem) {
    const f = open.find(c => c.title.toLowerCase().includes(String(forceItem).toLowerCase()));
    if (f) return f;
    log(`forceItem "${forceItem}" not proposed by Scout — falling back to rubric ranking.`);
  }
  const elig = open.filter(qualifies);
  if (!elig.length) return null;
  elig.sort((a, b) =>
    totalScore(b) - totalScore(a) ||
    (Number(b.scores.risk) - Number(a.scores.risk)) ||
    a.title.localeCompare(b.title));
  return elig[0];
}

// Route a judge FAMILY to a concrete backend. Replaces the old familyModel() Sonnet
// stand-in with REAL cross-family judges run via a Bash transport (shellJudge), mirroring
// the writers' run_triad.sh shell-out. "Lean HARD on Codex": Codex budget is expendable,
// Anthropic/Opus is the scarce one, so cross/codex (correctness, complexity, assumptions)
// all route to Codex 5.5; the one OpenRouter judge (scope) keeps a 3rd family for
// diversity; opus stays opus. GLM is intentionally NOT used (returns empty + burns
// retries — see OR_WRITER note); the OpenRouter judge uses DeepSeek V4 Pro, the same
// reliable house coder the writers use.
function backendFor(family) {
  if (family === 'opus') return { kind: 'agent', model: 'opus' };
  // cross defaults to Codex (lean-hard-on-codex); codex obviously Codex.
  if (family === 'codex' || family === 'cross') return { kind: 'codex', model: 'gpt-5.5' };
  if (family === 'glm') return { kind: 'openrouter', model: OR_WRITER }; // DeepSeek V4 Pro, NOT GLM
  return { kind: 'agent', model: 'sonnet' }; // unknown family -> safe Claude fallback
}

function triageTouches(triage, when) {
  if (when === 'core') return !!triage?.touchesCore;
  if (when === 'ui') return !!triage?.touchesUi;
  return false;
}

function lite(item) { return { title: item.title, gap: item.gap }; }

// Objective gate, re-run by the orchestrator (never trusted from the build agent).
async function runGate(branch, worktree) {
  const out = await agent(
    `OBJECTIVE GATE — run in the worktree and report RAW results; do NOT summarize as success.\n` +
    `Run (bash):\n` +
    `  cd "${worktree}"\n` +
    `  npx tsc --noEmit ; (echo "TSC=$?")\n` +
    `  npx vitest run 2>&1 | tail -8 ; (echo "VITEST=$?")\n` +
    `  npm run build 2>&1 | tail -8 ; (echo "BUILD=$?")  # if no build script, report build="skip"\n` +
    `  git -C "${worktree}" diff --stat main...${branch}\n` +
    `Report: tsc exit code, vitest green|red, build green|red|skip, diffPresent (true iff the ` +
    `git diff --stat is non-empty), the diffStat, and the raw tail.`,
    { phase: 'Gate', model: 'sonnet', schema: GATE });
  const green = !!out && out.tsc === 0 && out.vitest === 'green' && out.build !== 'red' && out.diffPresent === true;
  return { ...out, green };
}

// Single source of truth for the Assay contract — BOTH the Claude judge and the CLI/
// OpenRouter judge send byte-identical instructions, so verdicts are comparable across
// families. (Extracted from the old judgeAgent body, unchanged.)
function judgePrompt(j, ctx) {
  return (
    `You are the ${j.key} Assay (Forge PANEL.md, Stage 2). FRESH context. You are given ONLY the ` +
    `unit's diff, the SEAMS spec, and the implementer's step->verify chain — judge from those alone.\n` +
    `Remit: ${j.brief}.\n` +
    `Rules: cite a concrete file:line for EVERY finding; declare mode HARD or ADVISORY explicitly ` +
    `(silent degradation to advisory is a failure); default to verdict=BLOCK if you cannot verify a claim.\n` +
    `The DIFF below is authoritative. If you inspect the tree, use \`git -C "${ctx.worktree}"\` / files under ` +
    `"${ctx.worktree}" — the default cwd is the main checkout and lacks these changes.\n\n` +
    `=== DIFF (git diff main...${ctx.branch}) ===\n${ctx.diff}\n\n` +
    `=== SEAMS ===\n${ctx.seams}\n\n=== STEP->VERIFY ===\n${ctx.stepVerify || '(none provided)'}\n`
  );
}

// Today's Sonnet/Opus path: a native Claude agent IS the judge. Used for opus judges and
// as the graceful fallback when a CLI judge degrades.
function claudeJudge(j, ctx, model) {
  return agent(
    judgePrompt(j, ctx) +
    `\nReturn ONLY a JSON object: {judge, verdict:PASS|BLOCK, mode:HARD|ADVISORY, citation, reason}.`,
    { phase: 'Panel', label: `assay:${j.key}`, model, schema: VERDICT })
    // ALWAYS stamp the canonical key (agents return free-text judge names like
    // "Correctness Assay (Stage 2)"); the re-judge selector matches on j.key, so a
    // free-text name would make the re-judge set empty and merge a fix unverified.
    .then(v => v ? { ...v, judge: j.key } : null);
}

// CLI judge command builders — mirror run_triad.sh EXACTLY, incl. the no-train screen.
// The judge brief is written to a TEMP FILE (heredoc) and passed to the model via that
// file (codex: positional `"$(cat $BRIEF)"`; OpenRouter: `jq --rawfile`), NEVER inlined
// on argv — the diff contains backticks/$/quotes/newlines and is multi-KB (ARG_MAX).
function codexCmd(model, worktree) {
  // `timeout 600` — codex exec has NO built-in cap; a hung Codex must not stall the panel.
  // Capture the final message from the -o file, then cat it back to stdout for the courier.
  return (
    `OUT=$(mktemp); ` +
    // `</dev/null` is REQUIRED: without a stdin redirect, `codex exec` blocks on
    // "Reading additional input from stdin..." and `timeout 600` kills it (exit 124),
    // yielding empty output -> every Codex judge would silently degrade to Sonnet.
    `timeout 600 codex exec --skip-git-repo-check -C "${worktree}" -s read-only ` +
    `-m "${model}" -o "$OUT" "$(cat "$BRIEF")" </dev/null >/dev/null 2>&1; ` +
    `cat "$OUT" 2>/dev/null`
  );
}
function orCurlCmd(model) {
  // Replicate run_triad.sh:47-67 VERBATIM, especially provider.data_collection:"deny"
  // (+ allow_fallbacks, NO only/ignore allowlist — that is the WHOLE no-train screen).
  // Source the key from loopy-engine/.env (NOT the dead agent-loop/.env).
  return (
    `if [ -z "\${OPENROUTER_API_KEY:-}" ]; then ` +
    `export OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "${LOOPY_ENV}" | head -n1 | cut -d= -f2- | tr -d '\\r"'"'"'')"; fi; ` +
    `REQ=$(mktemp); ` +
    `jq -n --rawfile p "$BRIEF" --arg m "${model}" ` +
    `'{model:$m, messages:[{role:"user",content:$p}], max_tokens:48000, temperature:0.2, ` +
    `reasoning:{max_tokens:8000}, provider:{data_collection:"deny", allow_fallbacks:true}}' > "$REQ"; ` +
    `curl -sS --max-time 600 https://openrouter.ai/api/v1/chat/completions ` +
    `-H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" ` +
    `-H "HTTP-Referer: https://localhost/triad" -H "X-Title: triad-orchestration" ` +
    `-d @"$REQ" | jq -rc '.choices[0].message.content // ""'`
  );
}

// A Bash transport for REAL cross-family judges. The courier (a cheap Sonnet agent) ONLY
// runs the shell command and parses the JSON the cross-family model emits — it is NOT the
// judge. The ACTUAL judgment happens in the CLI (Codex) or OpenRouter (DeepSeek) model
// inside the command. The brief is written to a temp file ($BRIEF) via heredoc so the diff
// passes literally. Empty/errored/non-JSON return -> null (caller degrades, never silent-PASS).
function shellJudge(j, ctx, backend, model) {
  const brief = judgePrompt(j, ctx) +
    `\nAnswer with ONLY a JSON object (no prose, no code fences) matching: ` +
    `{judge, verdict:PASS|BLOCK, mode:HARD|ADVISORY, citation, reason}. ` +
    `If you cannot verify a claim, default to verdict=BLOCK.`;
  const cmd = backend === 'codex' ? codexCmd(model, ctx.worktree) : orCurlCmd(model);
  return agent(
    `You are a SHELL RUNNER / transport — NOT the judge. Do EXACTLY this, add no opinion of your own:\n` +
    `1. Write the JUDGE BRIEF below to a temp file with a quoted heredoc (so backticks/$/quotes pass ` +
    `   literally), e.g.:  BRIEF=$(mktemp); cat > "$BRIEF" <<'JUNO_BRIEF_EOF'\n<the brief>\nJUNO_BRIEF_EOF\n` +
    `2. Run the COMMAND below verbatim (it reads "$BRIEF" and prints the model's raw answer to stdout).\n` +
    `3. Capture the full stdout. STRIP any surrounding \`\`\`json / \`\`\` code fences. Then JSON.parse it.\n` +
    `4. Return that parsed object as your structured result, with judge="${j.key}".\n` +
    `DEGRADE CONTRACT: if the command errors, times out, prints empty (<50 bytes), or the output is NOT ` +
    `valid JSON after fence-stripping, return EXACTLY ` +
    `{"judge":"${j.key}","verdict":"BLOCK","mode":"ADVISORY","citation":"","reason":"CLI_JUDGE_EMPTY"} ` +
    `so the caller can detect degradation. Do NOT invent a verdict.\n\n` +
    `=== JUDGE BRIEF (write to the temp file) ===\n${brief}\n\n` +
    `=== COMMAND (run verbatim; it reads "$BRIEF") ===\n${cmd}\n`,
    { phase: 'Panel', label: `assay:${j.key}:${backend}`, model: 'sonnet', schema: VERDICT })
    // Treat the CLI_JUDGE_EMPTY sentinel as a degradation signal (-> null), same as a
    // dead agent — so judgeAgent falls back to a real Sonnet verdict, never a silent PASS.
    .then(v => (v && v.reason !== 'CLI_JUDGE_EMPTY') ? { ...v, judge: j.key } : null);
}

// Graceful, LOGGED fallback — never silent. A CLI judge that returns empty/errored/non-JSON
// falls back to a REAL Sonnet verdict (which itself defaults to BLOCK if it cannot verify),
// preserving the "un-run verification is not a pass" invariant. The log line makes the
// degraded cycle visible to the Ledger/BOARD (cross-family diversity LOST for this judge).
function degrade(j, ctx, backend) {
  log(`cycle: PANEL DEGRADE — ${backend} judge '${j.key}' returned empty/errored/non-JSON; ` +
      `falling back to a real Sonnet stand-in (cross-family diversity LOST for this judge).`);
  return claudeJudge(j, ctx, 'sonnet');
}

// Dispatch a judge to its backend. Call sites (jury :393, re-judge :231) are unchanged —
// they still call judgeAgent(j, ctx). opus -> native agent; codex/openrouter -> shellJudge
// transport with a degrade() fallback that can NEVER resolve to a silent PASS.
function judgeAgent(j, ctx) {
  const b = backendFor(j.family);
  if (b.kind === 'agent') return claudeJudge(j, ctx, b.model);
  if (b.kind === 'codex') return shellJudge(j, ctx, 'codex', b.model).then(v => v ?? degrade(j, ctx, 'codex'));
  return shellJudge(j, ctx, 'openrouter', b.model).then(v => v ?? degrade(j, ctx, 'openrouter')); // openrouter
}

function merge(n, item, verdicts, branch, writerPath) {
  const advisories = verdicts.filter(v => v.mode === 'ADVISORY');
  log(`cycle ${n}: MERGE-READY on ${branch} — unanimous HARD-PASS` +
      (advisories.length ? ` (+${advisories.length} advisory note(s) logged)` : '') + '.');
  return { n, item: lite(item), outcome: 'merged', branch, writerPath, verdicts, advisories };
}

function park(n, item, kind, reason, branch) {
  const outcome = kind === 'escalate' ? 'escalated' : (kind === 'reject' ? 'rejected' : 'parked');
  log(`cycle ${n}: ${outcome.toUpperCase()} — ${reason}`);
  // escalate/park fire an async, non-blocking notification (Stage 3); never stall on a human.
  return { n, item: lite(item), outcome, kind, reason, branch: branch || null };
}

// Overseer-style bounded auto-fix: fix the cited blockers, re-gate, re-convene ONLY the
// judges that blocked. After N attempts -> park 'blocked' + (async) notify, move on.
async function boundedFixOrPark(n, item, branch, hardBlocks, maxN, ctx) {
  let blocks = hardBlocks;
  for (let attempt = 1; attempt <= maxN; attempt++) {
    log(`cycle ${n}: HARD-BLOCK x${blocks.length} — bounded fix ${attempt}/${maxN}`);
    const brief = blocks.map(b => `- [${b.judge}] ${b.reason} @ ${b.citation || 'uncited'}`).join('\n');
    await agent(
      `In the worktree ${ctx.worktree} on branch ${branch}, fix ONLY these cited blockers; change ` +
      `nothing orthogonal (the Scope Auditor will re-check). Re-commit on ${branch}.\n${brief}`,
      { phase: 'Resolve', model: 'opus' });

    const gate = await runGate(branch, ctx.worktree);
    if (!gate.green) { blocks = [{ judge: 'gate', reason: 'objective gate red after fix', citation: (gate.raw || gate.diffStat || '').slice(0, 200) }]; continue; }

    const reJudges = ctx.active.filter(j => blocks.some(b => b.judge === j.key));
    if (!reJudges.length) {
      // Blockers don't map to any active judge — we CANNOT re-verify, so we must NOT
      // merge (the panel's "default to BLOCK if you cannot verify" applied to resolve).
      return park(n, item, 'blocked', `re-judge could not map blockers [${blocks.map(b => b.judge).join(', ')}] to active judges — refusing to merge unverified`, branch);
    }
    const fresh = (await parallel(reJudges.map(j => () => judgeAgent(j, ctx)))).filter(Boolean);
    if (fresh.length < reJudges.length) {
      // A re-judge died/returned null. An un-run verification is NOT a pass — keep the
      // unit blocked and let the next bounded attempt (or the park fallthrough) handle it.
      log(`cycle ${n}: ${reJudges.length - fresh.length} re-judge(s) returned nothing — treating as unresolved (no merge).`);
      continue;
    }
    const still = fresh.filter(v => v.mode === 'HARD' && v.verdict === 'BLOCK');
    if (!still.length) return merge(n, item, ctx.allVerdicts.concat(fresh), branch, ctx.writerPath);
    blocks = still;
  }
  return park(n, item, 'blocked', `HARD-BLOCK persisted after ${maxN} fix attempt(s): ${blocks.map(b => b.judge).join(', ')}`, branch);
}

// Durable audit (PANEL.md Stage 4). One Bash/Write agent persists the cycle so the
// script holds no file I/O. The Ledger is what prevents re-proposing killed ideas.
async function appendLedger(r) {
  const row = `| ${r.n} | ${r.item?.title || '?'} | ${r.outcome} | ${r.branch || '-'} | ${(r.reason || '').replace(/\n/g, ' ').slice(0, 140)} |`;
  await agent(
    `Persist the Forge cycle ${r.n} audit trail (use Write/Bash; report only "DONE").\n` +
    `1. Append this row to ${FORGE}/LEDGER.md under the "## Cycle outcomes" table; create the file ` +
    `   with header "| cycle | item | outcome | branch | reason |" + separator if it does not exist:\n${row}\n` +
    `2. Write ${FORGE}/cycle-${r.n}/PANEL_VERDICT.md containing this JSON pretty-printed as the verdict record:\n` +
    JSON.stringify(r, null, 2) + `\n` +
    `3. In ${FORGE}/BOARD.md move "${r.item?.title || '?'}" into the "${r.outcome}" lane (create lanes if missing).`,
    { phase: 'Resolve', model: 'sonnet' });
}

// Link-safe per-cycle worktree teardown. The build agent links the worktree's
// node_modules to main's — a Windows junction (mklink /J) OR a POSIX symlink (ln -s).
// `git worktree remove --force` FOLLOWS that link and would WIPE main's node_modules.
// So a tiny Bash agent removes ONLY the link first (Windows: plain rmdir, NO /S, on the
// reparse point; POSIX: rm -f, NO -r, on the symlink — neither recurses into the shared
// target), then removes the worktree. The branch is KEPT (merge-ready branches must
// persist for the conductor). Idempotent: missing worktree/link is a no-op. Verified
// safe by _forge/_tests/junction-cleanup.test.sh (main node_modules intact across teardown).
async function cleanupWorktree(branch) {
  const sl = String(branch).replace(/^forge\//, '');
  const worktree = worktreeFor(sl);
  await agent(
    `Tear down the Forge worktree for branch ${branch} (use Bash; report only "DONE"). ` +
    `LINK-SAFE — follow EXACTLY, the order is load-bearing:\n` +
    `1. Remove ONLY the node_modules link (junction on Windows / symlink on POSIX), guarded so it is a no-op if absent:\n` +
    `   ${unlinkNodeModulesCmd(worktree)}\n` +
    `   CRITICAL: this removes the LINK itself only — on Windows a plain rmdir with NO /S (never rmdir /S: it ` +
    `would recurse THROUGH the junction); on POSIX rm -f with NO -r (never rm -rf: it would follow the ` +
    `symlink). Either mistake would wipe main's ${REPO}/node_modules.\n` +
    `2. Then remove the worktree (now safe — no link to follow):\n` +
    `   git -C "${REPO}" worktree remove --force "${worktree}" 2>/dev/null; git -C "${REPO}" worktree prune\n` +
    `3. Do NOT delete the branch ${branch} — merge-ready branches must persist for the conductor to merge.\n` +
    `If the worktree is already gone, that is fine — report "DONE" regardless.`,
    { phase: 'Resolve', model: 'sonnet' });
}

// _forge/HALT kill-switch (Constitution / ROSTER Guardrails). Script has no fs, so a
// tiny agent stats the file each cycle.
async function halted() {
  const res = await agent(
    `Bash one-liner: test -f "${FORGE}/HALT" && echo HALTED || echo OK . Output ONLY that single word.`,
    { phase: 'Scout', model: 'sonnet' });
  return /HALTED/.test(String(res || '').trim().split(/\s+/).pop() || '');
}

// ============================================================================
// the cycle
// ============================================================================

async function runCycle(n, opts) {
  const { forceItem, maxFix } = opts;

  // -- Scout: cheap fan-out, grounded against Target State + Ledger ------------
  phase('Scout');
  const scouted = await agent(
    `Read ${FORGE}/TARGET_STATE.md, ${FORGE}/LEDGER.md (may not exist yet) and ${FORGE}/CONSTITUTION.md. ` +
    `Research the top open gaps (the Hermes doc at ${REPO}/"Hermes Agent Architecture.md", the Juno code ` +
    `under ${REPO}/src + tests, and ${FORGE}/KNOWLEDGE/). Propose candidates NOT already done/rejected in ` +
    `the Ledger, each scored 0-5 on the 6-axis fit rubric with keys exactly: ${SCORE_AXES.join(', ')} ` +
    `(constitution=Constitution-compliance, targetValue=Target-State-value, ui=UI-cohesion, ` +
    `architecture=architectural-fit, simplicity, risk=risk/size where 5=safest/smallest). Set blocked=true ` +
    `if a candidate's deps are unmet.` +
    (forceItem ? ` IMPORTANT: include a candidate titled to match "${forceItem}" with its honest scores.` : ''),
    { phase: 'Scout', model: 'sonnet', schema: CANDIDATES });
  if (!scouted?.candidates?.length) return { n, outcome: 'no-candidates' };

  // -- Filter: pick top item passing the rubric gate --------------------------
  phase('Filter');
  const item = pickTop(scouted.candidates, forceItem);
  if (!item) return { n, outcome: 'all-below-threshold' };
  const sl = slug(item.title);
  log(`cycle ${n}: ${item.title} (closes: ${item.gap}) -> forge/${sl}`);

  // -- Forge: scope a SEAMS, then triad-implement on an isolated forge/* worktree
  phase('Forge');
  const arch = await agent(
    `Scope a SEAMS spec for "${item.title}" per ${FORGE}/CONSTITUTION.md. Gap: ${item.gap}. ` +
    `Pin frozen seams FIRST. Constitution I.3: contracts.ts / events / reducer are ADDITIVE-OPTIONAL only. ` +
    `Set escalate=true ONLY if the item must ALTER or REMOVE an EXISTING field/signature in those three ` +
    `files — adding a NEW optional field or a NEW event variant is additive and ALLOWED (escalate=false). ` +
    `If escalate=true, give escalateReason naming the exact existing field. Put the full SEAMS spec in ` +
    `'seams' and a concrete step->verify chain in 'stepVerify'. Ground in the real Juno code under ${REPO}/src.`,
    { phase: 'Forge', model: 'opus', schema: SEAMS });

  if (arch.escalate) {
    return park(n, item, 'escalate', `frozen-seam change required: ${arch.escalateReason || '(unspecified)'}`);
  }
  const seams = arch.seams;
  const archStepVerify = arch.stepVerify;
  const wt = worktreeFor(sl); // the isolated forge worktree (sibling of REPO); same path cleanupWorktree removes.

  const built = await agent(
    `BUILD "${item.title}" using the Forge triad discipline. Repo: ${REPO} (git; branch "main" is the green baseline).\n` +
    `STEP 1 — isolate: create a real git worktree (reuse if it exists):\n` +
    `  git -C "${REPO}" worktree add "${wt}" -b "forge/${sl}" main\n` +
    `  Worktree = ${wt}. node_modules is gitignored, so link it so the gate can run:\n` +
    `  ${linkNodeModulesCmd(wt)}\n` +
    `STEP 2 — read the SEAMS below + the relevant Juno code (src/, tests/streamingTurn.test.ts).\n` +
    `STEP 3 — cross-family writers: write a self-contained brief to the worktree's _forge_brief.md, then:\n` +
    `  ensure OPENROUTER_API_KEY is set (it is normally in env; else: export $(grep -E '^OPENROUTER_API_KEY=' "${LOOPY_ENV}" | tr -d '\\r')).\n` +
    `  OR_MODEL="${OR_WRITER}" CODEX_CWD="${wt}" bash "${TRIAD}" "${wt}/_forge_brief.md" "${wt}/_triad_out"\n` +
    `  (Writer B = ${OR_WRITER}, a fast non-reasoning coder — GLM 5.2 is intentionally NOT used here.)\n` +
    `  -> draft_codex.md + draft_openrouter.md.\n` +
    `STEP 4 — as the Opus SYNTHESIZER, merge the stronger half of each draft and APPLY real code into the ` +
    `worktree (implement the feature AND add tests; honour the step->verify). If one draft is empty set ` +
    `writerPath="degraded" and synthesize from the non-empty one; if run_triad fully fails, implement ` +
    `directly and set writerPath="opus-fallback" — NEVER block the cycle on the writers.\n` +
    `STEP 5 — git add + commit on forge/${sl}. Do NOT touch main. Do NOT push.\n` +
    `STEP 6 — return: branch, worktree path, writerPath, the FULL unified diff (git -C <worktree> diff main...forge/${sl}), ` +
    `diffStat, and the step->verify chain you implemented.\n\n=== SEAMS ===\n${seams}`,
    { phase: 'Forge', schema: BUILT });
  if (!built?.branch) return park(n, item, 'reject', 'build agent returned no branch (build failed or rate-limited)');

  // -- Gate: objective check, re-run by the orchestrator, never trusted --------
  phase('Gate');
  const gate = await runGate(built.branch, built.worktree);

  // -- Panel Stage 0: GOLD_HAT pre-filter -------------------------------------
  phase('Panel');
  const goldhat = await agent(
    `GOLD_HAT pre-filter (PANEL.md Stage 0). The unit lives on branch ${built.branch} in the git worktree ` +
    `"${built.worktree}". CRITICAL: the default working directory is the MAIN checkout and is ALWAYS on ` +
    `'main' with these changes absent — run EVERY git / grep / file check with \`git -C "${built.worktree}"\` ` +
    `or against files under "${built.worktree}", NEVER the default cwd, or you will falsely see 'main' and an ` +
    `unchanged tree. Verify the worktree branch with \`git -C "${built.worktree}" branch --show-current\`.\n` +
    `Hard-reject (pass=false) on ANY of: objective gate not green; empty-diff (the committed forge/* tree is ` +
    `unchanged vs main); a frozen-seam violation in contracts.ts/events/reducer that is NOT additive-optional ` +
    `(set escalate=true for this one); any FROZEN Constitution rule tripped (--bare, per-token billing, ` +
    `permission floor, or the WORKTREE not on a forge/* branch). Else pass=true.\n\n` +
    `GATE: ${JSON.stringify({ tsc: gate.tsc, vitest: gate.vitest, build: gate.build, diffPresent: gate.diffPresent, green: gate.green, diffStat: gate.diffStat })}\n\n` +
    `DIFF (authoritative — git diff main...${built.branch}):\n${built.diff}`,
    { phase: 'Panel', model: 'opus', schema: GOLDHAT });
  if (!goldhat.pass) return park(n, item, goldhat.escalate ? 'escalate' : 'reject', `GOLD_HAT: ${goldhat.reason}`, built.branch);

  // -- Panel Stage 1: triage (which judges activate) --------------------------
  const triage = await agent(
    `Triage the diff (PANEL.md Stage 1): does it touch src/core|providers|tools|contracts (touchesCore)? ` +
    `Is it UI-visible — .tsx / render / palette / status line (touchesUi)? New capability vs refactor? ` +
    `One-line note per axis.\n\nDIFF:\n${built.diff}`,
    { phase: 'Panel', model: 'sonnet', schema: TRIAGE });

  const active = JUDGES.filter(j => j.always || triageTouches(triage, j.when));
  log(`cycle ${n}: panel = [${active.map(j => j.key).join(', ')}] (triage: core=${triage.touchesCore} ui=${triage.touchesUi})`);

  // -- Panel Stage 2: the Assay jury (fresh context, cited verdicts) ----------
  const ctx = { branch: built.branch, worktree: built.worktree, diff: built.diff,
    seams, stepVerify: built.stepVerify || archStepVerify, active, writerPath: built.writerPath, allVerdicts: [] };
  const verdicts = (await parallel(active.map(j => () => judgeAgent(j, ctx)))).filter(Boolean);
  ctx.allVerdicts = verdicts;

  // QUORUM: every active judge must return a verdict. judgeAgent's Codex/OpenRouter paths
  // always degrade to a real Sonnet verdict, but a native opus judge (goal/arch/ui/arbiter)
  // can return null if its agent dies, and the `.filter(Boolean)` above would silently drop it —
  // shrinking the panel and possibly slipping a merge on incomplete evidence. "Un-run
  // verification is not a pass": a missing judge => escalate (async notify), NEVER merge.
  if (verdicts.length < active.length) {
    return park(n, item, 'escalate',
      `panel incomplete — only ${verdicts.length}/${active.length} judge(s) returned a verdict; ` +
      `refusing to merge on incomplete evidence`, built.branch);
  }

  // -- Resolve: unanimous HARD-PASS merges; any HARD-BLOCK -> bounded fix or park
  phase('Resolve');
  const hardBlocks = verdicts.filter(v => v.mode === 'HARD' && v.verdict === 'BLOCK');
  if (hardBlocks.length === 0) return merge(n, item, verdicts, built.branch, built.writerPath);
  return boundedFixOrPark(n, item, built.branch, hardBlocks, maxFix, ctx);
}

// ============================================================================
// driver — self-chaining until budget (autonomous) OR a bounded supervised run
// ============================================================================
const results = [];
// args may arrive as an object or (defensively) a JSON string — normalize both.
let A = args;
if (typeof A === 'string') { try { A = JSON.parse(A); } catch (e) { A = {}; } }
A = A || {};

// -- ZERO-TOKEN DRY-RUN: resolve paths + emit the platform command plan, then STOP. -----
// No agent(), no commits, no cycle. Everything below is derived from the SAME `<forge:paths>`
// seam the build (create) and cleanupWorktree (remove) steps use, so the plan a supervisor
// executes is byte-identical to what a real cycle would run — proving the OS branch of
// link/unlink + worktree create/remove without spending a token. Returns the plan object.
if (A.dryRun) {
  const sl = slug(A.forceItem || 'dry-run');
  const wt = worktreeFor(sl);
  const plan = {
    dryRun: true,
    platform: process.platform,
    isWin: IS_WIN,
    slug: sl,
    branch: `forge/${sl}`,
    paths: { SRC, REPO, FORGE, HOME, TRIAD, LOOPY_ENV, worktree: wt },
    commands: {
      create: `git -C "${REPO}" worktree add "${wt}" -b "forge/${sl}" main`,
      link: linkNodeModulesCmd(wt),
      unlink: unlinkNodeModulesCmd(wt),
      remove: `git -C "${REPO}" worktree remove --force "${wt}"; git -C "${REPO}" worktree prune`,
    },
  };
  log(`dry-run: platform=${plan.platform} repo=${REPO} worktree=${wt}`);
  log(`dry-run: create = ${plan.commands.create}`);
  log(`dry-run: link   = ${plan.commands.link}`);
  log(`dry-run: unlink = ${plan.commands.unlink}`);
  log(`dry-run: remove = ${plan.commands.remove}`);
  return plan;
}

const maxCycles = (A.maxCycles ?? Infinity);       // supervised dry-run: 1
const forceItem = (A.forceItem ?? null);           // supervised dry-run: pin the item
const maxFix = (A.maxFix ?? 3);                     // overseer bound (dry-run: 1)
// Cycle number: an explicit startCycle wins (cron re-invocation passes it); otherwise
// AUTO-DETECT the next number from the Ledger's highest existing row. A bare `?? 1`
// default made every fresh supervised run reuse n=1, duplicating the cycle-1 Ledger row
// and OVERWRITING _forge/cycle-1/PANEL_VERDICT.md. Reading the Ledger makes n self-correct.
let n;
if (A.startCycle != null) {
  n = A.startCycle;
} else {
  const maxRow = await agent(
    `Bash one-liner only. Read ${FORGE}/LEDGER.md and print ONLY the largest integer that appears as a ` +
    `cycle number in the first column of the "## Cycle outcomes" table rows (lines like "| 6 | ..."). ` +
    `If the file or table is absent, print 0. Output just that one number, nothing else.`,
    { phase: 'Scout', model: 'sonnet' });
  const max = parseInt(String(maxRow ?? '').match(/\d+/)?.[0] ?? '0', 10) || 0;
  n = max + 1;
  log(`driver: no startCycle given — auto-detected next cycle ${n} from the Ledger (max existing = ${max}).`);
}
log(`driver: startCycle=${n} maxCycles=${maxCycles} forceItem=${forceItem ?? '(none)'} maxFix=${maxFix} budget.total=${budget.total}`);
let ran = 0;

while (true) {
  if (ran >= maxCycles) break;
  // autonomous mode requires budget headroom; supervised (finite maxCycles) ignores budget.
  if (maxCycles === Infinity && !(budget.total && budget.remaining() > 120_000)) break;
  if (await halted()) { log('HALT file present — parking the loop.'); break; }

  const r = await runCycle(n, { forceItem, maxFix });
  results.push(r);
  await appendLedger(r);                            // durable; prevents re-proposal
  if (r.branch) await cleanupWorktree(r.branch);    // junction-safe teardown; keeps the branch
  log(`cycle ${n} -> ${r.outcome}${r.branch ? ' (' + r.branch + ')' : ''}`);
  n += 1; ran += 1;
}

// perpetual continuation is a conductor-level cron re-invoking this script with
// args.startCycle = n; intra-run we just burn the budget target (autonomous mode).
return { ran: results.length, results };
