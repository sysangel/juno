import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import type { ReactElement } from 'react';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Msg, ToolState } from '../src/core/reducer';
import { reducer, initialState, type Action } from '../src/core/reducer';
import { App, INPUT_PLACEHOLDER, shouldRingBell, slashCommands, type AppDeps } from '../src/app';
import { createFakeModelClient } from '../src/core/fakeClient';
import { useKeybinds } from '../src/hooks/useKeybinds';
import { createPermissionPolicy } from '../src/permissions/policy';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { createConfigService, createFakeConfigService, DEFAULT_SETTINGS } from '../src/services/config';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { collapse, collapseIndicator } from '../src/ui/collapse';
import { buildDiff } from '../src/ui/diff';
import { OverlayHost } from '../src/ui/OverlayHost';
import { HELP_KEYBINDS } from '../src/ui/UnifiedCommandPalette';
import { ToolCallCard } from '../src/ui/ToolCallCard';
import { Message } from '../src/ui/Message';
import { PermissionPrompt, type PermissionRequest } from '../src/ui/PermissionPrompt';
import { flushInk, press, waitFor, waitForFrame } from './helpers/ink';

/** Bounded poll: the spy has fired at least once; the caller still asserts the
 * EXACT call count/payload afterwards, so "once" stays load-bearing. */
const called = (spy: { mock: { calls: unknown[][] } }, label: string): Promise<void> =>
  waitFor(() => spy.mock.calls.length > 0, { label });

// ---------------------------------------------------------------------------
// collapse() — pure state transitions + threshold boundary
// ---------------------------------------------------------------------------

describe('collapse (tool-output collapse core)', () => {
  it('passes a short input through unchanged (not collapsed)', () => {
    const c = collapse('one\ntwo\nthree', { maxLines: 12, maxChars: 800 });
    expect(c.text).toBe('one\ntwo\nthree');
    expect(c.hiddenLines).toBe(0);
    expect(c.truncated).toBe(false);
    expect(collapseIndicator(c)).toBe('');
  });

  it('is exactly at the threshold boundary: maxLines lines is NOT collapsed', () => {
    const raw = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const c = collapse(raw, { maxLines: 12, maxChars: 800 });
    expect(c.hiddenLines).toBe(0);
    expect(c.text).toBe(raw);
  });

  it('one line past the boundary (maxLines + 1) collapses and hides the overflow', () => {
    const raw = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join('\n');
    const c = collapse(raw, { maxLines: 12, maxChars: 800 });
    expect(c.hiddenLines).toBe(1);
    expect(c.text.split('\n')).toHaveLength(12);
    expect(c.text).not.toContain('line 13');
    expect(collapseIndicator(c)).toBe('… +1 line');
  });

  it('reports the exact hidden-line count with a pluralized indicator', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const c = collapse(raw, { maxLines: 12, maxChars: 800 });
    expect(c.hiddenLines).toBe(18);
    expect(collapseIndicator(c)).toBe('… +18 lines');
  });

  it('truncates a huge single line by the char cap and flags it', () => {
    const c = collapse('x'.repeat(5000), { maxLines: 12, maxChars: 800 });
    expect(c.text).toHaveLength(800);
    expect(c.truncated).toBe(true);
    expect(collapseIndicator(c)).toBe('… truncated');
  });
});

// ---------------------------------------------------------------------------
// ToolCallCard — collapsed rendering of long tool output
// ---------------------------------------------------------------------------

