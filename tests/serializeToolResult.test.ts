// tests/serializeToolResult.test.ts
// Wave 12 (rank 14) — the promptText split: serializeToolResult builds the
// `role:'tool'` content the model re-reads. A non-empty promptText on an OK result
// rides VERBATIM; everything else keeps the JSON {ok,data}/{ok,error} shape.
import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_TOOL_RESULT_CHARS,
  serializeToolResult,
  type ToolResultRecord,
} from '../src/agent/turnRunner';

describe('serializeToolResult — promptText split', () => {
  it('promptText present on an OK result → the RAW string (not JSON-wrapped)', () => {
    const record: ToolResultRecord = { ok: true, data: { x: 1 }, promptText: 'HINT: re-read first' };
    expect(serializeToolResult(record)).toBe('HINT: re-read first');
  });

  it('promptText absent → JSON.stringify({ok:true,data})', () => {
    const record: ToolResultRecord = { ok: true, data: { x: 1 } };
    expect(serializeToolResult(record)).toBe(JSON.stringify({ ok: true, data: { x: 1 } }));
  });

  it('whitespace-only promptText → falls back to JSON (never an empty tool content)', () => {
    // An empty/whitespace tool_result content is a hard Anthropic 400 — the guard
    // must reject a blank promptText and keep the JSON payload.
    const record: ToolResultRecord = { ok: true, data: { x: 1 }, promptText: '   \n\t ' };
    expect(serializeToolResult(record)).toBe(JSON.stringify({ ok: true, data: { x: 1 } }));
  });

  it('empty-string promptText → falls back to JSON', () => {
    const record: ToolResultRecord = { ok: true, data: 42, promptText: '' };
    expect(serializeToolResult(record)).toBe(JSON.stringify({ ok: true, data: 42 }));
  });

  it('error result → JSON error shape REGARDLESS of promptText', () => {
    // promptText is honored ONLY on ok results; an error keeps its JSON error shape
    // even if a promptText somehow rode along.
    const record: ToolResultRecord = { ok: false, error: 'boom', promptText: 'ignored' };
    expect(serializeToolResult(record)).toBe(JSON.stringify({ ok: false, error: 'boom' }));
  });
});

describe('serializeToolResult — context budget', () => {
  it('bounds structured results while preserving useful head and tail evidence', () => {
    const value = { head: `BEGIN${'x'.repeat(120_000)}`, tail: `${'y'.repeat(120_000)}END` };
    const serialized = serializeToolResult({ ok: true, data: value });
    expect(serialized.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARS);
    expect(serialized).toContain('BEGIN');
    expect(serialized).toContain('END');
    expect(serialized).toContain('tool result elided to protect context');
  });

  it('fails closed for circular structured results', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(serializeToolResult({ ok: true, data: value })).toContain('not serializable');
  });

  it('also bounds model-facing promptText supplied by a tool hook', () => {
    const serialized = serializeToolResult({ ok: true, data: {}, promptText: 'z'.repeat(200_000) });
    expect(serialized.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_RESULT_CHARS);
  });

  it('honors a smaller remaining per-turn budget', () => {
    const serialized = serializeToolResult({ ok: true, data: 'q'.repeat(20_000) }, 2_000);
    expect(serialized.length).toBeLessThanOrEqual(2_000);
    expect(serialized).toContain('tool result elided to protect context');
  });
});
