// src/permissions/policy.ts
// W8 — Interactive, policy-driven permissions.
//
// Headless, pure, synchronous permission gate. Decides whether a tool call may
// run based on remembered rules and the call's risk level. The interactive
// prompt UI lives in a different unit (W4); this module never touches React,
// Ink, the filesystem, the clock, or any global. Only `remember` and `setMode`
// mutate state.

import type { PermissionPolicy } from '../core/contracts';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { matchKey, matchesPattern, normalizePattern } from './patterns';

export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
  /** Permission mode. `acceptEdits` auto-allows write_file/edit_file by name. */
  mode?: 'default' | 'acceptEdits';
  /** Seed patterns to always-allow (stored as 'always-allow-pattern'). */
  allow?: ReadonlyArray<string>;
  /** Seed patterns to deny (stored as 'deny'). Seeded after `allow` so deny wins ties. */
  deny?: ReadonlyArray<string>;
}

/** Decisions that `remember` actually persists ('allow-once' is one-shot). */
type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

/**
 * Tool names that `acceptEdits` mode auto-allows (and that `default` mode would
 * PROMPT for). Deliberately a NAME set, not a risk check: `spawn_subagent` is
 * also `risk:'risky'`, but auto-allowing an unattended nested agent turn is
 * exactly what this gate exists to prevent.
 *
 * Exported so delegating backends (the claude-cli provider) can mirror juno's
 * OWN gate decision onto the CLI's `--allowedTools`/`--disallowedTools` instead
 * of maintaining a parallel hardcoded copy: these are exactly the tools that
 * flip from prompt→auto-allow when the mode is `acceptEdits`.
 */
export const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set<string>([
  'write_file',
  'edit_file',
  'apply_patch',
]);

/**
 * True when the policy carries a DENY rule that targets `name` but is SCOPED to
 * specific call args — a `name:<path-pattern>` that does NOT match the empty-args
 * key `name:`. A delegating backend's grant translation evaluates each MCP tool
 * ONCE with empty args (at spawn time there are no per-call args), so such a rule
 * (e.g. `mcp__fs__read:/etc/*`) would never fire there, and the tool would land
 * UNSCOPED on the child's allowlist — broader authority than juno's live gate
 * grants on real args, and the headless child enforces no per-call scoping of its
 * own. Fail closed: the tool is hard-denied for the whole spawn instead.
 *
 * Only DENY rules need this: an arg-scoped ALLOW/bypass that empty-args
 * evaluation cannot see fire can only make the translation deny MORE than the
 * live gate, never less. A policy without `rules()` (hand-built test fakes)
 * reports no scoped denies — matching its rule-free evaluate behaviour.
 *
 * The single authority shared by BOTH delegating CLI backends (claude-cli and
 * codex-cli) so this fail-closed check can never drift between them.
 */
export function hasArgScopedDenyRule(policy: PermissionPolicy, name: string): boolean {
  for (const { pattern, decision } of policy.rules?.() ?? []) {
    if (decision !== 'deny') {
      continue;
    }
    const normalized = normalizePattern(pattern);
    if (matchesPattern(normalized, `${name}:`)) {
      // Fires on the empty-args key too → the evaluate() call already sees it
      // (and deny wins there), so this rule is not a hidden scope.
      continue;
    }
    // Does the rule's NAME part target this tool? Split at the FIRST ':' — the
    // same separator matchKey uses (tool names cannot contain ':'), guaranteed
    // present after normalizePattern.
    const namePattern = normalized.slice(0, normalized.indexOf(':'));
    if (matchesPattern(`${namePattern}:*`, `${name}:`)) {
      return true;
    }
  }
  return false;
}

class DefaultPermissionPolicy implements PermissionPolicy {
  readonly #autoAllowSafe: boolean;
  #mode: 'default' | 'acceptEdits';
  // normalizedPattern -> stored decision. Last write wins per pattern.
  readonly #rules = new Map<string, StoredDecision>();

