import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Principal } from "@syl/shared";

import { ApiFailure } from "../routes/envelope.js";
import type {
  ApiKeyRecord,
  ApiKeyService,
  KeyScope,
  RejectionReason,
} from "../services/api-key-service.js";

/**
 * `Authorization: Bearer <token>` on everything except the two operations that
 * cannot have a token yet.
 *
 * Two rules shape this middleware, and both are about what a caller is allowed
 * to learn:
 *
 * 1. **Every rejection reads the same from outside.** Internally the service
 *    distinguishes malformed, unknown, revoked and expired — those go to the
 *    log, where they answer "why did my phone stop working". Externally they
 *    are one message. A caller who can tell "unknown token" from "revoked
 *    token" has an oracle for guessing tokens.
 * 2. **The exemption list is explicit and small.** `GET /health` and
 *    `POST /auth/pair` are unauthenticated because they must be: one is how a
 *    monitor learns the service is alive, the other is how a device gets a
 *    token in the first place. Everything else is closed by default, so a new
 *    route is authenticated unless somebody deliberately opens it.
 */

/** What a verified request carries. */
export interface AuthenticatedContext {
  readonly principal: Principal;
  readonly key: ApiKeyRecord;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by {@link requireBearerToken}. Absent on unauthenticated routes. */
    auth?: AuthenticatedContext;
  }
}

/**
 * The single message every rejection produces.
 *
 * Deliberately not "expired" or "revoked", however helpful that would be.
 */
const REJECTION_MESSAGE =
  "Authorization: Bearer <token> is required, and this one was not accepted. Re-pair this device.";

/** Pull the token out of an Authorization header, or `null`. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  // RFC 7235 makes the scheme case-insensitive; the token is not.
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** The failure every rejection produces. */
export function unauthorized(): ApiFailure {
  return new ApiFailure("UNAUTHORIZED", REJECTION_MESSAGE);
}

export interface AuthMiddlewareOptions {
  readonly keys: ApiKeyService;
  /**
   * Where a rejection is recorded. Injected so a test can assert that the
   * reason reached the log even though it never reached the response.
   */
  readonly onRejected?: (reason: RejectionReason, path: string) => void;
  /**
   * The contract's base path, for the agent confinement mounted behind this.
   *
   * Passed in rather than imported so this module does not depend on
   * `index.ts`, which depends on it. Defaults to the contract's value, so a
   * test can build the middleware without wiring a whole app.
   */
  readonly basePath?: string;
  /** Where the agent confinement's refusals go. See {@link confineAgent}. */
  readonly onConfined?: (path: string) => void;
}

/**
 * Build the bearer-token middleware.
 *
 * Mount it in front of the routes that need it rather than globally: an
 * exemption expressed by mount order is visible in one place, whereas a global
 * middleware with a path allowlist grows entries nobody re-reads.
 *
 * **{@link confineAgent} runs inside this handler**, after a token is accepted
 * and before `next()`. That is deliberate and it is the only place it could go
 * safely. `createApp` builds this once and hands the same handler to every
 * router, so it is the service's single authenticated chokepoint: a router
 * added tomorrow is confined without anybody remembering to confine it, and the
 * "401 before 403" ordering cannot be got wrong because the confinement is
 * *inside* the authentication that must precede it.
 */
export function requireBearerToken(options: AuthMiddlewareOptions): RequestHandler {
  const { keys } = options;
  const onRejected =
    options.onRejected ??
    ((reason: RejectionReason, path: string): void => {
      console.warn(`[syl] rejected a request to ${path}: token ${reason}`);
    });
  const confine = confineAgent({
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
    ...(options.onConfined === undefined ? {} : { onRefused: options.onConfined }),
  });

  return function authenticate(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      onRejected("malformed", request.path);
      next(unauthorized());
      return;
    }

    const result = keys.verify(token);
    if (!result.ok) {
      onRejected(result.reason, request.path);
      next(unauthorized());
      return;
    }

    request.auth = { principal: result.principal, key: result.key };
    confine(request, response, next);
  };
}

/**
 * The refusal a correctly-authenticated caller gets for asking too much.
 *
 * **Deliberately distinguishable from `unauthorized()`**, which is the opposite
 * of the rule one paragraph up, so the reasoning has to be explicit. The
 * indistinguishability rule exists so that a caller cannot use the API as an
 * oracle for *guessing tokens*. This refusal is only ever reached by a caller
 * whose token was accepted — they already hold a working credential, so there
 * is nothing left to guess. What they learn is that this surface exists and
 * their key is not for it, and the alternative is a phone told "re-pair this
 * device" for a route no phone will ever be allowed to reach, which is a
 * support call rather than a security property.
 *
 * This is the *operator's* refusal and it names the console command, because an
 * operator can go and run it. Syl gets {@link beyondAgentReach} instead: she
 * cannot mint herself anything, so offering her a next step she cannot take
 * would only give her something wrong to repeat to the Commander.
 */
