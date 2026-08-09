import { loadSpec } from "../spec.js";

/**
 * The mock's routing table, derived from `openapi.yaml` rather than
 * hand-written.
 *
 * This is the difference between a mock that claims to serve the contract and
 * one that provably does: add a path to the spec without a handler for it and
 * `tests/mock-server.test.ts` fails, because the route table and the handler
 * map are checked against each other. A hand-maintained list drifts silently,
 * and the squads building against it discover the gap as a 404 they assume is
 * their own bug.
 */

export const API_BASE = "/api/v1";

/** The WebSocket endpoint, mounted under the same base. */
export const WS_PATH = `${API_BASE}/ws`;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export interface RouteDef {
  readonly operationId: string;
  /** Upper-case HTTP method. */
  readonly method: string;
  /** The spec's path template, e.g. `/reminders/{reminderId}`. */
  readonly template: string;
  readonly paramNames: readonly string[];
  readonly pattern: RegExp;
  /** True when the spec requires an `Idempotency-Key` header. */
  readonly idempotent: boolean;
}

let cached: readonly RouteDef[] | undefined;

/** Every operation in the contract, most specific first. */
export function specRoutes(): readonly RouteDef[] {
  if (cached !== undefined) return cached;

  const routes: RouteDef[] = [];
  for (const [template, operations] of Object.entries(loadSpec().paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.has(method)) continue;
      const op = operation as {
        operationId?: string;
        parameters?: readonly { $ref?: string }[];
      };
      if (op.operationId === undefined) continue;
      const { pattern, paramNames } = compile(template);
      routes.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        template,
        paramNames,
        pattern,
        idempotent: (op.parameters ?? []).some(
          (p) => p.$ref === "#/components/parameters/IdempotencyKey",
        ),
      });
    }
  }

  // Literal segments beat parameters, so `/reminders/{id}/complete` is tried
  // before anything that could swallow `complete` as an id.
  routes.sort((a, b) => specificity(b.template) - specificity(a.template));
  cached = routes;
  return routes;
}

function specificity(template: string): number {
  const segments = template.split("/").filter(Boolean);
  const literals = segments.filter((s) => !s.startsWith("{")).length;
  return segments.length * 10 + literals;
}

function compile(template: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = template
    .split("/")
    .map((segment) => {
      if (!segment.startsWith("{")) return escape(segment);
      paramNames.push(segment.slice(1, -1));
      // Ids contain colons (`syl:reminder:...`), so a path parameter is
      // "anything but a slash" rather than a word character class.
      return "([^/]+)";
    })
    .join("/");
  return { pattern: new RegExp(`^${source}$`), paramNames };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RouteMatch {
  readonly route: RouteDef;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Match a request against the table.
 *
 * `pathname` is expected without the `/api/v1` prefix; the server strips it so
 * this stays a pure function of the contract's own paths.
 */
export function matchRoute(
  method: string,
  pathname: string,
  routes: readonly RouteDef[] = specRoutes(),
): RouteMatch | undefined {
  const wanted = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== wanted) continue;
    const found = route.pattern.exec(pathname);
    if (found === null) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1] ?? "");
    });
    return { route, params };
  }
  return undefined;
}

/**
 * Whether a path exists under some other method — the difference between 404
 * and 405, and worth getting right so a squad debugging a typo is told which
 * kind of mistake it was.
 */
export function pathExists(pathname: string, routes: readonly RouteDef[] = specRoutes()): boolean {
  return routes.some((route) => route.pattern.test(pathname));
}
