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
// Cross-family writers (GLM 5.2 / Codex 5.5) run via run_triad.sh invoked by the
// Bash-capable Build agent inside a real git worktree; Claude-family roles use agent()
// directly. Workflow agent() can only spawn Claude-family models, so cross-family PANEL
// judges are approximated by Sonnet in this path (logged degradation; the genuine
// GLM/Codex judge path is a documented post-dry-run hardening item).

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

// --- paths (absolute; the Workflow cwd is C:/Users/Core/src) ------------------
const REPO = 'C:/Users/Core/src/juno';
const FORGE = `${REPO}/_forge`;
const TRIAD = 'C:/Users/Core/.claude/skills/triad/run_triad.sh';
const LOOPY_ENV = 'C:/Users/Core/src/loopy-engine/.env'; // OpenRouter key fallback (agent-loop/.env is gone)
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
  { key: 'assumptions', family: 'opus',  always: true,  brief: 'undeclared scope decisions / silent assumptions' },
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
function qualifies(c) {
  const s = c.scores || {};
  if (SCORE_AXES.some(a => typeof s[a] !== 'number')) return false;
  if (SCORE_AXES.some(a => s[a] < 3)) return false;
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

let _xfamWarned = false;
function familyModel(family) {
  if (family === 'opus') return 'opus';
  // cross/glm/codex: Workflow agent() can only spawn Claude-family models. Native
  // approximation = Sonnet (different model + fresh context than the Opus implementer).
  if (!_xfamWarned) {
    log('NOTE: cross-family panel judges (correctness/complexity/scope) run on Sonnet in the ' +
        'Workflow-native path; genuine GLM/Codex judging is a documented post-dry-run hardening item.');
    _xfamWarned = true;
  }
  return 'sonnet';
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
    `Run (PowerShell or bash):\n` +
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

function judgeAgent(j, ctx) {
  return agent(
    `You are the ${j.key} Assay (Forge PANEL.md, Stage 2). FRESH context. You are given ONLY the ` +
    `unit's diff, the SEAMS spec, and the implementer's step->verify chain — judge from those alone.\n` +
    `Remit: ${j.brief}.\n` +
    `Rules: cite a concrete file:line for EVERY finding; declare mode HARD or ADVISORY explicitly ` +
    `(silent degradation to advisory is a failure); default to verdict=BLOCK if you cannot verify a claim.\n` +
    `The DIFF below is authoritative. If you inspect the tree, use \`git -C "${ctx.worktree}"\` / files under ` +
    `"${ctx.worktree}" — the default cwd is the main checkout and lacks these changes.\n\n` +
    `=== DIFF (git diff main...${ctx.branch}) ===\n${ctx.diff}\n\n` +
    `=== SEAMS ===\n${ctx.seams}\n\n=== STEP->VERIFY ===\n${ctx.stepVerify || '(none provided)'}\n`,
    { phase: 'Panel', label: `assay:${j.key}`, model: familyModel(j.family), schema: VERDICT })
    .then(v => v ? { ...v, judge: v.judge || j.key } : null);
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
    const fresh = (await parallel(reJudges.map(j => () => judgeAgent(j, ctx)))).filter(Boolean);
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

  const built = await agent(
    `BUILD "${item.title}" using the Forge triad discipline. Repo: ${REPO} (git; branch "main" is the green baseline).\n` +
    `STEP 1 — isolate: create a real git worktree (reuse if it exists):\n` +
    `  git -C "${REPO}" worktree add "C:/Users/Core/src/juno-forge-${sl}" -b "forge/${sl}" main\n` +
    `  Worktree = C:/Users/Core/src/juno-forge-${sl}. node_modules is gitignored, so link it so the gate can run:\n` +
    `  cmd //c mklink /J "C:\\\\Users\\\\Core\\\\src\\\\juno-forge-${sl}\\\\node_modules" "C:\\\\Users\\\\Core\\\\src\\\\juno\\\\node_modules"\n` +
    `STEP 2 — read the SEAMS below + the relevant Juno code (src/, tests/streamingTurn.test.ts).\n` +
    `STEP 3 — cross-family writers: write a self-contained brief to the worktree's _forge_brief.md, then:\n` +
    `  ensure OPENROUTER_API_KEY is set (it is normally in env; else: export $(grep -E '^OPENROUTER_API_KEY=' "${LOOPY_ENV}" | tr -d '\\r')).\n` +
    `  OR_MODEL="${OR_WRITER}" CODEX_CWD="C:/Users/Core/src/juno-forge-${sl}" bash "${TRIAD}" "C:/Users/Core/src/juno-forge-${sl}/_forge_brief.md" "C:/Users/Core/src/juno-forge-${sl}/_triad_out"\n` +
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
let n = (A.startCycle ?? 1);
const maxCycles = (A.maxCycles ?? Infinity);       // supervised dry-run: 1
const forceItem = (A.forceItem ?? null);           // supervised dry-run: pin the item
const maxFix = (A.maxFix ?? 3);                     // overseer bound (dry-run: 1)
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
  log(`cycle ${n} -> ${r.outcome}${r.branch ? ' (' + r.branch + ')' : ''}`);
  n += 1; ran += 1;
}

// perpetual continuation is a conductor-level cron re-invoking this script with
// args.startCycle = n; intra-run we just burn the budget target (autonomous mode).
return { ran: results.length, results };
