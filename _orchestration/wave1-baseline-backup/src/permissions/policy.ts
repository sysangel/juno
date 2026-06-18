// src/permissions/policy.ts
// W8 — Interactive, policy-driven permissions.
//
// Headless, pure, synchronous permission gate. Decides whether a tool call may
// run based on remembered rules and the call's risk level. The interactive
// prompt UI lives in a different unit (W4); this module never touches React,
// Ink, the filesystem, the clock, or any global. Only `remember` mutates state.

import type { PermissionPolicy } from '../core/contracts';
import type { PermissionDecision, RiskLevel } from '../core/events';
import { matchKey, matchesPattern, normalizePattern } from './patterns';

export interface PermissionPolicyOptions {
  /** If true, 'safe' tools auto-allow without prompting. Default: true. */
  autoAllowSafe?: boolean;
  /** Seed remembered patterns (e.g. from settings). Default: none. */
  initial?: ReadonlyArray<{ pattern: string; decision: PermissionDecision }>;
}

/** Decisions that `remember` actually persists ('allow-once' is one-shot). */
type StoredDecision = Exclude<PermissionDecision, 'allow-once'>;

class DefaultPermissionPolicy implements PermissionPolicy {
  readonly #autoAllowSafe: boolean;
  // normalizedPattern -> stored decision. Last write wins per pattern.
  readonly #rules = new Map<string, StoredDecision>();

  public constructor(opts?: PermissionPolicyOptions) {
    this.#autoAllowSafe = opts?.autoAllowSafe ?? true;
    for (const entry of opts?.initial ?? []) {
      this.remember(entry.pattern, entry.decision);
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
    for (const [pattern, decision] of this.#rules) {
      if (!matchesPattern(pattern, key)) {
        continue;
      }
      switch (decision) {
        case 'deny':
          matchedDeny = true;
          break;
        case 'always-allow-pattern':
        case 'dangerous-bypass':
          matchedAllow = true;
          break;
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    }

    // Order: deny wins over allow/bypass, which win over the risk fallback.
    if (matchedDeny) {
      return 'auto-deny';
    }
    if (matchedAllow) {
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
}

/** Build a permission policy. Callers use this factory, not `new`. */
export function createPermissionPolicy(
  opts?: PermissionPolicyOptions,
): PermissionPolicy {
  return new DefaultPermissionPolicy(opts);
}
