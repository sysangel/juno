// src/services/keyedQueue.ts
// Per-key serialized task queue. Each key owns a promise chain; tasks on the same
// key run strictly one-at-a-time in FIFO call order, so a whole-file
// read-modify-write can never interleave with another write to the same key. Tasks
// on DIFFERENT keys run concurrently (different keys = independent chains).
//
// The session store keys on the session id (different sessions stay concurrent —
// different files). The memory store keys ALL mutations on one constant key,
// because its single memory.json holds every entry, so cross-key updates would
// otherwise clobber each other via read-modify-write.

export interface KeyedQueue {
  /** Run `task` after all previously-scheduled tasks for `key` have settled. The
   * returned promise settles with THIS task's own result (resolve OR reject). */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Resolve once every currently-pending task (across all keys) has settled,
   * INCLUDING tasks scheduled while a drain is in progress. Never throws. */
  drain(): Promise<void>;
}

export function createKeyedQueue(): KeyedQueue {
  // Per-key TAIL: a never-rejecting continuation of the last task on the key. The
  // next run() chains off it, so ordering survives a failed task, and its entry is
  // GC'd once it settles and no newer task has replaced it.
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      // Run `task` after `prev` SETTLES — the SAME task in BOTH `.then` handlers
      // runs it even when the prior task REJECTED (task ignores its arg), so one
      // failed write never wedges the chain, while `.then`'s sequencing still
      // guarantees task N+1 starts only after task N settles (strict FIFO).
      const next = prev.then(task, task);
      // Never-rejecting tail stored as the chain head for the next run(). It also
      // attaches a rejection handler to `next`, so a caller that ignores the
      // returned promise can never leak an unhandled rejection.
      const tail = next.then(
        () => {},
        () => {},
      );
      // Mutate `tails` SYNCHRONOUSLY so same-key calls chain in strict call order.
      tails.set(key, tail);
      // GC: once this tail settles, drop the key IF it is still the live tail (a
      // later run() may have already replaced it — identity guard) so the map does
      // not grow unbounded across many keys.
      void tail.then(() => {
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      });
      // Return `next` (NOT `tail`) so the caller observes this specific task's
      // resolve/reject — a real write failure still surfaces to its awaiter.
      return next;
    },
    async drain(): Promise<void> {
      // Re-read `tails` each pass so tasks scheduled DURING the drain are also
      // awaited; the settled tails GC themselves out, so the map empties.
      while (tails.size > 0) {
        await Promise.allSettled([...tails.values()]);
      }
    },
  };
}
