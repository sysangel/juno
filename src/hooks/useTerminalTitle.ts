// src/hooks/useTerminalTitle.ts
// Terminal title (OSC 2) status hook — reflect the turn phase in the terminal's
// window/tab title so a backgrounded juno tab shows running / needs-input / idle
// at a glance. Process-edge I/O lives HERE, not in the reducer; `titleFor` keeps
// the phase→string mapping pure/testable, mirroring shouldRingBell in
// useCompletionBell.ts.
//
// TTY-gated exactly like useBracketedPaste: unit runners (a non-TTY stdout) must
// never get raw control bytes written into their captured frames, so we only emit
// when the stream is a real TTY. On mount we PUSH the current title onto the
// terminal's XTWINOPS title stack and POP it on unmount, so a terminal that
// supports the stack restores whatever title was there before juno ran (the pop
// is ignored harmlessly elsewhere).
import { useEffect, useRef } from 'react';
import { useStdout } from 'ink';
import { basename } from 'node:path';
import type { State } from '../core/reducer';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// XTWINOPS title-stack ops: 22;0t pushes the current window title, 23;0t pops it.
const PUSH_TITLE = `${ESC}[22;0t`;
const POP_TITLE = `${ESC}[23;0t`;

/**
 * PURE title formatter: the unified in-flight signal (`selectBusy`) + reducer phase +
 * cwd → the OSC-2 window-title string. Exported so the table is unit-testable without
 * rendering App. `awaiting-permission` OUTRANKS the busy signal (it IS busy) so a prompt
 * always reads 'needs input'; otherwise any in-flight phase — including preparing / retry
 * / compacting, which the old phase-only mapping missed and left reading idle — is
 * 'running'.
 *   awaiting-permission → '⚠ juno · needs input'
 *   inFlight (any other busy phase) → '✳ juno · <basename(cwd)> · running'
 *   settled (idle/error) → 'juno · <basename(cwd)>'
 */
export function titleFor(inFlight: boolean, phase: State['phase'], cwd: string): string {
  const dir = basename(cwd) || cwd;
  if (phase === 'awaiting-permission') {
    return '⚠ juno · needs input';
  }
  if (inFlight) {
    return `✳ juno · ${dir} · running`;
  }
  return `juno · ${dir}`;
}

export interface TerminalTitleDeps {
  /** The unified in-flight signal (selectBusy(turn.state)) at this render. */
  readonly inFlight: boolean;
  /** The reducer phase (turn.state.phase) at this render — decides 'needs input'. */
  readonly phase: State['phase'];
  /** settings.cwd — the working directory whose basename anchors the title. */
  readonly cwd: string;
  /** Optional gate; the title is written unless this is explicitly false. */
  readonly enabled?: boolean;
}

export function useTerminalTitle(deps: TerminalTitleDeps): void {
  const { inFlight, phase, cwd, enabled } = deps;
  const { stdout } = useStdout();
  const active = enabled !== false;
  // Last title we actually wrote — skip identical re-writes (a streaming ↔
  // running-tool flip mid-turn maps to the same title). Sentinel '' never
  // collides: titleFor always returns a non-empty string.
  const lastTitleRef = useRef<string>('');

  // Title-stack save/restore. Declared FIRST so on mount the push runs before
  // the first title write (React runs effects in declaration order); the pop
  // runs on unmount.
  useEffect(() => {
    if (!active || stdout === undefined || stdout.isTTY !== true) {
      return;
    }
    stdout.write(PUSH_TITLE);
    return () => {
      stdout.write(POP_TITLE);
    };
  }, [stdout, active]);

  // Write the OSC-2 title whenever the in-flight signal / phase / cwd (hence the
  // computed title) changes; dedup identical titles via lastTitleRef.
  useEffect(() => {
    if (!active || stdout === undefined || stdout.isTTY !== true) {
      return;
    }
    const title = titleFor(inFlight, phase, cwd);
    if (title === lastTitleRef.current) {
      return;
    }
    lastTitleRef.current = title;
    stdout.write(`${ESC}]2;${title}${BEL}`);
  }, [stdout, active, inFlight, phase, cwd]);
}