export function forbidden(scope: KeyScope): ApiFailure {
  return new ApiFailure(
    "FORBIDDEN",
    `This endpoint needs a key with ${scope} scope. Paired devices do not get one — ` +
      `mint it at the machine's own console with \`npm run pair -- --admin\`.`,
  );
}

export interface ScopeMiddlewareOptions {
  /**
   * Where a refusal is recorded.
   *
   * Separate from the auth log line for the same reason the failure is
   * separate: a device reaching for the admin surface is not a broken token,
   * it is either a mis-built client or somebody trying.
   */
  readonly onRefused?: (scope: KeyScope, path: string) => void;
}

/**
 * Require a scope, on top of a valid token.
 *
 * Mounted **after** {@link requireBearerToken} on the routes that need it, so
 * an anonymous caller still gets the indistinguishable 401 and never learns
 * that a scope exists. Throwing when `request.auth` is absent is the same
 * decision as {@link requireAuth}: a scope check in front of no authentication
 * check is a hole that reads like a guard.
 */
export function requireScope(
  scope: KeyScope,
  options: ScopeMiddlewareOptions = {},
): RequestHandler {
  const onRefused =
    options.onRefused ??
    ((refused: KeyScope, path: string): void => {
      console.warn(`[syl] refused a request to ${path}: key is not ${refused} scope`);
    });

  return function authorise(request: Request, _response: Response, next: NextFunction): void {
    const auth = request.auth;
    if (auth === undefined) {
      next(
        new Error(
          "requireScope is mounted without requireBearerToken in front of it. " +
            "Refusing to serve a request whose token was never checked.",
        ),
      );
      return;
    }
    if (auth.key.scope !== scope) {
      onRefused(scope, request.path);
      next(forbidden(scope));
      return;
    }
    next();
  };
}

/**
 * The contract's base path, as a default for {@link confineAgent}.
 *
 * A copy of `index.ts`'s `API_BASE_PATH` rather than an import of it, because
 * that module imports this one. `createApp` passes its own value in, so the two
 * cannot drift where it matters; this exists so a test can build the middleware
 * without wiring an app.
 */
const DEFAULT_BASE_PATH = "/api/v1";

/**
 * Everything the `agent` scope may reach, as path prefixes under the base.
 *
 * **An allowlist, not a denylist, and that is the whole design.** The scope
 * exists to bound what Syl can do on the Commander's own machine, so its
 * default has to be "no". A denylist would give a router mounted next month the
 * opposite default — reachable by her until somebody remembered — which is a
 * boundary that erodes by inaction.
 *
 * The entries here are the product's own nouns, and the ones she was given
 * hands for. What is deliberately absent is worth naming:
 *
 * - **`/logs`.** It is the record of everything she did on his machine. An
 *   assistant that can read her own audit trail can also tell you what is in
 *   it, and one with any write near it could shape it; either way the log stops
 *   being independent evidence. The point of the log is that it is a *third
 *   party* to any conversation about what she did.
 * - **`/auth`.** A credential that can pair a device can mint itself a `device`
 *   key, and a `device` key steps around every line in this file. Pairing is the
 *   one escalation path that would make the scope decorative.
 * - **`/devices`.** Push targets are where a notification goes. Nothing she
 *   needs to do requires changing that, and it is the natural way to make a
 *   reminder arrive somewhere it should not.
 * - **`/conversations`.** She speaks through `ConversationService` in process.
 *   An HTTP write here would let her author messages *as the Commander*, which
 *   is the one thing that would make the transcript untrustworthy.
 *
 * Adding an entry is a decision about what she can do, not a convenience. There
 * is a test asserting this list exactly, so it cannot grow as a side effect.
 */
