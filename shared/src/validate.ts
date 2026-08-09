import type { JsonSchema, JsonType, SchemaRegistry } from "./schema.js";
import { refName } from "./schema.js";

export interface ValidationError {
  /** JSONPath-ish location, e.g. `$.items[1].role`. */
  readonly path: string;
  readonly message: string;
}

/**
 * RFC 3339, UTC, millisecond precision — the only instant format on the wire.
 *
 * Deliberately strict about the `Z`. Constraint 5 exists because a fixed UTC
 * offset is a property of an instant rather than of a place, and one that
 * leaks onto the wire survives exactly one DST boundary. Rejecting
 * `-05:00` here is that rule with teeth.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

function matchesType(value: unknown, allowed: JsonType): boolean {
  const actual = typeOf(value);
  if (allowed === "number") return actual === "number" || actual === "integer";
  return actual === allowed;
}

/**
 * Validate `value` against the named schema.
 *
 * Returns every error rather than the first: a contract test that reports one
 * problem per run turns a five-minute fix into five runs.
 */
export function validate(
  registry: SchemaRegistry,
  schemaName: string,
  value: unknown,
): ValidationError[] {
  const root = registry[schemaName];
  if (root === undefined) throw new Error(`Unknown schema: ${schemaName}`);
  const errors: ValidationError[] = [];
  check(registry, root, value, "$", errors);
  return errors;
}

/** `validate`, as an exception. `label` names the thing under test in the message. */
export function validateOrThrow(
  registry: SchemaRegistry,
  schemaName: string,
  value: unknown,
  label?: string,
): void {
  const errors = validate(registry, schemaName, value);
  if (errors.length === 0) return;
  const where = label === undefined ? schemaName : `${label} (${schemaName})`;
  const detail = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
  throw new Error(`${where} does not match the contract:\n${detail}`);
}

function check(
  registry: SchemaRegistry,
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.$ref !== undefined) {
    const target = registry[refName(schema.$ref)];
    if (target === undefined) throw new Error(`Unknown schema: ${refName(schema.$ref)}`);
    check(registry, target, value, path, errors);
    return;
  }

  for (const branch of schema.allOf ?? []) check(registry, branch, value, path, errors);

  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((branch) => {
      const branchErrors: ValidationError[] = [];
      check(registry, branch, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (matching.length === 0) {
      errors.push({ path, message: `no branch of oneOf matched (${schema.oneOf.length} tried)` });
      return;
    }
    if (matching.length > 1) {
      errors.push({ path, message: `${matching.length} branches of oneOf matched; exactly one must` });
      return;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected the constant ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push({ path, message: `not in enum ${JSON.stringify(schema.enum)}` });
    return;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `expected type ${allowed.join(" | ")}, got ${typeOf(value)}` });
      return;
    }
  }

  if (typeof value === "string") checkString(schema, value, path, errors);
  if (typeof value === "number") checkNumber(schema, value, path, errors);
  if (Array.isArray(value)) checkArray(registry, schema, value, path, errors);
  else if (typeof value === "object" && value !== null) {
    checkObject(registry, schema, value as Record<string, unknown>, path, errors);
  }
}

function checkString(
  schema: JsonSchema,
  value: string,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.format === "date-time" && !INSTANT.test(value)) {
    errors.push({
      path,
      message: `expected an RFC 3339 UTC instant with a Z suffix, got ${JSON.stringify(value)}`,
    });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
    errors.push({ path, message: `does not match pattern ${schema.pattern}` });
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
  }
}

function checkNumber(
  schema: JsonSchema,
  value: number,
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `below minimum ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path, message: `above maximum ${schema.maximum}` });
  }
}

function checkArray(
  registry: SchemaRegistry,
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  errors: ValidationError[],
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
  }
  if (schema.items === undefined) return;
  value.forEach((item, index) => {
    check(registry, schema.items as JsonSchema, item, `${path}[${index}]`, errors);
  });
}

function checkObject(
  registry: SchemaRegistry,
  schema: JsonSchema,
  value: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      errors.push({ path: `${path}.${key}`, message: "required property is missing" });
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    check(registry, child, value[key], `${path}.${key}`, errors);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push({ path: `${path}.${key}`, message: "unexpected property" });
      }
    }
  } else if (typeof schema.additionalProperties === "object") {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) continue;
      check(registry, schema.additionalProperties, value[key], `${path}.${key}`, errors);
    }
  }
}
