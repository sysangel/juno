// boundedFixOrPark.check.mjs — deterministic, ZERO-TOKEN (no model calls) proof
// harness for two bug-fixes in _forge/forge-cycle.js's boundedFixOrPark.
//
//   Bug 3 fix  — judgeAgent stamps the canonical j.key (the `.then` at src line 193),
//                so the re-judge selector at src line 225 can match.
//   Bug 4a fix — empty reJudges -> park 'blocked' (refuse to merge unverified), src 226-230.
//   Bug 4b fix — a re-judge returned null/died (fresh.length < reJudges.length)
//                -> log + continue (no merge); park after maxN, src 232-242.
//
// HOW: the four units (judgeAgent / merge / park / boundedFixOrPark) plus their
// support fns (familyModel / lite / VERDICT) are LIFTED VERBATIM (byte-identical)
// from forge-cycle.js. The Workflow-injected globals they close over
// (agent / parallel / log / runGate) are provided as deterministic stubs. Each
// scenario asserts BOTH the post-fix outcome AND a clearly-labelled PRE-FIX MUTANT
// whose missing guard flips the outcome to a wrong merge.
//
// Run: cd C:\Users\Core\src\juno && node _forge/_tests/boundedFixOrPark.check.mjs

// =====================================================================
// INJECTABLE / STUBBED DEPS (these are Workflow globals in prod)
// =====================================================================
const _logs = [];
function log(s) { _logs.push(s); }                         // no-op (records)
const parallel = (thunks) => Promise.all(thunks.map(t => t()));   // real semantics
let _xfamWarned = false;                                   // referenced by familyModel

// Per-scenario control surface.
//   CFG.gate          -> what runGate resolves to
//   CFG.judge(key)    -> what the underlying judge agent() returns for assay:<key>
//                        (judgeAgent's .then does the stamping on top of this)
let CFG = { gate: { green: true }, judge: () => null };

// The Workflow agent(). Two call-sites reach it inside the units under test:
//   phase 'Resolve' = the bounded-fix step (src 217)  -> no-op, resolves null
//   phase 'Panel'   = a judge assay   (src 179)        -> CFG.judge(<key>)
async function agent(_prompt, opts = {}) {
  if (opts.phase === 'Resolve') return null;               // fix agent: no-op
  if (opts.phase === 'Panel') {
    const key = String(opts.label || '').replace(/^assay:/, '');
    return CFG.judge(key);
  }
  return null;
}

// runGate is stubbed wholesale (the real one calls agent w/ phase 'Gate').
async function runGate(_branch, _worktree) { return CFG.gate; }

// =====================================================================
// LIFTED VERBATIM from forge-cycle.js  (byte-identical copies)
//   VERDICT      : src lines 83-86
//   familyModel  : src lines 141-151
//   lite         : src line  159
//   judgeAgent   : src lines 178-194
//   merge        : src lines 196-201
//   park         : src lines 203-208
//   boundedFixOrPark : src lines 210-243
// =====================================================================

const VERDICT = { type: 'object', properties: {
  judge: { type: 'string' }, verdict: { enum: ['PASS', 'BLOCK'] },
  mode: { enum: ['HARD', 'ADVISORY'] }, citation: { type: 'string' }, reason: { type: 'string' },
}, required: ['judge', 'verdict', 'mode', 'reason'] };

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

function lite(item) { return { title: item.title, gap: item.gap }; }

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
    // ALWAYS stamp the canonical key (agents return free-text judge names like
    // "Correctness Assay (Stage 2)"); the re-judge selector matches on j.key, so a
    // free-text name would make the re-judge set empty and merge a fix unverified.
    .then(v => v ? { ...v, judge: j.key } : null);
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

// =====================================================================
// PRE-FIX MUTANTS — DO NOT use in prod. Each is `boundedFixOrPark` with a
// guard surgically removed to reproduce the original (buggy) behavior.
// =====================================================================

// PRE-FIX MUTANT (Bug 3): judgeAgent WITHOUT the canonical-key stamping.
// Returns the agent's free-text judge name verbatim (no `.then` rewrite).
function judgeAgent_nostamp(j, ctx) {
  return agent('(same prompt; stamping removed)',
    { phase: 'Panel', label: `assay:${j.key}`, model: familyModel(j.family), schema: VERDICT });
  // <-- PRE-FIX: no `.then(v => v ? { ...v, judge: j.key } : null)`
}

