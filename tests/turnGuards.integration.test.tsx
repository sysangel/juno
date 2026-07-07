// tests/turnGuards.integration.test.tsx
// Regressions for two CONFIRMED silent-data-loss UI bugs in <App>:
//
//   1. A message typed + submitted while the hook is BUSY (a turn, or a
//      fire-and-forget compaction / ambient-recall pass, still owns the
//      controller — even though the phase can read 'idle') must NOT be wiped
//      from the composer. app.tsx used to `setValue('')` BEFORE calling
//      `turn.submit`, whose guard silently no-ops in that window → the typed
//      text was cleared AND never sent. The fix gates on `turn.isBusy()`.
//
//   2. Resuming a session (/resume) or clearing (/clear) DURING an in-flight
//      turn must ABORT that turn. Neither `resume-session` nor `clear` aborted
//      it, so the controller stayed held and every subsequent plain submit was
//      silently swallowed until the orphaned turn finished. The fix calls
//      `turn.abort()` before dispatching `clear` / `resume-session`.
//
// Drives the REAL UI seams: the InputBox onSubmit (app.submit), the slash
// dispatch, the session-picker useKeybinds path, over an in-memory store. The
// InputBox is mocked (established pattern) so we can inspect/drive its props.
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
import { waitFor, waitForFrame } from './helpers/ink';

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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const ENTER = '\r';

function props(): CapturedInputBoxProps {
  const p = inputBoxMock.latestProps;
  if (p === null) {
    throw new Error('InputBox props were not captured');
  }
  return p;
}

/** Type text into the (mocked) composer, flushing the resulting re-render. */
async function typeInto(value: string): Promise<void> {
  await act(async () => {
    props().onChange(value);
    await tick();
  });
}

