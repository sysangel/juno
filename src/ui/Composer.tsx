// src/ui/Composer.tsx
// G (composer-input) — a local fork of `ink-text-input` (Ink 5.2.1 does not parse
// bracketed-paste markers, and its up/down handler early-returns, blocking input
// history). Forking gives us three things the upstream control cannot:
//   1. Bracketed paste: `ESC[200~ … ESC[201~` markers (possibly split across data
//      chunks) are buffered, stripped, CR-normalized, and inserted at the cursor
//      as ONE multiline value — WITHOUT submitting (an embedded newline must not
//      fire Enter). Enter OUTSIDE a paste still submits.
//   2. Input history: up/down at the buffer edges delegate to the parent's ring
//      instead of being swallowed.
//   3. Multiline rendering: the value may legitimately contain '\n' (from a paste);
//      we render it verbatim (CR already normalized away, so no overprint).
//
// The editing core (cursor math, insert/backspace) is ported faithfully from
// ink-text-input so existing composer behavior is unchanged for single keystrokes.
import { Text, useInput } from 'ink';
import chalk from 'chalk';
import { useEffect, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import { useBracketedPaste } from '../hooks/useBracketedPaste';

const ESC = String.fromCharCode(27);
// Ink strips a chunk's LEADING ESC before handing `input` to a useInput handler,
// so a start marker at the front of a chunk arrives as '[200~' (esc gone) while a
// mid-chunk end marker keeps its esc as 'ESC[201~'. Match both forms of each.
const PASTE_START = `${ESC}[200~`;
const PASTE_START_STRIPPED = '[200~';
const PASTE_END = `${ESC}[201~`;
const PASTE_END_STRIPPED = '[201~';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  /** When false, the control's useInput is inactive (keystrokes are ignored). */
  readonly focus?: boolean;
  readonly showCursor?: boolean;
  /**
   * Called on Up when the cursor sits on the FIRST line of the buffer (older
   * history). Omitted ⇒ Up is swallowed (the ink-text-input early-return). The
   * parent owns the ring; the Composer only reports the edge event.
   */
  readonly onHistoryPrev?: () => void;
  /** Called on Down when the cursor sits on the LAST line of the buffer (newer). */
  readonly onHistoryNext?: () => void;
  /**
   * Optional shared flag mirrored from the paste buffer: true while a bracketed
   * paste is still assembling (buffer non-null), false otherwise. Lets a SIBLING
   * useInput (useKeybinds) ignore keys mid-paste — see setPasteBuffer below.
   */
  readonly pasteActiveRef?: MutableRefObject<boolean>;
}

/** Does `input` open (or contain the opening of) a bracketed paste? */
function hasPasteStart(input: string): boolean {
  return input.startsWith(PASTE_START_STRIPPED) || input.includes(PASTE_START);
}

