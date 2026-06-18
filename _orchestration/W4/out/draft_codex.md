=== FILE: src/ui/ToolCallCard.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { ToolState } from '../core/reducer';
import type { ColorDepth, FlatTokenName } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

export interface ToolCallCardProps {
  tool: ToolState;
  depth?: ColorDepth;
}

function compact(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function statusToken(status: ToolState['status']): FlatTokenName {
  switch (status) {
    case 'pending':
      return 'toolPending';
    case 'running':
      return 'toolRunning';
    case 'result':
      return 'toolResult';
    case 'error':
      return 'toolError';
  }
}

function statusLabel(status: ToolState['status']): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'result':
      return 'done';
    case 'error':
      return 'error';
  }
}

export function ToolCallCard({ tool, depth = DEPTH }: ToolCallCardProps): React.ReactElement {
  const color = token(statusToken(tool.status), depth);
  const summary =
    tool.status === 'error'
      ? tool.error ?? 'Tool failed'
      : tool.status === 'result'
        ? compact(tool.result)
        : tool.argsText ?? compact(tool.args);

  return (
    <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column">
      <Text color={color}>
        {statusLabel(tool.status)} {tool.name}
      </Text>
      {summary.length > 0 ? <Text color={token('textDim', depth)}>{summary}</Text> : null}
    </Box>
  );
}
```

=== FILE: src/ui/ModeBadge.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { State } from '../core/reducer';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

export interface ModeBadgeProps {
  mode: State['mode'];
  depth?: ColorDepth;
}

function label(mode: State['mode']): string {
  switch (mode) {
    case 'normal':
      return 'NORMAL';
    case 'plan':
      return 'PLAN';
    case 'ultracode':
      return 'ULTRACODE';
  }
}

export function ModeBadge({ mode, depth = DEPTH }: ModeBadgeProps): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text backgroundColor={token(`modeBadge.${mode}`, depth)} color={token('textInverse', depth)}>
        {label(mode)}
      </Text>
    </Box>
  );
}
```

=== FILE: src/ui/Message.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { Block, Msg } from '../core/reducer';
import type { ColorDepth, FlatTokenName } from './theme';
import { detectColorDepth, token } from './theme';
import { ToolCallCard } from './ToolCallCard';

const DEPTH = detectColorDepth();

export interface MessageProps {
  msg: Msg;
  depth?: ColorDepth;
}

function roleToken(role: Msg['role']): FlatTokenName {
  switch (role) {
    case 'user':
      return 'roleUser';
    case 'assistant':
      return 'roleAssistant';
    case 'system':
      return 'roleSystem';
    case 'tool':
      return 'toolResult';
  }
}

function roleLabel(role: Msg['role']): string {
  switch (role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
  }
}

function renderBlock(msg: Msg, block: Block, depth: ColorDepth): React.ReactElement | null {
  switch (block.kind) {
    case 'text':
      return (
        <Text key={block.id} color={token('text', depth)}>
          {block.text}
        </Text>
      );
    case 'tool': {
      const tool = msg.toolSnapshot?.[block.toolCallId];
      return tool ? <ToolCallCard key={block.id} tool={tool} depth={depth} /> : null;
    }
  }
}

export function Message({ msg, depth = DEPTH }: MessageProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={token(roleToken(msg.role), depth)}>{roleLabel(msg.role)}</Text>
      {msg.reasoning ? (
        <Text color={token('textDim', depth)}>thinking: {msg.reasoning}</Text>
      ) : null}
      {msg.blocks.map((block) => renderBlock(msg, block, depth))}
    </Box>
  );
}
```

=== FILE: src/ui/Transcript.tsx ===
```tsx
import { Static } from 'ink';
import type * as React from 'react';
import type { Msg } from '../core/reducer';
import type { ColorDepth } from './theme';
import { detectColorDepth } from './theme';
import { Message } from './Message';

const DEPTH = detectColorDepth();

export interface TranscriptProps {
  committed: Msg[];
  depth?: ColorDepth;
}

export function Transcript({ committed, depth = DEPTH }: TranscriptProps): React.ReactElement {
  return (
    <Static items={committed}>
      {(msg) => <Message key={msg.id} msg={msg} depth={depth} />}
    </Static>
  );
}
```

=== FILE: src/ui/StreamingMessage.tsx ===
```tsx
import { Box } from 'ink';
import Spinner from 'ink-spinner';
import type * as React from 'react';
import type { Msg } from '../core/reducer';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';
import { Message } from './Message';

const DEPTH = detectColorDepth();

export interface StreamingMessageProps {
  live: Msg | null;
  depth?: ColorDepth;
}

