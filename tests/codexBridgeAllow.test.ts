import { describe, expect, it } from 'vitest';
import { parseCodexBridgeAllow } from '../src/cli';

describe('Codex managed-tool bridge preauthorization', () => {
  it('accepts comma-separated exact supported names', () => {
    expect([...parseCodexBridgeAllow(' start_process, poll_process,run_verification ')]).toEqual([
      'start_process',
      'poll_process',
      'run_verification',
    ]);
  });

  it('ignores unknown names and wildcards instead of broadening authority', () => {
    expect([...parseCodexBridgeAllow('*,start_*,run_shell,spawn_subagent,poll_process')]).toEqual([
      'poll_process',
    ]);
    expect([...parseCodexBridgeAllow(undefined)]).toEqual([]);
  });
});
