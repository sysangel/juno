/**
 * The rendering-relevant CLASS of a backend, derived from a catalog entry's
 * `provider`. juno has three kinds of backend and the UI (and one prompt gate)
 * branch on the kind, not the raw provider id:
 *  - `api`        : a raw-API adapter (openai/openrouter/anthropic) whose tools
 *    juno's OWN executor runs — tool lines are unmarked, and the skills system
 *    prompt applies.
 *  - `claude-cli` : the `claude -p` subprocess — a RENDER-ONLY delegate whose tools
 *    it runs itself and juno merely replays; tool lines are tagged `via claude cli`.
 *  - `codex-cli`  : the `codex exec` subprocess — same render-only delegate shape;
 *    tool lines are tagged `via codex cli`.
 *
 * This replaces the earlier boolean `viaClaudeCli` that was threaded through the
 * transcript components — a boolean cannot distinguish a second delegate CLI.
 */
export type ProviderKind = 'api' | 'claude-cli' | 'codex-cli';

/** Classify a catalog `entry.provider` (undefined → `api`, the unmarked default). */
export function providerKindOf(provider: string | undefined): ProviderKind {
  if (provider === 'claude-cli') return 'claude-cli';
  if (provider === 'codex-cli') return 'codex-cli';
  return 'api';
}

/**
 * The `via <x> cli` marker appended to a replayed tool line for a delegate-CLI
 * backend, or undefined for `api` (juno-executor tools are unmarked). The caller
 * prefixes the ` · ` separator.
 */
export function viaCliLabel(kind: ProviderKind | undefined): string | undefined {
  if (kind === 'claude-cli') return 'via claude cli';
  if (kind === 'codex-cli') return 'via codex cli';
  return undefined;
}
