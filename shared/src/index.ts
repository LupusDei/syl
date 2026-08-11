/**
 * `@syl/shared` — the API contract, as one import.
 *
 * ```ts
 * import type { Reminder, WsServerFrame } from "@syl/shared";
 * import { validateOrThrow, loadSchemas, fixture } from "@syl/shared";
 * ```
 *
 * Everything under `types` is GENERATED from `shared/openapi.yaml`. Do not
 * hand-edit it; run `npm run contract:generate` and commit the result. The
 * drift gate in `tests/drift.test.ts` fails `npm test` if the two disagree,
 * so a spec change that was not regenerated cannot reach a squad.
 */

/** Every wire type in Syl. Generated. */
export * from "./types.js";

/** Runtime validation against the contract, for the seam where JSON becomes a type. */
export { validate, validateOrThrow } from "./validate.js";
export type { ValidationError } from "./validate.js";

/** The parsed spec, for anything that needs the schemas at runtime. */
export {
  FIXTURES_DIR,
  loadSchemas,
  loadSpec,
  OPENAPI_PATH,
  schema,
  TYPES_PATH,
  WS_FRAME_ROOTS,
  WS_SCHEMA_PATH,
} from "./spec.js";
export type { OpenApiDocument } from "./spec.js";

export type { JsonSchema, JsonType, SchemaRegistry } from "./schema.js";
export { reachableSchemas, refName } from "./schema.js";

/**
 * The shared fixtures — the artefact both the TypeScript and Swift suites
 * decode. A spec both sides ignore is decoration; a fixture both sides must
 * decode is a gate.
 */
export {
  fixture,
  FIXTURE_NAMES,
  fixtureEntries,
  fixtureNames,
  loadFixture,
  readFixtureFile,
} from "./fixtures.js";
export type { FixtureEntry, FixtureEnvelope, FixtureName } from "./fixtures.js";
