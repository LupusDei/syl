import { Router, type RequestHandler } from "express";

import type { ErrorCode } from "@syl/shared";

import { requireAuth } from "../middleware/auth.js";
import {
  PairingError,
  type ApiKeyService,
  type PairingFailure,
} from "../services/api-key-service.js";
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

/**
 * How each pairing failure is rendered, and why they are not all the same.
 *
 * The original rule here was that every pairing failure is one
 * indistinguishable `UNAUTHORIZED`, on the reasoning that a caller who can
 * tell "wrong code" from "expired code" can narrow a hundred-million-value
 * search. That reasoning is right about `unknown` and wrong about the other
 * two, and the difference is worth being exact about:
 *
 * - `malformed` and `unknown` collapse into `UNAUTHORIZED`. A guess that was
 *   wrong and an attempt made while no code is live must look identical, or
 *   the endpoint reports when a pairing window is open.
 * - `expired` and `already_used` are returned **only for a code that matched a
 *   stored one**. Reaching either requires already knowing the secret, so
 *   neither narrows anything — and both are things the Commander genuinely
 *   needs to be told, on a phone, with no console in front of him. "Get a new
 *   code" and "that one already paired something" have different next actions,
 *   and rendering them as one message is how a person ends up retyping the
 *   same eight digits four times.
 *
 * The details field carries nothing beyond the code: it is the code that is
 * the contract.
 */
const FAILURE_CODES: Readonly<Record<PairingFailure, ErrorCode>> = {
  malformed: "UNAUTHORIZED",
  unknown: "UNAUTHORIZED",
  expired: "PAIRING_CODE_EXPIRED",
  already_used: "PAIRING_CODE_ALREADY_USED",
};

/** What the client is told for each. Never more than the code implies. */
const FAILURE_MESSAGES: Readonly<Record<PairingFailure, string>> = {
  malformed: "That pairing code was not accepted.",
  unknown: "That pairing code was not accepted.",
  expired: "That pairing code has expired. Run `npm run pair` on the server for a new one.",
  already_used:
    "That pairing code has already paired a device. Run `npm run pair` on the server for a new one.",
};

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
   *
   * It opens no new door over HTTP, and that is worth being precise about on
   * the one unauthenticated write. A replay is matched on key *and*
   * fingerprint, and the fingerprint covers the body — which contains the
   * pairing code. A caller holding a stolen key and nothing else gets
   * `IDEMPOTENCY_KEY_REUSE`; a caller who also has the pairing code could have
   * paired anyway.
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
            // See `FAILURE_CODES` for why these are not all one code.
            //
            // A failure is never recorded in the ledger, which matters here:
            // the Commander mistyping a code once must not make the same key
            // fail forever once he types it correctly.
            throw new ApiFailure(
              FAILURE_CODES[error.reason],
              FAILURE_MESSAGES[error.reason],
            );
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
