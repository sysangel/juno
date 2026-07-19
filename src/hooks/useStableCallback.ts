import { useCallback, useRef } from 'react';

/** A stable-identity callback that always delegates to the LATEST `fn`. Render-body ref
 * assignment — the same pattern App already uses for retryDispatchRef (app.tsx);
 * safe because the returned callback is only ever invoked from Ink event handlers,
 * never during render. */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
