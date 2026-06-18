import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../src/core/reducer';
import { selectStatusLine } from '../src/core/selectors';
import { ModeBadge } from '../src/ui/ModeBadge';
import { OverlayHost } from '../src/ui/OverlayHost';
import { PermissionPrompt, type PermissionRequest } from '../src/ui/PermissionPrompt';
import { StatusLine } from '../src/ui/StatusLine';
import { ToolCallCard } from '../src/ui/ToolCallCard';
import { Transcript } from '../src/ui/Transcript';

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
  mode: 'normal',
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

describe('ModeBadge', () => {
  it('renders the label for each mode', () => {
    expect(render(<ModeBadge mode="normal" />).lastFrame() ?? '').toContain('NORMAL');
    expect(render(<ModeBadge mode="plan" />).lastFrame() ?? '').toContain('PLAN');
    expect(render(<ModeBadge mode="ultracode" />).lastFrame() ?? '').toContain('ULTRACODE');
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
});
