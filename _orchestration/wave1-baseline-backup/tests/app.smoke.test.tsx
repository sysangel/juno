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
import { render } from 'ink-testing-library';
import { App, INPUT_PLACEHOLDER } from '../src/app';
import type { AppDeps } from '../src/app';
import { createFakeModelClient } from '../src/core/fakeClient';
import { createPermissionPolicy } from '../src/permissions/policy';
import { createFakeConfigService } from '../src/services/config';
import type { Settings } from '../src/services/config';
import { BUILTIN_MODELS, createModelCatalog } from '../src/services/catalog';
import { BUILTIN_TOOL_SPECS, createDefaultTools } from '../src/tools/registry';

function fakeSettings(): Settings {
  return {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4.1',
    cwd: '/work',
    maxContext: 200_000,
  };
}

function fakeDeps(): AppDeps {
  const config = createFakeConfigService(fakeSettings());
  return {
    client: createFakeModelClient({ tickMs: 0 }),
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
