// tests/selftest.pty.test.ts
// WAVE 8 (lane selftest-harness) — the vitest face of the automated render-feedback
// loop. It imports the SAME scenario table + runner that `npm run selftest` uses
// (scripts/selftest.ts), so the assertions asserted in CI can never drift from the
// frames written for human/agent critics. Each scenario spawns the REAL `tsx
// src/cli.ts` under a node-pty, renders the framebuffer through @xterm/headless, and
// asserts the presentation invariants:
//   • \x1b[3J (erase-scrollback) is never emitted;
//   • the composer prompt is on the last content rows of the final frame;
//   • no raw JSON fragments ({"description": / [{"type":) reach any frame/scrollback;
//   • status/mode chrome (the model chip) stays intact;
//   • plus each scenario's own check (condensed tool args, native scrollback history,
//     two concurrent subagents in the dropdown, ctrl+o open/close, dropdown expand/collapse).
//
// Honest availability (mirrors tui.smoke / autoscroll): node-pty missing ⇒ a REAL
// vitest SKIP, or a FAILURE when JUNO_REQUIRE_PTY=1. The node-pty spawn-helper exec-bit
// issue is environmental — it surfaces as a spawn throw ⇒ skip, never a silent pass.
import { describe, expect, it } from 'vitest';
import { SCENARIOS, runScenario, PTY_READY, REQUIRE_PTY, loadError } from '../scripts/selftest';

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
        const failures = result.invariants
          .filter((inv) => !inv.pass)
          .map((inv) => `${scenario.name}/${inv.name}: ${inv.detail}`);
        // An empty failure list keeps the message readable when an invariant regresses.
        expect(failures).toEqual([]);
      },
      60_000,
    );
  }
});
