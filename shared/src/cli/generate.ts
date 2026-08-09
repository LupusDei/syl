import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { renderTypes, renderWsJsonSchema } from "../generate.js";
import { loadSchemas, TYPES_PATH, WS_FRAME_ROOTS, WS_SCHEMA_PATH } from "../spec.js";

/** `npm run contract:generate` — rewrite every generated artifact from the spec. */
const schemas = loadSchemas();

const outputs: readonly (readonly [string, string])[] = [
  [TYPES_PATH, renderTypes(schemas)],
  [WS_SCHEMA_PATH, renderWsJsonSchema(schemas, WS_FRAME_ROOTS)],
];

for (const [path, contents] of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  process.stdout.write(`wrote ${path}\n`);
}