export function StreamingMessage({ live, depth = DEPTH }: StreamingMessageProps): React.ReactElement | null {
  if (live === null) return null;

  return (
    <Box flexDirection="column">
      {!live.done ? <Spinner type="dots" color={token('accent', depth)} /> : null}
      <Message msg={live} depth={depth} />
    </Box>
  );
}
```

=== FILE: src/ui/StatusLine.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { StatusLineState } from '../core/selectors';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';
import { ModeBadge } from './ModeBadge';

const DEPTH = detectColorDepth();
const BAR_WIDTH = 10;

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
}

function contextBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

export function StatusLine({ status, depth = DEPTH }: StatusLineProps): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor={token('border', depth)} paddingX={1}>
      <Text color={token('accent', depth)}>{status.model}</Text>
      <Text color={token('textDim', depth)}> {status.cwd} </Text>
      <Text color={token('text', depth)}>tok:{status.tokens.total} </Text>
      <Text color={token('accent', depth)}>{contextBar(status.contextFraction)} </Text>
      <ModeBadge mode={status.mode} depth={depth} />
      <Text color={token('textDim', depth)}> {status.statusText}</Text>
    </Box>
  );
}
```

=== FILE: src/ui/InputBox.tsx ===
```tsx
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type * as React from 'react';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

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
  placeholder = '',
  depth = DEPTH,
}: InputBoxProps): React.ReactElement {
  return (
    <Box>
      <Text color={token('accent', depth)}>{'› '}</Text>
      {value.length === 0 && placeholder.length > 0 ? (
        <Text color={token('textDim', depth)}>{placeholder}</Text>
      ) : null}
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
```

=== FILE: src/ui/SlashPalette.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

export interface SlashPaletteProps {
  commands: Array<{ name: string; description: string }>;
  selectedIndex?: number;
  depth?: ColorDepth;
}

