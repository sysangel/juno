=== FILE: src/cli.ts ===
```ts
#!/usr/bin/env -S tsx
// src/cli.ts
// W6 — the `juno` entry point. Parses --help/--version (preserving the W1
// behavior), else builds the real deps (config, catalog, client, policy, tools)
// and renders <App deps=... />.
//
// Windows note: npm's global bin shim invokes `node`, which cannot run .ts
// directly. Use `npm start` / `tsx src/cli.ts`. See docs/DECISIONS.md.
import { createElement } from 'react';
import { render } from 'ink';
import { App } from './app';
import type { AppDeps } from './app';
import { createPermissionPolicy } from './permissions/policy';
import { createModelClient } from './providers';
import { createConfigService } from './services/config';
import { BUILTIN_MODELS, createModelCatalog, type ModelEntry } from './services/catalog';
import { createDefaultTools } from './tools/registry';
import { assembleSystemPrompt, createSkillsService } from './services/skills';
import { loadAgentDefinitions } from './services/agents';

const HELP = `juno — terminal agent UI

Usage:
  juno              launch the TUI
  juno --help       show this help
  juno --version    print version
`;

function versionFromEnv(env: NodeJS.ProcessEnv): string {
  return env.npm_package_version ?? '0.0.0';
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`juno ${versionFromEnv(env)}\n`);
    return;
  }

  const config = createConfigService({ env });
  const settings = config.get();
  const catalog = createModelCatalog(BUILTIN_MODELS);
  const model = catalog.resolve(settings.defaultModel) ?? catalog.default();

  if (model === undefined) {
    process.stderr.write('juno: no model is configured.\n');
    process.exitCode = 1;
    return;
  }

  // One shared policy (the executor AND every sub-agent use it, so remembered
  // allow-patterns persist) and one client factory (App + sub-agents share it).
  // Factory: build a client for whichever entry the picker selects. Provider
  // config is keyed on the SELECTED entry's provider (not the frozen default),
  // so selecting a cross-provider entry routes to its own endpoint.
  const policy = createPermissionPolicy({
    autoAllowSafe: true,
    mode: settings.permissionMode,
    allow: settings.permissions?.allow,
    deny: settings.permissions?.deny,
  });
  const createClient = (entry: ModelEntry) =>
    createModelClient(entry, {
      provider: settings.providers?.[entry.provider],
      env,
      fetchImpl: fetch,
    });

  // Discover skills (~/.claude/skills + <cwd>/.claude/skills) and sub-agent
  // definitions (.claude/agents) once at startup. Skill names+descriptions go
  // into the (raw-API) system prompt; `load_skill` reads bodies on demand;
  // `spawn_subagent` runs fresh nested turns. Tools + specs are derived from ONE
  // built array so the model's tool specs always match the registered tools.
  const skillsService = createSkillsService({ cwd: settings.cwd });
  const skills = skillsService.list();
  const systemPrompt = assembleSystemPrompt(skills);
  const agents = loadAgentDefinitions({ cwd: settings.cwd });
  const tools = createDefaultTools({
    skills: skillsService,
    subagent: { createClient, catalog, policy, defaultModel: settings.defaultModel, agents },
  });
  const specs = tools.map((tool) => tool.spec);

  const deps: AppDeps = {
    createClient,
    tools,
    policy,
    catalog,
    settings,
    specs,
    systemPrompt,
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
  };

  render(createElement(App, { deps }));
}

// Run main() only when invoked directly (works under tsx `.ts` and a built `.js`).
const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (invokedPath !== undefined && /(?:^|\/)(?:cli|juno)\.(?:ts|js)$/.test(invokedPath)) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`juno: ${message}\n`);
    process.exit(1);
  });
}
```

