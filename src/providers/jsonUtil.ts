// src/providers/jsonUtil.ts
// Shared JSON / tool-argument normalization helpers for the provider adapters.
//
// These were copy-pasted verbatim across all four provider clients
// (openaiCompat, anthropic, claudeCli, codexCli); this module is now the single
// source of truth. Behaviour is byte-for-byte identical to the originals, so
// every client's edge-case handling is preserved:
//   - `parseToolArgs('')` / whitespace-only → `{}` (a no-arg tool call streams
//     as empty text; the executor requires an object);
//   - `parseToolArgs` THROWS on malformed JSON or a non-object (array/scalar),
//     carrying the tool-call index — a broken args blob is a real, surfaced
//     stream error, never silently coerced to empty args;
//   - `asObject` returns the value BY REFERENCE (callers never mutate it) or
//     `undefined` for null / array / non-object;
//   - `parseJsonObject` is the lenient (never-throwing) envelope-line parser.
// codexCli synthesizes its tool args from typed fields, so it does NOT use
// `parseToolArgs`; every client uses the rest.

export type JsonObject = Record<string, unknown>;

/**
 * Strict tool-argument parser for the STREAMED-string call path (the accumulated
 * `partial_json` / `arguments` delta text). Empty / whitespace-only → `{}`;
 * anything that is not a JSON object throws, naming the offending tool-call
 * `index`.
 */
export function parseToolArgs(argsText: string, index: number): unknown {
  if (argsText.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(argsText) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`tool call ${index} arguments were not a JSON object`);
  }

  return parsed;
}

/** A plain object (not null, not an array) BY REFERENCE, else undefined. */
export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/** Lenient JSON-string → object coercion for envelope lines. Never throws. */
export function parseJsonObject(value: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
