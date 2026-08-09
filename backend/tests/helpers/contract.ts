import type { Express } from "express";

import { loadSchemas, loadSpec, validateOrThrow } from "@syl/shared";

/**
 * The contract, read at runtime, so a live response can be measured against it.
 *
 * `shared/tests/` already proves the **mock** serves the spec, and it proves it
 * structurally: the mock derives its routing table from `openapi.yaml`, so it
 * cannot serve a path the spec does not have or miss one it does. That is a
 * strong guarantee about the mock and no guarantee at all about Syl. Both
 * clients were written against the mock; if the real service disagrees with the
 * spec, every one of those tests still passes.
 *
 * So the checks here read the same YAML and point it at a real socket.
 */

const HTTP_METHODS: readonly string[] = ["get", "post", "put", "patch", "delete"];

/** One operation in the contract, reduced to what a live probe needs. */
export interface SpecOperation {
  readonly operationId: string;
  /** Upper-case. */
  readonly method: string;
  /** The spec's template, e.g. `/reminders/{reminderId}`. */
  readonly template: string;
  /** `false` only where the operation declares `security: []`. */
  readonly requiresAuth: boolean;
  /** The success status the spec documents. */
  readonly successStatus: number;
  /**
   * The schema name the success envelope's `data` must match, or `null` when
   * the operation returns no body.
   */
  readonly dataSchema: string | null;
}

interface RawOperation {
  readonly operationId?: string;
  readonly security?: readonly unknown[];
  readonly responses?: Readonly<Record<string, RawResponse>>;
}

interface RawResponse {
  readonly content?: {
    readonly "application/json"?: { readonly schema?: RawSchema };
  };
}

interface RawSchema {
  readonly $ref?: string;
  readonly allOf?: readonly RawSchema[];
  readonly properties?: Readonly<Record<string, RawSchema>>;
}

/** `#/components/schemas/Reminder` -> `Reminder`. */
function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/**
 * Find the `data` schema inside a success response.
 *
 * Every one is spelled the same way in this contract — `allOf: [OkEnvelope,
 * { properties: { data: { $ref } } }]` — so this walks that shape rather than
 * being told the answer per operation. A response documented some other way
 * returns `null` and is reported as unprobeable rather than silently skipped.
 */
function dataSchemaOf(schema: RawSchema | undefined): string | null {
  if (schema === undefined) return null;
  for (const branch of schema.allOf ?? []) {
    const ref = branch.properties?.["data"]?.$ref;
    if (ref !== undefined) return refName(ref);
  }
  return schema.$ref === undefined ? null : refName(schema.$ref);
}

let cached: readonly SpecOperation[] | undefined;

/** Every operation the contract publishes. */
export function specOperations(): readonly SpecOperation[] {
  if (cached !== undefined) return cached;

  const operations: SpecOperation[] = [];
  for (const [template, methods] of Object.entries(loadSpec().paths)) {
    for (const [method, raw] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method)) continue;
      // Safe assertion: the shape is re-tested field by field below, and an
      // operation without an `operationId` is skipped.
      const operation = raw as RawOperation;
      if (operation.operationId === undefined) continue;

      const responses = operation.responses ?? {};
      const successCode =
        Object.keys(responses).find((code) => code.startsWith("2")) ?? "200";

      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        template,
        // `security: []` is how the spec spells "no token needed". Absent means
        // the document-level `bearerAuth` applies.
        requiresAuth: !(Array.isArray(operation.security) && operation.security.length === 0),
        successStatus: Number(successCode),
        dataSchema: dataSchemaOf(responses[successCode]?.content?.["application/json"]?.schema),
      });
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  cached = operations;
  return cached;
}

/** One operation by id. Throws rather than returning undefined. */
export function operation(operationId: string): SpecOperation {
  const found = specOperations().find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`No operation named ${operationId} in the contract.`);
  return found;
}

/**
 * One route Express will actually dispatch, as `METHOD /path`.
 *
 * Express's own spelling — `:todoId` — normalised to the contract's `{todoId}`
 * so the two vocabularies can be compared as sets.
 */
export type MountedRoute = string;

/** Express 5's router internals, named only as far as this walk needs them. */
interface RouterLayer {
  readonly route?: {
    readonly path?: unknown;
    readonly methods?: Readonly<Record<string, boolean>>;
  };
  readonly handle?: { readonly stack?: readonly RouterLayer[] };
}

/** `/todos/:todoId` -> `/todos/{todoId}`. */
function toTemplate(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, "{$1}");
}

