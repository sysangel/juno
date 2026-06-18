// forge-cycle.js — the Forge orchestration spine (Workflow script).
//
// Self-chaining until budget. One invocation runs cycles back-to-back until the
// token target is spent, then returns; a conductor-level cron re-invokes for
// perpetual operation. Reads its agenda fresh from _forge/*.md every cycle, so the
// trigger is static but the work is state-driven (the self-prompt).
//
// NOTE: not yet validated. Run ONE supervised cycle (manual) before enabling
// self-chaining + cron. Cross-family writers/judges (GLM 5.2 / Codex 5.5) run via
// `_orchestration/.../run_triad.sh` invoked by a Bash-capable agent; Claude-family
// roles use agent() directly.

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

const FORGE = 'juno/_forge';

// --- schemas (agents return validated objects) -------------------------------
const CANDIDATES = { type: 'object', properties: { candidates: { type: 'array', items: {
  type: 'object', properties: {
    title: { type: 'string' }, gap: { type: 'string' }, sketch: { type: 'string' },
    deps: { type: 'array', items: { type: 'string' } },
    scores: { type: 'object' }, // 6-axis fit-score per CONSTITUTION.md IV
  }, required: ['title', 'gap', 'scores'] } } }, required: ['candidates'] };

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

async function runCycle(n) {
  // -- Scout: cheap fan-out, grounded against Target State + Ledger ------------
  phase('Scout');
  const scouted = await agent(
    `Read ${FORGE}/TARGET_STATE.md, ${FORGE}/LEDGER.md and ${FORGE}/CONSTITUTION.md. ` +
    `Research the top open gaps (Hermes doc + Juno code + KNOWLEDGE/). Propose candidates ` +
    `NOT already done/rejected in the Ledger, each scored on the 6-axis fit rubric.`,
    { phase: 'Scout', model: 'sonnet', schema: CANDIDATES });
  if (!scouted?.candidates?.length) return { n, outcome: 'no-candidates' };

  // -- Filter: pick top item passing the rubric gate (>=3 all, >=4 Constitution+UI)
  phase('Filter');
  const item = pickTop(scouted.candidates); // deterministic: rubric + deps + not-blocked
  if (!item) return { n, outcome: 'all-below-threshold' };
  log(`cycle ${n}: ${item.title} (closes: ${item.gap})`);

  // -- Forge: scope a SEAMS, then triad-implement on an isolated forge/* worktree
  phase('Forge');
  const seams = await agent(`Scope a SEAMS_*.md for "${item.title}" per ${FORGE}/CONSTITUTION.md; ` +
    `pin frozen seams first; emit a step->verify chain.`, { phase: 'Forge', model: 'opus' });
  const built = await agent(
    `Implement "${item.title}" on branch forge/${slug(item.title)} in a worktree using the ` +
    `triad discipline (run_triad.sh: GLM 5.2 + Codex 5.5 writers, Opus synthesize). SEAMS:\n${seams}`,
    { phase: 'Forge', isolation: 'worktree' });

  // -- Gate: objective check, re-run by the orchestrator, never trusted ---------
  phase('Gate');
  const gate = await agent(`In the forge/${slug(item.title)} worktree run: tsc --noEmit; vitest run; build. ` +
    `Report exit codes + diff stat. Do not summarize success — report raw results.`,
    { phase: 'Gate', model: 'sonnet' });

  // -- Panel: GOLD_HAT pre-filter -> triage -> Assay jury ----------------------
  phase('Panel');
  const goldhat = await agent(`GOLD_HAT pre-filter per ${FORGE}/PANEL.md Stage 0 over the gate result ` +
    `and diff: empty-diff guard, gate-green, frozen-seam tripwire, Constitution FROZEN rules.\n${gate}`,
    { phase: 'Panel', model: 'opus', schema: GOLDHAT });
  if (!goldhat.pass) return park(n, item, goldhat.escalate ? 'escalate' : 'reject', goldhat.reason);

  const active = JUDGES.filter(j => j.always || triageTouches(gate, j.when));
  const verdicts = (await parallel(active.map(j => () =>
    agent(`You are the ${j.key} Assay (PANEL.md). Fresh context. Given ONLY the diff + SEAMS + ` +
      `step->verify chain, judge: ${j.brief}. Output verdict + mode(HARD|ADVISORY) + cited file:line.`,
      { phase: 'Panel', label: `assay:${j.key}`, model: familyModel(j.family), schema: VERDICT })
  ))).filter(Boolean);

  // -- Resolve: unanimous HARD-PASS merges; any HARD-BLOCK -> bounded fix or park
  phase('Resolve');
  const hardBlocks = verdicts.filter(v => v.mode === 'HARD' && v.verdict === 'BLOCK');
  if (hardBlocks.length === 0) return merge(n, item, verdicts);
  return boundedFixOrPark(n, item, hardBlocks, 3); // overseer-style N<=3, then park + notify
}

// --- self-chaining until budget ---------------------------------------------
const results = [];
let n = (args?.startCycle ?? 1);
while (budget.total && budget.remaining() > 120_000) {       // ~one cycle of headroom
  if (await halted()) { log('HALT file present — parking.'); break; }
  const r = await runCycle(n);
  results.push(r);
  appendLedger(r);                                            // durable, prevents re-proposal
  n += 1;
}
// perpetual continuation is a conductor-level cron re-invoking this script with
// args.startCycle = n; intra-run we just burn the budget target.
return { ran: results.length, results };

// helper stubs resolved at build time: pickTop, slug, triageTouches, familyModel,
// merge, park, boundedFixOrPark, appendLedger, halted (checks _forge/HALT).
