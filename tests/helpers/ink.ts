// tests/helpers/ink.ts — deterministic Ink-mount test synchronization.
//
// Root cause of the mount-test flakes: Ink's `useInput` subscribes its stdin
// listener inside a React EFFECT, so a key written before that effect commits
// is silently dropped. The old per-file `tick()` (one bare `setTimeout(0)`)
// only WAITS one macrotask — under CPU load (parallel suite runs, saturated CI)
// the effect flush can lag additional macrotasks, the keypress races it, and
// the spy records 0 calls. `act` instead keeps flushing until React's effect
// queue is EMPTY, which makes "listener is subscribed" a deterministic
// post-condition rather than a timing bet.
import { PassThrough, Writable } from 'node:stream';
import { render as renderInkApp } from 'ink';
import { act, type ReactElement } from 'react';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class CaptureOutput extends Writable {
  readonly columns = 100;
  readonly rows = 24;
  readonly isTTY = true;
  readonly frames: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = chunk.toString();
    if (frame.length > 0) this.frames.push(frame);
    callback();
  }

  lastFrame = (): string | undefined => this.frames.at(-1);
}

class TestInput extends PassThrough {
  readonly isTTY = true;

  setRawMode(_enabled: boolean): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

interface TrackedRenderer {
  readonly flush: () => Promise<void>;
  readonly unmount: () => void;
}

const trackedRenderers = new Set<TrackedRenderer>();

/**
 * React-19-compatible Ink test renderer. ink-testing-library 4 predates React
 * 19 and does not expose Ink 7's `waitUntilRenderFlush()`, so hook-only tests can
 * otherwise read stale state after a scheduled custom-reconciler update.
 */
export function renderInk(tree: ReactElement): {
  readonly stdin: TestInput;
  readonly frames: readonly string[];
  readonly lastFrame: () => string | undefined;
  readonly rerender: (next: ReactElement) => void;
  readonly flush: () => Promise<void>;
  readonly unmount: () => void;
} {
  const stdin = new TestInput();
  const stdout = new CaptureOutput();
  const stderr = new CaptureOutput();
  const instance = renderInkApp(tree, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  let disposed = false;
  const tracked: TrackedRenderer = {
    flush: instance.waitUntilRenderFlush,
    unmount: () => {
      if (disposed) return;
      disposed = true;
      trackedRenderers.delete(tracked);
      instance.unmount();
    },
  };
  trackedRenderers.add(tracked);
  return {
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
    rerender: instance.rerender,
    flush: tracked.flush,
    unmount: tracked.unmount,
  };
}

/** Unmount every helper-owned renderer, including roots left by a failed test. */
export function cleanupInkRenderers(): void {
  for (const renderer of [...trackedRenderers]) renderer.unmount();
}

/**
 * Flush React/Ink until all pending effects are committed. After this resolves,
 * every mounted `useInput` handler is subscribed and the latest frame reflects
 * all committed state. Await this before the FIRST stdin write of a test.
 */
export async function flushInk(): Promise<void> {
  await act(async () => {
    await tick();
    for (const renderer of [...trackedRenderers]) {
      // eslint-disable-next-line no-await-in-loop
      await renderer.flush();
    }
  });
}

/**
 * act-wrapped stdin write + effect flush: the state updates the keypress causes
 * are committed (and `useInput` closures refreshed) before the caller continues,
 * so multi-key sequences can't race their own re-renders.
 */
export async function press(stdin: { write: (s: string) => void }, chunk: string): Promise<void> {
  await act(async () => {
    stdin.write(chunk);
    // Ink 7 delays a lone Escape for 20ms so it can distinguish Esc from the
    // prefix of an arrow/meta sequence. Wait through that documented parser
    // window; compound escape sequences are emitted immediately.
    await tick(chunk === String.fromCharCode(27) ? 25 : 0);
  });
}

export interface WaitForOptions {
  /** Give up after this long (default 5s) — a genuinely broken condition fails
   * fast with `label` instead of hanging the suite. */
  readonly timeoutMs?: number;
  /** Human-readable description of the condition, used in the timeout error. */
  readonly label?: string;
}

/**
 * Poll `condition` across effect flushes until truthy (bounded). Use this to
 * assert on state that lands asynchronously instead of asserting immediately
 * after a write — it converts "usually flushed by now" into "flushed".
 */
export async function waitFor(
  condition: () => boolean,
  { timeoutMs = 5_000, label = 'condition' }: WaitForOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await flushInk();
  }
}

/** `waitFor` specialized to "a rendered frame contains `needle`"; returns that frame. */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  needle: string,
  options: WaitForOptions = {},
): Promise<string> {
  await waitFor(() => (lastFrame() ?? '').includes(needle), {
    label: `frame containing ${JSON.stringify(needle)}`,
    ...options,
  });
  return lastFrame() ?? '';
}
