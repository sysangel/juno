// tests/fixtures/hooks/injectContext.mjs
// PostToolUse hook fixture — models the brain-hook's ambient recall injection.
//
// Reads the JSON hook payload on stdin and writes a Claude-shaped
// `{hookSpecificOutput:{additionalContext}}` back on stdout. The additionalContext
// echoes the RECEIVED tool_name, so a passing e2e proves the real stdin payload
// reached this spawned child (not a stub). If argv[2] is a path it also drops the
// full received payload there as a sentinel, letting the e2e additionally assert
// hook_event_name / tool_input / tool_response crossed the pipe.
//
// Pure stdio + optional tempdir sentinel: no network, no personal paths, no
// ~/.claude access. Spawned via `[process.execPath, thisFile]` (shell-free).
import { writeFileSync } from 'node:fs';
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

  const sentinelPath = process.argv[2];
  if (typeof sentinelPath === 'string' && sentinelPath.length > 0) {
    try {
      writeFileSync(sentinelPath, JSON.stringify(payload));
    } catch {
      // best-effort; the stdout contract below is the primary assertion surface
    }
  }

  const additionalContext = `[recall] ${payload.tool_name}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext } }));
  process.exit(0);
});
