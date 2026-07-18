// tests/fixtures/hooks/blockByExit2.mjs
// The CONVERSE of approveOverExit2.mjs: writes NON-JSON output (no parseable
// decision) then exits 2. With no JSON decision to govern, the exit code takes
// over and exit 2 = block. Proves the exit-code path still gates when JSON is
// absent.
import process from 'node:process';

process.stdout.write('no decision in this output');
process.exit(2);
