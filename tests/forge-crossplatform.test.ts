// tests/forge-crossplatform.test.ts
// Guards that _forge/forge-cycle.js is cross-platform: it must bake in NO absolute
// Windows path, and its node_modules link/unlink commands must branch on
// process.platform (a POSIX symlink on darwin/linux, a junction on win32).
//
// The path/platform logic lives in a self-contained `<forge:paths>` block that
// depends only on `process`. We extract that block VERBATIM from the source and
// eval it with a fake `process`, so we exercise the REAL code (no drift) under
// both a POSIX and a win32 environment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../_forge/forge-cycle.js', import.meta.url), 'utf8');

/** The shape the `<forge:paths>` block computes. */
interface ForgePaths {
  posix: (p: string) => string;
  winPath: (p: string) => string;
  SRC: string;
  REPO: string;
  FORGE: string;
  HOME: string;
  TRIAD: string;
  LOOPY_ENV: string;
  IS_WIN: boolean;
  worktreeFor: (sl: string) => string;
  link: (wt: string) => string;
  unlink: (wt: string) => string;
}

interface FakeProcess {
  platform: string;
  cwd: () => string;
  env: Record<string, string | undefined>;
}

/** Extract the marker-delimited block and eval it against a supplied `process`. */
function derive(proc: FakeProcess): ForgePaths {
  const block = SOURCE.split('// <forge:paths>')[1]?.split('// </forge:paths>')[0];
  if (block === undefined) throw new Error('forge-cycle.js is missing the <forge:paths> markers');
  const ret =
    'return { posix, winPath, SRC, REPO, FORGE, HOME, TRIAD, LOOPY_ENV, IS_WIN,' +
    ' worktreeFor, link: linkNodeModulesCmd, unlink: unlinkNodeModulesCmd };';
  const factory = new Function('process', `${block}\n${ret}`) as (p: FakeProcess) => ForgePaths;
  return factory(proc);
}

const posixProc = (over: Partial<FakeProcess> = {}): FakeProcess => ({
  platform: 'darwin',
  cwd: () => '/Users/dev/src',
  env: { HOME: '/Users/dev' },
  ...over,
});

const winProc = (over: Partial<FakeProcess> = {}): FakeProcess => ({
  platform: 'win32',
  cwd: () => 'C:/Users/Core/src',
  env: { USERPROFILE: 'C:/Users/Core' },
  ...over,
});

describe('forge-cycle.js is free of hardcoded Windows paths', () => {
  it('contains no absolute C: drive path or Users/Core anchor', () => {
    expect(SOURCE).not.toContain('C:/');
    expect(SOURCE).not.toContain('C:\\');
    expect(SOURCE).not.toMatch(/Users[\\/]+Core/);
    expect(SOURCE).not.toMatch(/Core[\\/]+src/);
  });

  it('branches its filesystem-link behavior on process.platform', () => {
    expect(SOURCE).toContain("process.platform === 'win32'");
  });

  it('derives every path from a single worktreeFor() source of truth', () => {
    // build (create) and cleanupWorktree (remove) must compute the identical path.
    expect(SOURCE).toContain('const wt = worktreeFor(sl)');
    expect(SOURCE).toContain('const worktree = worktreeFor(sl)');
  });
});

describe('POSIX (darwin/linux) derivation', () => {
  const p = derive(posixProc());

  it('roots the repo + forge dir at $CWD/juno', () => {
    expect(p.SRC).toBe('/Users/dev/src');
    expect(p.REPO).toBe('/Users/dev/src/juno');
    expect(p.FORGE).toBe('/Users/dev/src/juno/_forge');
    expect(p.IS_WIN).toBe(false);
  });

  it('derives TRIAD + LOOPY_ENV from $HOME and $SRC', () => {
    expect(p.TRIAD).toBe('/Users/dev/.claude/skills/triad/run_triad.sh');
    expect(p.LOOPY_ENV).toBe('/Users/dev/src/loopy-engine/.env');
  });

  it('places the worktree as a sibling of the repo', () => {
    expect(p.worktreeFor('fix-x')).toBe('/Users/dev/src/juno-forge-fix-x');
  });

  it('links node_modules with a POSIX symlink and tears it down with a non-recursive rm', () => {
    const wt = p.worktreeFor('fix-x');
    const link = p.link(wt);
    expect(link).toBe(`ln -s "${p.REPO}/node_modules" "${wt}/node_modules"`);
    expect(link).not.toContain('mklink');

    const unlink = p.unlink(wt);
    expect(unlink).toBe(`rm -f "${wt}/node_modules"`);
    // NEVER recursive / force-recursive — that would follow the symlink into the shared target.
    expect(unlink).not.toMatch(/rm\s+-\S*r/);
    expect(unlink).not.toContain('cygpath');
  });
});

