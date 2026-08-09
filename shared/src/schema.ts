/**
 * The slice of JSON Schema the contract actually uses.
 *
 * Deliberately not "all of JSON Schema". The spec is hand-authored and the
 * validator below is the thing three codebases trust, so the honest move is to
 * support a small, named subset and fail loudly on anything outside it —
 * rather than to silently ignore a keyword and report a document valid because
 * we never looked at the constraint.
 */

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: JsonType | readonly JsonType[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly description?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly summary?: string;
}

export type SchemaRegistry = Readonly<Record<string, JsonSchema>>;

/** `#/components/schemas/Message` -> `Message`. Throws on any other form. */
export function refName(ref: string): string {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    throw new Error(
      `Unsupported $ref ${JSON.stringify(ref)}: the contract only uses local component refs.`,
    );
  }
  return ref.slice(prefix.length);
}

/**
 * Every schema name reachable from `roots`, including the roots.
 *
 * Used to carve the WebSocket frame subset out of the single schema registry.
 * One registry means a frame shape can only be changed in one place; the
 * closure is what lets `schemas/ws.json` still be a self-contained document.
 */
export function reachableSchemas(registry: SchemaRegistry, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];

  const visitNode = (node: JsonSchema): void => {
    if (node.$ref !== undefined) queue.push(refName(node.$ref));
    if (node.items !== undefined) visitNode(node.items);
    if (typeof node.additionalProperties === "object") visitNode(node.additionalProperties);
    for (const child of node.allOf ?? []) visitNode(child);
    for (const child of node.oneOf ?? []) visitNode(child);
    for (const child of Object.values(node.properties ?? {})) visitNode(child);
  };

  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) continue;
    const node = registry[name];
    if (node === undefined) throw new Error(`Unknown schema referenced: ${name}`);
    seen.add(name);
    visitNode(node);
  }

  // Registry order, not discovery order: a stable output keeps the generated
  // files diff-free when an unrelated schema moves.
  return Object.keys(registry).filter((name) => seen.has(name));
}
