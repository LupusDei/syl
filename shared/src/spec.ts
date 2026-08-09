import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import type { JsonSchema, SchemaRegistry } from "./schema.js";

/** Absolute path to the contract. The one source of truth. */
export const OPENAPI_PATH = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

/** Absolute path to the generated WebSocket frame bundle. */
export const WS_SCHEMA_PATH = fileURLToPath(new URL("../schemas/ws.json", import.meta.url));

/** Absolute path to the generated TypeScript types. */
export const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));

/** Absolute path to the fixture directory, shared with the Swift suite. */
export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: { readonly schemas: SchemaRegistry };
}

let cached: OpenApiDocument | undefined;

/** Parse `openapi.yaml`. Cached — it is immutable at runtime. */
export function loadSpec(): OpenApiDocument {
  if (cached === undefined) {
    cached = parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument;
  }
  return cached;
}

export function loadSchemas(): SchemaRegistry {
  return loadSpec().components.schemas;
}

export function schema(name: string): JsonSchema {
  const found = loadSchemas()[name];
  if (found === undefined) throw new Error(`No schema named ${name} in the contract.`);
  return found;
}

/**
 * The two roots of the WebSocket frame universe. `shared/schemas/ws.json` is
 * the transitive closure of these, and nothing else.
 */
export const WS_FRAME_ROOTS = ["WsClientFrame", "WsServerFrame"] as const;