/** Fire the composer's onSubmit with `value`, flushing the resulting re-render. */
async function submitComposer(value: string): Promise<void> {
  await act(async () => {
    props().onSubmit(value);
    await tick();
  });
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

interface DepsExtras {
  readonly sessionStore?: SessionStore;
  readonly ambientRecall?: (prompt: string) => Promise<string | undefined>;
}

function fakeDeps(client: ModelClient, extras: DepsExtras = {}): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  const base: AppDeps = {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
  return {
    ...base,
    ...(extras.sessionStore !== undefined ? { sessionStore: extras.sessionStore } : {}),
    ...(extras.ambientRecall !== undefined ? { ambientRecall: extras.ambientRecall } : {}),
  };
}

/** A client whose FIRST turn streams-then-hangs until the turn is aborted, and
 * whose subsequent turns complete cleanly with a visible reply. Records every
 * TurnInput it is handed so a test can count how many turns actually reached
 * the model. */
function makeControlledClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  let call = 0;
  const client: ModelClient = {
    streamTurn(input: TurnInput, _tools: ToolSpec[], signal: AbortSignal): AsyncIterable<AgentEvent> {
      requests.push(input);
      const n = call;
      call += 1;
      return (async function* (): AsyncGenerator<AgentEvent, void, unknown> {
        if (n === 0) {
          // Start streaming (so the turn is visibly in-flight), then park until abort.
          yield { type: 'assistant-start', id: 'hang-1' };
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        yield { type: 'assistant-start', id: `done-${n}` };
        yield { type: 'text-delta', id: `done-${n}`, delta: 'second reply' };
        yield { type: 'assistant-done', id: `done-${n}`, stopReason: 'end' };
      })();
    },
  };
  return { client, requests };
}

/** A client that records every TurnInput and streams nothing (clean empty turn). */
function makeRecordingClient(): { client: ModelClient; requests: TurnInput[] } {
  const requests: TurnInput[] = [];
  const client: ModelClient = {
    streamTurn(input: TurnInput, _tools: ToolSpec[], _signal: AbortSignal): AsyncIterable<AgentEvent> {
      requests.push(input);
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return (async function* (): AsyncGenerator<AgentEvent, void, unknown> {})();
    },
  };
  return { client, requests };
}

/** The user-role message contents of a captured TurnInput (the model-facing
 * transcript — deterministic, unlike Ink's append-only <Static> frame). */
function userContents(input: TurnInput | undefined): string[] {
  return (input?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
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

describe('composer preserves a message the hook would reject (busy window)', () => {
  it('typing + Enter during the busy ambient-recall window does NOT clear or drop the text', async () => {
    const { client, requests } = makeRecordingClient();

    // Gate ambient recall so the FIRST submit parks with the controller held while the
    // reducer phase is still 'idle' — the exact silent-drop window from the finding.
    let releaseRecall: () => void = () => undefined;
    const recallGate = new Promise<void>((resolve) => {
      releaseRecall = resolve;
    });
    const ambientRecall = async (): Promise<string | undefined> => {
      await recallGate;
      return undefined;
    };

    const { unmount } = render(<App deps={fakeDeps(client, { ambientRecall })} />);
    await act(async () => {
      await tick();
    });

    // First submit is ACCEPTED → composer clears. (It is now parked on the recall gate.)
    await typeInto('first');
    await submitComposer('first');
    expect(props().value).toBe('');

    // Second submit lands while the hook is busy (controller held, phase idle).
    await typeInto('second');
    await submitComposer('second');

    // The rejected message must be PRESERVED in the composer, never wiped...
    expect(props().value).toBe('second');
    // ...and it must not have reached the model (the first turn is still gated at 0).
    expect(requests).toHaveLength(0);

    // Release the gate so the parked turn can unwind before unmount.
    releaseRecall();
    await act(async () => {
      await tick();
    });
    unmount();
  });
});

describe('/clear during an in-flight turn aborts it so the next message is sent', () => {
  it('sends a fresh message after /clear cancels a streaming turn', async () => {
    const { client, requests } = makeControlledClient();
    const { unmount } = render(<App deps={fakeDeps(client)} />);
    await act(async () => {
      await tick();
    });

    // Start a turn that streams then hangs (controller held).
    await submitComposer('first');
    await waitFor(() => requests.length === 1, { label: 'first (hanging) turn dispatched' });

    // /clear MUST abort the in-flight turn (not merely reset the transcript).
    await submitComposer('/clear');
    await act(async () => {
      await tick();
    });
    await act(async () => {
      await tick();
    });

    // The next plain message must actually be sent — pre-fix it was silently swallowed
    // because the never-aborted turn kept the controller held.
    await submitComposer('second message');
    await waitFor(() => requests.length === 2, {
      label: 'second turn dispatched after /clear (would hang forever pre-fix)',
    });
    expect(requests).toHaveLength(2);
    // The model-facing transcript of the new turn is JUST the new message — /clear wiped
    // the first turn's history (asserted on the transcript, not the append-only frame).
    expect(userContents(requests[1])).toEqual(['second message']);
    unmount();
  });
});

describe('/resume during an in-flight turn aborts it so the next message is sent', () => {
  it('sends a fresh message after resuming a session cancels a streaming turn', async () => {
    const { client, requests } = makeControlledClient();
    const store = createMemorySessionStore();
    // Dated in the future so it stays FIRST under the picker's newest-first ordering
    // (F): committing 'first' below creates an active session stamped `now`, and the
    // seeded session must remain at index 0 for the Enter-accepts-index-0 flow.
    await store.create({ id: 'past-1', createdAt: '2099-01-01T00:00:00.000Z', title: 'past chat' });
    await store.save('past-1', pastSession('hello from the past'));

    const { stdin, lastFrame, unmount } = render(
      <App deps={fakeDeps(client, { sessionStore: store })} />,
    );
    await act(async () => {
      await tick();
    });

    // Start a turn that streams then hangs (controller held).
    await submitComposer('first');
    await waitFor(() => requests.length === 1, { label: 'first (hanging) turn dispatched' });

    // Open the session picker mid-turn and accept the seeded session. The picker close
    // (composer regains focus) is a deterministic signal that acceptSession ran — by then
    // its turn.abort() has released the controller (all release work is microtasks that
    // drain before the next render).
    await submitComposer('/resume');
    await waitForFrame(lastFrame, 'past chat');
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });
    await waitFor(() => props().focus === true, { label: 'session picker closed after resume' });

    // The next plain message must actually be sent — pre-fix it was silently swallowed.
    await submitComposer('after resume');
    await waitFor(() => requests.length === 2, {
      label: 'second turn dispatched after /resume (would hang forever pre-fix)',
    });
    expect(requests).toHaveLength(2);
    // The new turn's transcript is the RESUMED session (not the pre-resume 'first') plus
    // the new message — proving resume-session replaced the transcript AND the turn was sent.
    const users = userContents(requests[1]);
    expect(users).toContain('hello from the past');
    expect(users).toContain('after resume');
    expect(users).not.toContain('first');
    unmount();
  });
});
