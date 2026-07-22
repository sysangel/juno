// React 19 requires test runners to opt into act() semantics explicitly.
// Ink's renderer is a custom React reconciler, so there is no jsdom setup to
// install this flag for us. Without it, act() warns and does not reliably flush
// hook updates, leaving tests to observe stale pre-render state.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
