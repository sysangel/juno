// tests/selftest.pty.test.ts
// WAVE 8 (lane selftest-harness) — the vitest face of the automated render-feedback
// loop. It imports the SAME scenario table + runner that `npm run selftest` uses
// (scripts/selftest.ts), so the assertions asserted in CI can never drift from the
// frames written for human/agent critics. Each scenario spawns the REAL `tsx
// src/cli.ts` under a node-pty, renders the framebuffer through @xterm/headless, and
// asserts the presentation invariants:
//   • \x1b[3J (erase-scrollback) is never emitted;
//   • the composer prompt is on the last content rows of the final frame;
//   • no raw JSON fragments ({"description": / [{"type":) reach any frame/scrollback off the spawn card;
//   • status/mode chrome (the model chip) stays intact;
//   • plus each scenario's own check (condensed tool args, native scrollback history,
//     two concurrent subagents in the dropdown, ctrl+o open/close, dropdown expand/collapse,
//     codex-parent parity) and the EDGE scenarios (a 32-col narrow dropdown expanded over a
//     streaming turn, CJK + emoji descriptions, a failed subagent, and 3 concurrent spawns
//     with a mid-run expand/collapse cycle).
//
// KNOWN-GAP invariants (a `knownGap: true` marker on a cross-lane, acknowledged gap) are
// EXPECTED to fail: they are reported VIOLATED but do NOT fail the suite (`invariantBlocks`
// tolerates their expected failure). If one XPASSes — the owning lane fixed the gap — it
// BLOCKS, turning this test red so the knownGap marker gets removed. Both historical gaps
// (the un-condensed spawn card, the Ctrl+O chord echo) have since been fixed and promoted to
// hard invariants, so there are currently none; the machinery stays for the next one.
//
// Honest availability (mirrors tui.smoke / autoscroll): node-pty missing ⇒ a REAL
// vitest SKIP, or a FAILURE when JUNO_REQUIRE_PTY=1. The node-pty spawn-helper exec-bit
// issue is environmental — it surfaces as a spawn throw ⇒ skip, never a silent pass.
import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  runScenario,
  PTY_READY,
  REQUIRE_PTY,
  loadError,
  invariantBlocks,
  assembleInvariants,
  type Capture,
  type Scenario,
} from '../scripts/selftest';

describe('selftest pty invariants', () => {
  // Gate/visibility test: green when node-pty is loadable, a real SKIP when it is not,
  // and a hard FAILURE when it is not AND JUNO_REQUIRE_PTY=1 (the "cannot even load the
  // pty backend" failure mode, made honest).
  it('loads the node-pty backend (required under JUNO_REQUIRE_PTY=1)', (ctx) => {
    if (!PTY_READY) {
      if (REQUIRE_PTY) {
        throw new Error(
          `JUNO_REQUIRE_PTY=1 but node-pty could not be loaded: ${loadError ?? 'no spawn() export'}`,
        );
      }
      console.warn('[selftest.pty] node-pty not available — scenario cases will be skipped.');
      return ctx.skip();
    }
    expect(PTY_READY).toBe(true);
  });

  // The skip seam is HARD-CONSTRAINED (pure — no pty needed, never skipped): a scenario
  // may opt out of a core invariant ONLY from the SKIPPABLE_CORE_INVARIANTS allowlist and
  // ONLY by re-asserting the gap with that entry's compensating check. These pin the
  // assembleInvariants throw paths so a future scenario cannot casually widen the seam
  // (the anti-silent-exemption rule); the import-time allowlist guard already ran by
  // virtue of importing SCENARIOS above.
  describe('skip-seam enforcement (assembleInvariants)', () => {
    const cap: Capture = {
      scenario: 'fake',
      cols: 80,
      rows: 24,
      frames: [{ label: 'final', text: '❯ ' }],
      scrollback: '',
      raw: '',
    };

    /** Minimal well-typed scenario; `drive` is never invoked (assembly is pure). */
    function scenarioWith(overrides: Partial<Scenario> & Pick<Scenario, 'name'>): Scenario {
      return {
        cols: 80,
        rows: 24,
        env: {},
        async drive() {
          throw new Error('assembly-only fixture — drive must never run');
        },
        ...overrides,
      };
    }

    it('throws on a skip outside the allowlist (no casual exemption from other core guards)', () => {
      const rogue = scenarioWith({
        name: 'rogue',
        skipCoreInvariants: ['composer-pinned-bottom'],
        checks: () => [],
      });
      expect(() => assembleInvariants(rogue, cap)).toThrow(/non-skippable core invariant "composer-pinned-bottom"/);
    });

    it('throws when the compensating positive check is missing (a gap must be re-asserted)', () => {
      const uncompensated = scenarioWith({
        name: 'uncompensated',
        skipCoreInvariants: ['no-erase-scrollback'],
        checks: () => [{ name: 'something-else', pass: true, detail: 'not the compensation' }],
      });
      expect(() => assembleInvariants(uncompensated, cap)).toThrow(
        /compensating check "sanctioned-wipe-emitted"/,
      );
    });

    it('drops ONLY the declared skip and keeps the compensation (the compaction-dedupe shape)', () => {
      const sanctioned = scenarioWith({
        name: 'sanctioned',
        skipCoreInvariants: ['no-erase-scrollback'],
        checks: () => [{ name: 'sanctioned-wipe-emitted', pass: true, detail: 'wiped once' }],
      });
      const names = assembleInvariants(sanctioned, cap).map((inv) => inv.name);
      expect(names).not.toContain('no-erase-scrollback');
      expect(names).toContain('sanctioned-wipe-emitted');
      // The other three core invariants still apply untouched.
      expect(names).toEqual(
        expect.arrayContaining(['composer-pinned-bottom', 'no-raw-json', 'status-mode-chrome']),
      );
    });

    it('a scenario with no skips keeps all four core invariants', () => {
      const names = assembleInvariants(scenarioWith({ name: 'normal' }), cap).map((inv) => inv.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'no-erase-scrollback',
          'composer-pinned-bottom',
          'no-raw-json',
          'status-mode-chrome',
        ]),
      );
    });
  });

  for (const scenario of SCENARIOS) {
    it.skipIf(!PTY_READY)(
      `${scenario.name}: presentation invariants hold`,
      async (ctx) => {
        const result = await runScenario(scenario);
        // pty.spawn threw (environmental, e.g. the spawn-helper exec-bit issue) ⇒ honest skip.
        if (result.skipped) {
          console.warn(`[selftest.pty] ${scenario.name} skipped: ${result.skipReason ?? 'pty unavailable'}`);
          return ctx.skip();
        }
        // Every core invariant ran (4) plus this scenario's own checks.
        expect(result.invariants.length).toBeGreaterThanOrEqual(4);
        // Only BLOCKING invariants fail the suite: a normal invariant that failed, or a
        // known-gap invariant that unexpectedly PASSED (xpass → remove its marker). A
        // known-gap invariant in its expected-failing state is reported, not fatal.
        const failures = result.invariants.filter(invariantBlocks).map((inv) => {
          const kind = inv.knownGap ? 'XPASS (known gap fixed — remove knownGap marker)' : 'FAIL';
          return `${scenario.name}/${inv.name} [${kind}]: ${inv.detail}`;
        });
        // An empty failure list keeps the message readable when an invariant regresses.
        expect(failures).toEqual([]);
      },
      60_000,
    );
  }
});
