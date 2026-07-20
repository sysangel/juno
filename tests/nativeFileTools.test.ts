import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionDecision } from '../src/core/events';
import type { State } from '../src/core/reducer';
import type { Tool, ToolCtx } from '../src/core/contracts';
import { createFileTools } from '../src/tools/fileTools';

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'juno-native-tools-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ctx(cwd: string): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: () => undefined,
    awaitPermission: async (): Promise<PermissionDecision> => 'allow-once',
    state: {
      committed: [], live: null, tools: {}, phase: 'idle', overlay: 'none', effort: 'medium',
      permissionMode: 'default', tokens: { in: 0, out: 0 }, pendingPermission: null, errorMessage: null,
    } satisfies Readonly<State>,
  };
}

function tool(name: string): Tool {
  const found = createFileTools().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}

function customTool(name: string, options: Parameters<typeof createFileTools>[0]): Tool {
  const found = createFileTools(options).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing ${name}`);
  return found;
}

describe('apply_patch', () => {
  it('creates, updates, and deletes several files in one structured patch', async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, 'old.txt'), 'old\n', 'utf8');
    await writeFile(path.join(cwd, 'gone.txt'), 'remove\n', 'utf8');

    const result = await tool('apply_patch').run({ operations: [
      { op: 'create', path: 'nested/new.txt', content: 'new\n' },
      { op: 'update', path: 'old.txt', oldContent: 'old\n', content: 'updated\n' },
      { op: 'delete', path: 'gone.txt', oldContent: 'remove\n' },
    ] }, ctx(cwd));

    expect(result).toMatchObject({ ok: true, data: { filesChanged: 3 } });
    await expect(readFile(path.join(cwd, 'nested/new.txt'), 'utf8')).resolves.toBe('new\n');
    await expect(readFile(path.join(cwd, 'old.txt'), 'utf8')).resolves.toBe('updated\n');
    await expect(readFile(path.join(cwd, 'gone.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights the whole batch so a late precondition failure causes no partial writes', async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, 'one.txt'), 'one\n', 'utf8');
    await writeFile(path.join(cwd, 'two.txt'), 'two\n', 'utf8');

    const result = await tool('apply_patch').run({ operations: [
      { op: 'update', path: 'one.txt', oldContent: 'one\n', content: 'changed\n' },
      { op: 'update', path: 'two.txt', oldContent: 'stale\n', content: 'changed\n' },
    ] }, ctx(cwd));

    expect(result).toEqual({
      ok: false,
      error: 'operation 2 (two.txt): content precondition failed; re-read the file and retry',
    });
    await expect(readFile(path.join(cwd, 'one.txt'), 'utf8')).resolves.toBe('one\n');
    await expect(readFile(path.join(cwd, 'two.txt'), 'utf8')).resolves.toBe('two\n');
  });

  it('rolls back an already committed file when a later filesystem write fails', async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, 'one.txt'), 'one\n', 'utf8');
    await writeFile(path.join(cwd, 'two.txt'), 'two\n', 'utf8');
    let calls = 0;
    const patch = customTool('apply_patch', {
      patchAtomicWrite: async (target, content) => {
        calls += 1;
        if (calls === 2) throw new Error('injected disk failure');
        await writeFile(target, content, 'utf8');
      },
    });

    const result = await patch.run({ operations: [
      { op: 'update', path: 'one.txt', oldContent: 'one\n', content: 'changed one\n' },
      { op: 'update', path: 'two.txt', oldContent: 'two\n', content: 'changed two\n' },
    ] }, ctx(cwd));

    expect(result).toEqual({ ok: false, error: 'patch failed; all changes rolled back: injected disk failure' });
    await expect(readFile(path.join(cwd, 'one.txt'), 'utf8')).resolves.toBe('one\n');
    await expect(readFile(path.join(cwd, 'two.txt'), 'utf8')).resolves.toBe('two\n');
  });

  it('rejects workspace escapes, sensitive paths, duplicate canonical targets, and symlink escapes', async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, 'outside.txt'), 'secret', 'utf8');
    await symlink(outside, path.join(cwd, 'escape'));

    const cases = [
      { operations: [{ op: 'create', path: '../outside.txt', content: 'x' }] },
      { operations: [{ op: 'create', path: '.env', content: 'x' }] },
      { operations: [{ op: 'update', path: 'escape/outside.txt', oldContent: 'secret', content: 'x' }] },
      { operations: [
        { op: 'create', path: 'same.txt', content: 'x' },
        { op: 'create', path: './same.txt', content: 'y' },
      ] },
    ];
    for (const args of cases) {
      const result = await tool('apply_patch').run(args, ctx(cwd));
      expect(result.ok).toBe(false);
    }
    await expect(readFile(path.join(outside, 'outside.txt'), 'utf8')).resolves.toBe('secret');
  });
});

describe('repository navigation tools', () => {
  it('reads an inclusive line range while preserving the legacy full-file result', async () => {
    const cwd = await workspace();
    await writeFile(path.join(cwd, 'lines.txt'), 'one\ntwo\nthree\n', 'utf8');
    await expect(tool('read_file').run({ path: 'lines.txt' }, ctx(cwd))).resolves.toEqual({
      ok: true, data: { path: 'lines.txt', content: 'one\ntwo\nthree\n' },
    });
    await expect(tool('read_file').run({ path: 'lines.txt', startLine: 2, endLine: 3 }, ctx(cwd))).resolves.toEqual({
      ok: true, data: { path: 'lines.txt', content: 'two\nthree', startLine: 2, endLine: 3, totalLines: 4 },
    });
  });

  it('glob_files and tree are sorted, bounded, and omit secrets, ignored dirs, and symlinks', async () => {
    const cwd = await workspace();
    await mkdir(path.join(cwd, 'src', 'deep'), { recursive: true });
    await mkdir(path.join(cwd, 'node_modules'));
    await writeFile(path.join(cwd, 'src', 'a.ts'), '', 'utf8');
    await writeFile(path.join(cwd, 'src', 'deep', 'b.ts'), '', 'utf8');
    await writeFile(path.join(cwd, 'src', '.env'), 'secret', 'utf8');
    await writeFile(path.join(cwd, 'node_modules', 'hidden.ts'), '', 'utf8');
    await symlink(path.join(cwd, 'src', 'a.ts'), path.join(cwd, 'linked.ts'));

    const glob = await tool('glob_files').run({ pattern: 'src/**/*.ts' }, ctx(cwd));
    expect(glob).toEqual({ ok: true, data: { pattern: 'src/**/*.ts', files: ['src/a.ts', 'src/deep/b.ts'], truncated: false } });

    const tree = await tool('tree').run({ depth: 3, maxEntries: 20 }, ctx(cwd));
    expect(tree).toEqual({ ok: true, data: { dir: '.', entries: [
      { path: 'src/', type: 'directory' },
      { path: 'src/a.ts', type: 'file' },
      { path: 'src/deep/', type: 'directory' },
      { path: 'src/deep/b.ts', type: 'file' },
    ], truncated: false } });
  });
});
