import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../src/core/reducer';
import { selectStatusLine } from '../src/core/selectors';
import { EffortBadge } from '../src/ui/EffortBadge';
import { OverlayHost } from '../src/ui/OverlayHost';
import { PermissionPrompt, type PermissionRequest } from '../src/ui/PermissionPrompt';
import { StatusLine } from '../src/ui/StatusLine';
import { ToolCallCard } from '../src/ui/ToolCallCard';
import { Message } from '../src/ui/Message';
import { Transcript } from '../src/ui/Transcript';

/** Count of leading whitespace chars — used to assert nested-card indentation. */
const leadingWhitespace = (line: string): number => line.match(/^\s*/)?.[0].length ?? 0;

/**
 * ink-testing-library attaches `useInput`'s stdin listener on the first effect
 * flush (after raw-mode setup), so a key written synchronously right after
 * render() is dropped. Awaiting one macrotask tick lets the handler register.
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
  result: { ok: true, lines: 3 },
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

describe('Message — nested subagent rendering', () => {
  it('renders child tool cards INDENTED beneath their parent Agent card', () => {
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
    expect(frame).toContain('Agent');
    expect(frame).toContain('Bash');

    const lines = frame.split('\n');
    const agentLine = lines.find((line) => line.includes('Agent')) ?? '';
    const bashLine = lines.find((line) => line.includes('Bash')) ?? '';
    // The child (Bash) card frame is indented relative to the parent (Agent).
    expect(leadingWhitespace(bashLine)).toBeGreaterThan(leadingWhitespace(agentLine));
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
});

describe('ToolCallCard', () => {
  it('shows a result summary on result status', () => {
    const frame = render(<ToolCallCard tool={resultTool} />).lastFrame() ?? '';
    expect(frame).toContain('read_file');
    expect(frame).toContain('"ok":true');
    expect(frame).toContain('result');
  });

  it('shows the error on error status', () => {
    const frame = render(<ToolCallCard tool={errorTool} />).lastFrame() ?? '';
    expect(frame).toContain('write_file');
    expect(frame).toContain('permission denied');
    expect(frame).toContain('error');
  });

  it('different statuses produce different output', () => {
    const result = render(<ToolCallCard tool={resultTool} />).lastFrame() ?? '';
    const error = render(<ToolCallCard tool={errorTool} />).lastFrame() ?? '';
    const running = render(<ToolCallCard tool={runningTool} />).lastFrame() ?? '';
    expect(result).toContain('result');
    expect(error).toContain('error');
    expect(running).toContain('running');
    expect(result).not.toEqual(error);
    expect(running).not.toEqual(result);
  });
});

describe('EffortBadge', () => {
  it('renders the label for each effort level', () => {
    expect(render(<EffortBadge effort="medium" />).lastFrame() ?? '').toContain('MEDIUM');
    expect(render(<EffortBadge effort="high" />).lastFrame() ?? '').toContain('HIGH');
    expect(render(<EffortBadge effort="xhigh" />).lastFrame() ?? '').toContain('XHIGH');
  });
});

describe('StatusLine', () => {
  it('shows model, cwd, tokens and a context bar', () => {
    const status = selectStatusLine(baseState, { model: 'gpt-x', cwd: '/work', maxContext: 200 });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';
    expect(frame).toContain('gpt-x');
    expect(frame).toContain('/work');
    expect(frame).toContain('tok:150');
    expect(frame).toContain('[');
    expect(frame).toContain(']');
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

    // Line count must be identical regardless of width. Without nowrap/truncate
    // on the inner rows the width=20 constraint forces the chips to wrap to extra
    // lines, making narrow taller than wide and this assertion fail.
    expect(narrow.split('\n').length).toEqual(wide.split('\n').length);
    // Lock the absolute footer height (border + 2 content rows + border) so a
    // future change cannot make BOTH widths grow equally and still pass above.
    expect(narrow.split('\n').length).toEqual(4);
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
    await tick();
    stdin.write('y');
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
    await tick();
    stdin.write('d');
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
    await tick();
    stdin.write('!');
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
    await tick();
    stdin.write('a');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('always-allow-pattern');
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
    await tick();
    stdin.write('y');
    stdin.write('d');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
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