describe('win32 derivation preserves the original behavior', () => {
  const p = derive(winProc());

  it('reproduces the pre-existing worktree + repo paths', () => {
    expect(p.REPO).toBe('C:/Users/Core/src/juno');
    expect(p.worktreeFor('fix-x')).toBe('C:/Users/Core/src/juno-forge-fix-x');
  });

  it('links node_modules with a mklink /J junction (backslash paths)', () => {
    const wt = p.worktreeFor('fix-x');
    const link = p.link(wt);
    expect(link).toBe(
      'cmd //c mklink /J "C:\\Users\\Core\\src\\juno-forge-fix-x\\node_modules"' +
        ' "C:\\Users\\Core\\src\\juno\\node_modules"',
    );
    expect(link).not.toContain('ln -s');
  });

  it('tears down the junction with a plain rmdir (never rmdir /S)', () => {
    const wt = p.worktreeFor('fix-x');
    const unlink = p.unlink(wt);
    expect(unlink).toContain('cmd /c rmdir');
    expect(unlink).toContain('cygpath -w');
    expect(unlink).not.toMatch(/rmdir\s+\/S/i);
  });

  it('falls back to %USERPROFILE% when $HOME is absent', () => {
    expect(p.TRIAD).toBe('C:/Users/Core/.claude/skills/triad/run_triad.sh');
  });
});

describe('environment overrides for CI relocation', () => {
  it('honors JUNO_SRC / JUNO_REPO / JUNO_TRIAD over the derived defaults', () => {
    const p = derive(
      posixProc({
        cwd: () => '/nowhere',
        env: {
          HOME: '/home/ci',
          JUNO_SRC: '/opt/src',
          JUNO_REPO: '/opt/src/juno',
          JUNO_TRIAD: '/opt/tools/run_triad.sh',
        },
      }),
    );
    expect(p.SRC).toBe('/opt/src');
    expect(p.REPO).toBe('/opt/src/juno');
    expect(p.TRIAD).toBe('/opt/tools/run_triad.sh');
    expect(p.worktreeFor('z')).toBe('/opt/src/juno-forge-z');
  });
});

// The <forge:paths> block above is only ~30 lines; the crossplatform tests eval THAT
// slice. But a syntax error anywhere else in forge-cycle.js would ship silently:
// `node --check` cannot validate the file standalone (its module-level `export const meta`
// plus top-level `await`/`return` are only legal once the Workflow runner strips the
// `export` and wraps the body in an async function). This suite reproduces that exact
// transform over the WHOLE file, so any syntax error anywhere fails CI.
describe('forge-cycle.js whole-file smoke: the Workflow runner can wrap it', () => {
  // Constructs (parses) an async function body but never executes it — enough to surface
  // any SyntaxError. `Function`/AsyncFunction accept undeclared free variables, so the
  // param list need not be complete for the parse; we pass the runner's real injected
  // globals for fidelity.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
  // The identifiers the Workflow runtime injects into the wrapped module body.
  const INJECTED = ['args', 'budget', 'agent', 'parallel', 'phase', 'log'];
  // The runner's transform: drop the module-level `export` keyword (only `export const meta`
  // matches — it is the sole line-leading export in the file).
  const normalized = SOURCE.replace(/^export\s+/gm, '');

  it('cannot wrap the RAW source — the module-level `export` genuinely must be normalized', () => {
    // Guards that the normalization is load-bearing: without it the file is a hard
    // SyntaxError inside a function body, so a broken transform could never silently pass.
    expect(() => new AsyncFunction(...INJECTED, SOURCE)).toThrow(/export/);
    expect(normalized).not.toBe(SOURCE); // the strip actually changed something
  });

  it('wraps the ENTIRE normalized file body with no syntax error (whole-file parse gate)', () => {
    let fn: unknown = null;
    expect(() => { fn = new AsyncFunction(...INJECTED, normalized); }).not.toThrow();
    // It really is an async function — the body relies on top-level await + return.
    expect((fn as { constructor: unknown }).constructor).toBe(AsyncFunction);
  });

  it('genuinely needs the ASYNC wrapper — a sync Function rejects the top-level await', () => {
    // Confirms the file uses top-level await (so `node --check` / a sync wrap is not a
    // valid substitute) and that the async gate above is exercising the real grammar.
    expect(() => new Function(...INJECTED, normalized)).toThrow(/await is only valid/);
  });

  it('references every injected Workflow global, so the wrapper param list stays honest', () => {
    for (const g of INJECTED) expect(SOURCE).toMatch(new RegExp(`\\b${g}\\b`));
  });

  it('exposes a zero-token dryRun plan branch that returns before any agent() call', () => {
    // The dry-run guard must sit above the cycle loop and return a plan without touching
    // agent(); a regression that moved it below the loop would spend tokens on `vitest run`
    // of the real script. We assert the source shape, not execution (execution is the
    // out-of-band _forge/_tests/dryrun-darwin.mjs proof).
    expect(SOURCE).toMatch(/if \(A\.dryRun\)/);
    const dryRunAt = SOURCE.indexOf('if (A.dryRun)');
    const loopAt = SOURCE.indexOf('while (true)');
    expect(dryRunAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(dryRunAt); // dryRun short-circuits before the cycle loop
  });
});
