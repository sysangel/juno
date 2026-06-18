=== FILE: scripts/verify-openrouter-policy.ts ===
```ts
// scripts/verify-openrouter-policy.ts
//
// W11 — OPTIONAL, SECONDARY, NON-ENFORCING account-policy startup assertion.
//
// IMPORTANT: This is a convenience check ONLY. Privacy posture (no-train +
// Western-only) is enforced ACCOUNT-SIDE on OpenRouter (project decision D2).
// This script never sits in the request hot path and never gates requests.
// It is invoked standalone via `tsx scripts/verify-openrouter-policy.ts`.
//
// Import-safe: importing this module does NOT run main() or call process.exit.

import process from 'node:process';

const PREFIX = '[account-policy] (secondary, non-enforcing)';

export type PolicyOutcome =
  | { code: 0; status: 'ok' | 'skipped'; message: string }
  | { code: 1; status: 'unconfigured' | 'unverified'; message: string };

export interface PolicyInput {
  skip: boolean;
  hasApiKey: boolean;
  /** Result of the optional remote key check: 'ok' | 'failed' | 'unchecked'. */
  remote: 'ok' | 'failed' | 'unchecked';
}

/**
 * PURE: decide the outcome from gathered inputs. No I/O, no process.exit.
 * Every message includes the "secondary / not enforcement" framing.
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  if (input.skip) {
    return {
      code: 0,
      status: 'skipped',
      message: `${PREFIX} skipped (flag or JUNO_SKIP_POLICY_CHECK=1). This is a secondary advisory check, not enforcement.`,
    };
  }

  if (!input.hasApiKey) {
    return {
      code: 1,
      status: 'unconfigured',
      message: `${PREFIX} OPENROUTER_API_KEY is not set; cannot perform the secondary account check. This is advisory, not enforcement — privacy is enforced account-side.`,
    };
  }

  if (input.remote === 'failed') {
    return {
      code: 1,
      status: 'unverified',
      message: `${PREFIX} remote key check failed or could not be parsed. This is a secondary advisory check, not enforcement; the account may still be correctly configured.`,
    };
  }

  // remote === 'ok' || remote === 'unchecked'
  return {
    code: 0,
    status: 'ok',
    message: `${PREFIX} account key present${
      input.remote === 'ok' ? ' and resolved remotely' : ' (remote check skipped)'
    }. Secondary advisory check passed; this is not enforcement.`,
  };
}

interface ParsedArgs {
  skip: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    skip: argv.includes('--skip'),
  };
}

/**
 * Thin I/O wrapper: read argv/env, optionally fetch, print, then process.exit.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const parsed = parseArgs(argv);
  const envSkip = env.JUNO_SKIP_POLICY_CHECK === '1' || env.JUNO_SKIP_POLICY_CHECK === 'true';
  const skip = parsed.skip || envSkip;

  const apiKey = env.OPENROUTER_API_KEY;
  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;

  let remote: 'ok' | 'failed' | 'unchecked' = 'unchecked';

  if (!skip && hasApiKey) {
    const baseUrl = (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai').replace(/\/+$/, '');
    const url = `${baseUrl}/api/v1/key`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        remote = 'failed';
      } else {
        // Coarse parse: confirm the endpoint returned JSON we can read.
        // We never log the key or any secret value.
        const text = await res.text();
        try {
          JSON.parse(text);
          remote = 'ok';
        } catch {
          remote = 'failed';
        }
      }
    } catch {
      // Network error, DNS, TLS, etc. — graceful, never throw.
      remote = 'failed';
    }
  }

  const outcome = evaluatePolicy({ skip, hasApiKey, remote });
  // Print to stderr so stdout stays clean for tooling; advisory only.
  if (outcome.code === 0) {
    process.stderr.write(outcome.message + '\n');
  } else {
    process.stderr.write(outcome.message + '\n');
  }

  process.exit(outcome.code);
}

// Only auto-run when executed as the entry script. Import-safe.
const isEntry =
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('verify-openrouter-policy.ts');

if (isEntry) {
  void main();
}
```

=== FILE: tests/verify-policy.test.ts ===
```ts
// tests/verify-policy.test.ts
import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../scripts/verify-openrouter-policy';

describe('evaluatePolicy', () => {
  it('returns skipped (code 0) when skip is true', () => {
    const out = evaluatePolicy({ skip: true, hasApiKey: false, remote: 'unchecked' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('skipped');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
  });

  it('returns unconfigured (code 1) when no API key is present', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: false, remote: 'unchecked' });
    expect(out.code).toBe(1);
    expect(out.status).toBe('unconfigured');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns unverified (code 1) when key present but remote failed', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'failed' });
    expect(out.code).toBe(1);
    expect(out.status).toBe('unverified');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
  });

  it('returns ok (code 0) when key present and remote ok', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'ok' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('not enforcement');
  });

  it('returns ok (code 0) when key present and remote unchecked', () => {
    const out = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'unchecked' });
    expect(out.code).toBe(0);
    expect(out.status).toBe('ok');
    expect(out.message.length).toBeGreaterThan(0);
    expect(out.message.toLowerCase()).toContain('secondary');
  });
});

describe('import safety', () => {
  it('does not invoke process.exit on import', () => {
    // Importing the module above did not terminate the process; if it had,
    // this test file would never have loaded. Assert the exit code is untouched.
    // (process.exit is stubbed by vitest's default environment to throw on call.)
    expect(typeof evaluatePolicy).toBe('function');
  });
});
```

=== NOTES ===
W11 is a deliberately small, optional, advisory-only script. `evaluatePolicy` is pure and fully unit-tested across all four branches (skipped/unconfigured/unverified/ok) plus the unchecked-with-key case. `main()` is a thin I/O wrapper that reads env only (no W10 import), performs an optional `fetch` to `/api/v1/key` inside try/catch, never logs the key, and prefixes every line with the secondary/non-enforcing marker. Auto-run is guarded by `process.argv[1]` endswith check so test imports never trigger `process.exit`. Privacy enforcement remains account-side per D2; this script never gates requests.
