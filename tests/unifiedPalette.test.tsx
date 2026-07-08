// tests/unifiedPalette.test.tsx
// W5 Unit 5.2 — the unified command palette + the Unit-5.1 follow-up edge case.
//
// Two surfaces under test:
//   1. UnifiedCommandPalette enumeration: it renders the slash / model / skills /
//      permission-mode surfaces from LIVE data (not hardcoded snapshots).
//   2. The slash-overlay Enter routing edge case: when the slash overlay is open
//      but the input is replaced with a PLAIN non-slash line, Enter must send THAT
//      line once and NOT fire the default-highlighted command (`clear`). The
//      pre-fix code routed every Enter to acceptSlash → highlighted clear fired
//      AND the typed line was lost — this test goes red against that code.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, slashCommands } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { SKILLS_EMPTY_HINT, SLASH_EMPTY_HINT, UnifiedCommandPalette, computeRowWindow } from '../src/ui/UnifiedCommandPalette';
import { OverlayHost } from '../src/ui/OverlayHost';
import { flushInk, press, waitFor, waitForFrame } from './helpers/ink';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
  readonly focus?: boolean;
}

const inputBoxMock = vi.hoisted(() => ({
  latestProps: null as CapturedInputBoxProps | null,
}));

vi.mock('../src/ui/InputBox', () => ({
  InputBox: (props: CapturedInputBoxProps) => {
    inputBoxMock.latestProps = props;
    return <Text>mock-input</Text>;
  },
}));

// Frame/spy waits come from tests/helpers/ink (flushInk/press/waitFor/waitForFrame):
// act-based effect flushing is deterministic under load where a bare setTimeout(0)
// tick raced Ink's useInput subscription and dropped the first keypress.
const DOWN = '[B';
const ENTER = '\r';

const TEST_SKILLS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'review', description: 'Review code changes' },
  { name: 'docs', description: 'Draft documentation' },
];

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient, settingsOverrides: Partial<Settings> = {}): AppDeps {
  const config = createFakeConfigService(fakeSettings(settingsOverrides));
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
    skills: TEST_SKILLS,
  };
}

function createRecordingClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn(
      input: TurnInput,
      _tools: ToolSpec[],
      _signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      requests.push(input);
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return (async function* emptyStream(): AsyncGenerator<AgentEvent, void, unknown> {})();
    },
  };
  return { client, requests };
}

function submitCaptured(value: string): void {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  props.onSubmit(value);
}

