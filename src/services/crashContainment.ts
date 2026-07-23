export interface FatalProcessTarget {
  once(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  once(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: Error) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export interface FatalErrorHandlerDeps {
  readonly unmount: () => void;
  readonly restoreTerminal: () => void;
  readonly teardown: () => Promise<void>;
  readonly writeError: (message: string) => void;
  readonly exit: (code: number) => void;
  readonly teardownTimeoutMs?: number;
}

function fatalMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

async function settleWithin(task: Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void task.catch(() => {}).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Build the single fatal funnel shared by React's error boundary and Node's
 * uncaughtException/unhandledRejection hooks. Terminal restoration is
 * synchronous and precedes diagnostics; teardown is bounded so a wedged child
 * cannot prevent the process from exiting.
 */
export function createFatalErrorHandler(
  deps: FatalErrorHandlerDeps,
): (reason: unknown) => void {
  let handling = false;
  return (reason: unknown): void => {
    if (handling) return;
    handling = true;

    try {
      deps.unmount();
    } catch {
      // Continue through the emergency terminal restore.
    }
    try {
      deps.restoreTerminal();
    } catch {
      // Diagnostics and process exit still matter if a writer itself failed.
    }
    try {
      deps.writeError(`juno: fatal: ${fatalMessage(reason)}\n`);
    } catch {
      // A closed stderr must not prevent termination.
    }

    void settleWithin(
      Promise.resolve().then(deps.teardown),
      deps.teardownTimeoutMs ?? 1_000,
    ).finally(() => deps.exit(1));
  };
}

/** Install both Node fatal hooks and return an idempotent normal-exit cleanup. */
export function installFatalProcessHandlers(
  target: FatalProcessTarget,
  handleFatal: (reason: unknown) => void,
): () => void {
  const onUncaught = (error: Error): void => handleFatal(error);
  const onUnhandled = (reason: unknown): void => handleFatal(reason);
  target.once('uncaughtException', onUncaught);
  target.once('unhandledRejection', onUnhandled);

  let installed = true;
  return (): void => {
    if (!installed) return;
    installed = false;
    target.off('uncaughtException', onUncaught);
    target.off('unhandledRejection', onUnhandled);
  };
}
