// tests/schemaValidate.test.ts — Wave 14 (b6-boundary-honesty): the pure,
// dependency-free draft-07-subset validator shared by input-schema validation
// (executor boundary) and the optional output-schema pin. Covers the fail-open
// contract, each enforced keyword, nested recursion, unknown-keyword ignoring,
// multi-error collection, and both model-facing formatters.
import { describe, expect, it } from 'vitest';
import {
  validateAgainstSchema,
  formatInputValidationError,
  formatOutputValidationError,
  type SchemaError,
} from '../src/tools/schemaValidate';

describe('validateAgainstSchema — fail-open on non-interpretable schemas', () => {
  it('a non-object schema always passes (undefined / true / string / number / array)', () => {
    for (const schema of [undefined, true, false, 'x', 42, [1, 2], null]) {
      expect(validateAgainstSchema(schema, { anything: 1 })).toEqual({ ok: true });
      expect(validateAgainstSchema(schema, 'whatever')).toEqual({ ok: true });
    }
  });

  it('an empty object schema passes any value (no keywords to enforce)', () => {
    expect(validateAgainstSchema({}, {})).toEqual({ ok: true });
    expect(validateAgainstSchema({}, { a: 1, b: 2 })).toEqual({ ok: true });
    expect(validateAgainstSchema({}, 'string')).toEqual({ ok: true });
  });

  it('a bare {type:"object"} schema passes any object (loose/test fixtures)', () => {
    expect(validateAgainstSchema({ type: 'object' }, {})).toEqual({ ok: true });
    expect(validateAgainstSchema({ type: 'object' }, { extra: 'ok' })).toEqual({ ok: true });
  });
});

describe('validateAgainstSchema — required', () => {
  it('flags a missing required property by name', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const check = validateAgainstSchema(schema, {});
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'path', message: 'is required' }]);
    }
  });

  it('passes when the required property is present', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    expect(validateAgainstSchema(schema, { path: 'a.txt' })).toEqual({ ok: true });
  });
});

describe('validateAgainstSchema — type', () => {
  it('flags a wrong-typed field with expected/got', () => {
    const schema = { type: 'object', properties: { dir: { type: 'string' } } };
    const check = validateAgainstSchema(schema, { dir: 42 });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'dir', message: 'expected string, got number' }]);
    }
  });

  it('maps integer and number to a JS number; array/null distinguished from object', () => {
    expect(validateAgainstSchema({ type: 'integer' }, 3)).toEqual({ ok: true });
    expect(validateAgainstSchema({ type: 'number' }, 3.5)).toEqual({ ok: true });
    expect(validateAgainstSchema({ type: 'array' }, [1])).toEqual({ ok: true });
    const nullCheck = validateAgainstSchema({ type: 'object' }, null);
    expect(nullCheck.ok).toBe(false);
    if (!nullCheck.ok) expect(nullCheck.errors[0]?.message).toBe('expected object, got null');
    const arrCheck = validateAgainstSchema({ type: 'object' }, [1, 2]);
    expect(arrCheck.ok).toBe(false);
    if (!arrCheck.ok) expect(arrCheck.errors[0]?.message).toBe('expected object, got array');
  });

  it('a top-level type mismatch does not also emit spurious property/required errors', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    const check = validateAgainstSchema(schema, 'not an object');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: '', message: 'expected object, got string' }]);
    }
  });
});

describe('validateAgainstSchema — additionalProperties', () => {
  it('false rejects an undeclared key', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' } },
    };
    const check = validateAgainstSchema(schema, { path: 'a', bogus: 1 });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'bogus', message: 'is not an allowed property' }]);
    }
  });

  it('allows extras when additionalProperties is absent or true', () => {
    const absent = { type: 'object', properties: { path: { type: 'string' } } };
    expect(validateAgainstSchema(absent, { path: 'a', extra: 1 })).toEqual({ ok: true });
    const openTrue = { type: 'object', additionalProperties: true, properties: { path: { type: 'string' } } };
    expect(validateAgainstSchema(openTrue, { path: 'a', extra: 1 })).toEqual({ ok: true });
  });
});

describe('validateAgainstSchema — enum', () => {
  it('rejects a value outside the enum and lists the choices', () => {
    const schema = { enum: ['a', 'b', 'c'] };
    const check = validateAgainstSchema(schema, 'z');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: '', message: 'must be one of [a, b, c]' }]);
    }
  });

  it('accepts a value inside the enum', () => {
    expect(validateAgainstSchema({ enum: ['a', 'b'] }, 'b')).toEqual({ ok: true });
  });

  it('enforces an enum nested under a property (dotted path)', () => {
    const schema = { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } } };
    const check = validateAgainstSchema(schema, { mode: 'medium' });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'mode', message: 'must be one of [fast, slow]' }]);
    }
  });
});

