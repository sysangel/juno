// tests/fixtures/hooks/oversized.mjs
// Fail-OPEN via the stdout size cap: streams far more than the dispatcher's
// MAX_HOOK_OUTPUT_CHARS (100_000) so the drain loop trips the cap, kills the child,
// and proceeds (block:false). No explicit exit — the dispatcher's kill ends us; if
// the cap logic ever regressed the process would drain and exit on its own.
import process from 'node:process';

process.stdout.write('x'.repeat(200_000));
