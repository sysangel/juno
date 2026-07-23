import { describe, expect, it, vi } from 'vitest';
import {
  createFatalErrorHandler,
  installFatalProcessHandlers,
  type FatalProcessTarget,
} from '../src/services/crashContainment';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('fatal process containment', () => {
  it('restores synchronously, tears down, and exits once', async () => {
    const order: string[] = [];
    const handler = createFatalErrorHandler({
      unmount: () => order.push('unmount'),
      restoreTerminal: () => order.push('restore'),
      writeError: (message) => order.push(message),
      teardown: async () => {
        order.push('teardown');
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    handler(new Error('render exploded'));
    handler(new Error('duplicate'));
    expect(order.slice(0, 3)).toEqual([
      'unmount',
      'restore',
      'juno: fatal: render exploded\n',
    ]);
    await flush();
    expect(order).toEqual([
      'unmount',
      'restore',
      'juno: fatal: render exploded\n',
      'teardown',
      'exit:1',
    ]);
  });

  it('bounds a wedged teardown before exiting', async () => {
    const exit = vi.fn<(code: number) => void>();
    const handler = createFatalErrorHandler({
      unmount: () => {},
      restoreTerminal: () => {},
      writeError: () => {},
      teardown: () => new Promise<void>(() => {}),
      exit,
      teardownTimeoutMs: 1,
    });

    handler('rejected value');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('installs and removes both Node fatal hooks', () => {
    const listeners = new Map<string, (reason: never) => void>();
    const target: FatalProcessTarget = {
      once: (event, listener) => listeners.set(event, listener as (reason: never) => void),
      off: (event, listener) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      },
    };
    const fatal = vi.fn<(reason: unknown) => void>();
    const remove = installFatalProcessHandlers(target, fatal);

    listeners.get('uncaughtException')?.(new Error('boom') as never);
    listeners.get('unhandledRejection')?.('nope' as never);
    expect(fatal).toHaveBeenCalledTimes(2);

    remove();
    remove();
    expect(listeners.size).toBe(0);
  });
});