// PRE-FIX MUTANT (Bug 4a removed only): empty reJudges falls through to a merge.
async function boundedFixOrPark_no4a(n, item, branch, hardBlocks, maxN, ctx) {
  let blocks = hardBlocks;
  for (let attempt = 1; attempt <= maxN; attempt++) {
    const brief = blocks.map(b => `- [${b.judge}] ${b.reason} @ ${b.citation || 'uncited'}`).join('\n');
    await agent(`fix\n${brief}`, { phase: 'Resolve', model: 'opus' });
    const gate = await runGate(branch, ctx.worktree);
    if (!gate.green) { blocks = [{ judge: 'gate', reason: 'objective gate red after fix' }]; continue; }
    const reJudges = ctx.active.filter(j => blocks.some(b => b.judge === j.key));
    // <-- PRE-FIX: NO 4a guard here.
    const fresh = (await parallel(reJudges.map(j => () => judgeAgent(j, ctx)))).filter(Boolean);
    if (fresh.length < reJudges.length) { continue; }      // 4b still present
    const still = fresh.filter(v => v.mode === 'HARD' && v.verdict === 'BLOCK');
    if (!still.length) return merge(n, item, ctx.allVerdicts.concat(fresh), branch, ctx.writerPath);
    blocks = still;
  }
  return park(n, item, 'blocked', `persisted: ${blocks.map(b => b.judge).join(', ')}`, branch);
}

// PRE-FIX MUTANT (Bug 4b removed only): a null/short re-judge set is treated as a pass.
async function boundedFixOrPark_no4b(n, item, branch, hardBlocks, maxN, ctx) {
  let blocks = hardBlocks;
  for (let attempt = 1; attempt <= maxN; attempt++) {
    const brief = blocks.map(b => `- [${b.judge}] ${b.reason} @ ${b.citation || 'uncited'}`).join('\n');
    await agent(`fix\n${brief}`, { phase: 'Resolve', model: 'opus' });
    const gate = await runGate(branch, ctx.worktree);
    if (!gate.green) { blocks = [{ judge: 'gate', reason: 'objective gate red after fix' }]; continue; }
    const reJudges = ctx.active.filter(j => blocks.some(b => b.judge === j.key));
    if (!reJudges.length) {
      return park(n, item, 'blocked', `re-judge could not map blockers — refusing to merge unverified`, branch);
    }
    const fresh = (await parallel(reJudges.map(j => () => judgeAgent(j, ctx)))).filter(Boolean);
    // <-- PRE-FIX: NO 4b guard (no `if (fresh.length < reJudges.length) continue`).
    const still = fresh.filter(v => v.mode === 'HARD' && v.verdict === 'BLOCK');
    if (!still.length) return merge(n, item, ctx.allVerdicts.concat(fresh), branch, ctx.writerPath);
    blocks = still;
  }
  return park(n, item, 'blocked', `persisted: ${blocks.map(b => b.judge).join(', ')}`, branch);
}

// =====================================================================
// TEST RIG
// =====================================================================
function classify(r) {
  if (r.outcome === 'merged') return 'merged';
  if (r.outcome === 'parked' && r.kind === 'blocked') return 'blocked';
  return r.outcome;                                          // escalated/rejected/etc
}

const baseCtx = (active) => ({
  active,
  worktree: '/wt', branch: 'forge/x', diff: 'DIFF', seams: 'SEAMS',
  stepVerify: 'S->V', allVerdicts: [], writerPath: 'triad',
});
const ITEM = { title: 'demo', gap: 'g' };

let failures = [];
function check(label, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures.push(label);
}

