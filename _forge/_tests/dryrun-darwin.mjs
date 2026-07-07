// dryrun-darwin.mjs — ZERO-TOKEN, isolated end-to-end proof of forge-cycle.js's POSIX
// (darwin/linux) worktree + node_modules-link mechanics. No model is invoked and the
// real juno checkout is never touched: the harness stands up a THROWAWAY git repo in a
// temp dir laid out exactly like production (a repo named `juno`, node_modules gitignored,
// a `main` branch), points the script at it with JUNO_SRC, then:
//
//   1. wraps forge-cycle.js the way the Workflow runner does (strip `export`, async-wrap
//      with the injected globals) and calls it with args={dryRun:true} to get the REAL
//      command plan the script would run — no drift from a hand-copied string;
//   2. executes that plan's create -> link -> unlink -> remove sequence on THIS OS and
//      asserts the darwin branch actually works: the link is a symlink into the shared
//      node_modules, and — the load-bearing safety property — tearing the link down with
//      `rm -f` (never `rm -r`) then `git worktree remove --force` leaves the shared
//      node_modules and its sentinel fully intact and the repo clean (no stray worktree).
//
// Sibling of _forge/_tests/junction-cleanup.test.sh (the Windows-junction analogue).
// Run: node _forge/_tests/dryrun-darwin.mjs   (exit 0 = all green)

import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL = 'do-not-delete-shared-node_modules';
let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures += 1;
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// --- stand up an isolated, production-shaped throwaway repo -------------------
const SRC = mkdtempSync(join(tmpdir(), 'juno-dryrun-'));
const REPO = join(SRC, 'juno');
try {
  mkdirSync(REPO, { recursive: true });
  const G = `git -c user.email=forge@local -c user.name=forge -C "${REPO}"`;
  sh(`git init -q -b main "${REPO}"`);
  writeFileSync(join(REPO, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(REPO, 'README.md'), '# throwaway forge dry-run repo\n');
  sh(`${G} add -A && ${G} commit -q -m init`);
  // node_modules is gitignored (as in juno) — a real dir with a sentinel we must NOT lose.
  mkdirSync(join(REPO, 'node_modules'), { recursive: true });
  writeFileSync(join(REPO, 'node_modules', 'SENTINEL.txt'), SENTINEL);

  // --- get the REAL command plan from the script's dryRun mode ----------------
  const source = readFileSync(new URL('../forge-cycle.js', import.meta.url), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const normalized = source.replace(/^export\s+/gm, ''); // the runner's export-normalization
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'phase', 'log', normalized);

  // Point the script at the throwaway via the env override it already supports; scrub any
  // other JUNO_* so nothing leaks in from the caller's shell.
  process.env.JUNO_SRC = SRC;
  for (const k of ['JUNO_REPO', 'JUNO_TRIAD', 'JUNO_LOOPY_ENV']) delete process.env[k];

  const logs = [];
  const noAgent = async () => { throw new Error('agent() must NOT be called in dryRun mode'); };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const budget = { total: 0, remaining: () => 0 };
  const plan = await fn({ dryRun: true, forceItem: 'darwin-smoke' }, budget, noAgent, parallel, () => {}, (s) => logs.push(s));

  console.log('PLAN');
  console.log(JSON.stringify(plan, null, 2));
  console.log('LOGS\n' + logs.map((l) => '  ' + l).join('\n'));

  const wt = plan.paths.worktree;
  const nm = join(wt, 'node_modules');
  const repoSentinel = join(REPO, 'node_modules', 'SENTINEL.txt');

  // --- plan shape: derived paths + POSIX (not Windows) command strings --------
  check('dryRun plan returned (no cycle ran)', plan && plan.dryRun === true);
  check('platform is this host', plan.platform === process.platform);
  check('REPO derived from JUNO_SRC/juno', plan.paths.REPO === REPO);
  check('worktree is the SRC/juno-forge-<slug> sibling', wt === join(SRC, 'juno-forge-darwin-smoke'));
  check('link uses a POSIX symlink (ln -s), not mklink', plan.commands.link.startsWith('ln -s') && !plan.commands.link.includes('mklink'));
  check('unlink is a non-recursive rm (never rm -r/-rf, never cygpath)', /^rm -f /.test(plan.commands.unlink) && !/rm\s+-\S*r/.test(plan.commands.unlink) && !plan.commands.unlink.includes('cygpath'));

  if (plan.isWin) {
    console.log('\nHost is win32 — the execution proof is junction-cleanup.test.sh; skipping POSIX exec.');
  } else {
    // --- execute the plan end-to-end on this darwin/linux host -----------------
    console.log('\nEXEC create'); sh(plan.commands.create);
    check('worktree created on disk', existsSync(wt));
    const onBranch = sh(`git -C "${wt}" branch --show-current`).trim();
    check('worktree is on the forge/<slug> branch', onBranch === plan.branch);
    check('git worktree list registers it', sh(`git -C "${REPO}" worktree list`).includes(wt));

    console.log('EXEC link'); sh(plan.commands.link);
    check('node_modules is a SYMLINK in the worktree', lstatSync(nm).isSymbolicLink());
    check('symlink resolves to the shared node_modules', realpathSync(nm) === realpathSync(join(REPO, 'node_modules')));
    check('sentinel is readable through the link', readFileSync(join(nm, 'SENTINEL.txt'), 'utf8') === SENTINEL);
    check('shared node_modules intact after link', readFileSync(repoSentinel, 'utf8') === SENTINEL);

    console.log('EXEC unlink'); sh(plan.commands.unlink);
    check('worktree node_modules link removed', !existsSync(nm) && !symlinkExists(nm));
    // THE load-bearing property: rm -f removed the LINK, never recursed into the target.
    check('shared node_modules SURVIVES unlink (no follow-through)', existsSync(repoSentinel) && readFileSync(repoSentinel, 'utf8') === SENTINEL);

    console.log('EXEC remove'); sh(plan.commands.remove);
    check('worktree directory removed', !existsSync(wt));
    check('no stray worktree left registered', !sh(`git -C "${REPO}" worktree list`).includes(wt));
    check('repo working tree is clean', sh(`git -C "${REPO}" status --porcelain`).trim() === '');
    check('shared node_modules intact after full teardown', existsSync(repoSentinel) && readFileSync(repoSentinel, 'utf8') === SENTINEL);
  }
} finally {
  rmSync(SRC, { recursive: true, force: true });
}

function symlinkExists(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

console.log('');
if (failures) { console.log(`FAILURES: ${failures}`); process.exit(1); }
console.log('ALL PASS — darwin worktree create/link/unlink/remove proven; shared node_modules never touched.');
process.exit(0);
