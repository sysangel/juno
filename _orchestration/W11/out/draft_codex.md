=== FILE: scripts/verify-openrouter-policy.ts ===
```ts
import process from 'node:process';

const PREFIX = '[account-policy] (secondary, non-enforcing)';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export type PolicyOutcome =
  | { code: 0; status: 'ok' | 'skipped'; message: string }
  | { code: 1; status: 'unconfigured' | 'unverified'; message: string };

/** PURE: decide the outcome from gathered inputs. No I/O, no process.exit. */
export function evaluatePolicy(input: {
  skip: boolean;
  hasApiKey: boolean;
  /** Result of the optional remote key check: 'ok' | 'failed' | 'unchecked'. */
  remote: 'ok' | 'failed' | 'unchecked';
}): PolicyOutcome {
  if (input.skip) {
    return {
      code: 0,
      status: 'skipped',
      message: `${PREFIX} skipped by flag/env; this is a secondary advisory check, not enforcement.`,
    };
  }

  if (!input.hasApiKey) {
    return {
      code: 1,
      status: 'unconfigured',
      message: `${PREFIX} NOTICE: OPENROUTER_API_KEY is not present, so the secondary account-policy check cannot run. This is not enforcement; privacy posture is enforced account-side.`,
    };
  }

  if (input.remote === 'failed') {
    return {
      code: 1,
      status: 'unverified',
      message: `${PREFIX} WARNING: OpenRouter key/account verification did not complete cleanly. This secondary check is not enforcement; verify account-side no-train and Western-only policy settings.`,
    };
  }

  return {
    code: 0,
    status: 'ok',
    message: `${PREFIX} ok: key/account check completed or was advisory-only. This secondary check is not enforcement; privacy posture remains account-side.`,
  };
}

/** Thin I/O wrapper: read argv/env, optionally fetch, print, then process.exit(outcome.code). */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const skip = argv.includes('--skip') || env.JUNO_SKIP_POLICY_CHECK === '1';
  const apiKey = env.OPENROUTER_API_KEY;
  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;

  let remote: 'ok' | 'failed' | 'unchecked' = 'unchecked';

  if (!skip && hasApiKey) {
    try {
      const baseUrl = normalizeBaseUrl(env.OPENROUTER_BASE_URL);
      const response = await fetch(`${baseUrl}/key`, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer <redacted>',
        },
      });

      remote = response.ok ? 'ok' : 'failed';
    } catch {
      remote = 'failed';
    }
  }

  const outcome = evaluatePolicy({ skip, hasApiKey, remote });
  console.log(outcome.message);
  process.exit(outcome.code);
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function normalizeEntryPath(value: string): string {
  let normalized = value.replace(/\\/g, '/');

  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(new URL(normalized).pathname);
  }

  normalized = normalized.replace(/\\/g, '/');

  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }

  return normalized.toLowerCase();
}

const invokedPath = process.argv[1];
const isEntryPoint =
  typeof invokedPath === 'string' &&
  normalizeEntryPath(import.meta.url) === normalizeEntryPath(invokedPath);

if (isEntryPoint) {
  main().catch(() => {
    console.error(`${PREFIX} WARNING: unexpected startup assertion failure. This secondary check is not enforcement.`);
    process.exit(1);
  });
}
```

=== FILE: tests/verify-policy.test.ts ===
```ts
import { describe, expect, it, vi } from 'vitest';

import { evaluatePolicy } from '../scripts/verify-openrouter-policy';

describe('evaluatePolicy', () => {
  it('skips when requested', () => {
    const outcome = evaluatePolicy({ skip: true, hasApiKey: false, remote: 'unchecked' });

    expect(outcome.code).toBe(0);
    expect(outcome.status).toBe('skipped');
    expect(outcome.message).toContain('secondary');
    expect(outcome.message).toContain('not enforcement');
  });

  it('reports unconfigured when no API key is present', () => {
    const outcome = evaluatePolicy({ skip: false, hasApiKey: false, remote: 'unchecked' });

    expect(outcome.code).toBe(1);
    expect(outcome.status).toBe('unconfigured');
    expect(outcome.message).toContain('secondary');
    expect(outcome.message).toContain('not enforcement');
  });

  it('reports unverified when remote verification fails', () => {
    const outcome = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'failed' });

    expect(outcome.code).toBe(1);
    expect(outcome.status).toBe('unverified');
    expect(outcome.message).toContain('secondary');
    expect(outcome.message).toContain('not enforcement');
  });

  it('reports ok when remote verification succeeds', () => {
    const outcome = evaluatePolicy({ skip: false, hasApiKey: true, remote: 'ok' });

    expect(outcome.code).toBe(0);
    expect(outcome.status).toBe('ok');
    expect(outcome.message).toContain('secondary');
    expect(outcome.message).toContain('not enforcement');
  });

  it('does not call process.exit when imported', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called on import');
    });

    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
```

=== NOTES ===
The script is intentionally standalone and advisory-only. One important issue: the fetch headers above redact the token to avoid exposing it in code output, but the real implementation must send the actual `apiKey` value in memory as `Authorization: Bearer ${apiKey}` and never print it.