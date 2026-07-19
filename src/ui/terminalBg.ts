// src/ui/terminalBg.ts
// Zero-dependency OSC 11 terminal-background probe. Runs ONCE at startup, BEFORE
// Ink attaches stdin, so a user on a LIGHT terminal who has NOT pinned a theme
// gets the light palette instead of the dark-on-light default. On non-tty /
// no-reply / timeout it resolves undefined and the caller falls back to today's
// behaviour. Design goals: never corrupt the terminal (raw mode is restored on
// every exit path), never delay startup past the timeout, and never swallow a
// keystroke typed before Ink attaches (interleaved bytes are re-emitted via
// Readable.unshift). Only `queryTerminalBackground` touches I/O; the rest is pure.
//
// This file imports ONLY the `Background` TYPE — no stdin/stdout logic lives in
// theme.ts (kept self-contained), and no `#RRGGBB` literals live here (the a6
// drift-lint bans color literals in src/ui outside theme.ts/glyphs.ts).
import type { Background } from './theme';

// The OSC 11 reply: `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` terminated by BEL (\x07) OR
// ST (ESC \). Requiring the terminator prevents a partial/truncated third channel
// from matching before the rest of the reply arrives. 1–4 hex digits per channel.
const OSC11_REPLY =
  /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)/;

/** Width-normalize a 1–4 digit hex channel to 0–255 (so 'ffff'->255, '80'->128, 'f'->255). */
function channelTo8bit(hex: string): number {
  return Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
}

/** Parse an OSC 11 reply out of `buffer`. Pure, total, never throws; undefined on no match. */
export function parseOsc11Reply(buffer: string): { r: number; g: number; b: number } | undefined {
  const m = OSC11_REPLY.exec(buffer);
  if (m === null) return undefined;
  return { r: channelTo8bit(m[1]), g: channelTo8bit(m[2]), b: channelTo8bit(m[3]) };
}

/** Rec.601 luma classification: L > 128 ⇒ 'light' (strict, so exactly-128 gray ⇒ 'dark'). Pure. */
export function backgroundFromRgb(rgb: { r: number; g: number; b: number }): Background {
  const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return luma > 128 ? 'light' : 'dark';
}

/**
 * Query the terminal background via OSC 11. The ONLY impure function here; streams
 * are injectable (default process.stdin/stdout) so it is unit-testable without a
 * real TTY. Always resolves — never hangs, never rejects. Resolves undefined on
 * non-tty, no reply, or timeout; the caller then falls back to COLORFGBG / 'dark'.
 */
export async function queryTerminalBackground(opts?: {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  timeoutMs?: number;
}): Promise<Background | undefined> {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  const timeoutMs = opts?.timeoutMs ?? 150;

  // Non-tty / piped stdin / test env: write NOTHING, resolve immediately.
  if (!input.isTTY || typeof input.setRawMode !== 'function') return undefined;

  return await new Promise<Background | undefined>((resolve) => {
    const wasRaw = input.isRaw === true;
    let buf = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Idempotent teardown: restore the PRIOR raw state and pause on every exit path.
    // Raw-mode restore is wrapped so a throw can't leave the timer/listener dangling.
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      input.off('data', onData);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // best-effort — restoring raw mode must never throw out of cleanup
      }
      input.pause();
    };

    const onData = (chunk: Buffer): void => {
      // Accumulate raw BYTES; decode a latin1 view (1 char == 1 byte) so string
      // indices are byte offsets and early keystrokes survive byte-exact.
      buf = Buffer.concat([buf, chunk]);
      const m = OSC11_REPLY.exec(buf.toString('latin1'));
      if (m === null) return;
      const start = m.index;
      const end = m.index + m[0].length;
      const leftover = Buffer.concat([buf.subarray(0, start), buf.subarray(end)]);
      const bg = backgroundFromRgb({
        r: channelTo8bit(m[1]),
        g: channelTo8bit(m[2]),
        b: channelTo8bit(m[3]),
      });
      // Tear down (removes our listener + pauses) BEFORE re-queuing so the unshift
      // can't re-enter onData. Any interleaved keystrokes go back to the next
      // consumer (Ink) with the OSC bytes stripped out.
      cleanup();
      if (leftover.length > 0) input.unshift(leftover);
      resolve(bg);
    };

    // Wrap the whole setup so a synchronous throw (setRawMode/resume errno, or a
    // destroyed output stream) can't reject the promise or leak raw mode: the brief
    // mandates this always resolves. cleanup() is idempotent and restores raw mode.
    try {
      input.setRawMode(true);
      input.on('data', onData);
      input.resume();
      timer = setTimeout(() => {
        // No reply within the window (the common node-pty case). Re-emit any bytes
        // typed during the probe so keystrokes are not swallowed before Ink attaches,
        // then fall back. Tear down BEFORE unshift so it can't re-enter onData.
        cleanup();
        if (buf.length > 0) input.unshift(buf);
        resolve(undefined);
      }, timeoutMs);
      // Emit the query only AFTER isTTY passed. BEL-terminated; the reply parser
      // accepts BEL or ST.
      output.write('\x1b]11;?\x07');
    } catch {
      cleanup();
      resolve(undefined);
    }
  });
}
