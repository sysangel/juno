=== FILE: src/ui/Transcript.tsx ===
```tsx
import { Static } from 'ink';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface TranscriptProps {
  committed: Msg[];
  depth?: ColorDepth;
}

export function Transcript({ committed, depth }: TranscriptProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Static items={committed}>
      {(msg) => <Message key={msg.id} msg={msg} depth={d} />}
    </Static>
  );
}
```

=== FILE: src/ui/Message.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Msg, Block } from '../core/reducer';
import { token, detectColorDepth, type ColorDepth } from './theme';
import { ToolCallCard } from './ToolCallCard';

const DEPTH: ColorDepth = detectColorDepth();

function roleToken(role: Msg['role'], d: ColorDepth): string {
  switch (role) {
    case 'user':
      return token('roleUser', d);
    case 'assistant':
      return token('roleAssistant', d);
    case 'system':
      return token('roleSystem', d);
    case 'tool':
      return token('textDim', d);
  }
}

function BlockView({
  block,
  msg,
  d,
}: {
  block: Block;
  msg: Msg;
  d: ColorDepth;
}): ReactElement {
  switch (block.kind) {
    case 'text':
      return <Text color={roleToken(msg.role, d)}>{block.text}</Text>;
    case 'tool': {
      const tool = msg.toolSnapshot?.[block.toolCallId];
      if (tool) {
        return <ToolCallCard tool={tool} depth={d} />;
      }
      return <Text color={token('textDim', d)}>[tool {block.toolCallId}]</Text>;
    }
  }
}

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
}

export function Message({ msg, depth }: MessageProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      {msg.reasoning ? (
        <Text color={token('textDim', d)} dimColor>
          thinking: {msg.reasoning}
        </Text>
      ) : null}
      {msg.blocks.map((block) => (
        <BlockView key={block.id} block={block} msg={msg} d={d} />
      ))}
    </Box>
  );
}
```

=== FILE: src/ui/StreamingMessage.tsx ===
```tsx
import { Box, Text } from 'ink';
import { Spinner } from 'ink-spinner';
import type { ReactElement } from 'react';
import type { Msg } from '../core/reducer';
import { token, detectColorDepth, type ColorDepth } from './theme';
import { Message } from './Message';

const DEPTH: ColorDepth = detectColorDepth();

export interface StreamingMessageProps {
  live: Msg | null;
  depth?: ColorDepth;
}

