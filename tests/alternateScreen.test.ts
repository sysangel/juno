import { describe, expect, it, vi } from 'vitest';
import {
  createAlternateScreenController,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
} from '../src/ui/alternateScreen';

describe('alternate-screen ownership', () => {
  it('balances enter/exit and makes both edges idempotent', () => {
    const write = vi.fn<(data: string) => void>();
    const screen = createAlternateScreenController(write, true);

    screen.enter();
    screen.enter();
    expect(screen.active()).toBe(true);
    screen.exit();
    screen.exit();

    expect(screen.active()).toBe(false);
    expect(write.mock.calls.map(([data]) => data)).toEqual([
      ENTER_ALTERNATE_SCREEN,
      EXIT_ALTERNATE_SCREEN,
    ]);
  });

  it('is a no-op outside a TTY', () => {
    const write = vi.fn<(data: string) => void>();
    const screen = createAlternateScreenController(write, false);
    screen.enter();
    screen.exit();
    expect(screen.active()).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