/**
 * Every route the built app will dispatch, read out of Express itself.
 *
 * The **reverse** of `specOperations()`, and the reason both exist: a contract
 * check that only walks the spec catches a published endpoint nobody
 * implemented, and is completely blind to an implemented endpoint nobody
 * published. Syl has both kinds today (`syl-c1m`, `syl-21u`), which is what
 * settled the argument that one direction was enough.
 *
 * Mount prefixes are deliberately **not** reconstructed. `createApp` mounts
 * exactly one router, at the contract's base path, and says in its own comment
 * that this is so a later route cannot land outside it — so a layer's path
 * inside that router is already contract-relative. A second mount point would
 * show up here as a route whose bare path the contract does not declare, which
 * is the failure worth having rather than a false pass.
 *
 * @throws if the walk finds nothing. An introspection helper that quietly
 * returns an empty set turns every assertion built on it green forever, which
 * is precisely the class of vacuous test this file exists to prevent.
 */
export function mountedRoutes(app: Express): readonly MountedRoute[] {
  const found = new Set<MountedRoute>();

  const walk = (layers: readonly RouterLayer[] | undefined): void => {
    for (const layer of layers ?? []) {
      const path = layer.route?.path;
      if (typeof path === "string") {
        for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
          // Express marks a `.get()` route as also answering HEAD. That is
          // Express's business, not the contract's.
          if (enabled && method !== "head" && method !== "_all") {
            found.add(`${method.toUpperCase()} ${toTemplate(path)}`);
          }
        }
      }
      walk(layer.handle?.stack);
    }
  };

  // Safe assertion: Express 5 exposes its root router as `app.router`; the
  // shape is re-tested field by field by the walk, and an empty result throws.
  const root = (app as unknown as { router?: { stack?: readonly RouterLayer[] } }).router;
  walk(root?.stack);

  if (found.size === 0) {
    throw new Error(
      "Walked the Express app and found no routes. Express's router internals have moved; " +
        "fix this helper rather than letting every route check pass vacuously.",
    );
  }
  return [...found].sort();
}

/**
 * Fill a path template with real ids.
 *
 * Values are URI-encoded because Syl's ids contain colons.
 */
export function fillPath(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`No value for path parameter ${name}.`);
    return encodeURIComponent(value);
  });
}

/**
 * Assert a live response is the contract's success envelope, and that its
 * `data` matches the schema the spec names for that operation.
 *
 * Both halves matter. A body that is `{ success: true, data: ... }` with the
 * wrong `data` is exactly the drift that produced Adjutant's two late bugs;
 * a correct `data` in a bare body is a client crash at the envelope peel.
 */
export async function expectConformingSuccess<T>(
  response: Response,
  operationId: string,
): Promise<T> {
  const spec = operation(operationId);
  const body: unknown = await response.json();

  const schemas = loadSchemas();
  validateOrThrow(schemas, "OkEnvelope", body, `${operationId} envelope`);

  if (response.status !== spec.successStatus) {
    throw new Error(
      `${operationId} answered ${String(response.status)}; the contract documents ` +
        `${String(spec.successStatus)}. Body: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  /**
   * `data` is checked for *presence* here rather than left to the schema.
   *
   * Two things make that necessary and neither is obvious. `OkEnvelope` is
   * `required: [success]` only — the `required: [data]` lives in the second
   * branch of each operation's `allOf`, which this function does not evaluate.
   * And `validate` in `@syl/shared` reports **no errors at all** for
   * `undefined` against an object schema: its `typeOf` returns `"object"` for
   * `undefined`, while the `checkObject` call is guarded on
   * `typeof value === "object"`, which `undefined` fails. So the value falls
   * between the two and nothing looks at it.
   *
   * Without this check, a route that answered `{ "success": true }` with no
   * payload would pass every assertion in this file and hand the caller
   * `undefined` typed as `T` — the precise failure a conformance helper exists
   * to make impossible. See `syl-cgt`.
   */
  if (!(typeof body === "object" && body !== null && Object.hasOwn(body, "data"))) {
    throw new Error(
      `${operationId} answered a success envelope with no \`data\`. ` +
        `Body: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  // Safe assertion: guarded immediately above.
  const data = (body as { data: unknown }).data;
  if (data === undefined) {
    throw new Error(`${operationId} answered with \`data: undefined\`.`);
  }
  if (spec.dataSchema !== null) {
    validateOrThrow(schemas, spec.dataSchema, data, `${operationId} data`);
  }
  return data as T;
}

/** Assert a live response is the contract's failure envelope with `code`. */
export async function expectConformingFailure(
  response: Response,
  code: string,
): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  const schemas = loadSchemas();
  validateOrThrow(schemas, "ErrorEnvelope", body, `failure (${code})`);

  // Safe assertion: `ErrorEnvelope` validated above.
  const error = (body as { error: Record<string, unknown> }).error;
  if (error["code"] !== code) {
    throw new Error(
      `expected error code ${code}, got ${String(error["code"])}: ${String(error["message"])}`,
    );
  }
  return error;
}
