import { Router, type RequestHandler } from "express";

import { requireAuth } from "../middleware/auth.js";
import { PairingError, type ApiKeyService } from "../services/api-key-service.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Pairing and identity.
 *
 * `POST /auth/pair` is unauthenticated because it has to be — it is how a
 * device gets its first token. Its protection is the pairing code, which is
 * shown on the server console, lives ten minutes, and is consumed on use.
 *
 * **Consumed on use is exactly why this write needs its `Idempotency-Key` more
 * than any other.** `syl-ux1`: pairing used to ignore the header. If the
 * response was lost in flight — which is the entire scenario the header exists
 * for — the client retried, found the code already spent, and got a 401. There
 * is no endpoint to reissue a pairing code, so the device was permanently
 * unpairable and the service had to be restarted. The one write with no
 * recovery path was the one with no protection.
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
  /** The ledger that makes pairing survivable when the response is lost. */
  readonly idempotency: IdempotencyStore;
  /** The bearer middleware, applied only to the authenticated route. */
  readonly authenticate: RequestHandler;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { keys, idempotency, authenticate } = options;
  const router = Router();

  /**
   * Note what the ledger holds for this one route: a `TokenGrant`, and a
   * `TokenGrant` carries the bearer token in clear. `api_keys` deliberately
   * stores only a hash, so this is the one place a live token rests on disk,
   * for the ledger's 24-hour retention.
   *
   * It is the lesser of the two evils and worth naming rather than hiding.
   * Replaying the *stored* response is the only answer that leaves the device
   * with exactly one token; re-minting on retry would leave two live
   * credentials for one pairing, and refusing the retry is the bug being
   * fixed. Anyone who can read this table can already read the Commander's
   * entire message history from the row beside it.
   */
  router.post("/auth/pair", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const pairingCode = requireString(request.body, "pairingCode", {
          maxLength: MAX_PAIRING_CODE,
        });
        const deviceName = requireString(request.body, "deviceName", {
          maxLength: MAX_DEVICE_NAME,
        });

        try {
          return { status: 200, data: keys.pair(pairingCode, deviceName) };
        } catch (error) {
          if (error instanceof PairingError) {
            // Every pairing failure is UNAUTHORIZED rather than NOT_FOUND or
            // VALIDATION_FAILED. The code is an eight-digit secret: a caller
            // who can tell "wrong code" from "expired code" from "no code
            // active" can narrow the search, and there are only a hundred
            // million of them.
            //
            // A failure is never recorded in the ledger, which matters here:
            // the Commander mistyping a code once must not make the same key
            // fail forever once he types it correctly.
            throw new ApiFailure("UNAUTHORIZED", "That pairing code was not accepted.");
          }
          throw error;
        }
      }),
    );
  });

  router.get("/auth/whoami", authenticate, (request, response) => {
    sendOk(response, requireAuth(request).principal);
  });

  return router;
}
