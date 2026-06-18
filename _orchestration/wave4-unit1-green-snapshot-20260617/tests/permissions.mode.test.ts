// tests/permissions.mode.test.ts
// W8 — vitest suite for the mode/allow/deny subset of the permission policy.
// Standalone so the existing permissions.test.ts suite stays untouched.
import { describe, it, expect } from 'vitest';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFileTools } from '../src/tools/fileTools';

describe('createPermissionPolicy — mode default (unchanged baseline)', () => {
  it('prompts risky write_file in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('prompts risky edit_file in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('edit_file', { path: 'x' }, 'risky')).toBe('prompt');
  });

  it('still auto-allows safe tools in default mode', () => {
    const p = createPermissionPolicy({ mode: 'default' });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
  });

  it('omitting mode is identical to default', () => {
    const p = createPermissionPolicy();
    expect(p.evaluate('write_file', { path: 'x' }, 'risky')).toBe('prompt');
  });
});

describe('createPermissionPolicy — mode acceptEdits', () => {
  it('auto-allows write_file by name', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('write_file', { path: 'a/b.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('auto-allows edit_file by name', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('edit_file', { path: 'a/b.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('STILL prompts spawn_subagent even though it is risky (load-bearing)', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('spawn_subagent', { path: '' }, 'risky')).toBe('prompt');
  });

  it('does NOT auto-allow other risky tools (e.g. shell)', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('shell', { dir: 'repo' }, 'risky')).toBe('prompt');
  });

  it('still auto-allows safe tools under acceptEdits', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('auto-allow');
  });

  it('still prompts dangerous tools under acceptEdits with no bypass', () => {
    const p = createPermissionPolicy({ mode: 'acceptEdits' });
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('prompt');
  });

  it('respects autoAllowSafe false under acceptEdits', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      autoAllowSafe: false,
    });
    expect(p.evaluate('read_file', { path: 'a' }, 'safe')).toBe('prompt');
  });
});

describe('createPermissionPolicy — seeded allow', () => {
  it('auto-allows a matching risky call in default mode', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:src/*'],
    });
    expect(p.evaluate('write_file', { path: 'src/a.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });

  it('does not allow a non-matching path', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:src/*'],
    });
    expect(p.evaluate('write_file', { path: 'other/a.ts' }, 'risky')).toBe(
      'prompt',
    );
  });

  it('bare tool name in allow covers all paths for that tool', () => {
    const p = createPermissionPolicy({ mode: 'default', allow: ['edit_file'] });
    expect(p.evaluate('edit_file', { path: 'anywhere/x' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});

describe('createPermissionPolicy — seeded deny', () => {
  it('auto-denies a matching call', () => {
    const p = createPermissionPolicy({ deny: ['shell:*'] });
    expect(p.evaluate('shell', { dir: 'repo' }, 'dangerous')).toBe('auto-deny');
  });

  it('deny beats acceptEdits for write_file on a denied path', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      deny: ['write_file:secret.txt'],
    });
    expect(p.evaluate('write_file', { path: 'secret.txt' }, 'risky')).toBe(
      'auto-deny',
    );
  });

  it('deny on one path does not block acceptEdits auto-allow on another', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      deny: ['write_file:secret.txt'],
    });
    expect(p.evaluate('write_file', { path: 'normal.txt' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});

describe('createPermissionPolicy — deny beats allow (collision)', () => {
  it('seeded deny wins over seeded allow for the same pattern', () => {
    const p = createPermissionPolicy({
      mode: 'default',
      allow: ['write_file:locked/*'],
      deny: ['write_file:locked/*'],
    });
    expect(p.evaluate('write_file', { path: 'locked/a.ts' }, 'risky')).toBe(
      'auto-deny',
    );
  });

  it('deny wins over allow even under acceptEdits', () => {
    const p = createPermissionPolicy({
      mode: 'acceptEdits',
      allow: ['write_file:*'],
      deny: ['write_file:forbidden.ts'],
    });
    expect(p.evaluate('write_file', { path: 'forbidden.ts' }, 'risky')).toBe(
      'auto-deny',
    );
    // sibling path still allowed via the seeded allow
    expect(p.evaluate('write_file', { path: 'ok.ts' }, 'risky')).toBe(
      'auto-allow',
    );
  });
});

describe('acceptEdits tool-name pin (guards the policy <-> tool-name coupling)', () => {
  // The policy's ACCEPT_EDITS_TOOLS set hard-codes the tool NAMES 'write_file'
  // and 'edit_file'. If a tool were renamed, acceptEdits would silently stop
  // auto-allowing it (fail-safe toward prompting) with no other test catching it.
  // This pins the assumption: those names must exist and be risk:'risky' (so that
  // acceptEdits is exactly what flips them from prompt -> auto-allow).
  it('write_file and edit_file exist as risky tools', () => {
    const byName = new Map(createFileTools().map((tool) => [tool.name, tool]));
    for (const name of ['write_file', 'edit_file']) {
      const tool = byName.get(name);
      expect(tool, `tool "${name}" must exist for acceptEdits to target it`).toBeDefined();
      expect(tool?.risk).toBe('risky');
    }
  });
});
