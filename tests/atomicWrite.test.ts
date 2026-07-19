// tests/atomicWrite.test.ts
// Crash-safety unit tests for atomicWriteFile: a rename failure (the stand-in for
// a crash between the tmp write and the swap) must leave the target's PREVIOUS
// bytes byte-for-byte intact and never leak partial/new content into it.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../src/services/atomicWrite';

const tempDirs: string[] = [];

async function makeTempDir(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `juno-${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('atomicWriteFile', () => {
  it('atomically replaces the target with new content, no tmp leftover', async () => {
    const dir = await makeTempDir('atomic-rt');
    const target = path.join(dir, 'f.json');

    await atomicWriteFile(target, 'first');
    expect(await readFile(target, 'utf8')).toBe('first');

    await atomicWriteFile(target, 'second');
    expect(await readFile(target, 'utf8')).toBe('second');

    // Success path stages then renames the tmp away — only the target remains.
    expect(await readdir(dir)).toEqual(['f.json']);
  });

  it('leaves the target UNTOUCHED when rename fails (crash-safety)', async () => {
    const dir = await makeTempDir('atomic-crash');
    const target = path.join(dir, 'session.json');
    await writeFile(target, 'OLD', 'utf8');

    await expect(
      atomicWriteFile(target, 'NEW', {
        rename: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    // The previous bytes survive byte-for-byte — no partial/new content leaked.
    expect(await readFile(target, 'utf8')).toBe('OLD');
    // The orphan tmp was unlinked; only the untouched target remains.
    expect(await readdir(dir)).toEqual(['session.json']);
  });

  it('unlinks the partial tmp when writeFile fails AFTER writing (ENOSPC-style)', async () => {
    const dir = await makeTempDir('atomic-nospc');
    const target = path.join(dir, 'session.json');
    await writeFile(target, 'OLD', 'utf8');

    // Perform the REAL write (so a partial .tmp actually lands on disk) then throw,
    // standing in for an ENOSPC/EDQUOT/EACCES that surfaces after a partial write.
    await expect(
      atomicWriteFile(target, 'NEW', {
        writeFile: async (p, d) => {
          await writeFile(p as string, d as string, 'utf8');
          throw new Error('nospc');
        },
      }),
    ).rejects.toThrow('nospc');

    // The pre-existing target is untouched (rename never ran)...
    expect(await readFile(target, 'utf8')).toBe('OLD');
    // ...and the partial tmp was cleaned up, so no *.tmp litters the store dir.
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).toEqual(['session.json']);
  });

  it('stages into a same-dir sibling that never ends in .json', async () => {
    const dir = await makeTempDir('atomic-tmp');
    const target = path.join(dir, 'memory.json');
    let seenTmp = '';

    // Capture the tmp path via the rename source (rename is a no-op here).
    await atomicWriteFile(target, 'x', {
      rename: async (oldPath) => {
        seenTmp = String(oldPath);
      },
    });

    expect(path.dirname(seenTmp)).toBe(dir); // same filesystem as the target
    expect(seenTmp.endsWith('.tmp')).toBe(true);
    expect(seenTmp.endsWith('.json')).toBe(false); // so list()/reader .json filters skip it
  });
});
