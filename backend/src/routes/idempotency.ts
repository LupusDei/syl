import type { Request, Response } from "express";

import {
  IdempotencyConflict,
  fingerprintOf,
  type IdempotencyStore,
} from "../services/idempotency.js";
import { ApiFailure, sendOk } from "./envelope.js";

/**
 * The write side of the contract's idempotency rule, as one wrapper.
 *
 * Every write endpoint takes an `Idempotency-Key`. The header is required
 * rather than optional because the client that needs it most — the phone's
 * local outbox — is also the one that retries automatically, and an optional
 * safety rail is one that is missing exactly when the network is bad.
 *
 * A replayed request answers with the *stored* status, not a fresh one. A
 * client that got a 201 the first time and a 200 the second has to reconcile
 * two different answers to one operation, which is the ambiguity this whole
 * mechanism exists to remove.
 */

/** A key longer than this is not a key. A UUIDv4 is 36 characters. */
const MAX_KEY_LENGTH = 255;

/** What running an idempotent write produced. */
export interface IdempotentOutcome<T> {
  readonly status: number;
  readonly data: T;
  readonly replayed: boolean;
}

/**
 * Read the `Idempotency-Key` header.
 *
 * @throws {ApiFailure} `IDEMPOTENCY_KEY_REQUIRED` if it is absent or empty.
 */
export function requireIdempotencyKey(request: Request): string {
  const raw = request.header("Idempotency-Key");
  const key = raw?.trim() ?? "";
  if (key === "") {
    throw new ApiFailure(
      "IDEMPOTENCY_KEY_REQUIRED",
      "This write requires an Idempotency-Key header.",
      { details: { header: "Idempotency-Key", reason: "missing" } },
    );
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiFailure("VALIDATION_FAILED", "That Idempotency-Key is too long.", {
      details: { header: "Idempotency-Key", reason: `must be at most ${MAX_KEY_LENGTH} characters` },
    });
  }
  return key;
}

/**
 * Run a write exactly once per key.
 *
 * `produce` runs only when the key is new. Its result is recorded so a retry
 * replays it — and only on success, because remembering a validation failure
 * would make the client's corrected retry fail forever with the original
 * error, which is the opposite of what a retry is for.
 */
export function runIdempotent<T>(
  store: IdempotencyStore,
  request: Request,
  produce: () => { readonly status: number; readonly data: T },
): IdempotentOutcome<T> {
  const ledger = beginIdempotent<T>(store, request);
  if (ledger.replayed !== null) return ledger.replayed;

  const produced = produce();
  ledger.record(produced.status, produced.data);
  return { status: produced.status, data: produced.data, replayed: false };
}

/**
 * The same rule, for a write that has to wait for something.
 *
 * A separate function rather than one that accepts both, because the shared
 * shape would be `Promise<T> | T` and every caller would have to be read twice
 * to know which it was. The *ledger* is shared — see {@link beginIdempotent} —
 * so there is exactly one place that decides what a replay is.
 *
 * `POST /renders` is the first caller and it is the case that motivates the
 * function existing: a retried render submission that ran twice would be two
 * charges on the Commander's Runway account for one intention.
 */
export async function runIdempotentAsync<T>(
  store: IdempotencyStore,
  request: Request,
  produce: () => Promise<{ readonly status: number; readonly data: T }>,
): Promise<IdempotentOutcome<T>> {
  const ledger = beginIdempotent<T>(store, request);
  if (ledger.replayed !== null) return ledger.replayed;

  const produced = await produce();
  ledger.record(produced.status, produced.data);
  return { status: produced.status, data: produced.data, replayed: false };
}

/** The half of the rule that does not depend on how the write is produced. */
function beginIdempotent<T>(
  store: IdempotencyStore,
  request: Request,
): {
  readonly replayed: IdempotentOutcome<T> | null;
  record(status: number, data: T): void;
} {
  const key = requireIdempotencyKey(request);
  const fingerprint = fingerprintOf(
    request.method,
    request.originalUrl,
    // A body-less write (DELETE, POST with no payload) still has a path, and
    // the path is what distinguishes it.
    request.body ?? null,
  );

  let found;
  try {
    found = store.lookup(key, fingerprint);
  } catch (error) {
    if (error instanceof IdempotencyConflict) {
      throw new ApiFailure("IDEMPOTENCY_KEY_REUSE", error.message, {
        details: { header: "Idempotency-Key", reason: "used for a different request" },
      });
    }
    throw error;
  }

  return {
    replayed:
      found === null
        ? null
        : // Safe assertion: the body was stored by this same call site, whose
          // `produce` is typed to return `T`.
          { status: found.status, data: found.body as T, replayed: true },
    record: (status, data) => {
      store.save(key, fingerprint, status, data);
    },
  };
}

/** Send an idempotent outcome, flagging a replay so the client can see it. */
export function sendIdempotent<T>(response: Response, outcome: IdempotentOutcome<T>): void {
  if (outcome.replayed) response.setHeader("Idempotency-Replayed", "true");
  sendOk(response, outcome.data, outcome.status);
}