async function S1() {
  console.log('S1 — Bug 3 (identity stamping) + bug3/bug4a interaction');
  const active = [{ key: 'correctness', family: 'cross', brief: 'b' }];

  // (a) DIRECT bug-3 proof: real judgeAgent stamps a free-text agent return -> j.key;
  //     the nostamp mutant leaves the free-text name (proves the `.then` is the stamp).
  CFG = { gate: { green: true }, judge: () => ({ judge: 'Correctness Assay (Stage 2)', mode: 'HARD', verdict: 'PASS', reason: 'ok', citation: 'f:1' }) };
  const stamped = await judgeAgent(active[0], baseCtx(active));
  const unstamped = await judgeAgent_nostamp(active[0], baseCtx(active));
  check('post-fix judgeAgent stamps judge="correctness"', stamped.judge === 'correctness');
  check('pre-fix judgeAgent_nostamp leaves free-text judge name', unstamped.judge === 'Correctness Assay (Stage 2)');

  // (b) happy path: canonical hardBlocks -> reJudges match -> PASS -> MERGE.
  const okPost = await boundedFixOrPark(1, ITEM, 'forge/x', [{ judge: 'correctness', reason: 'r', citation: 'f:1' }], 1, baseCtx(active));
  check('post-fix canonical block re-judges + merges', classify(okPost) === 'merged');

  // (c) FLIP: UNstamped (free-text) hardBlocks. Post-fix 4a guard refuses; pre-fix merges.
  const freeBlocks = [{ judge: 'Correctness Assay (Stage 2)', reason: 'r', citation: 'f:1' }];
  const post = await boundedFixOrPark(1, ITEM, 'forge/x', freeBlocks, 1, baseCtx(active));
  const pre = await boundedFixOrPark_no4a(1, ITEM, 'forge/x', freeBlocks, 1, baseCtx(active));
  check('post-fix free-text block -> blocked (4a guard)', classify(post) === 'blocked' && /refusing to merge unverified/.test(post.reason));
  check('pre-fix mutant free-text block -> WRONG merge (flip)', classify(pre) === 'merged');
}

async function S2() {
  console.log('S2 — Bug 4a: blockers map to no active judge -> PARK not merge');
  const active = [{ key: 'correctness', family: 'cross', brief: 'b' }];
  CFG = { gate: { green: true }, judge: () => ({ judge: 'correctness', mode: 'HARD', verdict: 'PASS', reason: 'ok' }) };
  const blocks = [{ judge: 'gate', reason: 'r', citation: 'c' }];
  const post = await boundedFixOrPark(2, ITEM, 'forge/x', blocks, 1, baseCtx(active));
  const pre = await boundedFixOrPark_no4a(2, ITEM, 'forge/x', blocks, 1, baseCtx(active));
  check('post-fix -> blocked w/ "refusing to merge unverified"', classify(post) === 'blocked' && /refusing to merge unverified/.test(post.reason));
  check('pre-fix mutant (no 4a) -> WRONG merge (flip)', classify(pre) === 'merged');
}

async function S3() {
  console.log('S3 — Bug 4b: a re-judge returns null/died -> no merge');
  const active = [
    { key: 'correctness', family: 'cross', brief: 'b' },
    { key: 'security', family: 'opus', brief: 'b' },
  ];
  // correctness PASSes; security agent returns null (died) -> judgeAgent yields null -> filtered out.
  CFG = { gate: { green: true }, judge: (k) => k === 'correctness'
    ? ({ judge: 'correctness', mode: 'HARD', verdict: 'PASS', reason: 'ok' })
    : null };
  const blocks = [{ judge: 'correctness', reason: 'r', citation: 'c' }, { judge: 'security', reason: 'r', citation: 'c' }];
  const post = await boundedFixOrPark(3, ITEM, 'forge/x', blocks, 1, baseCtx(active));
  const pre = await boundedFixOrPark_no4b(3, ITEM, 'forge/x', blocks, 1, baseCtx(active));
  check('post-fix short re-judge set -> blocked (4b continue -> park)', classify(post) === 'blocked');
  check('pre-fix mutant (no 4b) -> WRONG merge on 1 survivor (flip)', classify(pre) === 'merged');
}

async function S4() {
  console.log('S4 — control: genuine persistent HARD BLOCK -> PARK after maxN (never merges)');
  const active = [{ key: 'correctness', family: 'cross', brief: 'b' }];
  CFG = { gate: { green: true }, judge: () => ({ judge: 'correctness', mode: 'HARD', verdict: 'BLOCK', reason: 'still broken', citation: 'f:9' }) };
  const blocks = [{ judge: 'correctness', reason: 'r', citation: 'c' }];
  const r = await boundedFixOrPark(4, ITEM, 'forge/x', blocks, 1, baseCtx(active));
  check('post-fix -> blocked ("HARD-BLOCK persisted")', classify(r) === 'blocked' && /HARD-BLOCK persisted/.test(r.reason));
  check('control never merges a real HARD BLOCK', classify(r) !== 'merged');
}

(async () => {
  await S1(); await S2(); await S3(); await S4();
  console.log('');
  if (failures.length) {
    console.log(`FAILURES: ${failures.length} -> ${failures.join(' | ')}`);
    process.exit(1);
  } else {
    console.log('ALL PASS — 4/4 scenarios green post-fix; all pre-fix mutations flip to a wrong merge.');
    process.exit(0);
  }
})();
