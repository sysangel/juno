import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { CrashBoundary } from '../src/ui/CrashBoundary';

afterEach(() => {
  vi.restoreAllMocks();
});

function Explodes(): never {
  throw new Error('render exploded');
}

describe('CrashBoundary', () => {
  it('contains a descendant render failure and reports it to the fatal funnel', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn<(error: Error) => void>();
    const screen = render(
      <CrashBoundary onError={onError}>
        <Text><Explodes /></Text>
      </CrashBoundary>,
    );

    expect(screen.lastFrame()).toContain('juno encountered a fatal error');
    expect(screen.lastFrame()).toContain('render exploded');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].message).toBe('render exploded');
    screen.unmount();
  });
});
