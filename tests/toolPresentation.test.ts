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
  });

  it('detects tests/builds conservatively and uses explicit exit/duration fields', () => {
    expect(presentTool({ name: 'run_shell', args: { command: 'npm test' }, result: { exitCode: 0, durationMs: 240 } })).toEqual({
      family: 'test', activity: 'Running tests', outcome: 'tests passed · exit 0 · 240ms',
    });
    expect(presentTool({ name: 'run_shell', args: { command: 'npm run build' }, result: undefined }).outcome).toBe('');
    expect(presentTool({ name: 'run_shell', args: { command: 'echo test' }, result: { stdout: 'test' } }).family).toBe('process');
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
