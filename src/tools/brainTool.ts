// src/tools/brainTool.ts
// The `brain_remember` tool — the DURABLE tier of juno's two-tier memory.
//
// Where remember_fact/recall_facts are session-local scratch (a bounded,
// evictable JSON pad), `brain_remember` writes a permanent memory to the user's
// personal "brain": dedup-guarded, git-committed, and pushed to a PRIVATE
// remote. Because a write publishes to that remote it is risk:'risky' — the
// executor ALWAYS prompts for it (never auto-allowed by risk alone), matching
// how Claude Code sessions gate brain writes.
//
// It is a parent-agent-only capability (registered AFTER the subagent snapshot,
// like the memory + shell tools) and juno-INTERNAL: it has no entry in the
// claude-cli backend's JUNO_TO_CLI_TOOL map, so it is never projected onto that
// backend. The actual write goes through src/services/brainRemember.ts, which
// spawns the brain-remember CLI shell-free and fails into a structured error
// result — a missing/broken brain never crashes the session.
import path from 'node:path';
import type { Tool, ToolCtx, ToolResult, ToolSpec } from '../core/contracts';
import {
  runBrainRemember,
  type BrainRememberInput,
  type BrainRememberOutcome,
} from '../services/brainRemember';
import type { BrainSpawn, TimerHandle } from '../services/brain';

export interface BrainRememberToolDeps {
  /** argv for the brain-remember CLI, spawned WITHOUT a shell. */
  readonly command: readonly string[];
  /** Workspace root — child cwd and the default provenance `project`. */
  readonly cwd: string;
  /** Hard timeout (ms) for the write; the child is killed on expiry. */
  readonly timeoutMs: number;
  // NOTE: no `session` provenance dep. juno's session id is created INSIDE
  // <App> (app.tsx generateSessionId, and it CHANGES on /resume), so it does
  // not exist when the tool registry is wired in cli.ts and there is no live
  // seam to read it later. The brain CLI defaults `session` to "" (the
  // provenance trailer is simply omitted); `project` provenance is real.
  /** Injectable spawn for deterministic tests. Defaults to node:child_process.spawn. */
  readonly spawnImpl?: BrainSpawn;
  /** Injectable scheduler so the timeout is deterministic in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

const brainRememberSpec: ToolSpec = {
  name: 'brain_remember',
  description:
    'Persist a DURABLE fact to the user\'s personal memory ("brain"): dedup-guarded, ' +
    'git-committed, and pushed to a private remote — permanent and shared across all of the ' +
    "user's agents. Use this for stable facts, decisions, and preferences worth keeping beyond " +
    'this session; use remember_fact for throwaway session scratch. A near-duplicate is refused ' +
    '(status "duplicate") unless force=true. This publishes to a remote, so it always requires ' +
    'explicit permission.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fact: {
        type: 'string',
        description:
          'The durable fact as short markdown. Its first sentence becomes the memory description.',
      },
      type: {
        type: 'string',
        enum: [...VALID_TYPES],
        description: 'Memory kind: user | feedback | project | reference. Default: project.',
      },
      name: {
        type: 'string',
        description: 'Optional kebab-slug filename for the memory (else derived from the fact).',
      },
      force: {
        type: 'boolean',
        description: 'Write even if a near-duplicate memory already exists. Default: false.',
      },
    },
    required: ['fact'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Build the `brain_remember` tool over injectable process/clock deps. */
export function createBrainRememberTool(deps: BrainRememberToolDeps): Tool {
  return {
    name: 'brain_remember',
    risk: 'risky',
    spec: brainRememberSpec,
    async run(args: unknown, ctx: ToolCtx): Promise<ToolResult> {
      if (!isRecord(args)) {
        return { ok: false, error: 'invalid args' };
      }
      const fact = stringProp(args, 'fact');
      if (fact === undefined || fact.trim().length === 0) {
        return { ok: false, error: 'invalid args: fact must be a non-empty string' };
      }

      const type = stringProp(args, 'type');
      if (type !== undefined && !(VALID_TYPES as readonly string[]).includes(type)) {
        return { ok: false, error: 'invalid args: type must be user|feedback|project|reference' };
      }
      const name = stringProp(args, 'name');
      const force = args.force === true;

      const input: BrainRememberInput = {
        fact,
        // Provenance: project = workspace basename. No session trailer — see
        // the deps note (juno's session id is not reachable from this seam).
        project: path.basename(deps.cwd),
      };
      if (type !== undefined) {
        input.type = type;
      }
      if (name !== undefined && name.length > 0) {
        input.name = name;
      }
      if (force) {
        input.force = true;
      }

      const outcome: BrainRememberOutcome = await runBrainRemember(
        {
          command: deps.command,
          cwd: deps.cwd,
          timeoutMs: deps.timeoutMs,
          spawnImpl: deps.spawnImpl,
          setTimer: deps.setTimer,
        },
        input,
      );

      if (!outcome.ok) {
        return { ok: false, error: outcome.error };
      }
      // A dedup refusal is not an error — surface the whole result so the model
      // can see status/hint and decide whether to retry with force.
      return { ok: true, data: outcome.result };
    },
  };
}