=== FILE: src/core/selectors.ts ===
```ts
// src/core/selectors.ts
// W3-PROPOSED — pure derived-state helpers for the StatusLine (W4 consumes).
// No React/Ink imports; pure functions over State. Flagged as proposed in NOTES.
import type { State } from './reducer';

export interface TokenBar {
  in: number;
  out: number;
  total: number;
}

export interface StatusLineState {
  model: string;
  cwd: string;
  tokens: TokenBar;
  /** Fraction of the context window used, clamped to [0, 1]. */
  contextFraction: number;
  effort: State['effort'];
  overlay: State['overlay'];
  phase: State['phase'];
  statusText: string;
  pendingPermissionToolCallId: string | null;
  /** Names of the skills available this session (render-only indicator). */
  skills?: ReadonlyArray<string>;
  permissionMode?: 'default' | 'acceptEdits';
}

export function selectTokenBar(state: State): TokenBar {
  return { in: state.tokens.in, out: state.tokens.out, total: state.tokens.in + state.tokens.out };
}

/** Context-bar fraction. `max` defaults to a placeholder until config supplies the real window. */
export function selectContextFraction(state: State, max = 128000): number {
  if (max <= 0) return 0;
  return Math.min(1, (state.tokens.in + state.tokens.out) / max);
}

export function selectEffort(state: State): State['effort'] {
  return state.effort;
}

export function selectOverlay(state: State): State['overlay'] {
  return state.overlay;
}

export function selectPhase(state: State): State['phase'] {
  return state.phase;
}

export function selectPendingPermission(state: State): string | null {
  return state.pendingPermissionToolCallId;
}

/** Human-readable status for the StatusLine, derived purely from phase. */
export function selectStatusText(state: State): string {
  switch (state.phase) {
    case 'idle':
      return 'idle';
    case 'streaming':
      return 'thinking…';
    case 'awaiting-permission':
      return 'awaiting permission';
    case 'running-tool':
      return 'running tool…';
    case 'error':
      return state.errorMessage ?? 'error';
  }
}

/**
 * Bundle for the StatusLine. `model`/`cwd` are runtime/config concerns the UI
 * passes in (the reducer doesn't own them), with safe placeholders.
 */
export function selectStatusLine(
  state: State,
  context: {
    model?: string;
    cwd?: string;
    maxContext?: number;
    skills?: ReadonlyArray<string>;
    permissionMode?: 'default' | 'acceptEdits';
  } = {},
): StatusLineState {
  return {
    model: context.model ?? 'fake',
    cwd: context.cwd ?? '.',
    tokens: selectTokenBar(state),
    contextFraction: selectContextFraction(state, context.maxContext),
    effort: state.effort,
    overlay: state.overlay,
    phase: state.phase,
    statusText: selectStatusText(state),
    pendingPermissionToolCallId: state.pendingPermissionToolCallId,
    skills: context.skills,
    permissionMode: context.permissionMode,
  };
}
```

=== FILE: src/ui/StatusLine.tsx ===
```tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusLineState } from '../core/selectors';
import { detectColorDepth, token, type ColorDepth } from './theme';
import { EffortBadge } from './EffortBadge';

const DEPTH: ColorDepth = detectColorDepth();
const BAR_WIDTH = 10;

export interface StatusLineProps {
  status: StatusLineState;
  depth?: ColorDepth;
}

/** Render a 0..1 fraction as a bracketed bar, e.g. `[####------]`. */
function contextBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * BAR_WIDTH);
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}]`;
}

export function StatusLine({ status, depth }: StatusLineProps): ReactElement {
  const d = depth ?? DEPTH;
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={token('border', d)} paddingLeft={1} paddingRight={1}>
      <Box gap={1}>
        <Text color={token('accent', d)} bold>
          {status.model}
        </Text>
        <Text color={token('textDim', d)}>{status.cwd}</Text>
        <Text color={token('text', d)}>tok:{status.tokens.total}</Text>
        <Text color={token('accent', d)}>{contextBar(status.contextFraction)}</Text>
        <EffortBadge effort={status.effort} depth={d} />
        {status.skills !== undefined && status.skills.length > 0 ? (
          <Text color={token('info', d)}>skills:{status.skills.length}</Text>
        ) : null}
        {status.permissionMode !== undefined && status.permissionMode !== 'default' ? (
          <Text color={token('warning', d)}>mode:{status.permissionMode}</Text>
        ) : null}
      </Box>
      <Box>
        <Text color={token('textDim', d)}>{status.statusText}</Text>
      </Box>
    </Box>
  );
}
```

=== FILE: tests/permissionMode.ui.test.tsx ===
```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { selectStatusLine } from '../src/core/selectors';
import { StatusLine } from '../src/ui/StatusLine';
import { initialState } from '../src/core/reducer';

describe('permission mode status line', () => {
  it('passes permissionMode through selectStatusLine', () => {
    expect(selectStatusLine(initialState(), { permissionMode: 'acceptEdits' }).permissionMode).toBe('acceptEdits');
  });

  it('renders the acceptEdits mode chip', () => {
    const status = selectStatusLine(initialState(), { model: 'm', cwd: '/w', permissionMode: 'acceptEdits' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';

    expect(frame).toContain('mode:acceptEdits');
  });

  it('suppresses the mode chip for default mode', () => {
    const status = selectStatusLine(initialState(), { model: 'm', cwd: '/w', permissionMode: 'default' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';

    expect(frame).not.toContain('mode:');
  });

  it('suppresses the mode chip when permissionMode is absent', () => {
    const status = selectStatusLine(initialState(), { model: 'm', cwd: '/w' });
    const frame = render(<StatusLine status={status} />).lastFrame() ?? '';

    expect(frame).not.toContain('mode:');
  });
});
```

=== NOTES ===

This consumes the provided seams without redefining them: `cli.ts` now passes `settings.permissionMode` plus seeded `allow`/`deny` lists into the single shared permission policy, so executor and subagents inherit the same policy instance.

The status selector treats `permissionMode` as runtime context, matching `model`, `cwd`, and `skills`. The UI only renders a warning-colored chip for the non-default `acceptEdits` mode, keeping default and absent modes visually quiet.