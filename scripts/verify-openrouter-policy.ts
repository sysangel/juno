// scripts/verify-openrouter-policy.ts
//
// W11 — OPTIONAL, SECONDARY, NON-ENFORCING account-policy startup assertion.
//
// IMPORTANT: This is a convenience check ONLY. The privacy posture (NO-TRAIN:
// OpenRouter `data_collection: "deny"`) is enforced ACCOUNT-SIDE on OpenRouter
// (project decision D2). This script never sits in the request hot path and
// never gates requests. It is invoked standalone via
// `tsx scripts/verify-openrouter-policy.ts`.
//
// Import-safe: importing this module does NOT run main() or call process.exit().

import process from 'node:process';

const PREFIX = '[account-policy] (secondary, non-enforcing)';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

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
 * Every message carries the "secondary / not enforcement" framing so it can
 * never be mistaken for the (account-side) privacy enforcement.
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
      message: `${PREFIX} NOTICE: OPENROUTER_API_KEY is not set, so the secondary account check cannot run. This is advisory, not enforcement — privacy (no-train) is enforced account-side.`,
    };
  }

  if (input.remote === 'failed') {
    return {
      code: 1,
      status: 'unverified',
      message: `${PREFIX} WARNING: the remote OpenRouter key check did not complete cleanly. This secondary check is advisory, not enforcement; the account may still be correctly configured (no-train) — verify account-side.`,
    };
  }

  // remote === 'ok' || remote === 'unchecked'
  return {
    code: 0,
    status: 'ok',
    message: `${PREFIX} ok: account key present${
      input.remote === 'ok' ? ' and resolved remotely' : ' (remote check skipped)'
    }. This secondary advisory check passed; it is not enforcement — privacy (no-train) remains account-side.`,
  };
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw =
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Thin I/O wrapper: read argv/env, optionally fetch, print, then
 * process.exit(outcome.code). Never throws an unhandled error; never logs the
 * API key or any secret value.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const skip =
    argv.includes('--skip') ||
    env.JUNO_SKIP_POLICY_CHECK === '1' ||
    env.JUNO_SKIP_POLICY_CHECK === 'true';

  const apiKey = env.OPENROUTER_API_KEY;
  const hasApiKey = typeof apiKey === 'string' && apiKey.trim().length > 0;

  let remote: 'ok' | 'failed' | 'unchecked' = 'unchecked';

  if (!skip && hasApiKey) {
    const baseUrl = normalizeBaseUrl(env.OPENROUTER_BASE_URL);
    try {
      // Send the real key in-memory; never print it. Coarse check only:
      // confirm the key resolves and the endpoint returns parseable JSON.
      const res = await fetch(`${baseUrl}/key`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        remote = 'failed';
      } else {
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
  // Advisory only: write to stderr so stdout stays clean for tooling.
  process.stderr.write(outcome.message + '\n');
  process.exit(outcome.code);
}

/**
 * Normalize a path or `file://` URL to a comparable form so the entry-point
 * check is robust across OSes (handles `file://`, Windows drive letters, and
 * backslash vs forward-slash separators).
 */
function normalizeEntryPath(value: string): string {
  let normalized = value;
  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(new URL(normalized).pathname);
  }
  normalized = normalized.replace(/\\/g, '/');
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.toLowerCase();
}

// Only auto-run when executed directly as the entry script. Import-safe: when
// this module is imported (e.g. by the test suite), import.meta.url !==
// process.argv[1], so main() is never invoked.
const invokedPath = process.argv[1];
const isEntryPoint =
  typeof invokedPath === 'string' &&
  normalizeEntryPath(import.meta.url) === normalizeEntryPath(invokedPath);

if (isEntryPoint) {
  main().catch(() => {
    process.stderr.write(
      `${PREFIX} WARNING: unexpected failure in the secondary startup assertion. This is advisory, not enforcement.\n`,
    );
    process.exit(1);
  });
}
