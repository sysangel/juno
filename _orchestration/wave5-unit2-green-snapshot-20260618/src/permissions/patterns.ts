// src/permissions/patterns.ts
// W8 — pure, deterministic pattern-matching helpers for the permission policy.
//
// No I/O, no side effects, no clock, no randomness. Every export is TOTAL:
// it never throws on odd inputs.

/**
 * Compute a stable match-key for a tool call. The key is `${name}:${salient}`
 * where `salient` is the `path` (or `dir` fallback) read from `args` when
 * `args` is a non-null object and the field is a string. Otherwise the salient
 * portion is the empty string. Never throws.
 */
export function matchKey(name: string, args: unknown): string {
  return `${name}:${salientPath(args)}`;
}

/**
 * Normalize a remembered/queried pattern: a bare tool-name pattern (no `:`)
 * is treated as `tool:*` so it matches any call to that tool.
 */
export function normalizePattern(pattern: string): string {
  return pattern.includes(':') ? pattern : `${pattern}:*`;
}

/**
 * Glob match: `*` matches any run of characters; all other regex
 * metacharacters are escaped. The match is anchored to the full string
 * (`^…$`). A bare tool-name pattern (no `:`) is normalized to `tool:*` first,
 * so it matches any call to that tool. Total: never throws.
 */
export function matchesPattern(pattern: string, key: string): boolean {
  const normalized = normalizePattern(pattern);

  if (normalized === key) {
    return true;
  }

  // Split on '*' so each literal segment is regex-escaped, then rejoin the
  // wildcards as '[\s\S]*'. This keeps '*' as the ONLY glob metacharacter AND
  // makes it match ANY run of characters incl. line terminators — so a
  // `deny tool:*` rule cannot be evaded by an arg containing '\n' (a bare '.*'
  // would not cross newlines, silently degrading a deny to a prompt).
  const source = normalized.split('*').map(escapeRegExp).join('[\\s\\S]*');

  return new RegExp(`^${source}$`).test(key);
}

function salientPath(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }

  const record = args as Record<string, unknown>;
  const pathVal = record['path'];
  if (typeof pathVal === 'string') {
    return pathVal;
  }
  const dirVal = record['dir'];
  if (typeof dirVal === 'string') {
    return dirVal;
  }
  return '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
