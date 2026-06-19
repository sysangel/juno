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
import { UnifiedCommandPalette } from '../src/ui/UnifiedCommandPalette';

interface CapturedInputBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Deterministically wait until a rendered frame contains `needle`. The slash
 * overlay mounts via a stdin-keybind state update; a single macrotask `tick()`
 * usually flushes the new ink frame, but under load (e.g. a saturated parallel
 * gate run) the commit can lag an extra macrotask, leaving the prior status-bar
 * frame captured — which is the flake this poll removes. Bounded so a genuinely
 * missing frame still fails the assertion instead of hanging.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  needle: string,
  maxTicks = 50,
): Promise<string> {
  for (let i = 0; i < maxTicks; i += 1) {
    if ((lastFrame() ?? '').includes(needle)) break;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await tick();
    });
  }
  return lastFrame() ?? '';
}
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
});

describe('App slash overlay Enter routing (Unit-5.1 follow-up edge case)', () => {
  it('does not fire the highlighted command when slash overlay input becomes a plain line', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    // Seed a committed transcript line so we can detect a spurious `clear`.
    await act(async () => {
      submitCaptured('seed transcript');
      await tick();
    });
    expect(requests).toHaveLength(1);
    expect(lastFrame() ?? '').toContain('seed transcript');

    await tick();

    // Open the slash palette.
    await act(async () => {
      stdin.write('/');
      await tick();
    });
    expect(await waitForFrame(lastFrame, 'commands')).toContain('commands');

    // The user backspaces the `/` and types a plain non-slash line.
    await act(async () => {
      changeCaptured('hello from slash overlay');
      await tick();
    });

    // Press Enter. Pre-fix: useKeybinds routed Enter to acceptSlash, which fired
    // highlighted `clear` (index 0) AND the typed line was never sent → this would
    // go red on BOTH assertions below. Post-fix: exactly one send, no clear.
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    // (a) the plain line was sent exactly once.
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.content).toBe('hello from slash overlay');

    // (b) NO phantom `clear` fired — the seeded transcript survives.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('seed transcript');
    expect(frame).toContain('hello from slash overlay');

    unmount();
  });

  it('still lets Enter choose the highlighted command when slash input is empty', async () => {
    const { client } = createRecordingClient();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await tick();

    await act(async () => {
      stdin.write('/');
      await tick();
    });
    expect(await waitForFrame(lastFrame, 'commands')).toContain('commands');

    // Move selection clear(0) → model(1), Enter accepts → opens the model picker.
    await act(async () => {
      stdin.write(DOWN);
      await tick();
    });
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('models');
    expect(frame).toContain(BUILTIN_MODELS[0]!.label);
    expect(frame).toContain(BUILTIN_MODELS[0]!.id);

    unmount();
  });
});
