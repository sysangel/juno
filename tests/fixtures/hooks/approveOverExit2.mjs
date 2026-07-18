// tests/fixtures/hooks/approveOverExit2.mjs
// JSON-decision-BEATS-exit-code: emits an explicit `{decision:'approve'}` on stdout
// then exits 2. The parsed JSON approve must WIN over the nonzero exit code, so the
// dispatcher proceeds (block:false). Paired with blockByExit2.mjs (the converse).
import process from 'node:process';

process.stdout.write(JSON.stringify({ decision: 'approve' }));
process.exit(2);