/**
 * No second key. The Commander's ruling, 2026-08-10: *"Remove the need for
 * another key for the admin panel. Too annoying."*
 *
 * `GET /logs` and the memory graph used to demand `admin` scope, which no HTTP
 * route can mint — so looking at either meant going to the machine, running
 * `npm run pair -- --admin`, and pasting a second token into a phone. The
 * argument for it was real: the log is the record of what a pre-authorised
 * program did on his machine, the graph's feedback endpoint writes into Syl's
 * memory, and a shoulder-surfed eight-digit pairing code should not reach
 * either.
 *
 * **He has weighed that and decided the friction costs more.** It is his
 * machine, his data, and his tailnet, and a view he needs a laptop to open is
 * a view he does not look at — which was the actual outcome: the memory graph
 * is the one he asked for specifically so he could judge the inferred engine,
 * and he could not get to it from the device he actually carries.
 *
 * What still holds, and is doing the real work either way: a caller must be
 * **authenticated**. Pairing is over the tailnet behind eight digits, and an
 * unpaired caller gets the same indistinguishable 401 it always did. This
 * removes a second factor on two routes; it does not open anything to a
 * stranger.
 *
 * The `scope` column stays, and `npm run pair -- --admin` still mints `admin`.
 * Nothing reads it today. It is left in place because taking a distinction OUT
 * of a schema is expensive and putting this one back is one line — see
 * `0014_api_key_scope.sql`.
 */
export const anyAuthenticatedDevice: RequestHandler = (_request, _response, next) => {
  next();
};

/** One surface she may reach, and what it is called when she has to say so. */
export interface AgentSurface {
  /** The path prefix under the base path. Matched on segment boundaries. */
  readonly path: string;
  /** What it is, in the words she would use to the Commander. */
  readonly says: string;
}

/**
 * Everything the `agent` scope may reach, with the name each one goes by.
 *
 * **A pair rather than a bare path, because the refusal has to name them.**
 * {@link beyondAgentReach} used to carry the sentence "reminders, to-dos and
 * goals" as a hand-written string beside this list, which is the exact shape
 * `docs/CONTEXT.md` §8 catalogues seven times over: a claim stated twice, going
 * stale on the day the other half moves, and failing as a fluent sentence that
 * no assertion can see. Widening the list without touching the sentence would
 * have had her telling him she cannot search her own memory while doing it.
 * Now the sentence is a function of the list, so there is nothing to keep in
 * step.
 *
 * ## `/memory/recall`, and why it is that and not `/memory` — `syl-016.1`
 *
 * She diagnosed the gap herself: *"I can't even see the nodes. I see a summary
 * someone else chose for me."* The retrieval kernels, the FTS5 index and the
 * graph view all existed and none of them was reachable from her hands, so the
 * only memory she had was a digest somebody else had ranked for her — and no
 * way to obtain the id that every corrective verb in `syl-016` needs.
 *
 * **The entry is the one route and not the router**, and that is the whole of
 * the security argument. `/memory` would also have handed her:
 *
 * - `POST /memory/edges/{id}/feedback`, which moves the weight of an edge in
 *   her own memory. An assistant that can confirm and reject her own inferences
 *   can groom what she will be shown tomorrow, and the graph stops being
 *   evidence about her for the same reason `/logs` would. This is the one that
 *   decides it.
 * - `GET /memory/graph` and `/memory/metrics`, instruments built for the
 *   Commander to judge the inferred engine — every night's cost, token spend
 *   and outcome. Telemetry about her own reflection is the dream-log half of
 *   constraint 7, and it is not memory.
 *
 * A read of her own memory is her own data and the thing she is FOR. Grading
 * it, and reading the record of her own nights, are not. The prefix match is on
 * segment boundaries (`withinAgentSurface`), so this opens exactly one route.
 */
export const AGENT_SURFACES: readonly AgentSurface[] = [
  { path: "/reminders", says: "reminders" },
  { path: "/todos", says: "to-dos" },
  { path: "/goals", says: "goals" },
  { path: "/memory/recall", says: "her own memory, to search it and read it back" },
];

export const AGENT_SURFACE: readonly string[] = AGENT_SURFACES.map((surface) => surface.path);

/**
 * The refusal Syl gets for reaching outside her own nouns.
 *
 * Distinct from {@link forbidden} because the audience is different. That one
 * is read by an operator who can go and mint the key it names; this one is read
 * by **Syl**, who has to turn it into a sentence for the Commander. So it says
 * what she *can* do rather than only what she cannot: "I am not allowed to do
 * that, I can only make reminders, to-dos and goals" is an answer, and
 * "forbidden" is a shrug.
 */
