// tests/fixtures/hooks/neverRun.mjs
// A hook that MUST NOT be spawned — used by the fail-CLOSED malformed-matcher e2e.
// If it is ever executed it writes a sentinel file (argv[2]); the test asserts the
// sentinel is ABSENT, proving the dispatcher blocked at matcher-compile time before
// any child was spawned. Pure stdio + tempdir sentinel, shell-free spawn.
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const sentinelPath = process.argv[2];
if (typeof sentinelPath === 'string' && sentinelPath.length > 0) {
  try {
    writeFileSync(sentinelPath, 'RAN');
  } catch {
    // best-effort
  }
}
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'neverRun must not have executed' }));
process.exit(0);
