import { describe, expect, it, vi } from 'vitest';
import {
  createAlternateScreenController,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  restoreActiveAlternateScreens,
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

  it('restores every active buffer through its owning writer after a fatal error', () => {
    const firstWrite = vi.fn<(data: string) => void>();
    const secondWrite = vi.fn<(data: string) => void>();
    const first = createAlternateScreenController(firstWrite, true);
    const second = createAlternateScreenController(secondWrite, true);
    first.enter();
    second.enter();

    restoreActiveAlternateScreens();
    restoreActiveAlternateScreens();

    expect(first.active()).toBe(false);
    expect(second.active()).toBe(false);
    expect(firstWrite.mock.calls.map(([data]) => data)).toEqual([
      ENTER_ALTERNATE_SCREEN,
      EXIT_ALTERNATE_SCREEN,
    ]);
    expect(secondWrite.mock.calls.map(([data]) => data)).toEqual([
      ENTER_ALTERNATE_SCREEN,
      EXIT_ALTERNATE_SCREEN,
    ]);
  });
});
