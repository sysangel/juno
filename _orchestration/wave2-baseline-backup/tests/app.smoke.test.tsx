// tests/app.smoke.test.tsx
// W6 — render-smoke for <App>. The hooks (useKeybinds/useTerminalSize via
// useStdout/useInput) are otherwise typecheck-only; mounting <App> under
// ink-testing-library is the only thing that actually EXERCISES that wiring
// (useStdout reads columns/rows, useInput registers a stdin listener).
//
// Deterministic: a fake ModelClient (no network/keys), the real catalog, the
// real headless permission policy, the real file tools, and a fake config
// service over literal Settings. Mirrors cli.ts's dep assembly with fakes.
//
// The placeholder assertion is coupled to INPUT_PLACEHOLDER exported from
// app.tsx, NOT a hardcoded literal — the product name is not finalized, so the
// test tracks the source value.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { App, INPUT_PLACEHOLDER } from '../src/app';
import type { AppDeps } from '../src/app';
import type { ModelClient } from '../src/core/contracts';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import type { ModelEntry } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
    ...overrides,
  };
}

function fakeDeps(settingsOverrides: Partial<Settings> = {}): AppDeps {
  const config = createFakeConfigService(fakeSettings(settingsOverrides));
  return {
    createClient: () => createFakeModelClient({ tickMs: 0 }),
    tools: createDefaultTools(),
    policy: createPermissionPolicy({ autoAllowSafe: true }),
    catalog: createModelCatalog(BUILTIN_MODELS),
    settings: config.get(),
    specs: BUILTIN_TOOL_SPECS,
  };
}

describe('App smoke', () => {
  it('mounts without throwing and renders the InputBox placeholder', () => {
    const deps = fakeDeps();

    let frame: string | undefined;
    expect(() => {
      const { lastFrame } = render(<App deps={deps} />);
      frame = lastFrame() ?? '';
    }).not.toThrow();

    // Coupled to the SOURCE constant, not a literal product name.
    expect(frame).toContain(INPUT_PLACEHOLDER);
  });
});

describe('App client factory — cross-provider routing (Wave 1A regression)', () => {
  // The build-once bug: the client was built ONCE from the default catalog entry,
  // so selecting an entry from a DIFFERENT provider sent a foreign slug to the
  // FIRST provider's endpoint. The fix builds the client from the SELECTED
  // (resolved) entry's provider. These tests prove the provider handed to
  // createClient follows the resolved entry, not a hardcoded default.
  function depsWith(
    settingsOverrides: Partial<Settings>,
    built: string[],
  ): AppDeps {
    const createClient = (entry: ModelEntry): ModelClient => {
      built.push(entry.provider);
      return createFakeModelClient({ tickMs: 0 });
    };
    return { ...fakeDeps(settingsOverrides), createClient };
  }

  it('builds the client for the resolved entry provider, not a hardcoded default', () => {
    const built: string[] = [];
    // Default model resolves to an ANTHROPIC entry. Pre-fix, the client would
    // have been pinned to whatever the first/default provider was.
    render(<App deps={depsWith({ defaultModel: 'claude-sonnet-4-20250514' }, built)} />);
    expect(built[0]).toBe('anthropic');
  });

  it('routes an openrouter entry to the openrouter provider', () => {
    const built: string[] = [];
    render(<App deps={depsWith({ defaultModel: 'anthropic/claude-sonnet-4' }, built)} />);
    expect(built[0]).toBe('openrouter');
    expect(built).not.toContain('openai');
  });

  it('an openai default still routes to openai', () => {
    const built: string[] = [];
    render(<App deps={depsWith({ defaultModel: 'gpt-4.1' }, built)} />);
    expect(built[0]).toBe('openai');
  });
});

describe('App client factory — RUNTIME picker swap rebuilds the client (Wave 1 dependency tripwire)', () => {
  // The Wave-1 fix is `useMemo(() => deps.createClient(resolvedEntry), [deps, selectedId])`
  // in app.tsx: the client is REBUILT whenever the model-picker swaps `selectedId`,
  // so the next turn dispatches against the SELECTED entry's provider endpoint.
  //
  // The earlier tests in this file only assert the provider at INITIAL render and would
  // NOT catch a regression that drops `selectedId` from that dependency array — without
  // `selectedId`, the memo would never recompute on a picker swap and the client would
  // stay pinned to the startup provider. This test drives the ACTUAL UI seam (the real
  // useInput/useKeybinds stdin path) to perform a runtime swap and asserts createClient
  // is invoked AGAIN with the NEW provider. Drop `selectedId` from the deps array and this
  // test goes RED.
  //
  // ink-testing-library attaches the useInput stdin listener on the first effect flush, so
  // a key written synchronously right after render() is dropped — await a macrotask tick
  // first (mirrors components.test.tsx's `tick`).
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  // Ink key byte sequences (see node_modules/ink/build/parse-keypress.js + use-input.js):
  const DOWN = '[B'; // key.downArrow
  const ENTER = '\r'; // key.return

  function depsRecording(
    settingsOverrides: Partial<Settings>,
    built: string[],
  ): AppDeps {
    const createClient = (entry: ModelEntry): ModelClient => {
      built.push(entry.provider);
      return createFakeModelClient({ tickMs: 0 });
    };
    return { ...fakeDeps(settingsOverrides), createClient };
  }

  it('rebuilds the client for the newly-selected provider after a runtime model-picker swap', async () => {
    const built: string[] = [];
    // Startup default is an OPENAI entry → the first build records 'openai'.
    const { stdin, unmount } = render(
      <App deps={depsRecording({ defaultModel: 'gpt-4.1' }, built)} />,
    );

    expect(built).toEqual(['openai']);

    // Let useInput register its stdin listener (dropped if written synchronously).
    await tick();

    // Drive the real UI seam, all via stdin → useKeybinds:
    //   overlay 'none':  '/'   → open slash menu (commands: clear, model, mode)
    //   overlay 'slash': DOWN  → move selection clear(0) → model(1)
    //                    ENTER → accept 'model' → openModelPicker()
    //   overlay 'model-picker': DOWN×2 → moveModel(+1) twice over BUILTIN_MODELS:
    //       gpt-4.1(openai,0) → gpt-4.1-mini(openai,1) → claude-sonnet-4(anthropic,2)
    // Each moveModel sets a new selectedId, so the [deps, selectedId] memo rebuilds
    // the client for the now-selected ANTHROPIC entry.
    await act(async () => {
      stdin.write('/');
      await tick();
    });
    await act(async () => {
      stdin.write(DOWN);
      await tick();
    });
    await act(async () => {
      stdin.write(ENTER);
      await tick();
    });
    await act(async () => {
      stdin.write(DOWN);
      await tick();
    });
    await act(async () => {
      stdin.write(DOWN);
      await tick();
    });

    // TRIPWIRE: the client was rebuilt for the newly-selected provider. With
    // `selectedId` dropped from the useMemo deps, the memo never recomputes on the
    // swap and this stays ['openai'] → the test fails.
    expect(built).toContain('anthropic');

    unmount();
  });
});
