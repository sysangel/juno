import { useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceControls } from '../src/hooks/useWorkspaceControls';
import type { WorkspaceFocus, WorkspacePane } from '../src/ui/workspace';
import { flushInk, press } from './helpers/ink';

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const DOWN = `${ESC}[B`;

function Harness(props: {
  wide: boolean;
  messageMode?: boolean;
  onClose: () => void;
  onMessage?: () => void;
  onCancelAgent?: () => void;
  onResolve?: (decision: 'allow-once' | 'deny') => void;
}) {
  const [focus, setFocus] = useState<WorkspaceFocus>('orbit');
  const [pane, setPane] = useState<WorkspacePane>('orbit');
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState(0);
  useWorkspaceControls({
    active: true,
    messageMode: props.messageMode ?? false,
    wide: props.wide,
    focus,
    narrowPane: pane,
    agentCount: 3,
    onMoveAgent: (delta) => setSelected((value) => Math.max(0, Math.min(2, value + delta))),
    onScrollStream: (delta) => setScroll((value) => Math.max(0, value + delta)),
    onSetFocus: setFocus,
    onSetNarrowPane: setPane,
    onClose: props.onClose,
    onCancelMessage: props.onClose,
    onMessage: props.onMessage ?? (() => {}),
    onCancelAgent: props.onCancelAgent ?? (() => {}),
    onResolvePermission: props.onResolve ?? (() => {}),
  });
  return <Text>{`${focus}:${pane}:${selected}:${scroll}`}</Text>;
}

describe('workspace controls', () => {
  it('drills into and back out of the narrow stream before closing', async () => {
    const close = vi.fn();
    const screen = render(<Harness wide={false} onClose={close} />);
    await flushInk();
    await press(screen.stdin, ENTER);
    expect(screen.lastFrame()).toBe('stream:stream:0:0');
    await press(screen.stdin, DOWN);
    expect(screen.lastFrame()).toBe('stream:stream:0:0');
    await press(screen.stdin, `${ESC}[A`);
    expect(screen.lastFrame()).toBe('stream:stream:0:1');
    await press(screen.stdin, ESC);
    expect(screen.lastFrame()).toBe('orbit:orbit:0:1');
    expect(close).not.toHaveBeenCalled();
    await press(screen.stdin, ESC);
    expect(close).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it('moves selection and routes live lifecycle actions', async () => {
    const message = vi.fn();
    const cancel = vi.fn();
    const resolve = vi.fn();
    const screen = render(
      <Harness wide onClose={() => {}} onMessage={message} onCancelAgent={cancel} onResolve={resolve} />,
    );
    await flushInk();
    await press(screen.stdin, DOWN);
    expect(screen.lastFrame()).toBe('orbit:orbit:1:0');
    await press(screen.stdin, 'm');
    await press(screen.stdin, 'x');
    await press(screen.stdin, 'g');
    await press(screen.stdin, 'd');
    expect(message).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolve.mock.calls.map(([decision]) => decision)).toEqual(['allow-once', 'deny']);
    screen.unmount();
  });

  it('gives message mode exclusive ownership except for Esc cancel', async () => {
    const close = vi.fn();
    const message = vi.fn();
    const screen = render(<Harness wide messageMode onClose={close} onMessage={message} />);
    await flushInk();
    await press(screen.stdin, 'm');
    expect(message).not.toHaveBeenCalled();
    await press(screen.stdin, ESC);
    expect(close).toHaveBeenCalledOnce();
    screen.unmount();
  });
});
