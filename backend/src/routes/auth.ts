import { Router, type RequestHandler } from "express";

import { requireAuth } from "../middleware/auth.js";
import { PairingError, type ApiKeyService } from "../services/api-key-service.js";
import { ApiFailure, sendOk } from "./envelope.js";

/**
 * Pairing and identity.
 *
 * `POST /auth/pair` is unauthenticated because it has to be — it is how a
 * device gets its first token. Its protection is the pairing code, which is
 * shown on the server console, lives ten minutes, and is consumed on use.
 *
 * `GET /auth/whoami` is the cheapest possible authenticated call, and exists
 * so a client can distinguish "my token is dead" from "the tunnel is down"
 * without side effects. Under Tailscale those two look identical from the app,
 * and treating a re-establishing tunnel as an expired token would send the
 * Commander to a re-pairing screen every time his phone woke up.
 */

/** Read a required string field, or refuse the request. */
function requireString(
  body: unknown,
  field: string,
  { maxLength }: { maxLength: number },
): string {
  const value =
    typeof body === "object" && body !== null
      ? // Safe assertion: guarded by the checks above, and the value is
        // re-tested immediately.
        (body as Record<string, unknown>)[field]
      : undefined;

  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is required.`, {
      details: { field, reason: "must be a non-empty string" },
    });
  }
  if (value.length > maxLength) {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is too long.`, {
      details: { field, reason: `must be at most ${maxLength} characters` },
    });
  }
  return value.trim();
}

/** Device names are shown on an admin screen, not stored for machines. */
const MAX_DEVICE_NAME = 120;
/** A pairing code is eight digits and a hyphen; anything longer is noise. */
const MAX_PAIRING_CODE = 32;

export interface AuthRouterOptions {
  readonly keys: ApiKeyService;
  /** The bearer middleware, applied only to the authenticated route. */
  readonly authenticate: RequestHandler;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { keys, authenticate } = options;
  const router = Router();

  router.post("/auth/pair", (request, response) => {
    const pairingCode = requireString(request.body, "pairingCode", {
      maxLength: MAX_PAIRING_CODE,
    });
    const deviceName = requireString(request.body, "deviceName", {
      maxLength: MAX_DEVICE_NAME,
    });

    try {
      sendOk(response, keys.pair(pairingCode, deviceName));
    } catch (error) {
      if (error instanceof PairingError) {
        // Every pairing failure is UNAUTHORIZED rather than NOT_FOUND or
        // VALIDATION_FAILED. The code is an eight-digit secret: a caller who
        // can tell "wrong code" from "expired code" from "no code active" can
        // narrow the search, and there are only a hundred million of them.
        throw new ApiFailure("UNAUTHORIZED", "That pairing code was not accepted.");
      }
      throw error;
    }
  });

  router.get("/auth/whoami", authenticate, (request, response) => {
    sendOk(response, requireAuth(request).principal);
  });

  return router;
}
