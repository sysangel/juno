// tests/slashIntercept.test.tsx
// W5 Unit 5.1 — slash-command interception. Two load-bearing invariants:
//   1. parseSlashCommand is a pure, lowercasing leading-`/word` parser.
//   2. submit() NEVER forwards a leading-`/` line to the model — a `/`-prefixed
//      submit reaches the model client ZERO times; a normal line reaches it once.
//
// Deterministic + Ink-stdin-timing-free: we mock InputBox to capture its props
// and drive onSubmit directly, and we use a RECORDING ModelClient whose
// streamTurn() records every TurnInput it receives (an empty stream). If a
// `/`-line ever reached turn.submit(), streamTurn would be invoked and `requests`
// would grow — so `requests` is the direct witness of the no-leak invariant.
import { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, filterSlashCommands, parseSlashCommand, parseSteerArg, slashCommands } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient, ToolSpec, TurnInput } from '../src/core/contracts';
import type { AgentEvent } from '../src/core/events';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';
import { flushInk, press } from './helpers/ink';

const ENTER = '\r';

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
  // Composer-framing hairline rules: stubbed to null here so the mocked-InputBox App
  // frame is unchanged (the rules are exercised in statusStrip/app.smoke tests).
  ComposerRule: () => null,
}));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(client: ModelClient): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    createClient: () => client,
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
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