  public constructor(opts?: PermissionPolicyOptions) {
    this.#autoAllowSafe = opts?.autoAllowSafe ?? true;
    this.#mode = opts?.mode ?? 'default';
    for (const entry of opts?.initial ?? []) {
      this.remember(entry.pattern, entry.decision);
    }
    // Seed allow FIRST, then deny, so a colliding normalized pattern ends up as
    // 'deny' (last-write-wins per key) and deny precedence is preserved even
    // before the evaluate-time scan enforces it.
    for (const pattern of opts?.allow ?? []) {
      this.remember(pattern, 'always-allow-pattern');
    }
    for (const pattern of opts?.deny ?? []) {
      this.remember(pattern, 'deny');
    }
  }

  public evaluate(
    name: string,
    args: unknown,
    risk: RiskLevel,
  ): 'auto-allow' | 'auto-deny' | 'prompt' {
    const key = matchKey(name, args);

    let matchedDeny = false;
    let matchedAllow = false;
    let matchedBypass = false;
    for (const [pattern, decision] of this.#rules) {
      if (!matchesPattern(pattern, key)) {
        continue;
      }
      switch (decision) {
        case 'deny':
          matchedDeny = true;
          break;
        case 'always-allow-pattern':
          matchedAllow = true;
          break;
        case 'dangerous-bypass':
          matchedBypass = true;
          break;
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    }

    // Order: deny wins over allow/bypass, which win over acceptEdits, which
    // wins over the risk fallback.
    if (matchedDeny) {
      return 'auto-deny';
    }
    if (matchedBypass) {
      return 'auto-allow';
    }
    // STRUCTURAL GUARD: an ordinary always-allow-pattern NEVER satisfies a
    // `dangerous` tool, even when a matching rule exists (e.g. a bare-name rule
    // remembered from the UI for another tool, or a broad seeded pattern). Only
    // an explicit `dangerous-bypass` pre-grants a dangerous call — defense in
    // depth against any UI regression that lets 'a' through for dangerous risk.
    if (matchedAllow && risk !== 'dangerous') {
      return 'auto-allow';
    }

    // acceptEdits auto-allows ONLY the explicit name set, evaluated by tool
    // NAME — never by risk level. spawn_subagent is risky but NOT in the set.
    if (this.#mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(name)) {
      return 'auto-allow';
    }

    switch (risk) {
      case 'safe':
        return this.#autoAllowSafe ? 'auto-allow' : 'prompt';
      case 'risky':
        return 'prompt';
      case 'dangerous':
        // Never silently auto-allowed by risk alone — only an explicit
        // remembered bypass (handled above) pre-grants a dangerous call.
        return 'prompt';
      case 'sandboxed':
        // run_shell whose child is GENUINELY OS-confined (macOS Seatbelt). The OS
        // is the control, so it auto-allows — this is the shell-prompt inversion.
        // The tool ONLY reports 'sandboxed' when its provider is available AND
        // wraps the child; the run()-level fail-closed guard refuses to spawn an
        // unwrapped child, so this can never auto-allow an unconfined command.
        return 'auto-allow';
      default: {
        const exhaustive: never = risk;
        return exhaustive;
      }
    }
  }

  public remember(pattern: string, decision: PermissionDecision): void {
    switch (decision) {
      case 'allow-once':
        // One-shot UI decision; never persisted as a rule.
        return;
      case 'deny':
      case 'always-allow-pattern':
      case 'dangerous-bypass':
        this.#rules.set(normalizePattern(pattern), decision);
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  }

  public setMode(mode: 'default' | 'acceptEdits'): void {
    this.#mode = mode;
  }

  public rules(): ReadonlyArray<{ pattern: string; decision: StoredDecision }> {
    // Patterns are stored normalized (see remember), so consumers can match
    // against matchKey-style `name:path` keys without re-normalizing.
    return [...this.#rules].map(([pattern, decision]) => ({ pattern, decision }));
  }
}

/** Build a permission policy. Callers use this factory, not `new`. */
export function createPermissionPolicy(
  opts?: PermissionPolicyOptions,
): PermissionPolicy {
  return new DefaultPermissionPolicy(opts);
}
