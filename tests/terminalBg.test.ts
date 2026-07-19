// tests/terminalBg.test.ts
// Pure unit tests for the OSC 11 terminal-background probe. The impure
// queryTerminalBackground is exercised ONLY with INJECTED fake streams — never
// with the default process.stdin/stdout, which under vitest's own tty could grab
// raw mode and hang the runner.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  backgroundFromRgb,
  parseOsc11Reply,
  queryTerminalBackground,
} from '../src/ui/terminalBg';

// --------------------------------------------------------------------------
// parseOsc11Reply — pure, total
// --------------------------------------------------------------------------
describe('parseOsc11Reply', () => {
  it('parses 4-digit channels (BEL-terminated)', () => {
    expect(parseOsc11Reply('\x1b]11;rgb:ffff/ffff/ffff\x07')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOsc11Reply('\x1b]11;rgb:0000/0000/0000\x07')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseOsc11Reply('\x1b]11;rgb:8080/8080/8080\x07')).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('parses 2-digit and 1-digit channels (width-normalized to 0-255)', () => {
    expect(parseOsc11Reply('\x1b]11;rgb:ff/80/00\x07')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseOsc11Reply('\x1b]11;rgb:f/f/f\x07')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('is case-insensitive on hex digits', () => {
    expect(parseOsc11Reply('\x1b]11;rgb:FFFF/0000/8080\x07')).toEqual({ r: 255, g: 0, b: 128 });
  });

  it('accepts an ST (ESC \\) terminator', () => {
    expect(parseOsc11Reply('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('finds a reply embedded in surrounding noise', () => {
    expect(parseOsc11Reply('abc\x1b]11;rgb:2020/2020/2020\x07def')).toEqual({ r: 32, g: 32, b: 32 });
  });

  it('returns undefined for malformed / truncated / wrong-OSC input', () => {
    expect(parseOsc11Reply('')).toBeUndefined();
    expect(parseOsc11Reply('\x1b]11;rgb:ff/ff\x07')).toBeUndefined(); // only 2 channels
    expect(parseOsc11Reply('\x1b]11;rgb:zz/zz/zz\x07')).toBeUndefined(); // non-hex
    expect(parseOsc11Reply('\x1b]4;1;rgb:ff/ff/ff\x07')).toBeUndefined(); // wrong OSC number
    expect(parseOsc11Reply('\x1b]11;rgb:ffff/ffff/ff')).toBeUndefined(); // no terminator (truncated)
  });
});

// --------------------------------------------------------------------------
// backgroundFromRgb — Rec.601 luma, strict > 128
// --------------------------------------------------------------------------
describe('backgroundFromRgb', () => {
  it('classifies grayscale by luminance with a strict boundary at 128', () => {
    expect(backgroundFromRgb({ r: 0, g: 0, b: 0 })).toBe('dark');
    expect(backgroundFromRgb({ r: 255, g: 255, b: 255 })).toBe('light');
    expect(backgroundFromRgb({ r: 127, g: 127, b: 127 })).toBe('dark');
    expect(backgroundFromRgb({ r: 129, g: 129, b: 129 })).toBe('light');
    expect(backgroundFromRgb({ r: 128, g: 128, b: 128 })).toBe('dark'); // boundary: strict >
  });

  it('weights channels per Rec.601 (blue dark, yellow light)', () => {
    expect(backgroundFromRgb({ r: 0, g: 0, b: 255 })).toBe('dark'); // luma ~29
    expect(backgroundFromRgb({ r: 255, g: 255, b: 0 })).toBe('light'); // luma ~226
  });
});

// --------------------------------------------------------------------------
// queryTerminalBackground — injected fake streams (never real process streams)
// --------------------------------------------------------------------------

/** EventEmitter-backed fake stdin: records raw-mode/resume/pause/unshift calls. */
class FakeInput extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawModeCalls: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;
  unshiftCalls: Buffer[] = [];

  constructor(opts: { isTTY?: boolean; isRaw?: boolean } = {}) {
    super();
    this.isTTY = opts.isTTY ?? true;
    this.isRaw = opts.isRaw ?? false;
  }

  setRawMode(mode: boolean): this {
    this.setRawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }

  unshift(chunk: Buffer): void {
    this.unshiftCalls.push(chunk);
  }
}

/** Fake stdout: records every write. */
class FakeOutput {
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

/** Fake stdout whose write() throws — models a destroyed/closed output stream. */
class ThrowingOutput {
  write(): boolean {
    throw new Error('stdout destroyed');
  }
}

const asInput = (f: FakeInput): NodeJS.ReadStream => f as unknown as NodeJS.ReadStream;
const asOutput = (f: FakeOutput): NodeJS.WriteStream => f as unknown as NodeJS.WriteStream;

describe('queryTerminalBackground', () => {
  it('resolves undefined and writes nothing on a non-tty input', async () => {
    const input = new FakeInput({ isTTY: false });
    const output = new FakeOutput();
    const result = await queryTerminalBackground({ input: asInput(input), output: asOutput(output) });
    expect(result).toBeUndefined();
    expect(output.writes).toHaveLength(0);
    expect(input.setRawModeCalls).toHaveLength(0);
  });

  it('happy path: emits the query, parses the reply, restores raw mode', async () => {
    const input = new FakeInput({ isTTY: true, isRaw: false });
    const output = new FakeOutput();
    const p = queryTerminalBackground({
      input: asInput(input),
      output: asOutput(output),
      timeoutMs: 1000,
    });
    input.emit('data', Buffer.from('\x1b]11;rgb:ffff/ffff/ffff\x07'));
    expect(await p).toBe('light');
    // The probe query was emitted.
    expect(output.writes.join('')).toContain('\x1b]11;?');
    // Raw mode was engaged then restored to the prior state (false).
    expect(input.setRawModeCalls).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    // Stream was resumed and paused.
    expect(input.resumeCalls).toBeGreaterThanOrEqual(1);
    expect(input.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it('does NOT swallow keystrokes: re-emits interleaved bytes with the OSC stripped', async () => {
    const input = new FakeInput({ isTTY: true, isRaw: false });
    const output = new FakeOutput();
    const p = queryTerminalBackground({
      input: asInput(input),
      output: asOutput(output),
      timeoutMs: 1000,
    });
    // A leading 'a' and trailing 'b' typed around the OSC reply must survive.
    input.emit('data', Buffer.from('a\x1b]11;rgb:0000/0000/0000\x07b'));
    expect(await p).toBe('dark');
    expect(input.unshiftCalls).toHaveLength(1);
    expect(input.unshiftCalls[0].equals(Buffer.from('ab'))).toBe(true);
  });

  it('times out to undefined, restoring raw mode and removing the data listener', async () => {
    const input = new FakeInput({ isTTY: true, isRaw: false });
    const output = new FakeOutput();
    const result = await queryTerminalBackground({
      input: asInput(input),
      output: asOutput(output),
      timeoutMs: 20,
    });
    expect(result).toBeUndefined();
    expect(input.setRawModeCalls).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(input.listenerCount('data')).toBe(0); // the 'data' listener was removed
  });

  it('does NOT swallow keystrokes typed during the probe window on TIMEOUT', async () => {
    // The terminal ignores OSC 11 (the common non-reply case). Bytes typed before
    // the timeout must be re-emitted, not dropped, so the non-reply path stays
    // byte-identical to today's behaviour.
    const input = new FakeInput({ isTTY: true, isRaw: false });
    const output = new FakeOutput();
    const p = queryTerminalBackground({
      input: asInput(input),
      output: asOutput(output),
      timeoutMs: 20,
    });
    input.emit('data', Buffer.from('hi')); // no OSC reply, just keystrokes
    expect(await p).toBeUndefined();
    expect(input.unshiftCalls).toHaveLength(1);
    expect(input.unshiftCalls[0].equals(Buffer.from('hi'))).toBe(true);
  });

  it('resolves undefined (never rejects) when output.write throws, restoring raw mode', async () => {
    // A destroyed output stream throwing out of write() must not reject the promise
    // or leave the terminal in raw mode with a dangling listener.
    const input = new FakeInput({ isTTY: true, isRaw: false });
    const output = new ThrowingOutput();
    const result = await queryTerminalBackground({
      input: asInput(input),
      output: output as unknown as NodeJS.WriteStream,
      timeoutMs: 1000,
    });
    expect(result).toBeUndefined();
    expect(input.isRaw).toBe(false); // raw mode restored
    expect(input.listenerCount('data')).toBe(0); // no dangling listener
  });
});
