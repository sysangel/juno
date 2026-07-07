// src/ui/paths.ts
// Small PURE path helpers for the status line's cwd chip. No Node `path`/`os`
// imports so they stay trivially testable and platform-neutral for the POSIX-ish
// paths juno shows; the caller injects `home` (defaults to `$HOME`).

/**
 * Abbreviate a leading home-directory prefix to `~`, Claude-Code style:
 *   abbreviateHome('/Users/a/src/juno', '/Users/a') -> '~/src/juno'
 *   abbreviateHome('/Users/a', '/Users/a')          -> '~'
 *   abbreviateHome('/etc', '/Users/a')              -> '/etc'  (unchanged)
 * A non-boundary prefix match (`/Users/ab` under home `/Users/a`) is NOT rewritten.
 */
export function abbreviateHome(p: string, home: string | undefined = process.env.HOME): string {
  if (home === undefined || home.length === 0) return p;
  const normHome = home.endsWith('/') ? home.slice(0, -1) : home;
  if (p === normHome) return '~';
  if (p.startsWith(`${normHome}/`)) return `~${p.slice(normHome.length)}`;
  return p;
}

/** Trailing path segment, e.g. `basename('~/src/juno')` -> `juno`; `basename('/')` -> `/`. */
export function basename(p: string): string {
  const trimmed = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1) || '/';
}
