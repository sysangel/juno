# Triad Brief C — juno: wire permission-mode into cli + add the `mode:<m>` status chip

You are writing a focused, correct change to the **juno** TS/Ink codebase. Output the
FULL new contents of three source files plus one new test file. You CANNOT browse the
repo — everything you need is in this brief. These changes consume a FROZEN seam that
two other units provide (the `PermissionPolicyOptions` and `Settings` extensions); do
not redefine those, just consume them as specified.

## Context & frozen seam you CONSUME (already provided by other units — assume present)
1. `src/permissions/policy.ts` `createPermissionPolicy(opts)` now accepts:
   ```ts
   interface PermissionPolicyOptions {
     autoAllowSafe?: boolean;
     initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
     mode?: 'default' | 'acceptEdits';
     allow?: ReadonlyArray<string>;
     deny?: ReadonlyArray<string>;
   }
   ```
2. `src/services/config.ts` `Settings` now has:
   ```ts
   permissionMode?: 'default' | 'acceptEdits';
   permissions?: { allow: string[]; deny: string[] };
   ```

- tsconfig: `strict:true`, `exactOptionalPropertyTypes` OFF, `noUncheckedIndexedAccess` OFF.
- Gate: `npx tsc --noEmit && npx vitest run` (vitest).
- The status-line theme tokens available via `token(name, depth)` include `'warning'`
  and `'info'` (use `'warning'` for the mode chip). NOTE: the token is `'warning'`, not `'warn'`.

## Tasks
### 1. `src/cli.ts` — wire mode + seeded allow/deny into the single shared policy
Change ONLY the `createPermissionPolicy({ autoAllowSafe: true })` call (~line 63) to:
```ts
const policy = createPermissionPolicy({
  autoAllowSafe: true,
  mode: settings.permissionMode,
  allow: settings.permissions?.allow,
  deny: settings.permissions?.deny,
});
```
Everything else in cli.ts stays byte-for-byte identical. (The one shared `policy`
instance already flows to both the executor and `SubagentDeps.policy`, so subagents
inherit the mode — no other change needed.)

### 2. `src/core/selectors.ts` — thread `permissionMode` through the status selector
- Add `permissionMode?: 'default' | 'acceptEdits';` to the `StatusLineState` interface.
- Add `permissionMode?: 'default' | 'acceptEdits';` to the `context` param object of
  `selectStatusLine`, and pass `permissionMode: context.permissionMode` into the
  returned object. No other selector changes.

### 3. `src/ui/StatusLine.tsx` — render the chip
Next to the existing `skills:N` chip, add a `mode:<m>` chip that renders ONLY when the
mode is the non-default `acceptEdits` (keep the default case clean):
```tsx
{status.permissionMode !== undefined && status.permissionMode !== 'default' ? (
  <Text color={token('warning', d)}>mode:{status.permissionMode}</Text>
) : null}
```

### 4. NEW test `tests/permissionMode.ui.test.tsx`
Mirror the existing StatusLine render tests (uses `ink-testing-library`):
```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { selectStatusLine } from '../src/core/selectors';
import { StatusLine } from '../src/ui/StatusLine';
import { initialState } from '../src/core/reducer';
```
Cover:
- `selectStatusLine(initialState(), { permissionMode: 'acceptEdits' }).permissionMode === 'acceptEdits'` (pure passthrough).
- Rendering `<StatusLine>` with an `acceptEdits` status shows `mode:acceptEdits`.
- Rendering with `permissionMode: 'default'` does NOT show `mode:` (chip suppressed).
- Rendering with no `permissionMode` does NOT show `mode:`.
Use `const frame = render(<StatusLine status={status} />).lastFrame() ?? '';` then
`expect(frame).toContain('mode:acceptEdits')` / `expect(frame).not.toContain('mode:')`.
Build the status via `selectStatusLine(initialState(), { model: 'm', cwd: '/w', permissionMode: ... })`.
(Do NOT touch app.tsx — the conductor wires the app-level context separately. Your
test feeds `permissionMode` directly through `selectStatusLine`'s context param.)

## CURRENT FULL CONTENTS — `src/cli.ts`
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
  const policy = createPermissionPolicy({ autoAllowSafe: true });
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

## CURRENT FULL CONTENTS — `src/core/selectors.ts`
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
  context: { model?: string; cwd?: string; maxContext?: number; skills?: ReadonlyArray<string> } = {},
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
  };
}
```

## CURRENT FULL CONTENTS — `src/ui/StatusLine.tsx`
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
      </Box>
      <Box>
        <Text color={token('textDim', d)}>{status.statusText}</Text>
      </Box>
    </Box>
  );
}
```

## Output contract (FOLLOW EXACTLY)
Respond with a SINGLE markdown document. For every file you propose, put a line
`=== FILE: <repo-relative-path> ===` immediately followed by a fenced code block
with the full file contents. After all files, add a `=== NOTES ===` section
(<200 words) on key design choices and the seams you expose/consume. Do NOT write
to the filesystem — output only this document.

Files you must output:
1. `=== FILE: src/cli.ts ===` — full new contents.
2. `=== FILE: src/core/selectors.ts ===` — full new contents.
3. `=== FILE: src/ui/StatusLine.tsx ===` — full new contents.
4. `=== FILE: tests/permissionMode.ui.test.tsx ===` — a NEW standalone vitest file.