export function StreamingMessage({
  live,
  depth,
}: StreamingMessageProps): ReactElement | null {
  if (live === null) {
    return null;
  }
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Message msg={live} depth={d} />
      {!live.done ? (
        <Box>
          <Text color={token('accent', d)}>
            <Spinner />
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
```

=== FILE: src/ui/ToolCallCard.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ToolState } from '../core/reducer';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

function statusToken(status: ToolState['status'], d: ColorDepth): string {
  switch (status) {
    case 'pending':
      return token('toolPending', d);
    case 'running':
      return token('toolRunning', d);
    case 'result':
      return token('toolResult', d);
    case 'error':
      return token('toolError', d);
  }
}

function statusGlyph(status: ToolState['status']): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'running':
      return '◐';
    case 'result':
      return '●';
    case 'error':
      return '✖';
  }
}

function summarize(v: unknown): string {
  if (v === undefined || v === null) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface ToolCallCardProps {
  tool: ToolState;
  depth?: ColorDepth;
}

export function ToolCallCard({ tool, depth }: ToolCallCardProps): ReactElement {
  const d = depth ?? DEPTH;
  const color = statusToken(tool.status, d);
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <Box gap={1}>
        <Text color={color}>{statusGlyph(tool.status)}</Text>
        <Text color={token('text', d)} bold>
          {tool.name}
        </Text>
        <Text color={token('textDim', d)}>[{tool.status}]</Text>
      </Box>
      {tool.status === 'result' && tool.result !== undefined ? (
        <Text color={token('textDim', d)}>{summarize(tool.result)}</Text>
      ) : null}
      {tool.status === 'error' && tool.error ? (
        <Text color={token('error', d)}>{tool.error}</Text>
      ) : null}
    </Box>
  );
}
```

=== FILE: src/ui/ModeBadge.tsx ===
```tsx
import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

function modeToken(mode: State['mode'], d: ColorDepth): string {
  switch (mode) {
    case 'normal':
      return token('modeBadge.normal', d);
    case 'plan':
      return token('modeBadge.plan', d);
    case 'ultracode':
      return token('modeBadge.ultracode', d);
  }
}

export interface ModeBadgeProps {
  mode: State['mode'];
  depth?: ColorDepth;
}

export function ModeBadge({ mode, depth }: ModeBadgeProps): ReactElement {
  const d = depth ?? DEPTH;
  const bg = modeToken(mode, d);
  return (
    <Text backgroundColor={bg} color={token('textInverse', d)}>
      {' '}
      {mode.toUpperCase()}{' '}
    </Text>
  );
}
```

=== FILE: src/ui/StatusLine.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { token, detectColorDepth, type ColorDepth } from './theme';
import { ModeBadge } from './ModeBadge';

const DEPTH: ColorDepth = detectColorDepth();

function ContextBar({ fraction, d }: { fraction: number; d: ColorDepth }): ReactElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  const width = 10;
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return (
    <Text>
      <Text color={token('accent', d)}>{'█'.repeat(filled)}</Text>
      <Text color={token('textDim', d)}>{'░'.repeat(empty)}</Text>
    </Text>
  );
}

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
}

export function StatusLine({ status, depth }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={token('accent', d)} bold>
          {status.model}
        </Text>
        <Text color={token('textDim', d)}>{status.cwd}</Text>
        <Text color={token('textDim', d)}>tok:{status.tokens.total}</Text>
        <ContextBar fraction={status.contextFraction} d={d} />
        <ModeBadge mode={status.mode} depth={d} />
      </Box>
      <Box>
        <Text color={token('text', d)}>{status.statusText}</Text>
      </Box>
    </Box>
  );
}
```

=== FILE: src/ui/InputBox.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import TextInput from 'ink-text-input';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface InputBoxProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  depth?: ColorDepth;
}

export function InputBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  depth,
}: InputBoxProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box>
      <Text color={token('accent', d)}>❯ </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder ?? ''}
      />
    </Box>
  );
}
```

