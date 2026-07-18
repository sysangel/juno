// tests/fixtures/hooks/denyPre.mjs
// PreToolUse hook fixture — models a sensitive-path guard that HARD-DENIES.
//
// Reads the JSON hook payload on stdin and writes a generic
// `{decision:'block', reason}` back on stdout (exit 0). The reason echoes the
// RECEIVED tool_name so the e2e proves the real stdin payload reached this child.
// Pure stdio, shell-free spawn, no personal paths.
import process from 'node:process';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    payload = {};
  }
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `blocked: ${payload.tool_name}` }));
  process.exit(0);
});