describe('ToolCallCard — condensed one-line tail (wave-7 lane C)', () => {
  it('renders a long multi-line result as a ONE-line tail: first line + `+N lines`', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'big.ts' },
      result: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'),
    };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" />).lastFrame() ?? '';
    // Only the first line is shown inline; the rest live behind the ctrl+o overlay.
    expect(frame).toContain('line 1');
    expect(frame).not.toContain('line 2');
    expect(frame).not.toContain('line 3');
    // Overflow marker for the 29 hidden lines. No multi-line `⎿` preview slot.
    expect(frame).toContain('+29 lines');
    expect(frame).not.toContain('⎿');
  });

  it('shows a single-line result inline with no overflow marker', () => {
    const tool: ToolState = {
      status: 'result',
      name: 'read_file',
      args: { path: 'a.ts' },
      // A single-line (string) result condenses to a clean inline tail — no raw JSON on the
      // card (R2), no `+N lines` overflow marker (it is one line), no multi-line `⎿` slot.
      result: 'file read ok',
    };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" />).lastFrame() ?? '';
    expect(frame).toContain('file read ok');
    expect(frame).not.toContain('+1 line');
    expect(frame).not.toContain('⎿');
  });
});

// ---------------------------------------------------------------------------
// Message — thinking-block collapse (polish; reducer says collapsed-by-default)
// ---------------------------------------------------------------------------