export function SlashPalette({
  commands,
  selectedIndex = 0,
  depth = DEPTH,
}: SlashPaletteProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={token('border', depth)} paddingX={1} flexDirection="column">
      <Text color={token('textDim', depth)}>commands</Text>
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={command.name} color={selected ? token('accent', depth) : token('text', depth)}>
            {selected ? '› ' : '  '}/{command.name} <Text color={token('textDim', depth)}>{command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
```

=== FILE: src/ui/ModelPicker.tsx ===
```tsx
import { Box, Text } from 'ink';
import type * as React from 'react';
import type { ModelEntry } from '../services/catalog';
import type { ColorDepth } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

export interface ModelPickerProps {
  models: ReadonlyArray<ModelEntry>;
  selectedId?: string;
  depth?: ColorDepth;
}

function modelLabel(model: ModelEntry): string {
  if ('label' in model && typeof model.label === 'string') return model.label;
  if ('name' in model && typeof model.name === 'string') return model.name;
  return model.id;
}

export function ModelPicker({ models, selectedId, depth = DEPTH }: ModelPickerProps): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={token('border', depth)} paddingX={1} flexDirection="column">
      <Text color={token('textDim', depth)}>models</Text>
      {models.map((model) => {
        const selected = model.id === selectedId;
        return (
          <Text key={model.id} color={selected ? token('accent', depth) : token('text', depth)}>
            {selected ? '› ' : '  '}
            {modelLabel(model)} <Text color={token('textDim', depth)}>{model.id}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
```

=== FILE: src/ui/PermissionPrompt.tsx ===
```tsx
import { Box, Text, useInput } from 'ink';
import type * as React from 'react';
import type { PermissionDecision, RiskLevel } from '../core/events';
import type { ColorDepth, FlatTokenName } from './theme';
import { detectColorDepth, token } from './theme';

const DEPTH = detectColorDepth();

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

function compact(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function riskToken(risk: RiskLevel): FlatTokenName {
  switch (risk) {
    case 'safe':
      return 'success';
    case 'neutral':
      return 'textDim';
    case 'risky':
      return 'warning';
    case 'dangerous':
      return 'error';
  }
}

export function PermissionPrompt({ request, onDecision }: PermissionPromptProps): React.ReactElement {
  useInput((input) => {
    switch (input) {
      case 'y':
        onDecision('allow-once');
        break;
      case 'a':
        onDecision('always-allow-pattern');
        break;
      case 'd':
        onDecision('deny');
        break;
      case '!':
        onDecision('dangerous-bypass');
        break;
      default:
        break;
    }
  });

  const riskColor = token(riskToken(request.risk), DEPTH);

  return (
    <Box borderStyle="round" borderColor={riskColor} paddingX={1} flexDirection="column">
      <Text color={token('accent', DEPTH)}>permission requested</Text>
      <Text color={token('text', DEPTH)}>{request.name}</Text>
      <Text color={token('textDim', DEPTH)}>{compact(request.args)}</Text>
      <Text color={riskColor}>risk: {request.risk}</Text>
      <Text color={token('textDim', DEPTH)}>
        y allow once · a always allow pattern · d deny · ! dangerous bypass
      </Text>
    </Box>
  );
}
```

=== FILE: src/ui/OverlayHost.tsx ===
```tsx
import type * as React from 'react';
import type { State } from '../core/reducer';
import type { ModelPickerProps } from './ModelPicker';
import { ModelPicker } from './ModelPicker';
import type { PermissionPromptProps } from './PermissionPrompt';
import { PermissionPrompt } from './PermissionPrompt';
import type { SlashPaletteProps } from './SlashPalette';
import { SlashPalette } from './SlashPalette';

export interface OverlayHostProps {
  overlay: State['overlay'];
  slash?: SlashPaletteProps;
  modelPicker?: ModelPickerProps;
  permission?: PermissionPromptProps;
}

export function OverlayHost(props: OverlayHostProps): React.ReactElement | null {
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
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Msg, State, ToolState } from '../../core/reducer';
import { selectStatusLine } from '../../core/selectors';
import { ModeBadge } from '../ModeBadge';
import { OverlayHost } from '../OverlayHost';
import { PermissionPrompt } from '../PermissionPrompt';
import { StatusLine } from '../StatusLine';
import { ToolCallCard } from '../ToolCallCard';
import { Transcript } from '../Transcript';

const userMsg: Msg = {
  id: 'm1',
  role: 'user',
  blocks: [{ kind: 'text', id: 'b1', text: 'hello juno' }],
  done: true,
};

const asstMsg: Msg = {
  id: 'm2',
  role: 'assistant',
  blocks: [{ kind: 'text', id: 'b2', text: 'hello human' }],
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

const baseState: State = {
  committed: [userMsg],
  live: null,
  tools: {},
  phase: 'idle',
  overlay: 'none',
  mode: 'normal',
  tokens: { in: 2, out: 3 },
  pendingPermissionToolCallId: null,
  errorMessage: null,
};

describe('ui components', () => {
  it('renders committed transcript messages', () => {
    const { lastFrame } = render(<Transcript committed={[userMsg, asstMsg]} />);
    const frame = lastFrame();

    expect(frame).toContain('hello juno');
    expect(frame).toContain('hello human');
  });

  it('renders tool result and error summaries with status text', () => {
    const result = render(<ToolCallCard tool={resultTool} />).lastFrame();
    const error = render(<ToolCallCard tool={errorTool} />).lastFrame();
    const pending = render(<ToolCallCard tool={{ ...resultTool, status: 'pending', result: undefined }} />).lastFrame();

    expect(result).toContain('done');
    expect(result).toContain('"ok":true');
    expect(error).toContain('error');
    expect(error).toContain('permission denied');
    expect(pending).toContain('pending');
  });

  it('renders mode labels', () => {
    expect(render(<ModeBadge mode="normal" />).lastFrame()).toContain('NORMAL');
    expect(render(<ModeBadge mode="plan" />).lastFrame()).toContain('PLAN');
    expect(render(<ModeBadge mode="ultracode" />).lastFrame()).toContain('ULTRACODE');
  });

  it('renders status line details and context bar', () => {
    const status = selectStatusLine(baseState, { model: 'm', cwd: '/c', maxContext: 10 });
    const frame = render(<StatusLine status={status} />).lastFrame();

    expect(frame).toContain('m');
    expect(frame).toContain('/c');
    expect(frame).toContain('[');
    expect(frame).toContain(']');
  });

  it('emits allow-once from permission prompt input', () => {
    const onDecision = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionPrompt
        request={{ toolCallId: 'tc1', name: 'shell', args: { command: 'ls' }, risk: 'risky' }}
        onDecision={onDecision}
      />,
    );

    expect(lastFrame()).toContain('shell');
    expect(lastFrame()).toContain('risky');

    stdin.write('y');

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });

  it('hosts overlays', () => {
    expect(render(<OverlayHost overlay="none" />).lastFrame()).toBe('');

    const frame = render(
      <OverlayHost
        overlay="permission"
        permission={{
          request: { toolCallId: 'tc1', name: 'shell', args: {}, risk: 'safe' },
          onDecision: vi.fn(),
        }}
      />,
    ).lastFrame();

    expect(frame).toContain('shell');
    expect(frame).toContain('safe');
  });
});
```

=== NOTES ===
These components stay controlled and data-only, with exhaustive switches over the pinned unions. `PermissionPrompt` emits only the typed decision and contains no policy logic. I used compact JSON summaries for unknown tool args/results and kept rendering deterministic for Ink tests.