export function beyondAgentReach(path: string): ApiFailure {
  return new ApiFailure(
    "FORBIDDEN",
    // DERIVED from the list, never written beside it. See `AGENT_SURFACES`.
    `Syl's own credential reaches ${prose(AGENT_SURFACES.map((surface) => surface.says))}, and ` +
      `nothing else on this API. ${path} is outside that, deliberately — she cannot pair a ` +
      "device, read the log of what she has done, or change where a notification goes.",
    { details: { reach: AGENT_SURFACE } },
  );
}

/** `a, b and c`. An Oxford-comma-free list, because she says this out loud. */
function prose(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "nothing";
  return `${items.slice(0, -1).join(", ")} and ${String(items.at(-1))}`;
}

export interface ConfineAgentOptions {
  /** The contract's base path. Defaults to the contract's own value. */
  readonly basePath?: string;
  /**
   * Where a refusal is recorded, given the full path.
   *
   * Worth a line of its own in the log: Syl reaching for a surface she does not
   * have is either a tool definition that outgrew its credential or a prompt
   * that talked her into trying, and both are things somebody should see.
   */
  readonly onRefused?: (path: string) => void;
}

/**
 * The path a request is really for, without its query string.
 *
 * `originalUrl` rather than `path`, and the difference is a bug rather than a
 * preference: inside a handler mounted with `router.use("/reminders", ...)`,
 * Express strips the mount point, so `request.path` is `/` and an allowlist
 * matched against it would match everything or nothing.
 */
function fullPath(request: Request): string {
  const raw = request.originalUrl ?? request.url ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

/**
 * Whether any segment of a path is `.` or `..` once unescaped.
 *
 * An allowlist matched on a raw path is only sound if the path cannot be read
 * as pointing somewhere else. Express does not normalise `..` today, so
 * `/api/v1/reminders/../logs` routes nowhere and is a 404 — but a proxy that
 * normalises before forwarding would turn it into `/api/v1/logs` past a guard
 * that had already said yes. Refusing the shape costs nothing and does not
 * depend on which layer normalises.
 *
 * A malformed escape counts as suspicious. Syl's ids legitimately carry `%3A`,
 * so `%` cannot itself be the discriminator; a `%` that does not decode is not
 * an id.
 */
function hasTraversal(path: string): boolean {
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === "..") return true;
  }
  return false;
}

/** Whether a path lies inside {@link AGENT_SURFACE}. */
function withinAgentSurface(path: string, basePath: string): boolean {
  if (hasTraversal(path)) return false;
  return AGENT_SURFACE.some((resource) => {
    const prefix = `${basePath}${resource}`;
    // The trailing slash matters: without it `/remindersecret` is inside
    // `/reminders`, which is a surface she was never given.
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/**
 * Confine the `agent` scope to the surfaces it was created for.
 *
 * Mounted **inside** {@link requireBearerToken}, which is the only place it can
 * be both closed-by-default and correctly ordered. See the note there.
 *
 * Every other scope passes through untouched: this is not a permission system
 * and must not become one. It answers exactly one question — "is this Syl
 * reaching outside her own nouns?" — and leaves the Commander's own devices
 * exactly as capable as they were.
 *
 * Throwing when `request.auth` is absent is the same decision as
 * {@link requireScope} and matters more here, because the failure mode is the
 * dangerous direction: a confinement that read `undefined !== "agent"` would
 * wave an unauthenticated request through.
 */
export function confineAgent(options: ConfineAgentOptions = {}): RequestHandler {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const onRefused =
    options.onRefused ??
    ((path: string): void => {
      console.warn(`[syl] refused Syl's own key at ${path}: outside the agent surface`);
    });

  return function confine(request: Request, _response: Response, next: NextFunction): void {
    const auth = request.auth;
    if (auth === undefined) {
      next(
        new Error(
          "confineAgent is mounted without requireBearerToken in front of it. " +
            "Refusing to serve a request whose token was never checked.",
        ),
      );
      return;
    }
    if (auth.key.scope !== "agent") {
      next();
      return;
    }

    const path = fullPath(request);
    if (!withinAgentSurface(path, basePath)) {
      onRefused(path);
      next(beyondAgentReach(path));
      return;
    }
    next();
  };
}

/**
 * Read the authenticated context off a request.
 *
 * Throws rather than returning `undefined`. A handler mounted behind the
 * middleware always has one, and a handler that is *not* behind it must fail
 * loudly during development rather than quietly serving the Commander's data
 * to whoever asked.
 */
export function requireAuth(request: Request): AuthenticatedContext {
  const auth = request.auth;
  if (auth === undefined) {
    throw new Error(
      "This handler is not mounted behind requireBearerToken. Refusing to serve an unauthenticated request.",
    );
  }
  return auth;
}
