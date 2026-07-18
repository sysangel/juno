// tests/fixtures/hooks/sleepForever.mjs
// A hook that NEVER responds: it emits no stdout and keeps its event loop alive on
// a long timer, so the run can only end when the dispatcher's per-hook timeout (or
// a turn abort) SIGTERM-kills it. It installs NO SIGTERM handler on purpose —
// node's default action terminates the process, which is what proves the
// dispatcher leaves no orphan behind. Drives the fail-OPEN timeout + abort e2e.
import process from 'node:process';

// Well past any test's own wall-clock bound; the dispatcher kills us first.
setTimeout(() => process.exit(0), 60_000);
