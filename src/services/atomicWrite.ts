// src/services/atomicWrite.ts
// Crash-safe file write: stage the full contents into a sibling tmp file, then
// atomically rename() it onto the final path. A SIGKILL (or any crash) at any
// point leaves the final path holding its PREVIOUS bytes — never a truncated or
// half-written file — because the target is only ever swapped whole by rename.
//
// Used by the session store and the memory store, both of which read-modify-write
// a whole file; the non-atomic `writeFile` they used before could truncate the
// target mid-write, and their tolerant readers then silently dropped the file
// (returning undefined / an empty map). This closes that data-loss window.
import { rename as nodeRename, unlink as nodeUnlink, writeFile as nodeWriteFile } from 'node:fs/promises';

/**
 * Injectable fs seam so a test can force a rename failure (crash between write and
 * rename) without a real crash. Defaults are the real node:fs/promises functions.
 */
export interface AtomicWriteDeps {
  writeFile?: typeof nodeWriteFile;
  rename?: typeof nodeRename;
  unlink?: typeof nodeUnlink;
}

// Monotonic per-process counter feeding the tmp name. pid + counter make the tmp
// unique across concurrent writers to the SAME target AND across crash-leftovers
// (a stale tmp from a dead pid can never collide with a live write).
let tmpCounter = 0;

/**
 * Atomically replace `finalPath` with `contents`.
 *
 * The tmp sibling MUST live in the same directory as `finalPath` (rename is atomic
 * only WITHIN one filesystem) and MUST NOT end in `.json` — the session `list()`
 * and the memory reader both key off that suffix, so a `.tmp` sibling is skipped.
 * On ANY failure (a partial writeFile as well as a rename) the target is left
 * UNTOUCHED (its previous bytes intact) and the orphan tmp is best-effort removed
 * before the error is rethrown.
 */
export async function atomicWriteFile(
  finalPath: string,
  contents: string,
  deps?: AtomicWriteDeps,
): Promise<void> {
  const writeFile = deps?.writeFile ?? nodeWriteFile;
  const rename = deps?.rename ?? nodeRename;
  const unlink = deps?.unlink ?? nodeUnlink;

  tmpCounter += 1;
  const tmp = `${finalPath}.${process.pid}.${tmpCounter}.tmp`;

  try {
    // writeFile MUST live inside the try: a failure AFTER a partial write
    // (ENOSPC/EDQUOT/EACCES) would otherwise leave a partial tmp littering the
    // dir forever. unlink of a tmp that was never created is safely swallowed.
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, finalPath);
  } catch (err) {
    // NEVER touch finalPath on failure — that is the crash-safety guarantee. Drop
    // the orphan tmp best-effort (its removal must not mask the real error).
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
