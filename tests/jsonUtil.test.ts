// tests/jsonUtil.test.ts
//
// Table-driven coverage for the shared provider JSON / tool-argument helpers
// (src/providers/jsonUtil.ts). The cases below are the UNION of the edge-case
// behaviour that used to live, copy-pasted, in the four provider clients
// (openaiCompat, anthropic, claudeCli, codexCli):
//   - parseToolArgs: the STREAMED tool-call args path (the accumulated
//     `partial_json` / `arguments` delta text) — '' / whitespace-only → {}, a
//     JSON object passes through, and any non-object (array/scalar) or malformed
//     blob throws (non-object errors carry the tool-call index).
//   - asObject / parseJsonObject / stringField / numberField: the ENVELOPE-line
//     parse path — lenient, never-throwing coercion of stdout / SSE JSON lines.
//   - errorMessage: the uniform error-to-string used on every failure path.
import { describe, it, expect } from 'vitest';
import {
  asObject,
  errorMessage,
  numberField,
  parseJsonObject,
  parseToolArgs,
  stringField,
  type JsonObject,
} from '../src/providers/jsonUtil';

describe('parseToolArgs (streamed tool-call args)', () => {
  const valid: Array<[label: string, input: string, expected: unknown]> = [
    ['empty string → {}', '', {}],
    ['whitespace-only → {}', '   ', {}],
    ['flat object', '{"a":1}', { a: 1 }],
    ['nested object + array values', '{"nested":{"b":2},"arr":[1,2]}', { nested: { b: 2 }, arr: [1, 2] }],
  ];
  it.each(valid)('parses %s', (_label, input, expected) => {
    expect(parseToolArgs(input, 0)).toEqual(expected);
  });

  const nonObject: Array<[label: string, input: string, index: number]> = [
    ['array', '[1,2]', 3],
    ['number', '42', 7],
    ['string', '"str"', 1],
    ['boolean true', 'true', 0],
    ['null literal', 'null', 5],
  ];
  it.each(nonObject)('throws naming the tool-call index for a %s', (_label, input, index) => {
    // The non-object error carries the offending call's `index` verbatim.
    expect(() => parseToolArgs(input, index)).toThrow(`tool call ${index} arguments were not a JSON object`);
  });

  it('throws a SyntaxError (from JSON.parse) on a malformed blob', () => {
    expect(() => parseToolArgs('{bad', 0)).toThrow(SyntaxError);
  });

  it('returns the parsed object itself for the object path', () => {
    const result = parseToolArgs('{"a":1}', 2);
    expect(typeof result).toBe('object');
    expect(result).toEqual({ a: 1 });
  });
});

describe('asObject', () => {
  const cases: Array<[label: string, input: unknown, isObject: boolean]> = [
    ['empty object', {}, true],
    ['populated object', { a: 1 }, true],
    ['array', [], false],
    ['null', null, false],
    ['number', 42, false],
    ['string', 'x', false],
    ['boolean', true, false],
  ];
  it.each(cases)('%s', (_label, input, isObject) => {
    if (isObject) {
      // Returned BY REFERENCE — never re-wrapped or cloned.
      expect(asObject(input)).toBe(input as JsonObject | undefined);
    } else {
      expect(asObject(input)).toBeUndefined();
    }
  });
});

describe('parseJsonObject (lenient envelope-line parse, never throws)', () => {
  const cases: Array<[label: string, input: string, expected: JsonObject | undefined]> = [
    ['object literal', '{"a":1}', { a: 1 }],
    ['array', '[1]', undefined],
    ['scalar number', '42', undefined],
    ['empty string', '', undefined],
    ['malformed', '{bad', undefined],
  ];
  it.each(cases)('%s', (_label, input, expected) => {
    expect(parseJsonObject(input)).toEqual(expected);
  });
});

describe('stringField', () => {
  const cases: Array<[label: string, obj: JsonObject, key: string, expected: string | undefined]> = [
    ['string value', { k: 'v' }, 'k', 'v'],
    ['non-string value', { k: 1 }, 'k', undefined],
    ['missing key', {}, 'k', undefined],
  ];
  it.each(cases)('%s', (_label, obj, key, expected) => {
    expect(stringField(obj, key)).toBe(expected);
  });
});

describe('numberField', () => {
  const cases: Array<[label: string, obj: JsonObject, key: string, expected: number | undefined]> = [
    ['number value', { k: 1 }, 'k', 1],
    ['non-number value', { k: '1' }, 'k', undefined],
    ['missing key', {}, 'k', undefined],
  ];
  it.each(cases)('%s', (_label, obj, key, expected) => {
    expect(numberField(obj, key)).toBe(expected);
  });
});

describe('errorMessage', () => {
  const cases: Array<[label: string, input: unknown, expected: string]> = [
    ['Error instance', new Error('boom'), 'boom'],
    ['plain string', 'plain', 'plain'],
    ['number', 42, '42'],
    ['plain object', {}, '[object Object]'],
  ];
  it.each(cases)('%s', (_label, input, expected) => {
    expect(errorMessage(input)).toBe(expected);
  });
});
