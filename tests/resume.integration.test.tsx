// tests/resume.integration.test.tsx
// Session Resume — Unit 3 integration. Drives the REAL UI seams:
//   - the slash palette (`/resume` → session-picker overlay),
//   - useKeybinds (arrow + Enter inside the session-picker → acceptSession),
//   - the persistence useEffect (committed turn → store.create + store.save),
// all over an in-memory SessionStore. We mock InputBox to capture onSubmit/onChange
// (the established pattern) and use ink stdin for the keybind path.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { Msg } from '../src/core/reducer';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { createMemorySessionStore } from '../src/services/sessions';
import type { SessionStore } from '../src/services/sessions';

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

const ENTER = '\r';

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient, sessionStore?: SessionStore): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  const deps: AppDeps = {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
  return sessionStore === undefined ? deps : { ...deps, sessionStore };
}

function createRecordingClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn(input: TurnInput, _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<AgentEvent> {
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

function pastSession(text: string): Msg[] {
  return [
    { id: 'u1', role: 'user', blocks: [{ kind: 'text', id: 'u1:block:1', text }], done: true },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ kind: 'text', id: 'a1:block:1', text: 'past assistant reply' }],
      done: true,
    },
  ];
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('Session Resume — /resume opens the picker', () => {
  it('typing /resume + Enter opens the session-picker overlay (sessions header)', async () => {
    const { client } = createRecordingClient();
    const store = createMemorySessionStore();
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client, store)} />);

    await tick();
    await act(async () => {
      submitCaptured('/resume');
      await tick();
    });

    expect(await waitForFrame(lastFrame, 'sessions')).toContain('sessions');
    unmount();
  });

  it('selecting in an empty picker just closes it (no crash)', async () => {
    const { client } = createRecordingClient();
    const store = createMemorySessionStore();
    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, store)} />);

    await tick();
    await act(async () => {
      submitCaptured('/resume');
      await tick();
    });
    expect(await waitForFrame(lastFrame, 'sessions')).toContain('sessions');

    // Enter on an empty list → acceptSession finds no entry → closeOverlay.
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });
    await act(async () => {
      await tick();
    });

    expect(lastFrame() ?? '').not.toContain('sessions');
    unmount();
  });
});

describe('Session Resume — hydrate a past session', () => {
  it('Enter on a seeded session hydrates the transcript with the loaded messages', async () => {
    const { client } = createRecordingClient();
    const store = createMemorySessionStore();
    await store.create({ id: 'past-1', createdAt: '2026-06-20T09:00:00.000Z', title: 'past chat' });
    await store.save('past-1', pastSession('hello from the past'));

    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, store)} />);

    await tick();
    await act(async () => {
      submitCaptured('/resume');
      await tick();
    });
    // Picker lists the seeded session by its title.
    expect(await waitForFrame(lastFrame, 'past chat')).toContain('past chat');

    // Enter accepts the highlighted (index 0) session → resume-session dispatch.
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    const frame = await waitForFrame(lastFrame, 'hello from the past');
    expect(frame).toContain('hello from the past');
    expect(frame).toContain('past assistant reply');
    unmount();
  });
});

describe('Session Resume — hydrate MID-session (Static remount regression)', () => {
  it('resuming after a committed turn shows ALL resumed messages (leading ones not dropped)', async () => {
    // Concrete failure the epoch/<Static> remount fixes: with messages already
    // committed (so Ink's <Static> internal index has advanced past 0), a wholesale
    // resume slices off the leading messages of the loaded transcript unless Static
    // is remounted. Here we commit one live turn FIRST, then resume a 2-message
    // session and assert BOTH loaded messages render.
    const { client } = createRecordingClient();
    const store = createMemorySessionStore();
    // Future-dated so it stays FIRST under the picker's newest-first ordering (F):
    // the live turn committed below creates an active session stamped `now`, and this
    // seeded session must remain at index 0 for the Enter-accepts-index-0 flow.
    await store.create({ id: 'past-2', createdAt: '2099-01-01T00:00:00.000Z', title: 'earlier chat' });
    await store.save('past-2', pastSession('hello from the past'));

    const { stdin, lastFrame, unmount } = render(<App deps={fakeDeps(client, store)} />);

    // 1) Commit a live turn so committed.length > 0 (advances Static's index).
    await tick();
    await act(async () => {
      submitCaptured('a live turn before resuming');
      await tick();
    });
    expect(await waitForFrame(lastFrame, 'a live turn before resuming')).toContain(
      'a live turn before resuming',
    );

    // 2) Open the picker and resume the seeded 2-message session.
    await act(async () => {
      submitCaptured('/resume');
      await tick();
    });
    expect(await waitForFrame(lastFrame, 'earlier chat')).toContain('earlier chat');
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });

    // Both resumed messages must appear. Without the remount, the loaded user msg
    // (#1) is sliced off and never printed.
    const frame = await waitForFrame(lastFrame, 'past assistant reply');
    expect(frame).toContain('hello from the past');
    expect(frame).toContain('past assistant reply');
    unmount();
  });
});

describe('Session Resume — best-effort persistence', () => {
  it('a committed user turn is created + saved to the store (round-trips via list/load)', async () => {
    const { client } = createRecordingClient();
    const store = createMemorySessionStore();
    const { unmount } = render(<App deps={fakeDeps(client, store)} />);

    await tick();
    await act(async () => {
      submitCaptured('persist this turn');
      await tick();
    });
    // Let the fire-and-forget persistence effect flush.
    await act(async () => {
      await tick();
    });
    await act(async () => {
      await tick();
    });

    const metas = await store.list();
    expect(metas).toHaveLength(1);
    const loaded = await store.load(metas[0]!.id);
    expect(loaded).toBeDefined();
    expect(loaded!.messages[0]?.blocks[0]).toMatchObject({ kind: 'text', text: 'persist this turn' });
    // The meta title was derived from the first user message.
    expect(metas[0]!.title).toBe('persist this turn');
    unmount();
  });
});

describe('Session Resume — back-compat (no sessionStore dep)', () => {
  it('App with NO sessionStore still renders and runs a turn', async () => {
    const { client, requests } = createRecordingClient();
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await tick();
    await act(async () => {
      submitCaptured('a normal turn');
      await tick();
    });

    expect(requests).toHaveLength(1);
    expect(lastFrame() ?? '').toContain('a normal turn');
    unmount();
  });

  it('/resume with NO sessionStore opens an empty picker without crashing', async () => {
    const { client } = createRecordingClient();
    const { lastFrame, unmount } = render(<App deps={fakeDeps(client)} />);

    await tick();
    await act(async () => {
      submitCaptured('/resume');
      await tick();
    });

    expect(await waitForFrame(lastFrame, 'sessions')).toContain('sessions');
    unmount();
  });
});