=== FILE: src/ui/SlashPalette.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface SlashPaletteProps {
  commands: Array<{ name: string; description: string }>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export function SlashPalette({
  commands,
  selectedIndex = 0,
  depth,
}: SlashPaletteProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={token('border', d)}
      paddingLeft={1}
      paddingRight={1}
    >
      {commands.map((c, i) => {
        const selected = i === selectedIndex;
        const marker = selected ? '▸' : ' ';
        const nameColor = selected ? token('accent', d) : token('text', d);
        return (
          <Box key={c.name} gap={1}>
            <Text color={selected ? token('accent', d) : token('textDim', d)}>
              {marker}
            </Text>
            <Text color={nameColor} bold={selected}>
              /{c.name}
            </Text>
            <Text color={token('textDim', d)}>{c.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

=== FILE: src/ui/ModelPicker.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ModelEntry } from '../services/catalog';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
}

export function ModelPicker({
  models,
  selectedId,
  depth,
}: ModelPickerProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={token('border', d)}
      paddingLeft={1}
      paddingRight={1}
    >
      {models.map((m) => {
        const selected = m.id === selectedId;
        const marker = selected ? '▸' : ' ';
        const labelColor = selected ? token('accent', d) : token('text', d);
        return (
          <Box key={m.id} gap={1}>
            <Text color={selected ? token('accent', d) : token('textDim', d)}>
              {marker}
            </Text>
            <Text color={labelColor} bold={selected}>
              {m.label}
            </Text>
            <Text color={token('textDim', d)}>{m.id}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

=== FILE: src/ui/PermissionPrompt.tsx ===
```tsx
import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { token, detectColorDepth, type ColorDepth } from './theme';

const DEPTH: ColorDepth = detectColorDepth();

export interface PermissionRequest {
  toolCallId: string;
  name: string;
  args: unknown;
  risk: RiskLevel;
}

export interface PermissionPromptProps {
  request: PermissionRequest;
  onDecision: (d: PermissionDecision) => void;
}

function riskToken(risk: RiskLevel, d: ColorDepth): string {
  switch (risk) {
    case 'safe':
      return token('success', d);
    case 'risky':
      return token('warning', d);
    case 'dangerous':
      return token('error', d);
  }
}

function summarize(v: unknown): string {
  if (v === undefined || v === null) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function PermissionPrompt({
  request,
  onDecision,
}: PermissionPromptProps): ReactElement {
  const d = DEPTH;
  const decidedRef = useRef(false);

  useInput((input) => {
    if (decidedRef.current) {
      return;
    }
    let decision: PermissionDecision | null = null;
    switch (input) {
      case 'y':
        decision = 'allow-once';
        break;
      case 'a':
        decision = 'always-allow-pattern';
        break;
      case 'd':
        decision = 'deny';
        break;
      case '!':
        decision = 'dangerous-bypass';
        break;
      default:
        break;
    }
    if (decision !== null) {
      decidedRef.current = true;
      onDecision(decision);
    }
  });

  const color = riskToken(request.risk, d);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingLeft={1}
      paddingRight={1}
    >
      <Box>
        <Text color={color} bold>
          ⚠ Permission required
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={token('text', d)} bold>
          {request.name}
        </Text>
        <Text color={token('textDim', d)}>risk:</Text>
        <Text color={color} bold>
          {request.risk}
        </Text>
      </Box>
      <Text color={token('textDim', d)}>{summarize(request.args)}</Text>
      <Text color={token('text', d)}>
        [y] allow once   [a] always allow   [d] deny   [!] dangerous bypass
      </Text>
    </Box>
  );
}
```

=== FILE: src/ui/OverlayHost.tsx ===
```tsx
import type { ReactElement } from 'react';
import type { State } from '../core/reducer';
import { SlashPalette, type SlashPaletteProps } from './SlashPalette';
import { ModelPicker, type ModelPickerProps } from './ModelPicker';
import { PermissionPrompt, type PermissionPromptProps } from './PermissionPrompt';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  permission?: PermissionPromptProps;
}

export function OverlayHost(props: OverlayHostProps): ReactElement | null {
  switch (props.overlay) {
    case 'none':
      return null;
    case 'slash':
      return props.slash ? <SlashPalette {...props.slash} /> : null;
    case 'model-picker':
      return props.modelPicker ? <ModelPicker {...props.modelPicker} /> : null;
    case 'permission':
      return props.permission ? <PermissionPrompt {...props.permission} /> : null;
  }
}
```

=== FILE: src/ui/tests/components.test.tsx ===
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Transcript } from '../Transcript';
import { ToolCallCard } from '../ToolCallCard';
import { ModeBadge } from '../ModeBadge';
import { StatusLine } from '../StatusLine';
import { PermissionPrompt, type PermissionRequest } from '../PermissionPrompt';
import { OverlayHost } from '../OverlayHost';
import type { Msg, ToolState, State } from '../../core/reducer';
import { selectStatusLine } from '../../core/selectors';

const userMsg: Msg = {
  id: 'u1',
  role: 'user',
  blocks: [{ kind: 'text', id: 'u1t', text: 'hello world' }],
  done: true,
};

const asstMsg: Msg = {
  id: 'a1',
  role: 'assistant',
  blocks: [{ kind: 'text', id: 'a1t', text: 'hi there from assistant' }],
  done: true,
};

const resultTool: ToolState = {
  status: 'result',
  name: 'read_file',
  args: { path: '/a' },
  result: 'file contents here',
};

const errorTool: ToolState = {
  status: 'error',
  name: 'read_file',
  args: {},
  error: 'not found',
};

const runningTool: ToolState = {
  status: 'running',
  name: 'shell',
  args: {},
};

const baseState: State = {
  committed: [],
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
    const f = lastFrame() ?? '';
    expect(f).toContain('hello world');
    expect(f).toContain('hi there from assistant');
  });
});

describe('ToolCallCard', () => {
  it('shows result summary on result status', () => {
    const { lastFrame } = render(<ToolCallCard tool={resultTool} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('read_file');
    expect(f).toContain('file contents here');
    expect(f).toContain('result');
  });

  it('shows error on error status', () => {
    const { lastFrame } = render(<ToolCallCard tool={errorTool} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('not found');
    expect(f).toContain('error');
  });

  it('different statuses produce different output', () => {
    const r = render(<ToolCallCard tool={resultTool} />).lastFrame() ?? '';
    const e = render(<ToolCallCard tool={errorTool} />).lastFrame() ?? '';
    const run = render(<ToolCallCard tool={runningTool} />).lastFrame() ?? '';
    expect(r).toContain('result');
    expect(e).toContain('error');
    expect(run).toContain('running');
    expect(r).not.toEqual(e);
    expect(run).not.toEqual(r);
  });
});

describe('ModeBadge', () => {
  it('renders the mode label for each mode', () => {
    const modes = ['normal', 'plan', 'ultracode'] as const;
    for (const m of modes) {
      const f = render(<ModeBadge mode={m} />).lastFrame() ?? '';
      expect(f).toContain(m.toUpperCase());
    }
  });
});

describe('StatusLine', () => {
  it('shows model, cwd, and a context bar', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/c' });
    const { lastFrame } = render(<StatusLine status={status} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('m');
    expect(f).toContain('/c');
    expect(f).toMatch(/[█░]/);
  });
});

describe('PermissionPrompt', () => {
  it('renders tool name and risk', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'rm -rf' },
      risk: 'dangerous',
    };
    const onDecision = vi.fn();
    const { lastFrame } = render(
      <PermissionPrompt request={request} onDecision={onDecision} />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('shell_exec');
    expect(f).toContain('dangerous');
  });

  it('calls onDecision once with allow-once on y', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: { cmd: 'ls' },
      risk: 'risky',
    };
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionPrompt request={request} onDecision={onDecision} />,
    );
    stdin.write('y');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  it('calls onDecision once with deny on d', () => {
    const request: PermissionRequest = {
      toolCallId: 't2',
      name: 'write_file',
      args: {},
      risk: 'safe',
    };
    const onDecision = vi.fn();
    const { stdin } = render(
      <PermissionPrompt request={request} onDecision={onDecision} />,
    );
    stdin.write('d');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('deny');
  });
});

describe('OverlayHost', () => {
  it('returns null for none', () => {
    const { lastFrame } = render(<OverlayHost overlay="none" />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders the permission prompt for permission overlay', () => {
    const request: PermissionRequest = {
      toolCallId: 't1',
      name: 'shell_exec',
      args: {},
      risk: 'risky',
    };
    const onDecision = vi.fn();
    const { lastFrame } = render(
      <OverlayHost
        overlay="permission"
        permission={{ request, onDecision }}
      />,
    );
    const f = lastFrame() ?? '';
    expect(f).toContain('shell_exec');
    expect(f).toContain('risky');
  });
});
```

=== NOTES ===
All components are pure/controlled: data via props only, no store/provider/network/clock. Color depth detected once per module (`DEPTH`), overridable via optional `depth` prop. Exhaustive switches over `role`, `block.kind`, `tool.status`, `mode`, `overlay`, and `risk` — no `any`. `unknown` (`tool.result`/`args`) is narrowed via `summarize` before display. `PermissionPrompt` uses a `useRef` guard to guarantee `onDecision` fires exactly once. `OverlayHost` switches exhaustively and returns `null` for `'none'`. `Transcript` wraps Ink `<Static>` with stable `msg.id` keys. Tests use inline `State`/`Msg`/`ToolState` fixtures and `ink-testing-library`'s `render`/`lastFrame`/`stdin.write`.