// A client whose stream never completes on its own: it records the TurnInput and
// then parks on a gate, so the turn stays in flight (controllerRef held) until
// the test releases it. This reproduces the "a turn is streaming" window.
function createHangingClient(): {
  client: ModelClient;
  requests: TurnInput[];
  release: () => void;
} {
  const requests: TurnInput[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: ModelClient = {
    streamTurn(
      input: TurnInput,
      _tools: ToolSpec[],
      _signal: AbortSignal,
    ): AsyncIterable<AgentEvent> {
      requests.push(input);
      return (async function* hangingStream(): AsyncGenerator<AgentEvent, void, unknown> {
        await gate;
      })();
    },
  };
  return { client, requests, release };
}

beforeEach(() => {
  inputBoxMock.latestProps = null;
});

describe('parseSlashCommand', () => {
  it('returns a lowercased command name from leading slash input', () => {
    expect(parseSlashCommand('/clear')).toBe('clear');
    expect(parseSlashCommand('/EFFORT')).toBe('effort');
    expect(parseSlashCommand('/Model')).toBe('model');
    expect(parseSlashCommand('  /model extra')).toBe('model');
  });

  it('returns null when there is no leading slash command word', () => {
    expect(parseSlashCommand('hello /clear')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/ ')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('parseSteerArg', () => {
  it('extracts the inline guidance text after /steer', () => {
    expect(parseSteerArg('/steer go faster')).toBe('go faster');
    expect(parseSteerArg('  /STEER  focus on tests ')).toBe('focus on tests');
  });

  it('returns null for a bare /steer with no text', () => {
    expect(parseSteerArg('/steer')).toBeNull();
    expect(parseSteerArg('/steer   ')).toBeNull();
  });

  it('does not match /steering (word boundary, not the steer command)', () => {
    expect(parseSteerArg('/steering wheel')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  it('returns every command for a null or empty query', () => {
    expect(filterSlashCommands(slashCommands, null)).toEqual([...slashCommands]);
    expect(filterSlashCommands(slashCommands, '')).toEqual([...slashCommands]);
  });

  it('narrows to commands whose name starts with the query (case-insensitive)', () => {
    expect(filterSlashCommands(slashCommands, 's').map((c) => c.name)).toEqual(['skills', 'steer']);
    expect(filterSlashCommands(slashCommands, 'st').map((c) => c.name)).toEqual(['steer']);
    expect(filterSlashCommands(slashCommands, 'C').map((c) => c.name)).toEqual(['clear', 'compact']);
  });

  it('returns an empty list when nothing matches (safe zero-match)', () => {
    expect(filterSlashCommands(slashCommands, 'zzz')).toEqual([]);
  });
});

describe('App /steer inline arg via the focused slash composer (exactly once, no model leak)', () => {
  it('typed "/steer <text>" + Enter reaches turn.steer once and never the model', async () => {
    const { client, requests } = createRecordingClient();
    const { stdin, unmount } = render(<App deps={fakeDeps(client)} />);

    await flushInk();

    // Open the palette (composer stays focused now) and type the full inline-arg line.
    await press(stdin, '/');
    await act(async () => {
      changeCaptured('/steer make it shorter');
      await tick();
    });

    // A single physical Enter fires BOTH the focused TextInput.onSubmit (submit) AND
    // useKeybinds' acceptSlash. Replicate that dual-fire: submit injects, acceptSlash
    // closes. The injection must happen EXACTLY once and never start a model turn.
    await act(async () => {
      submitCaptured('/steer make it shorter');
      stdin.write(ENTER);
      await tick();
    });
    expect(requests).toHaveLength(0);

    // A follow-up real submit carries the committed steer forward — and it appears
    // exactly once (a double-injection would commit the guidance twice).
    await act(async () => {
      submitCaptured('continue');
      await tick();
    });
    expect(requests).toHaveLength(1);
    const steered = requests[0]!.messages.filter((m) => m.content === 'make it shorter');
    expect(steered).toHaveLength(1);
    expect(requests[0]!.messages.map((m) => m.content)).toContain('continue');

    unmount();
  });
});

describe('App /steer interception (mid-turn inject, no model leak)', () => {
  it('routes /steer <text> to the queue without leaking to the model, and carries it into the next submit', async () => {
    const { client, requests } = createRecordingClient();
    const { unmount } = render(<App deps={fakeDeps(client)} />);

    // A typed `/steer <text>` injects via turn.steer — it must NOT start a model turn.
    await act(async () => {
      submitCaptured('/steer go faster');
      await tick();
    });
    expect(requests).toHaveLength(0);

    // A bare `/steer` (no text) is a no-op, also no leak.
    await act(async () => {
      submitCaptured('/steer');
      await tick();
    });
    expect(requests).toHaveLength(0);

    // The committed steer is rendered + carried forward: the NEXT real submit's transcript
    // contains BOTH the steered guidance and the new line.
    await act(async () => {
      submitCaptured('continue');
      await tick();
    });
    expect(requests).toHaveLength(1);
    const contents = requests[0]!.messages.map((m) => m.content);
    expect(contents).toContain('go faster');
    expect(contents).toContain('continue');

    unmount();
  });
});

describe('App slash interception (no model leak)', () => {
  it('never sends leading-/ input to the model client, but still sends normal input', async () => {
    const { client, requests } = createRecordingClient();
    const { unmount } = render(<App deps={fakeDeps(client)} />);

    // A typed `/command` (overlay NOT 'slash') must dispatch locally, never leak.
    await act(async () => {
      submitCaptured('/clear');
      await tick();
    });
    expect(requests).toHaveLength(0);

    // An unknown `/command` is dropped, also never reaching the model.
    await act(async () => {
      submitCaptured('/totally-unknown');
      await tick();
    });
    expect(requests).toHaveLength(0);

    // A normal line still reaches the model exactly once.
    await act(async () => {
      submitCaptured('hello');
      await tick();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)?.content).toBe('hello');

    unmount();
  });
});

describe('App mid-turn submit (type-ahead is preserved, not silently dropped)', () => {
  it('keeps a message typed while a turn is streaming in the composer instead of clearing + dropping it', async () => {
    const { client, requests, release } = createHangingClient();
    const { unmount } = render(<App deps={fakeDeps(client)} />);

    // Start a turn. The hanging stream keeps the controller held, so the turn is
    // genuinely in flight for the mid-turn submit below.
    await act(async () => {
      submitCaptured('first question');
      await tick();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)?.content).toBe('first question');

    // Type-ahead: the user types the next message WHILE the turn streams (the
    // composer is focused at overlay 'none'), then presses Enter.
    await act(async () => {
      changeCaptured('mid-turn message');
      await tick();
    });
    await act(async () => {
      submitCaptured('mid-turn message');
      await tick();
    });

    // turn.submit no-ops while busy, so the model never saw a second turn.
    expect(requests).toHaveLength(1);
    // REGRESSION: pre-fix the composer was cleared (setValue('')) BEFORE that
    // no-op, silently discarding the typed text with no trace. The fix keeps it so
    // the user can resend once the turn settles.
    expect(inputBoxMock.latestProps?.value).toBe('mid-turn message');

    // Release the parked turn so it settles cleanly before unmount.
    await act(async () => {
      release();
      await tick();
    });
    unmount();
  });
});