describe('validateAgainstSchema — nested properties recursion', () => {
  it('recurses into nested objects with dotted paths', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { field: { type: 'string' } },
          required: ['field'],
        },
      },
      required: ['nested'],
    };
    const check = validateAgainstSchema(schema, { nested: { field: 7 } });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'nested.field', message: 'expected string, got number' }]);
    }
  });

  it('reports a missing nested required field with a dotted path', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] },
      },
    };
    const check = validateAgainstSchema(schema, { nested: {} });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toEqual([{ path: 'nested.field', message: 'is required' }]);
    }
  });
});

describe('validateAgainstSchema — unknown keywords are ignored per-keyword', () => {
  it('never rejects on an unsupported keyword (minLength / items / format / oneOf / $ref)', () => {
    expect(validateAgainstSchema({ type: 'string', minLength: 5 }, 'hi')).toEqual({ ok: true });
    expect(
      validateAgainstSchema({ type: 'array', items: { type: 'string' } }, [1, 2, 3]),
    ).toEqual({ ok: true });
    expect(validateAgainstSchema({ format: 'email' }, 'not-an-email')).toEqual({ ok: true });
    expect(validateAgainstSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }, true)).toEqual({
      ok: true,
    });
    expect(validateAgainstSchema({ $ref: '#/definitions/x' }, { anything: 1 })).toEqual({ ok: true });
  });

  it('enforces the supported keywords even alongside ignored ones', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string', minLength: 3 } },
      required: ['path'],
      // an unsupported top-level keyword must not affect the verdict
      patternProperties: { '^x': {} },
    };
    // minLength ignored (short string OK), but the missing required field still fires.
    const check = validateAgainstSchema(schema, {});
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.errors).toEqual([{ path: 'path', message: 'is required' }]);
  });
});

describe('validateAgainstSchema — collects ALL errors', () => {
  it('reports every failure in one pass (missing + wrong-typed + extra)', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' }, count: { type: 'number' } },
      required: ['path'],
    };
    const check = validateAgainstSchema(schema, { count: 'nope', extra: true });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.errors).toContainEqual({ path: 'path', message: 'is required' });
      expect(check.errors).toContainEqual({ path: 'extra', message: 'is not an allowed property' });
      expect(check.errors).toContainEqual({ path: 'count', message: 'expected number, got string' });
      expect(check.errors).toHaveLength(3);
    }
  });
});

describe('formatInputValidationError', () => {
  it('names each field, instructs a retry, and echoes redacted args', () => {
    const errors: SchemaError[] = [
      { path: 'path', message: 'is required' },
      { path: 'dir', message: 'expected string, got number' },
    ];
    const msg = formatInputValidationError('read_file', errors, { dir: 5 });
    expect(msg).toContain('Invalid arguments for tool "read_file":');
    expect(msg).toContain('  - path: is required');
    expect(msg).toContain('  - dir: expected string, got number');
    expect(msg).toContain("Fix the arguments to match the tool's input schema and call it again.");
    expect(msg).toContain('Received: {"dir":5}');
  });

  it('truncates an oversized arg echo with an ellipsis', () => {
    const big = { blob: 'x'.repeat(500) };
    const msg = formatInputValidationError('t', [{ path: 'a', message: 'is required' }], big);
    const received = msg.slice(msg.indexOf('Received: ') + 'Received: '.length);
    expect(received.endsWith('…')).toBe(true);
    expect(received.length).toBeLessThan(210);
  });

  it('degrades an unserializable arg echo to a marker', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const msg = formatInputValidationError('t', [{ path: 'a', message: 'is required' }], circular);
    expect(msg).toContain('Received: [unserializable]');
  });
});

describe('formatOutputValidationError', () => {
  it('describes a result-shape mismatch as a tool defect', () => {
    const msg = formatOutputValidationError('spawn_subagent', [
      { path: 'summary', message: 'expected string, got number' },
    ]);
    expect(msg).toContain('Tool "spawn_subagent" returned a result that does not match its declared output schema:');
    expect(msg).toContain('  - summary: expected string, got number');
    expect(msg).toContain('(this is a tool defect, not an argument problem)');
  });
});
