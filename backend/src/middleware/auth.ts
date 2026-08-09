import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { Principal } from "@syl/shared";

import { ApiFailure } from "../routes/envelope.js";
import type { ApiKeyRecord, ApiKeyService, RejectionReason } from "../services/api-key-service.js";

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
}

/**
 * Build the bearer-token middleware.
 *
 * Mount it in front of the routes that need it rather than globally: an
 * exemption expressed by mount order is visible in one place, whereas a global
 * middleware with a path allowlist grows entries nobody re-reads.
 */
export function requireBearerToken(options: AuthMiddlewareOptions): RequestHandler {
  const { keys } = options;
  const onRejected =
    options.onRejected ??
    ((reason: RejectionReason, path: string): void => {
      console.warn(`[syl] rejected a request to ${path}: token ${reason}`);
    });

  return function authenticate(
    request: Request,
    _response: Response,
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
