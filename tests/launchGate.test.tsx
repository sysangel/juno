import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchGate } from '../src/ui/LaunchGate';

afterEach(() => {
  vi.useRealTimers();
});

const gate = (enabled = true) => (
  <LaunchGate
    enabled={enabled}
    version="1.2.3"
    model="claude-fable-5"
    cwd="/work/juno"
    width={80}
    durationMs={600}
    frameMs={90}
    depth="ansi16"
  >
    <Text>CHAT READY</Text>
  </LaunchGate>
);

describe('LaunchGate', () => {
  it('renders a branded orbital entry and lets any key skip it', async () => {
    const screen = render(gate());
    expect(screen.lastFrame()).toContain('J U N O');
    expect(screen.lastFrame()).toContain('workspace linked');
    expect(screen.lastFrame()).toContain('any key to enter');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      screen.stdin.write('x');
    });
    expect(screen.lastFrame()).toContain('CHAT READY');
    screen.unmount();
  });

  it('enters automatically after the bounded duration', async () => {
    vi.useFakeTimers();
    const screen = render(gate());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(601);
    });
    expect(screen.lastFrame()).toContain('CHAT READY');
    screen.unmount();
  });

  it('renders the app immediately when disabled', () => {
    const screen = render(gate(false));
    expect(screen.lastFrame()).toBe('CHAT READY');
    screen.unmount();
  });

  it('uses a compact orbit without exceeding a narrow terminal width', () => {
    const screen = render(
      <LaunchGate
        enabled
        version="1.2.3"
        model="fable-5"
        cwd="/work/juno"
        width={12}
        rows={5}
        durationMs={600}
        depth="ansi16"
      >
        <Text>CHAT READY</Text>
      </LaunchGate>,
    );
    const lines = (screen.lastFrame() ?? '').split('\n');
    expect(screen.lastFrame()).toContain('J U N O');
    expect(screen.lastFrame()).toContain('any key');
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    screen.unmount();
  });
});
