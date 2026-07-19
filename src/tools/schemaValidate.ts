// src/tools/schemaValidate.ts
// Wave 14 (b6-boundary-honesty) — a PURE, dependency-free validator for the
// draft-07 subset every juno built-in tool ships plus the useful subset of MCP
// server schemas: `type`, `properties`, `required`, `enum`, `additionalProperties`.
//
// It is deliberately MINIMAL and FAIL-OPEN. A schema it cannot interpret (not a
// plain object, or carrying keywords outside the covered set) is never a rejection:
// unknown keywords are ignored PER-KEYWORD, so partial validation is safe
// validation. The one job is to turn a structurally-malformed tool call (missing a
// required field, a wrong-typed field, an extra key under a closed schema) into a
// single, actionable, model-facing error at the executor boundary — instead of the
// bare "invalid args" each tool used to hand back.
//
// Shared by the input-validation step (executor validates args against
// `tool.spec.inputSchema`) and the optional output-schema pin (executor validates
// `result.data` against a tool's `outputSchema`).

/** One validation failure: a dotted path into the value plus a human message. */
export interface SchemaError {
  path: string;
  message: string;
}

/** A validation outcome: ok, or a non-empty list of collected errors. */
export type SchemaCheck = { ok: true } | { ok: false; errors: SchemaError[] };

/** True for a non-null, non-array object (a JSON "object"). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema-ish type name of a runtime value, for `expected X, got Y` messages. */
function typeNameOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Does `value` satisfy a JSON-Schema `type` keyword? Unrecognized type strings
 * (an exotic/loose schema) are treated as a match — fail-open per keyword. */
function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** Compose a dotted child path (`''` root → `dir` → `nested.field`). */
function childPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

/** Recurse one level of the covered draft-07 subset, collecting ALL errors. */
function validate(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: SchemaError[],
): void {
  // type — enforced only when it is a plain string keyword.
  const type = schema.type;
  if (typeof type === 'string' && !typeMatches(type, value)) {
    errors.push({ path, message: `expected ${type}, got ${typeNameOf(value)}` });
  }

  // enum — value must be one of the listed literals.
  const enumSchema = schema.enum;
  if (Array.isArray(enumSchema)) {
    const values = enumSchema as unknown[];
    if (!values.includes(value)) {
      errors.push({ path, message: `must be one of [${values.join(', ')}]` });
    }
  }

  // Object-shaped checks (required / additionalProperties / properties recursion)
  // apply only when the value really is an object; a type error above already
  // reported the mismatch, so we skip these to avoid piling on nonsensical noise.
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  const hasObjectShape = type === 'object' || properties !== undefined;
  if (!hasObjectShape || !isPlainObject(value)) {
    return;
  }

  // required — each declared name must be present on the value.
  if (Array.isArray(schema.required)) {
    for (const name of schema.required as unknown[]) {
      if (typeof name === 'string' && !(name in value)) {
        errors.push({ path: childPath(path, name), message: 'is required' });
      }
    }
  }

  // additionalProperties:false — every value key must be a declared property.
  if (schema.additionalProperties === false && properties !== undefined) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push({ path: childPath(path, key), message: 'is not an allowed property' });
      }
    }
  }

  // properties — recurse into each declared property PRESENT on the value. An
  // absent property is only an error when `required` (handled above).
  if (properties !== undefined) {
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in value && isPlainObject(subSchema)) {
        validate(subSchema, value[key], childPath(path, key), errors);
      }
    }
  }
}

/**
 * Validate `value` against `schema` (the covered draft-07 subset). FAIL-OPEN:
 * a non-plain-object schema (undefined, `true`, a complex/exotic MCP schema)
 * always returns `{ ok: true }`. Collects every error so the model gets the full
 * list in one shot.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): SchemaCheck {
  if (!isPlainObject(schema)) {
    return { ok: true };
  }
  const errors: SchemaError[] = [];
  validate(schema, value, '', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** JSON.stringify `args`, truncated to ~200 chars, for the re-entry echo. Never
 * throws — a circular/unserializable value degrades to a marker. */
function redactArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return '[unserializable]';
  }
  const text = json ?? String(args);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Render collected errors as the ` - path: message` block both formatters share. */
function errorLines(errors: SchemaError[]): string {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}

/**
 * The model-facing re-entry string for an INPUT-schema failure: names each bad
 * field, tells the model to fix its arguments and call again, and echoes a
 * redacted copy of what it sent. Flows the plain terminal error path (a red ✗
 * failure — a malformed call IS a failure), never the neutral declined/aborted
 * markers.
 */
export function formatInputValidationError(
  toolName: string,
  errors: SchemaError[],
  args: unknown,
): string {
  return (
    `Invalid arguments for tool "${toolName}":\n${errorLines(errors)}\n` +
    `Fix the arguments to match the tool's input schema and call it again. ` +
    `Received: ${redactArgs(args)}`
  );
}

/**
 * The model-facing string for an OUTPUT-schema failure: a tool returned a result
 * that does not match its declared output schema. Marked as a tool defect (not an
 * argument problem) so the model does not try to "fix" its call.
 */
export function formatOutputValidationError(toolName: string, errors: SchemaError[]): string {
  return (
    `Tool "${toolName}" returned a result that does not match its declared output schema:\n` +
    `${errorLines(errors)}\n(this is a tool defect, not an argument problem)`
  );
}
