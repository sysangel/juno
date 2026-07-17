// tests/useTerminalTitle.test.tsx
// Terminal title (OSC 2) status hook. Three concerns, matching the two existing
// edge-I/O hooks' test shape:
//   1. titleFor — the PURE phase→string table, over every State['phase'] value.
//   2. non-TTY — a non-TTY stdout (ink-testing-library's default) must capture
//      ZERO raw control bytes: the hook is gated on isTTY === true.
//   3. TTY — a TTY-mocked stdout records push→title on mount, dedups an
//      identical title across a re-render, and pops the title stack on unmount.
import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { act } from 'react';
import { Text } from 'ink';
import { render as inkRender } from 'ink';
import { render as testRender } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { titleFor, useTerminalTitle } from '../src/hooks/useTerminalTitle';
import type { TerminalTitleDeps } from '../src/hooks/useTerminalTitle';
import type { State } from '../src/core/reducer';
import { flushInk } from './helpers/ink';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const PUSH = `${ESC}[22;0t`;
const POP = `${ESC}[23;0t`;

/** A write the hook itself emitted (OSC-2 title or an XTWINOPS stack op), as
 * opposed to a frame/cursor sequence ink writes. */
const isOurControl = (s: string): boolean =>
  s.includes(`${ESC}]2;`) || s.includes(PUSH) || s.includes(POP);

/** A stdout that IS a TTY, so the hook's isTTY gate opens; records every write. */
class FakeTtyStdout extends EventEmitter {
  isTTY = true;
  readonly writes: string[] = [];
  get columns(): number {
    return 100;
  }
  get rows(): number {
    return 30;
  }
  write = (data: string): boolean => {
    this.writes.push(data);
    return true;
  };
}

/** A stdin stub so ink's render never touches the real process.stdin. */
class FakeStdin extends EventEmitter {
  isTTY = false;
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): null {
    return null;
  }
}

function Probe(props: TerminalTitleDeps): ReactElement {
  useTerminalTitle(props);
  return <Text>probe</Text>;
}

const CWD = '/home/dev/my-project';

describe('titleFor — the pure phase→title table', () => {
  it("'streaming' → running, with the cwd basename", () => {
    expect(titleFor('streaming', CWD)).toBe('✳ juno · my-project · running');
  });
  it("'running-tool' → running, with the cwd basename", () => {
    expect(titleFor('running-tool', CWD)).toBe('✳ juno · my-project · running');
  });
  it("'awaiting-permission' → needs input (no cwd)", () => {
    expect(titleFor('awaiting-permission', CWD)).toBe('⚠ juno · needs input');
  });
  it("'idle' → plain juno + basename", () => {
    expect(titleFor('idle', CWD)).toBe('juno · my-project');
  });
  it("'error' → plain juno + basename", () => {
    expect(titleFor('error', CWD)).toBe('juno · my-project');
  });
  it('every State phase maps to a non-empty title', () => {
    const phases: State['phase'][] = [
      'idle',
      'streaming',
      'awaiting-permission',
      'running-tool',
      'error',
    ];
    for (const phase of phases) {
      expect(titleFor(phase, CWD).length).toBeGreaterThan(0);
    }
  });
});

describe('useTerminalTitle — non-TTY stdout writes nothing', () => {
  it('captures zero control bytes in the frames of a non-TTY runner', async () => {
    const app = testRender(<Probe phase="streaming" cwd={CWD} />);
    await flushInk();
    app.rerender(<Probe phase="awaiting-permission" cwd={CWD} />);
    await flushInk();
    // ink-testing-library's stdout has isTTY undefined → the gate stays shut.
    expect(app.frames.filter(isOurControl)).toHaveLength(0);
    app.unmount();
  });
});

describe('useTerminalTitle — TTY stdout lifecycle', () => {
  it('pushes the title stack, writes the title, dedups, then pops on unmount', async () => {
    const stdout = new FakeTtyStdout();
    const stdin = new FakeStdin();
    const app = inkRender(<Probe phase="streaming" cwd={CWD} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await flushInk();

    // Mount: push BEFORE the first title, then the streaming title.
    const afterMount = stdout.writes.filter(isOurControl);
    expect(afterMount).toHaveLength(2);
    expect(afterMount[0]).toBe(PUSH);
    expect(afterMount[1]).toBe(`${ESC}]2;✳ juno · my-project · running${BEL}`);

    // Dedup: streaming → running-tool is the SAME title; no new write.
    app.rerender(<Probe phase="running-tool" cwd={CWD} />);
    await flushInk();
    expect(stdout.writes.filter(isOurControl)).toHaveLength(2);

    // A genuine title change writes once more.
    app.rerender(<Probe phase="idle" cwd={CWD} />);
    await flushInk();
    const afterIdle = stdout.writes.filter(isOurControl);
    expect(afterIdle).toHaveLength(3);
    expect(afterIdle[2]).toBe(`${ESC}]2;juno · my-project${BEL}`);

    // Unmount pops the title stack (restore).
    await act(async () => {
      app.unmount();
    });
    const afterUnmount = stdout.writes.filter(isOurControl);
    expect(afterUnmount[afterUnmount.length - 1]).toBe(POP);
  });
});
