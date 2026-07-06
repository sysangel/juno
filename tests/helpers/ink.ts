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
import { act } from 'react';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Flush React/Ink until all pending effects are committed. After this resolves,
 * every mounted `useInput` handler is subscribed and the latest frame reflects
 * all committed state. Await this before the FIRST stdin write of a test.
 */
export async function flushInk(): Promise<void> {
  await act(async () => {
    await tick();
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
    await tick();
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
