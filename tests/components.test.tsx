import { describe, it, expect, vi } from 'vitest';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../src/core/reducer';
import { selectStatusLine } from '../src/core/selectors';
import { DEFAULT_SETTINGS } from '../src/services/config';
import { EffortBadge } from '../src/ui/EffortBadge';
import { OverlayHost } from '../src/ui/OverlayHost';
import { PermissionPrompt, type PermissionRequest } from '../src/ui/PermissionPrompt';
import { StatusLine } from '../src/ui/StatusLine';
import { ToolCallCard } from '../src/ui/ToolCallCard';
import { Message } from '../src/ui/Message';
import { StreamingMessage } from '../src/ui/StreamingMessage';
import { Transcript } from '../src/ui/Transcript';
import { flushInk, waitFor } from './helpers/ink';

/** Count of leading whitespace chars — used to assert nested-card indentation. */
const leadingWhitespace = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

/** Bounded poll: the decision spy has fired (write delivery is not assumed
 * synchronous); callers still assert the EXACT call count/payload after. */
const decided = (spy: { mock: { calls: unknown[][] } }): Promise<void> =>
  waitFor(() => spy.mock.calls.length > 0, { label: 'onDecision called' });

const userMsg: Msg = {
  id: 'u1',
  role: 'user',
  blocks: [{ kind: 'text', id: 'u1:block:1', text: 'hello juno' }],
  done: true,
};

const asstMsg: Msg = {
  id: 'a1',
  role: 'assistant',
  blocks: [{ kind: 'text', id: 'a1:block:1', text: 'hello human' }],
  done: true,
};

const resultTool: ToolState = {
  status: 'result',
  name: 'read_file',
  args: { path: 'a.ts' },
  // A realistic read_file result is file text, condensed to a clean inline tail — never a
  // raw JSON blob on the card (R2). A structured result would be humanized/suppressed instead.
  result: 'export const answer = 42;',
};

const errorTool: ToolState = {
  status: 'error',
  name: 'write_file',
  args: { path: 'a.ts' },
  error: 'permission denied',
};

const runningTool: ToolState = {
  status: 'running',
  name: 'grep',
  args: { pattern: 'x' },
};

const baseState: State = {
  committed: [userMsg],
  live: null,
  tools: {},
  phase: 'idle',
  overlay: 'none',
  effort: 'medium',
  permissionMode: 'default',
  tokens: { in: 100, out: 50 },
  pendingPermissionToolCallId: null,
  errorMessage: null,
};

