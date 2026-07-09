// src/hooks/useBracketedPaste.ts
// G (composer-input) — turn the terminal's bracketed-paste mode ON while the
// composer is mounted so a paste arrives wrapped in ESC[200~ … ESC[201~ markers
// (Composer strips them and inserts the payload as ONE multiline value instead of
// letting an embedded newline fire a premature submit). Mode is a terminal-global
// toggle, so enable on mount and DISABLE on unmount to leave the terminal as we
// found it.
//
// TTY-gated: unit runners (ink-testing-library, a non-TTY stdout) must never get
// raw control bytes written into their captured frames, so we only emit when the
// stream is a real TTY.
import { useEffect } from 'react';
import { useStdout } from 'ink';

const ESC = String.fromCharCode(27);
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

export function useBracketedPaste(): void {
  const { stdout } = useStdout();
  useEffect(() => {
    if (stdout === undefined || stdout.isTTY !== true) {
      return;
    }
    stdout.write(ENABLE_BRACKETED_PASTE);
    return () => {
      stdout.write(DISABLE_BRACKETED_PASTE);
    };
  }, [stdout]);
}