export function Composer({
  value,
  onChange,
  onSubmit,
  focus,
  showCursor,
  onHistoryPrev,
  onHistoryNext,
  pasteActiveRef,
}: ComposerProps): ReactElement {
  const isFocused = focus ?? true;
  const withCursor = (showCursor ?? true) && isFocused;

  useBracketedPaste();

  const [cursorOffset, setCursorOffset] = useState<number>(value.length);
  // Accumulates a paste payload while its markers span multiple data chunks.
  // null ⇒ not inside a paste.
  const pasteBufferRef = useRef<string | null>(null);
  // Single writer for the paste buffer that also mirrors the open/closed state into
  // the optional shared `pasteActiveRef`. Sibling useInput handlers (useKeybinds)
  // read that flag to ignore keystrokes mid-paste — a bare '\r' chunk between paste
  // chunks is buffered content here, and must NOT reach the palette's Enter handler.
  const setPasteBuffer = (next: string | null): void => {
    pasteBufferRef.current = next;
    if (pasteActiveRef !== undefined) {
      pasteActiveRef.current = next !== null;
    }
  };
  // The last value THIS control emitted via onChange. When the incoming `value`
  // prop differs from it, the change came from the parent (history recall, seed,
  // clear, prefill) — snap the cursor to the end so the next keystroke lands
  // sensibly. This supersedes ink-text-input's clamp-only effect.
  const lastEmittedRef = useRef<string>(value);

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      lastEmittedRef.current = value;
      setCursorOffset(value.length);
    }
  }, [value]);

  const emit = (nextValue: string, nextCursor: number): void => {
    lastEmittedRef.current = nextValue;
    setCursorOffset(nextCursor);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  // Consume a data chunk while inside (or entering) a bracketed paste. Buffers
  // until the closing marker arrives, then strips markers + normalizes CRLF/CR to
  // LF and inserts the whole payload at the cursor. Never submits.
  const consumePaste = (chunk: string): void => {
    let pending = chunk;
    if (pasteBufferRef.current === null) {
      const escIdx = chunk.indexOf(PASTE_START);
      const contentStart =
        escIdx !== -1 ? escIdx + PASTE_START.length : PASTE_START_STRIPPED.length;
      pending = chunk.slice(contentStart);
      setPasteBuffer('');
    }

    const combined = pasteBufferRef.current + pending;
    let endIdx = combined.indexOf(PASTE_END);
    let endLen = PASTE_END.length;
    if (endIdx === -1) {
      endIdx = combined.indexOf(PASTE_END_STRIPPED);
      endLen = PASTE_END_STRIPPED.length;
    }

    if (endIdx === -1) {
      // Marker still open — keep buffering, no visible change yet.
      setPasteBuffer(combined);
      return;
    }

    const payload = combined.slice(0, endIdx);
    const trailing = combined.slice(endIdx + endLen);
    setPasteBuffer(null);

    const normalized = (payload + trailing).replace(/\r\n?/g, '\n');
    const nextValue = value.slice(0, cursorOffset) + normalized + value.slice(cursorOffset);
    emit(nextValue, cursorOffset + normalized.length);
  };

  useInput(
    (input, key) => {
      // Paste FIRST — before Enter/arrows — so an embedded '\r' (a bare return
      // chunk mid-paste) is buffered as content, never a submit.
      if (pasteBufferRef.current !== null || hasPasteStart(input)) {
        consumePaste(input);
        return;
      }

      if ((key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
        return;
      }

      // Up/Down: at a buffer edge, delegate to the parent's history ring; else
      // swallow (matches ink-text-input, which has no vertical cursor movement).
      if (key.upArrow) {
        if (onHistoryPrev !== undefined && !value.slice(0, cursorOffset).includes('\n')) {
          onHistoryPrev();
        }
        return;
      }
      if (key.downArrow) {
        if (onHistoryNext !== undefined && !value.slice(cursorOffset).includes('\n')) {
          onHistoryNext();
        }
        return;
      }

      if (key.return) {
        onSubmit?.(value);
        return;
      }

      let nextCursor = cursorOffset;
      let nextValue = value;

      if (key.leftArrow) {
        if (withCursor) {
          nextCursor = Math.max(0, cursorOffset - 1);
        }
      } else if (key.rightArrow) {
        if (withCursor) {
          nextCursor = Math.min(value.length, cursorOffset + 1);
        }
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          nextCursor = cursorOffset - 1;
        }
      } else {
        nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        nextCursor = cursorOffset + input.length;
      }

      emit(nextValue, Math.max(0, Math.min(nextCursor, nextValue.length)));
    },
    { isActive: isFocused },
  );

  let rendered = value;
  if (withCursor) {
    if (value.length === 0) {
      rendered = chalk.inverse(' ');
    } else {
      rendered = '';
      for (let i = 0; i < value.length; i++) {
        const ch = value[i]!;
        if (i === cursorOffset) {
          // A cursor sitting on a newline: show an inverse block, then break.
          rendered += ch === '\n' ? chalk.inverse(' ') + '\n' : chalk.inverse(ch);
        } else {
          rendered += ch;
        }
      }
      if (cursorOffset >= value.length) {
        rendered += chalk.inverse(' ');
      }
    }
  }

  return <Text>{rendered}</Text>;
}
