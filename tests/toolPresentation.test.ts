import { describe, expect, it } from 'vitest';
import { batchOutcomeText, presentTool } from '../src/ui/toolPresentation';

describe('semantic tool presentation', () => {
  it('describes navigation by intent and explicit counts by outcome', () => {
    expect(presentTool({ name: 'grep', args: { pattern: 'TODO' }, result: { matches: [{}, {}] } })).toEqual({
      family: 'search', activity: 'Searching for “TODO”', outcome: '2 matches',
    });
    expect(presentTool({ name: 'glob_files', args: { pattern: 'src/**' }, result: { files: ['a', 'b'] } }).outcome).toBe('2 files');
  });

  it('reports write and patch facts without exposing payload plumbing', () => {
    expect(presentTool({ name: 'write_file', args: { path: 'a.ts', content: 'secret' }, result: { path: 'a.ts', bytesWritten: 6 } })).toEqual({
      family: 'write', activity: 'Writing a.ts', outcome: '6 bytes',
    });
    expect(presentTool({
      name: 'apply_patch',
      args: { operations: [{ op: 'update', path: 'a.ts', content: 'x' }, { op: 'create', path: 'b.ts', content: 'y' }] },
      result: { filesChanged: 2, created: ['b.ts'], updated: ['a.ts'], deleted: [] },
    }).outcome).toBe('2 files · 1 created · 1 updated');
    expect(presentTool({
      name: 'apply_patch',
      args: { changes: [{ kind: 'add', path: 'a.ts' }, { kind: 'update', path: 'b.ts' }] },
      result: 'add a.ts\nupdate b.ts',
    }).activity).toBe('Applying patch to 2 files');
    expect(presentTool({ name: 'apply_patch', args: { changes: [] }, result: '' }).activity).toBe('Applying patch');
  });

  it('detects tests/builds conservatively and uses explicit exit/duration fields', () => {
    expect(presentTool({ name: 'run_shell', args: { command: 'npm test' }, result: { exitCode: 0, durationMs: 240 } })).toEqual({
      family: 'test', activity: 'Running tests', outcome: 'tests passed · exit 0 · 240ms',
    });
    expect(presentTool({ name: 'run_shell', args: { command: 'npm run build' }, result: undefined }).outcome).toBe('');
    expect(presentTool({ name: 'run_shell', args: { command: 'echo test' }, result: { stdout: 'test' } }).family).toBe('process');
    expect(presentTool({ name: 'shell', args: { command: "/bin/zsh -lc 'pwd && rg --files | head -50'" }, result: undefined }).activity).toBe('Inspecting workspace');
    expect(presentTool({ name: 'shell', args: { command: "/bin/zsh -lc 'npm run check && npm run build'" }, result: undefined }).activity).toBe('Checking project');
    expect(presentTool({ name: 'shell', args: { command: 'deploy --token super-secret' }, result: undefined }).activity).toBe('Running command');
  });

  it('distinguishes semantic TypeScript checks from syntax-only Node checks', () => {
    expect(presentTool({ name: 'shell', args: { command: 'tsc --noEmit' }, result: { exitCode: 0 } })).toMatchObject({
      family: 'build', activity: 'Type-checking project', outcome: 'typecheck passed · exit 0',
    });
    expect(presentTool({ name: 'shell', args: { command: './node_modules/.bin/tsc --noEmit' }, result: undefined }).activity).toBe('Type-checking project');
    expect(presentTool({ name: 'shell', args: { command: 'node --check src/cli.js' }, result: { exitCode: 0 } })).toMatchObject({
      activity: 'Checking syntax', outcome: 'syntax passed · exit 0',
    });
    expect(presentTool({ name: 'shell', args: { command: "/bin/zsh -lc 'node --experimental-strip-types --check src/cli.ts'" }, result: { exitCode: 0 } })).toMatchObject({
      activity: 'Checking TypeScript syntax', outcome: 'syntax passed · exit 0',
    });
    expect(presentTool({ name: 'shell', args: { command: 'node scripts/check-types.mjs' }, result: undefined }).activity).toBe('Checking project');
    expect(presentTool({ name: 'shell', args: { command: 'node scripts/typecheck.mjs' }, result: undefined }).activity).toBe('Running command');
    expect(presentTool({ name: 'shell', args: { command: 'echo src/typecheck.ts' }, result: undefined }).activity).toBe('Running command');
  });

  it('presents managed process lifecycle evidence instead of a generic tool name', () => {
    expect(presentTool({ name: 'poll_process', args: { process_id: 'p1' }, result: { status: 'timed_out', reason: 'idle timeout after 25ms', exitCode: null, signal: 'SIGTERM' } })).toEqual({
      family: 'process', activity: 'Checking process p1', outcome: 'timed_out · idle timeout after 25ms · SIGTERM',
    });
    expect(presentTool({ name: 'terminate_process', args: { process_id: 'p2' }, result: { status: 'terminated', reason: 'terminated by request', signal: 'SIGTERM' } }).outcome).toBe('terminated · terminated by request · SIGTERM');
  });

  it('summarizes structured verification without dumping diagnostics', () => {
    expect(presentTool({ name: 'run_verification', args: { checks: ['test', 'lint'] }, result: { status: 'failed', passed: 1, failed: 1, durationMs: 321, commands: [{ diagnostics: 'secret' }] } })).toEqual({
      family: 'build', activity: 'Verifying project', outcome: '1 check passed · 1 check failed · 321ms',
    });
  });

  it('turns MCP plumbing into a stable service.operation label', () => {
    expect(presentTool({ name: 'mcp__brain__recall', args: { query: 'state' }, result: {} }).activity).toBe('Calling brain.recall');
  });

  it('does not invent outcomes for unknown result shapes', () => {
    expect(presentTool({ name: 'read_file', args: { path: 'a.ts' }, result: undefined }).outcome).toBe('');
    expect(presentTool({ name: 'mystery', args: { private: 'raw' }, result: { ok: true } })).toEqual({ family: 'other', activity: 'mystery', outcome: '' });
  });

  it('aggregates only additive explicit facts for concurrent completion', () => {
    expect(batchOutcomeText([
      { name: 'glob_files', result: { files: ['a', 'b'] } },
      { name: 'grep', result: { matches: [{}, {}, {}] } },
      { name: 'run_shell', result: { exitCode: 0 } },
    ])).toBe('2 files · 3 matches · exit 0');
  });
});