describe('Message — thinking collapse', () => {
  // LIVE (streaming): dim italic `✻ thinking…` marker + current thinking text,
  // bounded to a preview. No literal `thinking:` prefix (that presentation is gone).
  it('live: shows the ✻ thinking… marker + bounded preview + overflow indicator', () => {
    const reasoning = Array.from({ length: 10 }, (_, i) => `thought ${i + 1}`).join('\n');
    const frame =
      render(
        <Message
          msg={{ id: 'a1', role: 'assistant', done: false, blocks: [], reasoning }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✻ thinking…');
    expect(frame).not.toContain('thinking:'); // the old literal prefix is dead
    expect(frame).toContain('thought 1');
    expect(frame).not.toContain('thought 5'); // still bounded to a live preview
    expect(frame).toContain('… +6 lines');
  });

  it('live: short reasoning renders in full with the marker and no indicator', () => {
    const frame =
      render(
        <Message
          msg={{ id: 'a2', role: 'assistant', done: false, blocks: [], reasoning: 'just a bit' }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✻ thinking…');
    expect(frame).toContain('just a bit');
    expect(frame).not.toContain('… +');
  });

  // COMMITTED: the full text collapses to a single marker line — but is NEVER
  // deleted (the marker always persists in scrollback). Regression for the tour
  // finding that thinking vanished entirely on commit.
  it('committed: collapses full text to a single ✻ thought marker (text absent, marker present)', () => {
    const reasoning = Array.from({ length: 10 }, (_, i) => `thought ${i + 1}`).join('\n');
    const frame =
      render(
        <Message
          msg={{ id: 'a3', role: 'assistant', done: true, blocks: [], reasoning }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✻ thought'); // marker always survives commit
    expect(frame).not.toContain('thought 1'); // full text is NOT rendered in scrollback
    expect(frame).not.toContain('thinking:');
    expect(frame).not.toContain('✻ thinking…');
  });

  it('committed: renders `✻ thought for <n>s` when the phase bounds are available', () => {
    const frame =
      render(
        <Message
          msg={{
            id: 'a4',
            role: 'assistant',
            done: true,
            blocks: [],
            reasoning: 'mulling',
            reasoningStartedAt: 1_000,
            reasoningEndedAt: 5_000,
          }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✻ thought for 4s');
  });

  it('committed: omits the duration (`✻ thought`) when the phase bounds are absent', () => {
    const frame =
      render(
        <Message
          msg={{ id: 'a5', role: 'assistant', done: true, blocks: [], reasoning: 'mulling' }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✻ thought');
    expect(frame).not.toContain('thought for');
  });

  it('a turn that never thought renders no thinking marker at all', () => {
    const frame =
      render(
        <Message
          msg={{
            id: 'a6',
            role: 'assistant',
            done: true,
            blocks: [{ kind: 'text', id: 'a6:block:0', text: 'hello' }],
          }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';
    expect(frame).not.toContain('✻');
    expect(frame).toContain('hello');
  });

  // Acceptance: the live→commit transition changes ONLY the thinking region — the
  // rest of the message (label + prose) is byte-identical across the transition.
  it('live→commit transition only changes the thinking region', () => {
    const base = {
      id: 'a7',
      role: 'assistant' as const,
      reasoning: 'deliberating carefully',
      blocks: [{ kind: 'text' as const, id: 'a7:block:0', text: 'the visible answer' }],
    };
    const liveFrame =
      render(<Message msg={{ ...base, done: false }} depth="ansi16" />).lastFrame() ?? '';
    const committedFrame =
      render(
        <Message
          msg={{ ...base, done: true, reasoningStartedAt: 1_000, reasoningEndedAt: 3_000 }}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';

    // Drop the thinking-region lines (the ✻ marker line + the live preview text)
    // from each frame; everything that remains must match exactly.
    const stripThinking = (frame: string): string =>
      frame
        .split('\n')
        .filter((line) => !line.includes('✻') && !line.includes('deliberating'))
        .join('\n');

    expect(stripThinking(liveFrame)).toEqual(stripThinking(committedFrame));
    // And the transition really did change the thinking region.
    expect(liveFrame).toContain('✻ thinking…');
    expect(liveFrame).toContain('deliberating');
    expect(committedFrame).toContain('✻ thought for 2s');
    expect(committedFrame).not.toContain('deliberating');
  });
});

// ---------------------------------------------------------------------------
// buildDiff — pure diff builder (added / removed / context lines)
// ---------------------------------------------------------------------------

describe('buildDiff (diff preview core)', () => {
  it('returns null for a non-file tool', () => {
    expect(buildDiff('grep', { pattern: 'x' })).toBeNull();
  });

  it('returns null when required args are missing', () => {
    expect(buildDiff('edit_file', { path: 'a.ts' })).toBeNull();
    expect(buildDiff('write_file', { path: 'a.ts' })).toBeNull();
  });

  it('edit_file yields context (shared) + removed (old) + added (new) lines', () => {
    const lines = buildDiff('edit_file', {
      path: 'a.ts',
      oldString: 'keep\nold line\ntail',
      newString: 'keep\nnew line\ntail',
    });
    expect(lines).not.toBeNull();
    const byKind = (k: string): string[] =>
      (lines ?? []).filter((l) => l.kind === k).map((l) => l.text);
    expect(byKind('meta')).toEqual(['edit a.ts']);
    expect(byKind('context')).toEqual(['keep', 'tail']);
    expect(byKind('remove')).toEqual(['old line']);
    expect(byKind('add')).toEqual(['new line']);
  });

  it('write_file yields an all-adds "new content" view (args carry no prior file)', () => {
    const lines = buildDiff('write_file', { path: 'new.ts', content: 'a\nb' });
    expect(lines).not.toBeNull();
    expect((lines ?? []).map((l) => l.kind)).toEqual(['meta', 'add', 'add']);
    expect((lines ?? []).filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// PermissionPrompt — diff preview rendering + colorization + backward compat
// ---------------------------------------------------------------------------

describe('PermissionPrompt — diff preview', () => {
  it('renders a colorized +/- diff for edit_file instead of raw args', () => {
    const request: PermissionRequest = {
      toolCallId: 't-edit',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'const x = 1', newString: 'const x = 2' },
      risk: 'risky',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('edit a.ts');
    expect(frame).toContain('- const x = 1');
    expect(frame).toContain('+ const x = 2');
    // Raw one-lined JSON args must NOT leak through.
    expect(frame).not.toContain('"oldString"');
  });

  it('tints added vs removed lines differently (added green / removed red)', () => {
    const request: PermissionRequest = {
      toolCallId: 't-edit2',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'gone', newString: 'here' },
      risk: 'risky',
    };
    const frame =
      render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    const removed = frame.split('\n').find((l) => l.includes('- gone')) ?? '';
    const added = frame.split('\n').find((l) => l.includes('+ here')) ?? '';
    // Different theme tokens -> different ANSI color escapes on each line.
    expect(removed).not.toEqual(added);
  });

  it('renders a write_file preview as added content lines', () => {
    const request: PermissionRequest = {
      toolCallId: 't-write',
      name: 'write_file',
      args: { path: 'new.ts', content: 'export const y = 1\n' },
      risk: 'risky',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('write new.ts');
    expect(frame).toContain('+ export const y = 1');
  });

  it('falls back to the compact arg line for a non-file tool (no regression)', () => {
    const request: PermissionRequest = {
      toolCallId: 't-grep',
      name: 'grep',
      args: { pattern: 'needle' },
      risk: 'safe',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    // Non-file tools now humanize to the ONE meaningful field (grep→pattern) instead of
    // leaking a raw {"pattern":…} JSON blob (wave-9 humanizeArgs parity).
    expect(frame).toContain('needle');
    expect(frame).not.toContain('"pattern":"needle"');
  });

  it('still resolves a decision for a diffed edit_file prompt', async () => {
    const onDecision = vi.fn();
    const request: PermissionRequest = {
      toolCallId: 't-edit3',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'a', newString: 'b' },
      risk: 'risky',
    };
    const { stdin } = render(<PermissionPrompt request={request} onDecision={onDecision} />);
    await flushInk(); // useInput listener is subscribed only after effects commit
    stdin.write('y');
    await called(onDecision, 'onDecision called');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('allow-once');
  });
});

// ---------------------------------------------------------------------------
// buildDiff — edge cases (the prefix/suffix scan and its oEnd/nEnd guard)
// ---------------------------------------------------------------------------

describe('buildDiff — edge cases', () => {
  const kinds = (name: string, oldString: string, newString: string): string[] =>
    (buildDiff(name, { path: 'a.ts', oldString, newString }) ?? [])
      .filter((l) => l.kind !== 'meta')
      .map((l) => `${l.kind}:${l.text}`);

  it('overlapping prefix/suffix: [A,B] -> [A,A,B] yields ctx A, +A, ctx B (guard regression)', () => {
    // Without the `oEnd > start && nEnd > start` guard the suffix scan would walk
    // past the shared prefix and swallow the inserted A into context (no add).
    expect(kinds('edit_file', 'A\nB', 'A\nA\nB')).toEqual(['context:A', 'add:A', 'context:B']);
  });

  it('pure deletion: [A,B,C] -> [A,C] yields ctx A, -B, ctx C (no adds)', () => {
    expect(kinds('edit_file', 'A\nB\nC', 'A\nC')).toEqual(['context:A', 'remove:B', 'context:C']);
  });

  it('pure insertion: [A,C] -> [A,B,C] yields ctx A, +B, ctx C (no removes)', () => {
    expect(kinds('edit_file', 'A\nC', 'A\nB\nC')).toEqual(['context:A', 'add:B', 'context:C']);
  });

  it('identical old/new renders all-context (nothing added or removed)', () => {
    expect(kinds('edit_file', 'A\nB', 'A\nB')).toEqual(['context:A', 'context:B']);
  });

  it('empty oldString: everything is an add (plus the empty-line remove)', () => {
    expect(kinds('edit_file', '', 'x')).toEqual(['remove:', 'add:x']);
  });

  it('empty newString: everything is a remove (plus the empty-line add)', () => {
    expect(kinds('edit_file', 'x', '')).toEqual(['remove:x', 'add:']);
  });

  it('trailing newlines on both sides stay context; only the payload line flips', () => {
    expect(kinds('edit_file', 'a\n', 'b\n')).toEqual(['remove:a', 'add:b', 'context:']);
  });
});

// ---------------------------------------------------------------------------
// buildDiff / PermissionPrompt — replaceAll surfaced
// ---------------------------------------------------------------------------

describe('edit_file replaceAll surfaced in the diff preview', () => {
  it('adds an "(applies to all occurrences)" meta line when replaceAll is true', () => {
    const lines = buildDiff('edit_file', {
      path: 'a.ts',
      oldString: 'x',
      newString: 'y',
      replaceAll: true,
    });
    expect((lines ?? []).filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual([
      'edit a.ts',
      '(applies to all occurrences)',
    ]);
  });

  it('omits the multiplier line when replaceAll is absent or false', () => {
    for (const args of [
      { path: 'a.ts', oldString: 'x', newString: 'y' },
      { path: 'a.ts', oldString: 'x', newString: 'y', replaceAll: false },
    ]) {
      const lines = buildDiff('edit_file', args);
      expect((lines ?? []).filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual(['edit a.ts']);
    }
  });

  it('renders the multiplier in the permission prompt', () => {
    const request: PermissionRequest = {
      toolCallId: 't-ra',
      name: 'edit_file',
      args: { path: 'a.ts', oldString: 'x', newString: 'y', replaceAll: true },
      risk: 'risky',
    };
    const frame = render(<PermissionPrompt request={request} onDecision={vi.fn()} />).lastFrame() ?? '';
    expect(frame).toContain('(applies to all occurrences)');
  });
});

// ---------------------------------------------------------------------------
// Polish batch — #4 help overlay
// ---------------------------------------------------------------------------

describe('Help overlay (#4)', () => {
  it('renders the keybind cheatsheet for the help overlay', () => {
    const frame = render(<OverlayHost overlay="help" />).lastFrame() ?? '';
    expect(frame).toContain('keyboard shortcuts');
    for (const bind of HELP_KEYBINDS) {
      expect(frame).toContain(bind.key);
    }
  });

  it('registers /help in the slash command palette', () => {
    expect(slashCommands).toContainEqual({ name: 'help', description: 'Show keyboard shortcuts' });
  });

  it('"?" on an empty input opens help (and not mid-sentence)', async () => {
    const onOpenHelp = vi.fn();
    const Harness = ({ value }: { value: string }): ReactElement => {
      useKeybinds({
        overlay: 'none',
        value,
        slashCommandCount: 0,
        modelCount: 0,
        onAbort: vi.fn(),
        onCycleEffort: vi.fn(),
        onOpenSlash: vi.fn(),
        onOpenHelp,
        onCloseOverlay: vi.fn(),
        onMoveSlash: vi.fn(),
        onAcceptSlash: vi.fn(),
        onMoveModel: vi.fn(),
        onAcceptModel: vi.fn(),
      });
      return <Text>harness</Text>;
    };

    const empty = render(<Harness value="" />);
    await flushInk();
    empty.stdin.write('?');
    await called(onOpenHelp, 'onOpenHelp called');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    empty.unmount();

    const typing = render(<Harness value="what" />);
    await flushInk();
    typing.stdin.write('?');
    await flushInk(); // key fully processed before asserting it was swallowed
    expect(onOpenHelp).toHaveBeenCalledTimes(1); // unchanged — gated on empty input
    typing.unmount();
  });

  it('while help is open, global keys are swallowed and Esc closes it', async () => {
    const onCycleEffort = vi.fn();
    const onCloseOverlay = vi.fn();
    const onAbort = vi.fn();
    const Harness = (): ReactElement => {
      useKeybinds({
        overlay: 'help',
        value: '',
        slashCommandCount: 0,
        modelCount: 0,
        onAbort,
        onCycleEffort,
        onOpenSlash: vi.fn(),
        onCloseOverlay,
        onMoveSlash: vi.fn(),
        onAcceptSlash: vi.fn(),
        onMoveModel: vi.fn(),
        onAcceptModel: vi.fn(),
      });
      return <Text>harness</Text>;
    };

    const { stdin, unmount } = render(<Harness />);
    await flushInk();
    stdin.write('\t'); // Tab must NOT cycle effort behind the overlay
    await flushInk(); // key fully processed before asserting it was swallowed
    expect(onCycleEffort).not.toHaveBeenCalled();
    stdin.write('\u001B'); // Esc closes (not abort)
    await called(onCloseOverlay, 'onCloseOverlay called');
    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Polish batch — #6 spinner + elapsed timer on running tools
// ---------------------------------------------------------------------------

describe('Running tool card — spinner + elapsed (#6)', () => {
  it('shows an elapsed-seconds readout from the injected clock', () => {
    // Deterministic fake clock: first call (start ref) 1_000, second (render) 4_200.
    let t = 1_000;
    const now = (): number => {
      const v = t;
      t += 3_200;
      return v;
    };
    const tool: ToolState = { status: 'running', name: 'grep', args: { pattern: 'x' } };
    const { lastFrame, unmount } = render(<ToolCallCard tool={tool} depth="ansi16" now={now} />);
    const frame = lastFrame() ?? '';
    // Compact running line: `<spinner> grep(x) · 3s` (whole seconds), no [running] label.
    expect(frame).toContain('grep(x)');
    expect(frame).not.toContain('[running]');
    expect(frame).toContain('· 3s');
    expect(frame).not.toContain('◐'); // static glyph replaced by the spinner
    unmount();
  });

  it('shows no elapsed readout on a settled card', () => {
    const tool: ToolState = { status: 'result', name: 'grep', args: {}, result: 'ok' };
    const frame = render(<ToolCallCard tool={tool} depth="ansi16" now={() => 0} />).lastFrame() ?? '';
    expect(frame).not.toContain('s)');
  });

  it('live streaming message renders a real running card from the live tools map', () => {
    // The in-flight msg has NO toolSnapshot (frozen only at commit); the live
    // `tools` map must reach the card so users see spinner + elapsed, not the
    // dim "[tool id]" placeholder.
    const live: Msg = {
      id: 'a-live',
      role: 'assistant',
      done: false,
      blocks: [{ kind: 'tool', id: 'a-live:block:1', toolCallId: 'toolu-live' }],
    };
    const tools: Record<string, ToolState> = {
      'toolu-live': { status: 'running', name: 'grep', args: { pattern: 'x' } },
    };
    const { lastFrame, unmount } = render(<Message msg={live} depth="ansi16" tools={tools} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('grep(x)');
    expect(frame).not.toContain('[tool toolu-live]');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Polish batch — #7 completion bell (config-gated)
// ---------------------------------------------------------------------------

describe('Completion bell (#7)', () => {
  it('rings exactly on the turn-end transitions (streaming/running-tool -> idle)', () => {
    expect(shouldRingBell('streaming', 'idle')).toBe(true);
    expect(shouldRingBell('running-tool', 'idle')).toBe(true);
    // Never on: staying in flight, error terminals, overlay-phase flips, or idle noise.
    expect(shouldRingBell('streaming', 'streaming')).toBe(false);
    expect(shouldRingBell('streaming', 'error')).toBe(false);
    expect(shouldRingBell('streaming', 'running-tool')).toBe(false);
    expect(shouldRingBell('awaiting-permission', 'idle')).toBe(false);
    expect(shouldRingBell('idle', 'idle')).toBe(false);
    expect(shouldRingBell('error', 'idle')).toBe(false);
  });

  it('rings exactly ONCE for a multi-tool-round turn (counts turn-ends, not tool rounds)', () => {
    // Regression for the "bell rings once per tool round" bug. On a raw-API backend a
    // single user turn that runs N tool rounds re-enters the model N times; the runner
    // dispatches each round's deferred `assistant-done` (stopReason 'tool_use') between
    // HTTP requests. If that intermediate done flips phase to 'idle', app.tsx's passive
    // bell effect reads it as a turn-end and rings. Replay the exact reducer action
    // stream for a 2-round turn and count rings the way the effect does — over every
    // committed phase transition via shouldRingBell.
    const actions: Action[] = [
      { t: 'user-submit', id: 'u1', text: 'do it' },
      // --- round 1: text, one tool call, deferred tool_use done ---
      { t: 'assistant-start', id: 'a1' },
      { t: 'text-delta', id: 'a1', delta: 'working' },
      { t: 'tool-call', toolCallId: 'tc1', name: 'read', args: {} },
      { t: 'tool-status', toolCallId: 'tc1', status: 'running' },
      { t: 'tool-status', toolCallId: 'tc1', status: 'result', result: 1 },
      { t: 'assistant-done', id: 'a1', stopReason: 'tool_use' },
      // --- round 2: same shape, model re-entered ---
      { t: 'assistant-start', id: 'a2' },
      { t: 'text-delta', id: 'a2', delta: 'more' },
      { t: 'tool-call', toolCallId: 'tc2', name: 'read', args: {} },
      { t: 'tool-status', toolCallId: 'tc2', status: 'running' },
      { t: 'tool-status', toolCallId: 'tc2', status: 'result', result: 2 },
      { t: 'assistant-done', id: 'a2', stopReason: 'tool_use' },
      // --- final answer: terminal stop, the ONE real turn-end ---
      { t: 'assistant-start', id: 'a3' },
      { t: 'text-delta', id: 'a3', delta: 'the answer' },
      { t: 'assistant-done', id: 'a3', stopReason: 'end' },
    ];

    let s = initialState();
    let prevPhase = s.phase;
    let rings = 0;
    for (const a of actions) {
      s = reducer(s, a);
      if (shouldRingBell(prevPhase, s.phase)) rings += 1;
      prevPhase = s.phase;
    }
    expect(rings).toBe(1);
  });

  it('completionBell config: default off, file-settable, env-overridable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'juno-bell-'));
    try {
      const configPath = path.join(dir, 'config.json');

      // Default: absent (off).
      expect(createConfigService({ configPath, env: {} }).get().completionBell).toBeUndefined();

      // File: on.
      await writeFile(configPath, JSON.stringify({ completionBell: true }), 'utf8');
      expect(createConfigService({ configPath, env: {} }).get().completionBell).toBe(true);

      // Env wins over file; invalid env value is ignored (file stands).
      expect(
        createConfigService({ configPath, env: { JUNO_COMPLETION_BELL: 'false' } }).get().completionBell,
      ).toBe(false);
      expect(
        createConfigService({ configPath, env: { JUNO_COMPLETION_BELL: 'banana' } }).get().completionBell,
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Composer focus gating — REAL app wiring (useKeybinds + InputBox/TextInput
// composed by <App>, driven through stdin). Regression for the key-leak bug:
// useKeybinds' swallow only blocks keybind ACTIONS; Ink still delivers every
// keypress to each active useInput, so an ungated TextInput typed behind
// overlays (and the opening `?` landed in the composer).
// ---------------------------------------------------------------------------

describe('Composer focus gating behind overlays (real <App> wiring)', () => {
  const ESC = '\u001B';

  function fakeDeps(): AppDeps {
    const config = createFakeConfigService({
      defaultProvider: 'openai',
      defaultModel: DEFAULT_SETTINGS.defaultModel,
      cwd: '/work',
      maxContext: 200_000,
    });
    return {
      createClient: () => createFakeModelClient({ tickMs: 0 }),
      tools: createDefaultTools(),
      policy: createPermissionPolicy({ autoAllowSafe: true }),
      catalog: createModelCatalog(BUILTIN_MODELS),
      settings: config.get(),
      specs: BUILTIN_TOOL_SPECS,
    };
  }

  /** The composer row (the `❯ ` prompt line) of a frame. */
  const composerLine = (frame: string): string =>
    frame.split('\n').find((line) => line.includes('❯')) ?? '';

  it('"?" on empty input opens help and the composer stays empty (also after Esc)', async () => {
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps()} />);
    await flushInk();

    await press(stdin, '?');
    let frame = await waitForFrame(lastFrame, 'keyboard shortcuts');
    // Empty composer still shows the placeholder; the opening '?' must NOT land.
    expect(composerLine(frame)).toContain(INPUT_PLACEHOLDER);
    expect(composerLine(frame)).not.toContain('?');

    await press(stdin, ESC);
    await waitFor(() => !(lastFrame() ?? '').includes('keyboard shortcuts'), {
      label: 'help overlay closed',
    });
    frame = lastFrame() ?? '';
    expect(composerLine(frame)).toContain(INPUT_PLACEHOLDER);
    expect(composerLine(frame)).not.toContain('?');

    unmount();
  });

  it('typing while the help overlay is open leaves the composer unchanged', async () => {
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps()} />);
    await flushInk();

    await press(stdin, '?');
    await waitForFrame(lastFrame, 'keyboard shortcuts');

    await press(stdin, 'qq');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('keyboard shortcuts'); // still open (keys swallowed)
    expect(composerLine(frame)).toContain(INPUT_PLACEHOLDER); // still empty
    expect(frame).not.toContain('qq');

    unmount();
  });

  it('typing while the slash palette is open builds a live filter query (F: type-to-filter)', async () => {
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps()} />);
    await flushInk();

    // The slash palette is type-to-filter (F): unlike the OTHER overlays it keeps the
    // composer FOCUSED, so typed characters build a `/query` that narrows the list —
    // they are NOT swallowed. (The gated-overlay key-swallow invariant is still held
    // by the help-overlay test above.)
    await press(stdin, '/');
    await waitForFrame(lastFrame, '/clear');

    // Typing 'e' narrows to /effort and drops the non-matching rows.
    await press(stdin, 'e');
    await waitForFrame(lastFrame, '/effort');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/effort');
    expect(frame).not.toContain('/clear'); // filtered out of the list
    expect(composerLine(frame)).toContain('/e'); // the query lives in the composer

    unmount();
  });

  it("seeds '/' as the live query on open and clears it on close (F: palette-args)", async () => {
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps()} />);
    await flushInk();

    // F reverses the old strip-the-seed behavior: '/' opens the palette AND seeds the
    // composer with '/' as the live filter query (composer stays focused). The seed is
    // now visible in the composer.
    await press(stdin, '/');
    // Detect the palette via a palette-only row ('/clear'), NOT the header word
    // 'commands' — the welcome banner ('/ commands · ? shortcuts') also carries
    // 'commands' on the fresh screen, so it can never signal palette open/close.
    await waitForFrame(lastFrame, '/clear');
    expect(composerLine(lastFrame() ?? '')).toContain('/'); // seed query visible

    // Esc closes the palette AND clears the composer (closeOverlay clears every path),
    // so no leftover '/' can corrupt the next message.
    await press(stdin, ESC);
    await waitFor(() => !(lastFrame() ?? '').includes('/clear'), {
      label: 'slash palette closed',
    });
    expect(composerLine(lastFrame() ?? '')).toContain(INPUT_PLACEHOLDER);
    expect(composerLine(lastFrame() ?? '')).not.toContain('/');

    // The next real message is typed VERBATIM — not prefixed by a leftover '/'.
    await press(stdin, 'h');
    await press(stdin, 'i');
    await waitFor(() => composerLine(lastFrame() ?? '').includes('hi'), {
      label: 'composer shows "hi"',
    });
    expect(composerLine(lastFrame() ?? '')).not.toContain('/');

    unmount();
  });

  it('normal typing works with no overlay, and "?" in non-empty input is text, not help', async () => {
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps()} />);
    await flushInk();

    await press(stdin, 'h');
    await press(stdin, 'i');
    await waitFor(() => composerLine(lastFrame() ?? '').includes('hi'), {
      label: 'composer shows "hi"',
    });

    await press(stdin, '?');
    await waitFor(() => composerLine(lastFrame() ?? '').includes('hi?'), {
      label: 'composer shows "hi?"',
    });
    expect(lastFrame() ?? '').not.toContain('keyboard shortcuts');

    unmount();
  });
});