describe('Transcript', () => {
  it('renders committed messages text', () => {
    const { lastFrame } = render(<Transcript committed={[userMsg, asstMsg]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello juno');
    expect(frame).toContain('hello human');
  });
});

describe('Message — notice blocks (F: feedback + empty states)', () => {
  const noticeMsg: Msg = {
    id: 'notice-cleared',
    role: 'system',
    done: true,
    blocks: [{ kind: 'notice', id: 'notice-cleared:block:1', text: 'session cleared' }],
  };

  it('renders the notice text without a bold role-label heading', () => {
    const frame = render(<Message msg={noticeMsg} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('session cleared');
    // A notice is a bare dim line — no `system` heading over it (unlike other roles).
    expect(frame).not.toContain('system');
  });

  it('still labels a NON-notice system message (only notice-only messages drop the label)', () => {
    const systemText: Msg = {
      id: 'sys-1',
      role: 'system',
      done: true,
      blocks: [{ kind: 'text', id: 'sys-1:block:1', text: 'boom' }],
    };
    const frame = render(<Message msg={systemText} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('system');
    expect(frame).toContain('boom');
  });

  // E: a system message is now dim NEUTRAL, not bold purple. The `system` label +
  // body render in textDim (#8F908A) with NO bold weight — the old roleSystem purple
  // (#AE81FF) and bold heading are gone. Forced truecolor so the SGR bytes are real.
  it('renders a system message in dim neutral, never bold purple', () => {
    const systemText: Msg = {
      id: 'sys-1',
      role: 'system',
      done: true,
      blocks: [{ kind: 'text', id: 'sys-1:block:1', text: 'boom' }],
    };
    const priorLevel = chalk.level;
    chalk.level = 3; // truecolor — ink emits real SGR escapes
    try {
      const frame = render(<Message msg={systemText} depth="truecolor" />).lastFrame() ?? '';
      expect(frame).toContain('system'); // label word kept
      expect(frame).toContain('boom');
      expect(frame).toContain('38;2;143;144;138'); // textDim #8F908A
      expect(frame).not.toContain('38;2;174;129;255'); // NOT roleSystem purple #AE81FF
      expect(frame).not.toContain('[1m'); // NOT bold
    } finally {
      chalk.level = priorLevel;
    }
  });
});

describe('Message — terminal error visibility', () => {
  // A committed failure from the reducer `error` case. `tone: 'error'` is the forward
  // discriminator; the `system-error-` id is the load-time fallback for sessions
  // persisted before the field existed.
  const errorMsg: Msg = {
    id: 'system-error-0',
    role: 'system',
    done: true,
    tone: 'error',
    blocks: [
      { kind: 'text', id: 'system-error-0:block:1', text: 'provider stream dropped (503)' },
    ],
  };

  // Ink emits SGR only when its OWN chalk (chalk@5, nested — a DIFFERENT instance than
  // the chalk@4 this test imports) resolves a non-zero color level from the environment.
  // Under `FORCE_COLOR=0` no escapes are written, so the raw-hue byte assertions are
  // guarded on real color being present; the color-INDEPENDENT text discriminator
  // (`✗ error` vs `system`) is what always carries the fix and is asserted unconditionally.
  const colorActive = (frame: string): boolean => frame.includes('\x1b[');

  it('renders a `✗ error` heading (toolError hue + bold) with the body legible at normal text', () => {
    const frame = render(<Message msg={errorMsg} depth="truecolor" />).lastFrame() ?? '';
    // Failure heading: FAIL glyph + `error` label — the discriminator a benign `system`
    // chrome line can never produce.
    expect(frame).toContain('✗ error');
    // The provider error BODY is present and legible (normal `text`, never dropped/dimmed away).
    expect(frame).toContain('provider stream dropped (503)');
    // It must NOT read as the dim `system` chrome word.
    expect(frame).not.toContain('system');
    if (colorActive(frame)) {
      // When ink emits color (CI / a color TTY / FORCE_COLOR>=1 at truecolor), the heading
      // carries the toolError hue and bold weight — a benign `system` heading is UNbold.
      expect(frame).toContain('38;2;249;38;114'); // toolError #F92672
      expect(frame).toContain('\x1b[1m'); // bold heading
    }
  });

  it('surfaces the failure via the `system-error-` id fallback when tone is absent (resumed old session)', () => {
    // A session persisted BEFORE `tone` existed: the msg carries the `system-error-` id
    // but no tone field. The id-prefix fallback must still render `✗ error`.
    const legacyError: Msg = {
      id: 'system-error-2',
      role: 'system',
      done: true,
      blocks: [{ kind: 'text', id: 'system-error-2:block:1', text: 'connection reset' }],
    };
    const frame = render(<Message msg={legacyError} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('✗ error'); // glyph+label carries the signal even at ansi16 (token fallback)
    expect(frame).toContain('connection reset');
  });

  it('leaves a benign (non-error) system message as the dim `system` heading', () => {
    const benign: Msg = {
      id: 'sys-note',
      role: 'system',
      done: true,
      blocks: [{ kind: 'text', id: 'sys-note:block:1', text: 'context compacted' }],
    };
    const frame = render(<Message msg={benign} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('system'); // still the dim neutral chrome heading
    expect(frame).not.toContain('✗ error'); // NOT promoted to a failure surface
  });
});

describe('MessageSeparator / Transcript separators', () => {
  // Unified-rendering wave 1: the full-width dash rule is GONE. Turns are separated
  // by a single blank line only, on both the live and committed paths. A '─'
  // (U+2500) must never appear from a text-only transcript.
  // An INTERIOR blank line (turn separator) — the trailing framebuffer newline is
  // ignored so a single message (no separator) reads as "no blank line".
  const hasBlankLine = (frame: string): boolean =>
    frame.replace(/\n+$/, '').split('\n').some((line) => line.trim().length === 0);

  it('does not render a dash rule OR a leading blank line before a single committed message', () => {
    const frame = render(<Transcript committed={[userMsg]} />).lastFrame() ?? '';
    expect(frame.includes('─')).toBe(false);
    expect(hasBlankLine(frame)).toBe(false);
  });

  it('separates committed messages with a blank line (no dash rule, never before the first)', () => {
    const frame = render(<Transcript committed={[userMsg, asstMsg]} />).lastFrame() ?? '';
    expect(frame.includes('─')).toBe(false);
    // The two messages are split by a blank line between them.
    expect(hasBlankLine(frame)).toBe(true);
  });

  it('adds a leading blank line (not a dash rule) only when separated is set', () => {
    const plain = render(<Message msg={userMsg} depth="ansi16" />).lastFrame() ?? '';
    const separated = render(<Message msg={userMsg} depth="ansi16" separated />).lastFrame() ?? '';

    expect(plain.includes('─')).toBe(false);
    expect(separated.includes('─')).toBe(false);
    // `separated` prepends exactly one blank line, so it is one row taller than plain.
    expect(separated.split('\n').length).toBe(plain.split('\n').length + 1);
    expect(separated.startsWith('\n')).toBe(true);
    expect(plain.startsWith('\n')).toBe(false);
  });
});

describe('Message — nested subagent rendering', () => {
  it('HIDES a subagent child card inline; keeps the parent card + a per-agent status row (LANE B de-clutter)', () => {
    const parentAgentId = 'toolu-parent-agent';
    const childBashId = 'toolu-child-bash';
    const msg: Msg = {
      id: 'a-nested',
      role: 'assistant',
      done: true,
      blocks: [
        { kind: 'tool', id: 'a-nested:block:1', toolCallId: parentAgentId },
        { kind: 'tool', id: 'a-nested:block:2', toolCallId: childBashId },
      ],
      toolSnapshot: {
        [parentAgentId]: { status: 'result', name: 'Agent', args: {}, result: 'done' },
        [childBashId]: {
          status: 'result',
          name: 'Bash',
          args: {},
          result: '8',
          parentToolUseId: parentAgentId,
        },
      },
    };

    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    // The parent spawn card stays as one condensed line…
    expect(frame).toContain('Agent');
    // …but its child (Bash) card no longer renders inline — it lives in the agents panel.
    expect(frame).not.toContain('Bash');
    // A single per-agent status row stands in for the hidden subtree (done → ✓ + outcome);
    // the old `↓ agents` pointer is gone.
    expect(frame).toContain('✓');
    expect(frame).not.toContain('↓ agents');
  });

  it('renders a parent-less tool card WITHOUT nested indentation (no regression)', () => {
    const msg: Msg = {
      id: 'a-flat',
      role: 'assistant',
      done: true,
      blocks: [{ kind: 'tool', id: 'a-flat:block:1', toolCallId: 'toolu-flat' }],
      toolSnapshot: {
        'toolu-flat': { status: 'result', name: 'Bash', args: {}, result: '8' },
      },
    };

    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    const bashLine = frame.split('\n').find((line) => line.includes('Bash')) ?? '';
    expect(leadingWhitespace(bashLine)).toBe(0);
  });

  it('HIDES the whole descendant subtree of a subagent (child AND grandchild) — panel-only now', () => {
    // A three-level subagent chain: parent Agent → child Task → grandchild Bash. Only the
    // TOP spawn card renders in the transcript; the entire descendant subtree moves to the
    // agents panel, replaced by one dim pointer under the parent.
    const parentId = 'toolu-parent';
    const childId = 'toolu-child';
    const grandId = 'toolu-grand';
    const msg: Msg = {
      id: 'a-grand',
      role: 'assistant',
      done: true,
      blocks: [
        { kind: 'tool', id: 'a-grand:block:1', toolCallId: parentId },
        { kind: 'tool', id: 'a-grand:block:2', toolCallId: childId },
        { kind: 'tool', id: 'a-grand:block:3', toolCallId: grandId },
      ],
      toolSnapshot: {
        [parentId]: { status: 'result', name: 'Agent', args: {}, result: 'rp' },
        [childId]: { status: 'result', name: 'Task', args: {}, result: 'rc', parentToolUseId: parentId },
        [grandId]: {
          status: 'result',
          name: 'Bash',
          args: { command: 'echo gc' },
          result: 'rg',
          parentToolUseId: childId,
        },
      },
    };

    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent'); // the top spawn card stays
    expect(frame).not.toContain('Task'); // child hidden
    expect(frame).not.toContain('Bash'); // grandchild hidden
    // The parent card is not indented; the status row sits one step in beneath it.
    const lines = frame.split('\n');
    expect(leadingWhitespace(lines.find((l) => l.includes('Agent')) ?? '')).toBe(0);
    expect(frame).not.toContain('↓ agents');
    expect(frame).toContain('✓'); // one done status row for the hidden subtree
  });

  it('does not hang or double-render on a cyclic / duplicated parentToolUseId chain (visited-set guard)', () => {
    // Malformed input must not hang the renderer. Two guards: (1) a child referenced
    // TWICE renders exactly once (visited-set dedup); (2) a 2-cycle with no root is
    // dropped rather than looped forever.
    const parentId = 'toolu-p';
    const childId = 'toolu-c';
    const cycA = 'toolu-cyc-a';
    const cycB = 'toolu-cyc-b';
    const msg: Msg = {
      id: 'a-cyc',
      role: 'assistant',
      done: true,
      blocks: [
        { kind: 'tool', id: 'a-cyc:block:1', toolCallId: parentId },
        { kind: 'tool', id: 'a-cyc:block:2', toolCallId: childId },
        { kind: 'tool', id: 'a-cyc:block:3', toolCallId: childId }, // duplicate reference
        { kind: 'tool', id: 'a-cyc:block:4', toolCallId: cycA },
        { kind: 'tool', id: 'a-cyc:block:5', toolCallId: cycB },
      ],
      toolSnapshot: {
        [parentId]: { status: 'result', name: 'Agent', args: {}, result: 'rp' },
        [childId]: { status: 'result', name: 'Grep', args: { pattern: 'x' }, result: 'rc', parentToolUseId: parentId },
        // Each cycle node claims the other as parent → neither is a root.
        [cycA]: { status: 'result', name: 'CycleA', args: {}, result: 'ra', parentToolUseId: cycB },
        [cycB]: { status: 'result', name: 'CycleB', args: {}, result: 'rb', parentToolUseId: cycA },
      },
    };

    // A hang here would time the test out; reaching the assertions proves termination.
    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent');
    // The child (Grep) is a subagent descendant → hidden inline (moved to the panel),
    // duplicate reference and all — the malformed input still terminates cleanly.
    expect(frame).not.toContain('Grep');
    // The rootless cycle is dropped, never looped.
    expect(frame).not.toContain('CycleA');
    expect(frame).not.toContain('CycleB');
  });

  it('bounds recursion at MAX_NEST_DEPTH so a very deep chain cannot recurse unboundedly (depth cap)', () => {
    // A 6-level linear chain t0 → t1 → … → t5. The recursion is capped at
    // MAX_NEST_DEPTH (4): depths 0..4 render, the depth-5 card is not walked.
    const ids = ['t0', 't1', 't2', 't3', 't4', 't5'];
    const blocks = ids.map((id, i) => ({ kind: 'tool' as const, id: `deep:block:${i}`, toolCallId: id }));
    const toolSnapshot: Record<string, ToolState> = {};
    ids.forEach((id, i) => {
      toolSnapshot[id] = {
        status: 'result',
        name: `Depth${i}`,
        args: {},
        result: `r${i}`,
        ...(i > 0 ? { parentToolUseId: ids[i - 1] } : {}),
      };
    });
    const msg: Msg = { id: 'deep', role: 'assistant', done: true, blocks, toolSnapshot };

    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    for (let i = 0; i <= 4; i += 1) expect(frame).toContain(`Depth${i}`);
    // The depth-5 card is dropped by the cap (never rendered, renderer never hung).
    expect(frame).not.toContain('Depth5');
  });
});

describe('Message — per-subagent live status line (wave-6 lane C)', () => {
  /** A LIVE assistant turn (no toolSnapshot) carrying `blocks` + a live `tools` map —
   * the only path where a subagent can be `running` (committed turns are settled). */
  const liveTurn = (
    blocks: Msg['blocks'],
    tools: Record<string, ToolState>,
  ): { msg: Msg; tools: Record<string, ToolState> } => ({
    msg: { id: 'a-live', role: 'assistant', done: false, blocks },
    tools,
  });

  it('renders a RUNNING status row (no child chatter, no rollup label) beneath the spawn card', () => {
    const agentId = 'toolu-agent';
    const bashId = 'toolu-bash';
    const { msg, tools } = liveTurn(
      [
        { kind: 'tool', id: 'a-live:block:1', toolCallId: agentId },
        { kind: 'tool', id: 'a-live:block:2', toolCallId: bashId },
      ],
      {
        [agentId]: { status: 'running', name: 'Agent', args: { description: 'crunch' } },
        [bashId]: { status: 'running', name: 'Bash', args: { command: 'echo hi' }, parentToolUseId: agentId },
      },
    );

    const frame = render(<Message msg={msg} tools={tools} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent');
    // The child (Bash) card no longer renders inline — the descendant subtree is suppressed
    // (written to disk + summarised in the below-composer panel).
    expect(frame).not.toContain('Bash');
    // The RUNNING status row is a DISTINCT line beneath the spawn card, not merely the card's
    // own `Agent(crunch)` arg line: 'crunch' appears on BOTH the card AND the row, so exactly
    // two rendered lines carry it. A bare toContain('crunch') is vacuous here — it is already
    // satisfied by the card — and would silently pass if the running row regressed to null
    // (the pre-wave-8 behavior). Pinning the count catches that regression.
    const crunchLines = frame.split('\n').filter((l) => l.includes('crunch'));
    expect(crunchLines).toHaveLength(2);
    // The status row shows the subagent's own description, NOT a running-child rollup label,
    // and carries no abort hint (the single-busy-line invariant owns that).
    expect(frame).not.toContain('running Bash…');
    expect(frame).not.toContain('↓ agents'); // the old pointer is gone
    expect(frame).not.toContain('esc to abort');
  });

  it('renders a DONE status row (check + outcome, no running rollup) for a FINISHED subagent', () => {
    const agentId = 'toolu-agent-done';
    const bashId = 'toolu-bash-done';
    const msg: Msg = {
      id: 'a-done',
      role: 'assistant',
      done: true,
      blocks: [
        { kind: 'tool', id: 'a-done:block:1', toolCallId: agentId },
        { kind: 'tool', id: 'a-done:block:2', toolCallId: bashId },
      ],
      toolSnapshot: {
        [agentId]: { status: 'result', name: 'Agent', args: { description: 'crunch' }, result: 'all clear' },
        [bashId]: { status: 'result', name: 'Bash', args: {}, result: '8', parentToolUseId: agentId },
      },
    };
    const frame = render(<Message msg={msg} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent');
    // A settled subagent renders a DONE row: ✓ + description + outcome hint from its result.
    expect(frame).toContain('✓');
    expect(frame).toContain('all clear');
    // No live rollup: neither a running-child label nor the fallback.
    expect(frame).not.toContain('running Bash…');
    expect(frame).not.toContain('working…');
  });

  it('two concurrent running subagents render TWO condensed parent cards, no inline child chatter', () => {
    const agent1 = 'toolu-a1';
    const bash1 = 'toolu-b1';
    const agent2 = 'toolu-a2';
    const grep2 = 'toolu-g2';
    const { msg, tools } = liveTurn(
      [
        { kind: 'tool', id: 'a-two:block:1', toolCallId: agent1 },
        { kind: 'tool', id: 'a-two:block:2', toolCallId: bash1 },
        { kind: 'tool', id: 'a-two:block:3', toolCallId: agent2 },
        { kind: 'tool', id: 'a-two:block:4', toolCallId: grep2 },
      ],
      {
        // Real claude-cli Agent payloads carry a `description` (+ prompt); modelling that
        // here keeps humanizeArgs on its description path instead of the raw-JSON fallback,
        // so the card can be guarded against a `{`. subagent_type surfaces as the row model.
        [agent1]: {
          status: 'running',
          name: 'Agent',
          args: { description: 'first task', prompt: 'p1', subagent_type: 'alpha' },
        },
        [bash1]: { status: 'running', name: 'Bash', args: { command: 'b' }, parentToolUseId: agent1 },
        [agent2]: {
          status: 'running',
          name: 'Agent',
          args: { description: 'second task', prompt: 'p2', subagent_type: 'beta' },
        },
        [grep2]: { status: 'running', name: 'Grep', args: { pattern: 'x' }, parentToolUseId: agent2 },
      },
    );

    const frame = render(<Message msg={msg} tools={tools} depth="ansi16" />).lastFrame() ?? '';
    // Both parent spawn cards render (their subagent_type shows as the row's model)…
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    // …and the condensed card shows the description, never the raw `{"subagent_type":…}` blob.
    expect(frame).not.toContain('{');
    // …but neither subagent's child card, nor any inline rollup, appears in the transcript.
    expect(frame).not.toContain('Bash');
    expect(frame).not.toContain('Grep');
    expect(frame).not.toContain('running Bash…');
    expect(frame).not.toContain('running Grep…');
    // The old dim panel pointer is gone — each running subagent gets a status row instead.
    expect(frame).not.toContain('↓ agents');
  });

  it('hides a grandchild subtree under a nested subagent (chain still de-clutters)', () => {
    // p (Agent, running) → c (Task, settled) → g (Bash, running). Only p renders; the
    // whole descendant chain (settled child + running grandchild) is panel-only now.
    const agentId = 'toolu-p';
    const taskId = 'toolu-c';
    const bashId = 'toolu-g';
    const { msg, tools } = liveTurn(
      [
        { kind: 'tool', id: 'a-gc:block:1', toolCallId: agentId },
        { kind: 'tool', id: 'a-gc:block:2', toolCallId: taskId },
        { kind: 'tool', id: 'a-gc:block:3', toolCallId: bashId },
      ],
      {
        [agentId]: { status: 'running', name: 'Agent', args: {} },
        [taskId]: { status: 'result', name: 'Task', args: {}, result: 'rc', parentToolUseId: agentId },
        [bashId]: { status: 'running', name: 'Bash', args: { command: 'x' }, parentToolUseId: taskId },
      },
    );

    const frame = render(<Message msg={msg} tools={tools} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('Agent');
    expect(frame).not.toContain('Task');
    expect(frame).not.toContain('Bash');
    expect(frame).not.toMatch(/running \w+…/);
    // The parent renders its single running status row; the old pointer is gone.
    expect(frame).not.toContain('↓ agents');
  });
});

describe('StreamingMessage — subagent children stay suppressed under live-window elision', () => {
  it('never leaks a subagent child as a flat top-level card when the spawn card is windowed out', () => {
    // A long-running subagent turn: the spawn card block + the first child fall past the live
    // height budget and get windowed out (liveWindow.ts), while the two NEWEST child blocks
    // survive in the tail. The pre-wave-8 parent-present guard decided suppression from BLOCK
    // presence, so once the spawn card block was elided its orphaned children re-rendered as
    // flat, UNindented, misattributed top-level cards — e.g. `shell(npm run build)` presented
    // as if the MAIN agent were running it. Suppression is now decided from tool ANCESTRY, so
    // the whole subtree stays hidden regardless of which blocks the window kept.
    const agentId = 'toolu-agent';
    const [c1, c2, c3] = ['child-1', 'child-2', 'child-3'];
    const live: Msg = {
      id: 'a-live-window',
      role: 'assistant',
      done: false,
      blocks: [
        { kind: 'tool', id: 'blk-agent', toolCallId: agentId },
        { kind: 'tool', id: 'blk-c1', toolCallId: c1 },
        { kind: 'tool', id: 'blk-c2', toolCallId: c2 },
        { kind: 'tool', id: 'blk-c3', toolCallId: c3 },
      ],
    };
    const tools: Record<string, ToolState> = {
      [agentId]: { status: 'running', name: 'Agent', args: { description: 'refactor auth' } },
      [c1]: { status: 'result', name: 'shell', args: { command: 'npm test' }, result: 'ok', parentToolUseId: agentId },
      [c2]: { status: 'result', name: 'read_file', args: { path: 'auth.ts' }, result: 'ok', parentToolUseId: agentId },
      [c3]: { status: 'running', name: 'shell', args: { command: 'npm run build' }, parentToolUseId: agentId },
    };

    // maxLines=25 at 80 cols keeps ~2 trailing tool blocks (each estimated ~10 rows) and windows
    // the spawn card + first child out — the exact condition that surfaced the leak.
    const frame =
      render(
        <StreamingMessage live={live} tools={tools} maxLines={25} columns={80} depth="ansi16" />,
      ).lastFrame() ?? '';

    // The elision marker is present (something was windowed out)…
    expect(frame).toContain('earlier output');
    // …and NONE of the subagent's child cards leaked to the top level.
    expect(frame).not.toContain('npm test');
    expect(frame).not.toContain('npm run build');
    expect(frame).not.toContain('read_file');
    expect(frame).not.toContain('shell(');
  });
});

describe('ToolCallCard — compact lines (wave-1 item C)', () => {
  it('renders a settled result as `● name(args)` with an inline one-line tail, no [result] label', () => {
    const frame = render(<ToolCallCard tool={resultTool} depth="ansi16" />).lastFrame() ?? '';
    // humanized call line: glyph + name(path), the args humanized to the file path.
    expect(frame).toContain('● read_file(a.ts)');
    // Condensed: the result tail is inline on the same line — no multi-line `⎿` slot.
    expect(frame).toContain('export const answer = 42;');
    expect(frame).not.toContain('⎿');
    // The whole card is one line (glyph row only).
    expect(frame.trim().split('\n')).toHaveLength(1);
    // No boxed-card `[result]` label and no box border glyphs.
    expect(frame).not.toContain('[result]');
    expect(frame).not.toMatch(/[╭╮╰╯│─]/);
  });

  it('renders an error as `✗ name(args)` with the first error line inline', () => {
    const frame = render(<ToolCallCard tool={errorTool} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('✗ write_file(a.ts)');
    expect(frame).toContain('permission denied');
    expect(frame).not.toContain('[error]');
    expect(frame).not.toMatch(/[╭╮╰╯│─]/);
  });

  it('renders a gated (waiting-on-permission) tool as amber `◌ …· waiting on permission`, never running', () => {
    // A pending tool with an open permission prompt: honest state mapping — no spinner.
    const frame =
      render(<ToolCallCard tool={{ status: 'pending', name: 'run_shell', args: { command: 'rm -rf /' } }} depth="ansi16" waitingOnPermission />).lastFrame() ?? '';
    expect(frame).toContain('◌ run_shell(rm -rf /)');
    expect(frame).toContain('waiting on permission');
  });

  it('tags a claude-cli replay with `· via claude cli` on the call line', () => {
    const frame = render(<ToolCallCard tool={resultTool} depth="ansi16" providerKind="claude-cli" />).lastFrame() ?? '';
    expect(frame).toContain('· via claude cli');
  });

  it('tags a codex-cli replay with `· via codex cli` on the call line', () => {
    const frame = render(<ToolCallCard tool={resultTool} depth="ansi16" providerKind="codex-cli" />).lastFrame() ?? '';
    expect(frame).toContain('· via codex cli');
  });

  it('omits the via-marker when the tool ran under juno\'s own executor', () => {
    const frame = render(<ToolCallCard tool={resultTool} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).not.toContain('via claude cli');
    expect(frame).not.toContain('via codex cli');
  });

  it('different states produce visibly different glyphs/output', () => {
    const result = render(<ToolCallCard tool={resultTool} depth="ansi16" />).lastFrame() ?? '';
    const error = render(<ToolCallCard tool={errorTool} depth="ansi16" />).lastFrame() ?? '';
    const running = render(<ToolCallCard tool={runningTool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(result).toContain('●');
    expect(error).toContain('✗');
    expect(result).not.toEqual(error);
    expect(running).not.toEqual(result);
  });
});

describe('EffortBadge', () => {
  it('renders the label for each effort level', () => {
    // Claude-Code minimal: plain lowercase colored text, no inverse-background chip.
    expect(render(<EffortBadge effort="medium" />).lastFrame() ?? '').toContain('medium');
    expect(render(<EffortBadge effort="high" />).lastFrame() ?? '').toContain('high');
    expect(render(<EffortBadge effort="xhigh" />).lastFrame() ?? '').toContain('xhigh');
  });
});

describe('StatusLine', () => {
  it('shows model and cwd with ` · ` separators, and drops the tok counter + gauge', () => {
    const status = selectStatusLine(baseState, { model: 'gpt-x', cwd: '/work', maxContext: 200 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('gpt-x');
    expect(frame).toContain('/work');
    expect(frame).toContain('·'); // dim chip separator
    // The boxed-header presentation is gone: no tok counter, no bracketed gauge.
    expect(frame).not.toContain('tok:');
    expect(frame).not.toContain('[');
    expect(frame).not.toContain(']');
  });

  it('fresh idle collapses to just model · cwd · effort (zero/empty chips hidden)', () => {
    // baseState has committed tokens but no contextWindowTokens and 100/50 tokens;
    // with a fresh (zero-usage) state the ctx chip is hidden and only the core
    // chips remain — the spec's `<model> · ~/src/juno · medium` shape.
    const fresh: State = { ...baseState, tokens: { in: 0, out: 0 }, committed: [] };
    const status = selectStatusLine(fresh, { model: DEFAULT_SETTINGS.defaultModel, cwd: '/w', maxContext: 200 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain(DEFAULT_SETTINGS.defaultModel);
    expect(frame).toContain('medium');
    expect(frame).not.toContain('ctx');
    expect(frame).not.toContain('skills:');
  });

  it('keeps a stable line count when width shrinks (resize duplication regression)', () => {
    // Root cause: with no width constraint the gap'd chip row uses Ink's default
    // flex-wrap. When the terminal width shrinks below the chips' combined length,
    // the row wraps to MORE lines than the prior frame; Ink's log-update erases
    // the old (smaller) line count and leaves the extra wrapped lines as residue,
    // so the footer visually duplicates/accumulates. The fix threads `width` and
    // pins the rows to nowrap+truncate so line count is stable across widths.
    const status = selectStatusLine(baseState, {
      model: 'gpt-extremely-long-model-name-that-far-exceeds-any-narrow-width',
      cwd: '/workspaces/juno/a/very/deep/path/that/greatly/exceeds/the/status/width',
      maxContext: 200,
      skills: ['alpha', 'beta'],
      permissionMode: 'acceptEdits',
    });

    const narrow = render(<StatusLine status={status} width={20} />).lastFrame() ?? '';
    const wide = render(<StatusLine status={status} width={80} />).lastFrame() ?? '';

    // Line count must be identical regardless of width. The status strip drops
    // WHOLE chips (never wraps/collapses separators) to fit a narrow width, so both
    // renders stay a single line.
    expect(narrow.split('\n').length).toEqual(wide.split('\n').length);
    // Lock the absolute footer height: the boxed 4-row header is gone — the strip
    // is now exactly one dim line.
    expect(narrow.split('\n').length).toEqual(1);
  });

  it('renders a skills chip with the count when skills are present (Wave 3)', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w', skills: ['alpha', 'beta'] });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('skills:2');
  });

  it('omits the skills chip when there are no skills', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('skills:');
  });

  it('renders a cumulative cost:$ chip when the model has pricing (session 100/50, $2/$8 per MTok)', () => {
    const status = selectStatusLine(
      { ...baseState, tokens: { in: 100, out: 50 } },
      {
        model: 'm',
        cwd: '/w',
        pricing: { inputPerMTok: 2, outputPerMTok: 8 },
      },
    );
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('cost:$0.0006');
  });

  it('omits the cost chip when the model has no pricing (subscription backend)', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).not.toContain('cost:');
  });

  it('renders the cumulative session cost (consistent with tok:total)', () => {
    const status = selectStatusLine(
      { ...baseState, tokens: { in: 1_000_000, out: 1_000_000 } },
      { model: 'm', cwd: '/w', pricing: { inputPerMTok: 2, outputPerMTok: 8 } },
    );
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('cost:$10'); // 1M*$2 + 1M*$8 = $10
  });

  it('renders cost:$0.0000 before any usage event (no tokens yet)', () => {
    const status = selectStatusLine(
      { ...baseState, tokens: { in: 0, out: 0 } },
      {
        model: 'm',
        cwd: '/w',
        pricing: { inputPerMTok: 2, outputPerMTok: 8 },
      },
    );
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('cost:$0.0000');
  });

  it('renders a tools:used/max budget chip when a ceiling is set and a tool has run', () => {
    const status = selectStatusLine(baseState, {
      model: 'm',
      cwd: '/w',
      toolBudget: { used: 3, max: 10 },
    });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('tools:3/10');
  });

  it('omits the tools chip when no ceiling is set or nothing has run yet', () => {
    const noMax = selectStatusLine(baseState, {
      model: 'm',
      cwd: '/w',
      toolBudget: { used: 5, max: undefined },
    });
    expect(render(<StatusLine status={noMax} />).lastFrame() ?? '').not.toContain('tools:');

    const unused = selectStatusLine(baseState, {
      model: 'm',
      cwd: '/w',
      toolBudget: { used: 0, max: 10 },
    });
    expect(render(<StatusLine status={unused} />).lastFrame() ?? '').not.toContain('tools:');
  });

  it('switches the tools chip to a warn tint once usage crosses 80% of the ceiling', () => {
    // Below the 80% threshold (info tint) vs at/over it (warn tint). With a real color
    // depth the two frames must differ in their ANSI color codes even though the chip
    // text is identical shape — proving the tint actually flips at the boundary.
    const warn =
      render(
        <StatusLine
          status={selectStatusLine(baseState, { model: 'm', cwd: '/w', toolBudget: { used: 8, max: 10 } })}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    const info =
      render(
        <StatusLine
          status={selectStatusLine(baseState, { model: 'm', cwd: '/w', toolBudget: { used: 7, max: 10 } })}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';

    expect(warn).toContain('tools:8/10');
    expect(info).toContain('tools:7/10');
    // Different tint => different rendered color escapes around the chip.
    expect(warn).not.toEqual(info);
  });

  it('renders the ctx: context-window monitor chip with humanized used/max and percent', () => {
    const status = selectStatusLine(
      { ...baseState, contextWindowTokens: 50_000 },
      { model: 'm', cwd: '/w', maxContext: 200_000 },
    );
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('ctx 50k (25%)');
  });

  it('marks the ctx chip with ~ when the value is an estimate (no measurement yet)', () => {
    // No contextWindowTokens -> the chip falls back to the transcript estimate and flags it.
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/w', maxContext: 200_000 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('ctx ~');
  });

  it('tints the ctx chip green→amber→red across the warn/danger thresholds', () => {
    const at = (fraction: number): string =>
      render(
        <StatusLine
          status={selectStatusLine(
            { ...baseState, contextWindowTokens: Math.round(fraction * 200_000) },
            { model: 'm', cwd: '/w', maxContext: 200_000 },
          )}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    const healthy = at(0.2); // < 0.5 -> green
    const warn = at(0.6); // >= 0.5 -> amber
    const danger = at(0.9); // >= 0.8 -> red
    // Each tier renders a distinct color escape around the chip.
    expect(healthy).not.toEqual(warn);
    expect(warn).not.toEqual(danger);
    expect(healthy).not.toEqual(danger);
  });

  it('shows an active compacting chip while compaction is in flight (no longer silent)', () => {
    // The compaction window reuses the controller, so a submit made during it is
    // silently dropped. Surfacing the active chip makes that window VISIBLE even on
    // the FIRST compaction (compactions still 0 until the action lands).
    const during = selectStatusLine(baseState, { model: 'm', cwd: '/w', isCompacting: true });
    const activeFrame = render(<StatusLine status={during} />).lastFrame() ?? '';
    expect(activeFrame).toContain('compacting');

    // Once the window closes the active chip is gone (and falls back to cmp:<n> only
    // when a compaction has actually completed).
    const after = selectStatusLine(baseState, { model: 'm', cwd: '/w', isCompacting: false });
    const idleFrame = render(<StatusLine status={after} />).lastFrame() ?? '';
    expect(idleFrame).not.toContain('compacting');
  });
});

describe('PermissionPrompt', () => {
  it('renders the tool name and risk', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'rm -rf' },
      risk: 'dangerous',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('shell_exec');
    expect(frame).toContain('dangerous');
  });

  it('calls onDecision once with allow-once on "y"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'ls' },
      risk: 'risky',
    };
    const { stdin, lastFrame } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    expect(lastFrame() ?? '').toContain('risky');
    await flushInk(); // useInput listener is subscribed only after effects commit
    stdin.write('y');
    await decided(onDecision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  it('calls onDecision once with deny on "d"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't2',
      name: 'write_file',
      args: {},
      risk: 'safe',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await flushInk();
    stdin.write('d');
    await decided(onDecision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('deny');
  });

  it('calls onDecision once with dangerous-bypass on "!"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't4',
      name: 'shell_exec',
      args: { cmd: 'rm -rf /' },
      risk: 'dangerous',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await flushInk();
    stdin.write('!');
    await decided(onDecision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('dangerous-bypass');
  });

  it('calls onDecision once with always-allow-pattern on "a"', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't5',
      name: 'write_file',
      args: { path: 'a.ts' },
      risk: 'risky',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await flushInk();
    stdin.write('a');
    await decided(onDecision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('always-allow-pattern');
  });

  it('dangerous risk: "a" is disabled (no decision) and the hint hides always-allow', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't6',
      name: 'run_shell',
      args: { command: 'ls' },
      risk: 'dangerous',
    };
    const { stdin, lastFrame } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    // The footer must not offer [a] for a dangerous tool (a bare-name
    // always-allow would blanket-grant every future shell command).
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('[a] always allow');
    expect(frame).toContain('[y] allow once');
    expect(frame).toContain('[!] dangerous bypass');
    await flushInk();
    stdin.write('a');
    await flushInk(); // give the (ignored) keypress every chance to land before asserting silence
    expect(onDecision).not.toHaveBeenCalled();
    // The other bindings still work after the ignored keypress.
    stdin.write('y');
    await decided(onDecision);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  it('does not fire onDecision twice', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't3',
      name: 'read_file',
      args: {},
      risk: 'safe',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await flushInk();
    stdin.write('y');
    stdin.write('d');
    await decided(onDecision);
    await flushInk(); // both keys fully processed before the exactly-once assertion
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  // Wave-10: the prompt HUMANIZES the args to the one meaningful field (the same condenser
  // the grouped tool rows use), so a non-diff tool no longer prints a raw `{"…":…}` JSON blob.
  it('humanizes shell args to the command line, not a raw {"command":…} JSON blob', () => {
    const request: PermissionRequest = {
      toolCallId: 't-shell',
      name: 'run_shell',
      args: { command: 'ls -la /work' },
      risk: 'risky',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('ls -la /work'); // the meaningful field, verbatim
    expect(frame).not.toContain('{"command"'); // never the raw JSON payload the old compact() printed
  });

  it('humanizes a PascalCase claude-cli tool to its first string arg, not {"file_path":…}', () => {
    const request: PermissionRequest = {
      toolCallId: 't-read',
      name: 'Read',
      args: { file_path: 'src/app.tsx' },
      risk: 'safe',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('src/app.tsx');
    expect(frame).not.toContain('{"file_path"');
  });
});

// BUG 2 regression: DIFF_MAX_LINES caps the diff LINE COUNT but not the on-screen
// HEIGHT — a long unbroken line wraps into many rows and shoves the y/a/d/! controls
// off a short terminal. With the live width/rows threaded, the overlay must width-cap
// + truncate long lines to one row each AND tighten the shown-diff cap on short
// terminals, so the controls stay in the rendered frame within the terminal height.
describe('PermissionPrompt — bounded to terminal height (BUG 2)', () => {
  // 40 diff lines each far wider than any test width -> ~80 diff lines, each of
  // which would wrap to multiple rows without truncation.
  const longDiffRequest: PermissionRequest = {
    toolCallId: 't-long-diff',
    name: 'edit_file',
    args: {
      path: 'big.ts',
      oldString: Array.from({ length: 40 }, (_, i) => `old-${i}-${'x'.repeat(200)}`).join('\n'),
      newString: Array.from({ length: 40 }, (_, i) => `new-${i}-${'y'.repeat(200)}`).join('\n'),
    },
    risk: 'risky',
  };

  // Short tokens survive control-line wrapping at narrow widths (the full
  // '[!] dangerous bypass' string can be split across rows when it wraps).
  const controlsPresent = (frame: string): boolean =>
    frame.includes('[y]') && frame.includes('[d]') && frame.includes('[!]');

  it.each([
    { width: 80, rows: 24 },
    { width: 40, rows: 24 },
    { width: 80, rows: 14 }, // short terminal -> the cap must shrink below 16
  ])('keeps the y/a/d/! controls on screen for a long diff at $width x $rows', ({ width, rows }) => {
    const frame =
      render(<PermissionPrompt request={longDiffRequest} onDecision={vi.fn()} width={width} rows={rows} />)
        .lastFrame() ?? '';
    const height = frame.split('\n').length;
    // The whole overlay fits within the terminal height, controls included.
    expect(height).toBeLessThanOrEqual(rows);
    expect(controlsPresent(frame)).toBe(true);
    // A distant diff line was clipped by the cap (the diff was NOT rendered whole).
    expect(frame).not.toContain('old-39');
  });

  it('truncates a long unbroken arg line to one row so the controls stay visible (40 cols)', () => {
    const request: PermissionRequest = {
      toolCallId: 't-long-arg',
      name: 'run_shell',
      args: { command: 'x'.repeat(800) },
      risk: 'dangerous',
    };
    const frame =
      render(<PermissionPrompt request={request} onDecision={vi.fn()} width={40} rows={24} />).lastFrame() ?? '';
    // Without width-aware truncation the 800-char arg wraps into ~20 rows; capped
    // to one screen row the overlay stays tiny.
    expect(frame.split('\n').length).toBeLessThanOrEqual(10);
    // The full arg is clipped, not wrapped whole into the frame.
    expect(frame).not.toContain('x'.repeat(200));
    expect(controlsPresent(frame)).toBe(true);
    // Dangerous risk still hides the always-allow control.
    expect(frame).not.toContain('[a]');
  });
});

describe('OverlayHost', () => {
  it('returns null (empty frame) for none', () => {
    expect(render(<OverlayHost overlay="none" />).lastFrame() ?? '').toBe('');
  });

  it('renders the permission prompt for the permission overlay', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: {},
      risk: 'risky',
    };
    const frame =
      render(<OverlayHost overlay="permission" permission={{ request, onDecision: vi.fn() }} />).lastFrame() ?? '';
    expect(frame).toContain('shell_exec');
    expect(frame).toContain('risky');
  });

  it('renders the slash palette for the slash overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="slash"
          slash={{ commands: [{ name: 'model', description: 'switch model' }] }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('commands');
    expect(frame).toContain('/model');
    expect(frame).toContain('switch model');
  });

  it('renders the model picker for the model-picker overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="model-picker"
          modelPicker={{
            models: [{ id: 'gpt-x', provider: 'openai', label: 'GPT X', contextWindow: 200 }],
          }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('models');
    expect(frame).toContain('GPT X');
    expect(frame).toContain('gpt-x');
  });

  it('renders the skill picker for the skill-picker overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="skill-picker"
          skillPicker={{ skills: [{ name: 'review', description: 'Review code' }] }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('skills');
    expect(frame).toContain('review');
    expect(frame).toContain('Review code');
  });

  it('renders the permission mode picker for the permission-mode overlay', () => {
    const frame =
      render(
        <OverlayHost
          overlay="permission-mode"
          permissionModePicker={{ selectedMode: 'acceptEdits' }}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('permission mode');
    expect(frame).toContain('default');
    expect(frame).toContain('acceptEdits');
  });
});
