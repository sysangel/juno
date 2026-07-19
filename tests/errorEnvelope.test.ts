// tests/errorEnvelope.test.ts
// Wave 14 (a5-error-envelope) — pure unit coverage for the normalized provider-error
// envelope + its three classifier entry points. No I/O.
import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyMessage,
  classifyThrown,
  envelope,
  type ProviderErrorKind,
} from '../src/core/errorEnvelope';

const RETRYABLE_KINDS = new Set<ProviderErrorKind>(['network', 'timeout', 'rate-limit']);

describe('envelope() — retryability is derived from kind (single source of truth)', () => {
  const ALL_KINDS: ProviderErrorKind[] = [
    'network',
    'timeout',
    'rate-limit',
    'context-overflow',
    'auth',
    'tool',
    'child-exit',
    'unknown',
  ];

  it('sets retryable === (kind in {network,timeout,rate-limit}) for every kind', () => {
    for (const kind of ALL_KINDS) {
      const env = envelope(kind);
      expect(env.kind).toBe(kind);
      expect(env.retryable).toBe(RETRYABLE_KINDS.has(kind));
    }
  });

  it('includes stderrTail ONLY when a non-empty string is passed', () => {
    expect(envelope('child-exit', 'boom on stderr').stderrTail).toBe('boom on stderr');
    // Absent (not empty-string) when omitted or empty.
    expect(Object.hasOwn(envelope('child-exit'), 'stderrTail')).toBe(false);
    expect(Object.hasOwn(envelope('child-exit', ''), 'stderrTail')).toBe(false);
  });
});

describe('classifyHttpStatus', () => {
  it('429 → rate-limit (retryable)', () => {
    expect(classifyHttpStatus(429)).toEqual({ kind: 'rate-limit', retryable: true });
  });

  it('401 / 403 → auth (not retryable)', () => {
    expect(classifyHttpStatus(401)).toEqual({ kind: 'auth', retryable: false });
    expect(classifyHttpStatus(403)).toEqual({ kind: 'auth', retryable: false });
  });

  it('500 / 503 → network (retryable)', () => {
    expect(classifyHttpStatus(500)).toEqual({ kind: 'network', retryable: true });
    expect(classifyHttpStatus(503)).toEqual({ kind: 'network', retryable: true });
  });

  it('400 (no body) / 404 → unknown (not retryable)', () => {
    expect(classifyHttpStatus(400)).toEqual({ kind: 'unknown', retryable: false });
    expect(classifyHttpStatus(404)).toEqual({ kind: 'unknown', retryable: false });
  });

  it('400 with a context-overflow body → context-overflow (not retryable)', () => {
    expect(classifyHttpStatus(400, 'prompt is too long: 200000 tokens')).toEqual({
      kind: 'context-overflow',
      retryable: false,
    });
  });

  it('429 stays rate-limit even when a body is present (status buckets after context check)', () => {
    expect(classifyHttpStatus(429, 'rate limited, slow down')).toEqual({ kind: 'rate-limit', retryable: true });
  });
});

describe('classifyThrown', () => {
  it("Error with name 'StreamStallError' → timeout", () => {
    const e = new Error('idle timeout after 60000ms');
    e.name = 'StreamStallError';
    expect(classifyThrown(e)).toEqual({ kind: 'timeout', retryable: true });
  });

  it("'installed' does NOT read as 'stall' → unknown, not timeout", () => {
    // Word-boundary guard: 'installed'.includes('stall') is true, so a bare substring
    // check would wrongly mark this deterministic failure retryable 'timeout'.
    expect(classifyThrown(new Error('claude CLI is not installed'))).toEqual({
      kind: 'unknown',
      retryable: false,
    });
  });

  it("Error('fetch failed') → network", () => {
    expect(classifyThrown(new Error('fetch failed'))).toEqual({ kind: 'network', retryable: true });
  });

  it('an Error carrying a Node ECONNRESET code → network', () => {
    const e = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyThrown(e)).toEqual({ kind: 'network', retryable: true });
  });

  it("Error('spawn codex ENOENT') → child-exit", () => {
    expect(classifyThrown(new Error('spawn codex ENOENT'))).toEqual({ kind: 'child-exit', retryable: false });
  });

  it("Error('prompt is too long') → context-overflow", () => {
    expect(classifyThrown(new Error('prompt is too long'))).toEqual({
      kind: 'context-overflow',
      retryable: false,
    });
  });

  it("Error('weird') → unknown", () => {
    expect(classifyThrown(new Error('weird'))).toEqual({ kind: 'unknown', retryable: false });
  });

  it('a non-Error string → unknown', () => {
    expect(classifyThrown('some string')).toEqual({ kind: 'unknown', retryable: false });
  });
});

describe('classifyMessage', () => {
  it("'codex stream stalled (idle timeout after 60000ms)' → timeout", () => {
    expect(classifyMessage('codex stream stalled (idle timeout after 60000ms)')).toEqual({
      kind: 'timeout',
      retryable: true,
    });
  });

  it("'installed' does NOT read as 'stall' → unknown, not timeout", () => {
    expect(classifyMessage('claude CLI is not installed')).toEqual({
      kind: 'unknown',
      retryable: false,
    });
  });

  it("the HUMANIZED codex stall message still classifies as retryable timeout (keeps 'stall')", () => {
    // Wave 14 (a5-idle-guard) humanized onStall to 'codex stalled: no output for Ns
    // (…)'. This pins the load-bearing invariant: the word 'stalled' must survive so
    // /\bstall/ yields the retryable timeout envelope — the humanization must not
    // silently regress the classification.
    const env = classifyMessage('codex stalled: no output for 60s (waiting for the first response)');
    expect(env.kind).toBe('timeout');
    expect(env.retryable).toBe(true);
  });

  it("'codex exited with code 1: segfault' → child-exit", () => {
    expect(classifyMessage('codex exited with code 1: segfault')).toEqual({
      kind: 'child-exit',
      retryable: false,
    });
  });

  it("'claude killed by signal SIGKILL' → child-exit", () => {
    expect(classifyMessage('claude killed by signal SIGKILL')).toEqual({
      kind: 'child-exit',
      retryable: false,
    });
  });

  it("contains '429' / 'rate limit' → rate-limit", () => {
    expect(classifyMessage('provider request failed: 429 Too Many Requests').kind).toBe('rate-limit');
    expect(classifyMessage('you hit the rate limit').kind).toBe('rate-limit');
  });

  it("'unauthorized' → auth", () => {
    expect(classifyMessage('request was unauthorized')).toEqual({ kind: 'auth', retryable: false });
  });

  it('passes a non-empty stderrTail through to the envelope', () => {
    const env = classifyMessage('codex exited with code 1', 'tail of stderr');
    expect(env.kind).toBe('child-exit');
    expect(env.stderrTail).toBe('tail of stderr');
  });
});
