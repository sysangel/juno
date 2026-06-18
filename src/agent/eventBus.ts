// src/agent/eventBus.ts
// W6 — the permission park/resolve registry, keyed by toolCallId.
//
// This is the heart of the permission round-trip. The executor (W7) calls
// `await deps.awaitPermission(toolCallId)` and only re-checks `signal.aborted`
// AFTER that promise settles. So EVERY parked promise MUST eventually resolve —
// on a user decision (`resolve`) or on abort/teardown (`drainDeny`) — or the
// turn hangs forever. We never reject; the only currency is a PermissionDecision.
//
// No clock, no randomness, no Promise.withResolvers (Node 20 may lack it) — we
// build our own minimal deferred.
import type { PermissionDecision } from '../core/events';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  return { promise, resolve: resolveDeferred };
}

export interface PermissionRegistry {
  /** Park a promise for `toolCallId`; a second await for the same id returns the same pending promise. */
  await(toolCallId: string): Promise<PermissionDecision>;
  /** Resolve the parked promise once; no-op if absent/already resolved. */
  resolve(toolCallId: string, decision: PermissionDecision): void;
  /** Resolve EVERY still-parked promise with 'deny' (abort/teardown). */
  drainDeny(): void;
  /** Count of currently-parked ids (for tests). */
  pending(): number;
}

export function createPermissionRegistry(): PermissionRegistry {
  const parked = new Map<string, Deferred<PermissionDecision>>();
  // A decision that arrived via resolve() BEFORE any await() parked it. The
  // executor's await(id) settles synchronously from here (and clears it) so an
  // out-of-order resolve()->await() can never hang. drainDeny() does NOT touch
  // this map — only a parked promise can be drained; an early decision is the
  // user's already-made choice and must win.
  const resolvedBefore = new Map<string, PermissionDecision>();

  return {
    await: (toolCallId: string): Promise<PermissionDecision> => {
      const early = resolvedBefore.get(toolCallId);
      if (early !== undefined) {
        resolvedBefore.delete(toolCallId);
        return Promise.resolve(early);
      }

      const existing = parked.get(toolCallId);
      if (existing !== undefined) {
        return existing.promise;
      }

      const deferred = createDeferred<PermissionDecision>();
      parked.set(toolCallId, deferred);
      return deferred.promise;
    },

    resolve: (toolCallId: string, decision: PermissionDecision): void => {
      const deferred = parked.get(toolCallId);
      if (deferred === undefined) {
        // Nothing parked yet: stash the decision so a later await(id) returns it
        // immediately instead of hanging. Last write wins.
        resolvedBefore.set(toolCallId, decision);
        return;
      }

      // Delete BEFORE resolve so re-entrant resolve()/drainDeny() can't double-fire.
      parked.delete(toolCallId);
      deferred.resolve(decision);
    },

    drainDeny: (): void => {
      const entries = Array.from(parked.values());
      parked.clear();

      for (const deferred of entries) {
        deferred.resolve('deny');
      }
    },

    pending: (): number => parked.size,
  };
}
