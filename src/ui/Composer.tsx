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
  /**
   * Called on Down when the cursor sits on the LAST line of the buffer (newer history).
   * Returns `true` if it CONSUMED the Down (recalled a newer entry / restored the draft),
   * `false`/void if it was a no-op (already showing the live draft) — in which case the
   * Down is otherwise dead in the input and `onArrowDownAtBottom` (if wired) fires.
   */
  readonly onHistoryNext?: () => boolean | void;
  /**
   * Called on Down at the LAST line ONLY when history navigation was a no-op — i.e. the
   * Down would otherwise do nothing in the input. LANE B wires this to hand keyboard
   * focus from the composer down into the subagent-browser panel. Omitted ⇒ Down at the
   * bottom stays a no-op (unchanged behaviour).
   */
  readonly onArrowDownAtBottom?: () => void;
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

/**
 * True when a keypress is a control chord that must NOT be inserted as literal text.
 * The insert branch is the LAST resort for `input`, so without this guard a chord's
 * letter/byte lands in the draft: Ink maps Ctrl+O (which useKeybinds consumes to open
 * the tool-detail overlay) to `input: 'o'` with `key.ctrl` set, and its bare 'o' would
 * echo into the composer (`❯ o`); some terminals instead pass the raw C0 byte (0x0f for
 * Ctrl+O) straight through with `key.ctrl` UNSET — that lone control byte is likewise not
 * printable text. Enter (\r), Tab, and the arrows are classified by Ink into their own
 * `key.*` flags and handled BEFORE the insert branch, so they never reach here. Exported
 * for unit tests.
 */
export function isControlChord(input: string, key: { readonly ctrl: boolean }): boolean {
  if (key.ctrl) return true;
  // A lone unmapped C0 control byte (0x00–0x1f) or DEL (0x7f) — never printable text.
  return input.length === 1 && (input.charCodeAt(0) < 0x20 || input.charCodeAt(0) === 0x7f);
}

export function Composer({
  value,
  onChange,
  onSubmit,
  focus,
  showCursor,
  onHistoryPrev,
  onHistoryNext,
  onArrowDownAtBottom,
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
        if (!value.slice(cursorOffset).includes('\n')) {
          // Cursor on the last line: first try newer-history recall. If that CONSUMED the
          // Down (returned true), we're done; otherwise the Down is otherwise dead in the
          // input, so hand focus down to the subagent panel (when the parent wired it).
          const consumed = onHistoryNext?.() === true;
          if (!consumed) onArrowDownAtBottom?.();
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
      } else if (isControlChord(input, key)) {
        // A control chord (e.g. Ctrl+O, which useKeybinds consumes to open the
        // tool-detail overlay) — swallow it so its letter/byte never leaks into the
        // draft. Placed AFTER the arrow/backspace branches so a ctrl+arrow still moves.
        return;
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