function changeCaptured(value: string): void {
  const props = inputBoxMock.latestProps;
  if (props === null) {
    throw new Error('InputBox props were not captured');
  }
  props.onChange(value);
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('UnifiedCommandPalette enumeration', () => {
  it('lists the steer command for palette discoverability', () => {
    expect(slashCommands).toContainEqual(
      expect.objectContaining({
        name: 'steer',
        description: 'Inject mid-turn guidance (no restart)',
      }),
    );
  });

  it('renders the slash surface with commands, descriptions and a selected marker', () => {
    const commands = slashCommands.map((command) => ({
      name: command.name,
      description: command.description,
    }));

    const frame =
      render(
        <UnifiedCommandPalette mode="slash" commands={[...commands]} selectedIndex={1} depth="ansi16" />,
      ).lastFrame() ?? '';

    expect(frame).toContain('commands');
    expect(frame).toContain('▸');
    for (const command of commands) {
      expect(frame).toContain(`/${command.name}`);
      expect(frame).toContain(command.description);
    }
  });

  it('echoes the active type-to-filter query in the slash header', () => {
    const frame =
      render(
        <UnifiedCommandPalette
          mode="slash"
          commands={[{ name: 'steer', description: 'Inject mid-turn guidance (no restart)' }]}
          query="st"
          selectedIndex={0}
          depth="ansi16"
        />,
      ).lastFrame() ?? '';

    // Header still contains 'commands' (enumeration substring holds) plus the query.
    expect(frame).toContain('commands');
    expect(frame).toContain('/st');
    expect(frame).toContain('/steer');
  });

  it('renders a dim empty-filter hint (not a bare box) when the query matches nothing (F)', () => {
    const frame =
      render(<UnifiedCommandPalette mode="slash" commands={[]} query="zzz" depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('commands');
    expect(frame).toContain('/zzz');
    expect(frame).not.toContain('▸');
    expect(frame).toContain(SLASH_EMPTY_HINT);
  });

  it('renders the model surface with labels and ids from the live catalog', () => {
    const models = createModelCatalog(BUILTIN_MODELS).list();

    const frame =
      render(
        <UnifiedCommandPalette mode="model" models={models} selectedId={models[0]?.id} depth="ansi16" />,
      ).lastFrame() ?? '';

    expect(frame).toContain('models');
    for (const model of models) {
      expect(frame).toContain(model.label);
      expect(frame).toContain(model.id);
    }
  });

  it('renders the skills surface from deps.skills-shaped entries', () => {
    const { client } = createRecordingClient();
    const skills = fakeDeps(client).skills ?? [];

    const frame =
      render(
        <UnifiedCommandPalette mode="skills" skills={skills} selectedIndex={0} depth="ansi16" />,
      ).lastFrame() ?? '';

    expect(frame).toContain('skills');
    expect(frame).toContain('▸');
    for (const skill of skills) {
      expect(frame).toContain(skill.name);
      expect(frame).toContain(skill.description);
    }
  });

  it('renders a dim empty-state hint (not a bare box) when no skills are discovered (F)', () => {
    const frame =
      render(
        <UnifiedCommandPalette mode="skills" skills={[]} depth="ansi16" />,
      ).lastFrame() ?? '';

    // Header still present, no selection marker, and the honest discovery-path hint.
    expect(frame).toContain('skills');
    expect(frame).not.toContain('▸');
    expect(frame).toContain(SKILLS_EMPTY_HINT);
  });

  it('renders the permission-mode surface with both modes and an active marker', () => {
    const frame =
      render(
        <UnifiedCommandPalette mode="permission-mode" selectedMode="acceptEdits" depth="ansi16" />,
      ).lastFrame() ?? '';

    expect(frame).toContain('permission mode');
    expect(frame).toContain('default');
    expect(frame).toContain('acceptEdits');
    expect(frame).toContain('▸');
  });

  it('renders the session surface with titles, subtitles and a selection marker', () => {
    const sessions = [
      { id: 's1', title: 'First chat', subtitle: '2026-06-20T09:00:00.000Z' },
      { id: 's2', title: 'Second chat', subtitle: '2026-06-20T10:00:00.000Z' },
    ];

    const frame =
      render(
        <UnifiedCommandPalette mode="session" sessions={sessions} selectedIndex={1} depth="ansi16" />,
      ).lastFrame() ?? '';

    expect(frame).toContain('sessions');
    expect(frame).toContain('▸');
    for (const session of sessions) {
      expect(frame).toContain(session.title);
      expect(frame).toContain(session.subtitle);
    }
  });

  it('renders only the sessions header for an empty list (no rows, no crash)', () => {
    const frame =
      render(<UnifiedCommandPalette mode="session" sessions={[]} depth="ansi16" />).lastFrame() ?? '';

    expect(frame).toContain('sessions');
    expect(frame).not.toContain('▸');
  });
});

// ---------------------------------------------------------------------------
// Long-list windowing (BUG 1 regression): a list longer than the terminal must
// window around the selection so the highlight stays on screen and the rows
// that scrolled off are summarized by a "… +N more" indicator. Without a `rows`
// prop the palette renders every row (the isolated-test fallback).
// ---------------------------------------------------------------------------

describe('computeRowWindow', () => {
  it('returns the whole list when it already fits (or maxVisible <= 0)', () => {
    expect(computeRowWindow(5, 3, 10)).toEqual({ start: 0, count: 5, hiddenAbove: 0, hiddenBelow: 0 });
    expect(computeRowWindow(5, 3, 0)).toEqual({ start: 0, count: 5, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it('anchors at the top when the selection is near the top', () => {
    // selected 0, window of 10 over 50 -> [0,10), 40 hidden below, none above.
    expect(computeRowWindow(50, 0, 10)).toEqual({ start: 0, count: 10, hiddenAbove: 0, hiddenBelow: 40 });
  });

  it('centers the window on the selection in the middle of a long list', () => {
    // selected 25, window 10 -> start = 25 - 5 = 20, so 20 above / 20 below.
    const w = computeRowWindow(50, 25, 10);
    expect(w).toEqual({ start: 20, count: 10, hiddenAbove: 20, hiddenBelow: 20 });
    // Selection is strictly inside the rendered window.
    expect(25).toBeGreaterThanOrEqual(w.start);
    expect(25).toBeLessThan(w.start + w.count);
  });

  it('clamps at the bottom without hiding the last (selected) row', () => {
    // selected 49 (last), window 10 -> start = 40, nothing hidden below.
    const w = computeRowWindow(50, 49, 10);
    expect(w).toEqual({ start: 40, count: 10, hiddenAbove: 40, hiddenBelow: 0 });
    expect(49).toBeLessThan(w.start + w.count);
  });
});

describe('UnifiedCommandPalette — long-list windowing (BUG 1)', () => {
  const LONG = Array.from({ length: 50 }, (_, i) => ({
    name: `pick-${String(i).padStart(2, '0')}`,
    description: `option number ${i}`,
  }));

  // Count rendered entry rows / parse the overflow indicators out of a frame.
  const inspect = (frame: string) => {
    const visible = frame.split('\n').filter((l) => l.includes('pick-')).length;
    const above = Number(/\+(\d+) more above/.exec(frame)?.[1] ?? 0);
    const below = Number(/\+(\d+) more below/.exec(frame)?.[1] ?? 0);
    return { visible, above, below };
  };

  it('windows a 50-entry list at a 24-row terminal and keeps the highlight visible', () => {
    const { lastFrame, rerender } = render(
      <UnifiedCommandPalette mode="skills" skills={LONG} selectedIndex={0} rows={24} depth="ansi16" />,
    );

    const top = lastFrame() ?? '';
    const t = inspect(top);
    // Windowed: far fewer than all 50 rows are rendered, the selected row shows,
    // and a distant row has scrolled out of view.
    expect(t.visible).toBeLessThan(50);
    expect(top).toContain('pick-00');
    expect(top).not.toContain('pick-49');
    // Overflow accounting is exact: shown + hidden-above + hidden-below === 50.
    expect(t.above).toBe(0);
    expect(t.below).toBeGreaterThan(0);
    expect(t.visible + t.above + t.below).toBe(50);
    expect(top).toContain('more below');

    // Move the selection down past the fold: the window scrolls so the newly
    // selected row is on screen and the former top row is not.
    rerender(<UnifiedCommandPalette mode="skills" skills={LONG} selectedIndex={45} rows={24} depth="ansi16" />);
    const down = lastFrame() ?? '';
    const dSel = down.split('\n').find((l) => l.includes('pick-45')) ?? '';
    expect(dSel).toContain('▸'); // highlight is rendered, in-window
    expect(down).not.toContain('pick-00'); // scrolled off the top
    expect(down).toContain('more above');
    const d = inspect(down);
    expect(d.above).toBeGreaterThan(0);
    expect(d.visible + d.above + d.below).toBe(50);
  });

  it('renders every row (no windowing) when no rows prop is threaded', () => {
    const frame =
      render(<UnifiedCommandPalette mode="skills" skills={LONG} selectedIndex={0} depth="ansi16" />).lastFrame() ??
      '';
    expect(frame).toContain('pick-00');
    expect(frame).toContain('pick-49');
    expect(frame).not.toContain('more below');
  });
});

describe('OverlayHost — session-picker routing', () => {
  it('routes overlay "session-picker" to the session palette when sessionPicker is provided', () => {
    const frame =
      render(
        <OverlayHost
          overlay="session-picker"
          sessionPicker={{
            sessions: [{ id: 's1', title: 'Resumable', subtitle: '2026-06-20T09:00:00.000Z' }],
            selectedIndex: 0,
            depth: 'ansi16',
          }}
        />,
      ).lastFrame() ?? '';

    expect(frame).toContain('sessions');
    expect(frame).toContain('Resumable');
  });

  it('renders nothing for session-picker when no sessionPicker prop is supplied', () => {
    const { lastFrame } = render(<OverlayHost overlay="session-picker" />);
    expect(lastFrame() ?? '').toBe('');
  });
});

describe('App slash overlay Enter routing (Unit-5.1 follow-up edge case)', () => {
  it('does not fire the highlighted command when slash overlay input becomes a plain line', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    // Seed a committed transcript line so we can detect a spurious `clear`.
    await act(async () => {
      submitCaptured('seed transcript');
    });
    await waitForFrame(lastFrame, 'seed transcript');
    expect(requests).toHaveLength(1);

    await flushInk();

    // Open the slash palette.
    await press(stdin, '/');
    expect(await waitForFrame(lastFrame, 'commands')).toContain('commands');

    // The user backspaces the `/` and types a plain non-slash line.
    await act(async () => {
      changeCaptured('hello from slash overlay');
    });
    await flushInk();

    // Press Enter. Pre-fix: useKeybinds routed Enter to acceptSlash, which fired
    // highlighted `clear` (index 0) AND the typed line was never sent → this would
    // go red on BOTH assertions below. Post-fix: exactly one send, no clear.
    await press(stdin, ENTER);

    // (a) the plain line was sent exactly once.
    await waitFor(() => requests.length >= 2, { label: 'plain line sent' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toBe('hello from slash overlay');

    // (b) NO phantom `clear` fired — the seeded transcript survives.
    const frame = await waitForFrame(lastFrame, 'hello from slash overlay');
    expect(frame).toContain('seed transcript');

    unmount();
  });

  it('still lets Enter choose the highlighted command when slash input is empty', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await flushInk();

    await press(stdin, '/');
    expect(await waitForFrame(lastFrame, 'commands')).toContain('commands');

    // Move selection clear(0) → model(1), Enter accepts → opens the model picker.
    await press(stdin, DOWN);
    await press(stdin, ENTER);

    const frame = await waitForFrame(lastFrame, 'models');
    expect(frame).toContain(BUILTIN_MODELS[0]!.label);
    expect(frame).toContain(BUILTIN_MODELS[0]!.id);

    unmount();
  });
});

describe('App slash palette type-to-filter (F: palette-args)', () => {
  it('narrows the visible rows to a typed query and resets the highlight to the top', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await flushInk();

    // Open the palette — the composer stays focused now (type-to-filter). '/' seeds.
    await press(stdin, '/');
    expect(await waitForFrame(lastFrame, '/clear')).toContain('/model');

    // Move the highlight off the top row (onto index 1 of the full list).
    await press(stdin, DOWN);

    // Type a query that narrows to a single command. selectedIndex (1) is now past the
    // filtered end; the reset effect must snap it back to 0 or the sole row shows no
    // marker (this is the direct witness of the selectedIndex-reset requirement).
    await act(async () => {
      changeCaptured('/e');
    });
    const frame = await waitForFrame(lastFrame, '/effort');
    // Filtered: only the /effort row survives.
    expect(frame).toContain('/effort');
    expect(frame).not.toContain('/clear');
    expect(frame).not.toContain('/model');
    // Highlight reset to the (only) filtered row.
    const effortRow = frame.split('\n').find((l) => l.includes('/effort')) ?? '';
    expect(effortRow).toContain('▸');

    unmount();
  });

  it('prefills "/steer " (composer stays open + focused) when steer is chosen without an arg', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await flushInk();

    await press(stdin, '/');
    await waitForFrame(lastFrame, 'commands');

    // Narrow to steer with no argument typed. (Separate act flushes so the Enter's
    // useKeybinds closure sees the new value, not the stale seed.)
    await act(async () => {
      changeCaptured('/st');
    });
    await waitForFrame(lastFrame, '/steer');

    // A physical Enter fires submit (a no-op that must NOT clobber the value) AND
    // acceptSlash (the prefill). Fire submit, then Enter → acceptSlash.
    await act(async () => {
      submitCaptured('/st');
    });
    await press(stdin, ENTER);

    // Palette-select of an arg command prefills '/steer ' and keeps the overlay open +
    // composer focused for inline arg entry — it does NOT close or hit the model.
    await waitFor(() => inputBoxMock.latestProps?.value === '/steer ', { label: "value prefilled '/steer '" });
    expect(inputBoxMock.latestProps?.value).toBe('/steer ');
    expect(inputBoxMock.latestProps?.focus).toBe(true);
    expect(lastFrame() ?? '').toContain('commands');
    expect(requests).toHaveLength(0);

    unmount();
  });

  it('keeps the composer focused for the slash palette but gates every other overlay', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await flushInk();

    // Slash palette: composer stays focused so type-to-filter works.
    await press(stdin, '/');
    await waitForFrame(lastFrame, 'commands');
    expect(inputBoxMock.latestProps?.focus).toBe(true);

    // Narrow to /model, then Enter → acceptSlash opens the model picker — a gated
    // overlay: focus flips OFF so keystrokes cannot leak behind it.
    await act(async () => {
      changeCaptured('/model');
    });
    await waitForFrame(lastFrame, '/model');
    await press(stdin, ENTER);
    await waitForFrame(lastFrame, 'models');
    expect(inputBoxMock.latestProps?.focus).toBe(false);

    unmount();
  });

  it('makes Enter on a zero-match query a safe no-op (no command fires, no model leak)', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    // Seed a committed transcript line so a phantom `clear` would be detectable.
    await act(async () => {
      submitCaptured('seed transcript');
    });
    await waitForFrame(lastFrame, 'seed transcript');
    expect(requests).toHaveLength(1);

    await press(stdin, '/');
    await waitForFrame(lastFrame, 'commands');

    // A query that matches nothing, then Enter (submit no-op + acceptSlash).
    await act(async () => {
      changeCaptured('/zzz');
    });
    await waitForFrame(lastFrame, SLASH_EMPTY_HINT);
    await act(async () => {
      submitCaptured('/zzz');
    });
    await press(stdin, ENTER);
    await flushInk();

    // No model turn started (still just the seed) and the seeded transcript survives —
    // no phantom highlighted command fired, and the composer is cleared on close.
    expect(requests).toHaveLength(1);
    expect(lastFrame() ?? '').toContain('seed transcript');
    expect(inputBoxMock.latestProps?.value).toBe('');

    unmount();
  });
});
