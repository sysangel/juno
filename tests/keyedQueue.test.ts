// tests/keyedQueue.test.ts
// Unit tests for the per-key serialized queue: strict FIFO per key, concurrency
// across keys, a failed task never wedging the chain (and its returned promise
// still rejecting), and drain() awaiting everything — including tasks scheduled
// DURING the drain.
import { describe, expect, it } from 'vitest';
import { createKeyedQueue } from '../src/services/keyedQueue';

/** A real macrotask tick, so a task is genuinely pending across a check. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createKeyedQueue', () => {
  it('runs same-key tasks strictly one-at-a-time in FIFO order', async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];

    const p1 = queue.run('k', async () => {
      order.push('t1-start');
      await tick();
      order.push('t1-end');
    });
    const p2 = queue.run('k', async () => {
      order.push('t2-start');
      order.push('t2-end');
    });

    await Promise.all([p1, p2]);
    // t2 never overlaps t1: t1 fully settles before t2 starts.
    expect(order).toEqual(['t1-start', 't1-end', 't2-start', 't2-end']);
  });

  it('runs different keys concurrently', async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];

    const a = queue.run('a', async () => {
      order.push('a-start');
      await tick();
      order.push('a-end');
    });
    const b = queue.run('b', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.all([a, b]);
    // 'b' does not wait behind 'a' — its start interleaves before 'a' finishes.
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('a rejected task does NOT wedge the key; its promise still rejects', async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];

    const p1 = queue.run('k', async () => {
      order.push('t1');
      throw new Error('boom');
    });
    const p2 = queue.run('k', async () => {
      order.push('t2');
      return 'ok';
    });

    await expect(p1).rejects.toThrow('boom'); // the specific task's error surfaces
    await expect(p2).resolves.toBe('ok'); // the next task still ran
    expect(order).toEqual(['t1', 't2']); // and in order
  });

  it('returns each task its OWN result, not the swallowed tail', async () => {
    const queue = createKeyedQueue();
    const value = await queue.run('k', async () => 42);
    expect(value).toBe(42);
  });

  it('drain resolves only AFTER all pending tasks settle', async () => {
    const queue = createKeyedQueue();
    let done = false;

    queue.run('k', async () => {
      await tick();
      await tick();
      done = true;
    });

    expect(done).toBe(false); // still pending right after run()
    await queue.drain();
    expect(done).toBe(true); // drain waited for it
  });

  it('drain also awaits tasks scheduled DURING the drain', async () => {
    const queue = createKeyedQueue();
    const order: string[] = [];

    queue.run('k', async () => {
      order.push('t1');
      // Schedule a follow-up while the drain is already in flight.
      void queue.run('k', async () => {
        await tick();
        order.push('t2');
      });
    });

    await queue.drain();
    expect(order).toEqual(['t1', 't2']);
  });
});
