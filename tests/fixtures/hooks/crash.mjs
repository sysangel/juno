// tests/fixtures/hooks/crash.mjs
// Fail-OPEN case: writes NON-JSON junk then exits NONZERO but NOT 2. With no
// parseable JSON decision and an exit code that is not the block sentinel (2), the
// dispatcher must proceed as if the hook produced no decision (block:false). This
// is deliberately distinct from the exit-2 governance path (see blockByExit2.mjs).
import process from 'node:process';

process.stdout.write('crashed: not-json junk output');
process.exit(1);
