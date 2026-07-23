// src/ui/wipeScrollback.ts
// The ONE sanctioned emitter of the erase-scrollback escape. The scroll model
// (docs/UX-SPEC.md R4.2, selftest invariant `no-erase-scrollback`) treats `\x1b[3J`
// as UNREACHABLE — Ink's tall-output full-repaint branch must never destroy native
// scrollback — EXCEPT here: the deliberate transcript-replacement wipe on
// clear / resume. Those two lifecycle actions swap `committed` wholesale
// and bump `transcriptEpoch`, remounting <Static> so it RE-PRINTS the entire new
// transcript; the terminal cannot un-print the OLD copy still sitting in its
// scrollback, so unless the scrollback is erased FIRST the remount stacks a second
// copy above it (the resume duplication bug). Owning the escape in
// one place means the call sites can never drift or forget the wipe.

/** Minimal writable-with-TTY-flag shape. `process.stdout` and Ink's `useStdout()`
 *  stream both satisfy it, and a test can pass a capturing fake. */
export interface WipeTarget {
  readonly isTTY?: boolean;
  write(chunk: string): boolean;
}

/** ANSI: erase scrollback (`3J`) + erase screen (`2J`) + cursor home (`H`). */
export const WIPE_SEQUENCE = '\x1b[3J\x1b[2J\x1b[H';

/** Erase native scrollback + screen so a <Static> remount reprints onto a clean
 *  terminal instead of stacking a second copy above the old one. Model-only
 *  compaction never calls this path. TTY-gated: a
 *  non-TTY stdout (unit runners, pipes) must never receive raw control bytes. */
export function wipeScrollback(stdout: WipeTarget): void {
  if (stdout.isTTY === true) {
    stdout.write(WIPE_SEQUENCE);
  }
}
