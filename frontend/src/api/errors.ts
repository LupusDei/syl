/**
 * The failure taxonomy for everything the admin asks the backend.
 *
 * The contract is explicit that **`error.code` is the contract and the HTTP
 * status is advisory** — clients branch on the code, never on the status line.
 * So one error type carries the typed code through, and adds the two failure
 * modes that never reach an envelope at all: the request that produced no
 * response (the Tailscale extension is torn down when idle, so the first call
 * after a wake genuinely fails) and the response that is not a Syl envelope.
 *
 * `retryable` is answered here rather than at each call site, because the
 * retry policy in `retry.ts` is the only thing that reads it and a second
 * opinion about what is worth retrying is how an auth failure ends up being
 * retried fifty times.
 */

import type { ApiError, ErrorCode } from "@syl/shared/types";

/** Why a request failed. */
export type FailureKind =
  /** The server answered with a typed `ErrorEnvelope`. `apiError` is set. */
  | "api"
  /** No response at all — tunnel down, connection reset, DNS. */
  | "network"
  /** A response arrived and was not a Syl envelope. */
  | "malformed"
  /** Something threw that is none of the above. Never retried. */
  | "unknown";

export interface AdminApiErrorInit {
  readonly kind: FailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number | undefined;
  readonly apiError?: ApiError | undefined;
  readonly cause?: unknown;
}

/**
 * Every failure the admin client throws. One class rather than a hierarchy:
 * the discriminant callers want is `kind` (and, for an API failure, `code`),
 * and `instanceof` against four classes reads worse than a switch.
 */
export class AdminApiError extends Error {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  /** The HTTP status, when there was a response. Advisory — see `code`. */
  readonly status: number | null;
  /** The contract's typed code. Null unless `kind` is `"api"`. */
  readonly code: ErrorCode | null;
  readonly apiError: ApiError | null;
  /** The server's suggested backoff floor, when it named one. */
  readonly retryAfterMs: number | null;

  constructor(init: AdminApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "AdminApiError";
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.status = init.status ?? null;
    this.apiError = init.apiError ?? null;
    this.code = init.apiError?.code ?? null;
    this.retryAfterMs = init.apiError?.retryAfterMs ?? null;
  }
}

export function isAdminApiError(value: unknown): value is AdminApiError {
  return value instanceof AdminApiError;
}

/**
 * Whether a value is usable as the contract's `ApiError`.
 *
 * Deliberately structural, and deliberately **not** checked against the
 * `ErrorCode` enum. A server that adds a code must not make this client
 * report "malformed response" — the operator would be told the wrong thing
 * about the wrong layer. An unrecognised code surfaces as itself.
 */
export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown; retryable?: unknown };
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

export function apiFailure(status: number, error: ApiError): AdminApiError {
  return new AdminApiError({
    kind: "api",
    message: `${error.code}: ${error.message}`,
    retryable: error.retryable,
    status,
    apiError: error,
  });
}

export function networkFailure(cause: unknown): AdminApiError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AdminApiError({
    kind: "network",
    // Retryable by construction: a torn-down tunnel is the expected cause,
    // and treating it as "the server is down" makes a healthy system feel
    // broken.
    retryable: true,
    message: `The request did not reach Syl: ${detail}`,
    cause,
  });
}

export function malformedResponse(status: number, detail: string): AdminApiError {
  return new AdminApiError({
    kind: "malformed",
    retryable: false,
    status,
    message: `Syl answered ${status} with something that is not an envelope: ${detail}`,
  });
}

/**
 * Normalise anything thrown into the taxonomy, so a view renders one shape.
 * Used at the React boundary; the client itself already throws these.
 */
export function asAdminApiError(cause: unknown): AdminApiError {
  if (isAdminApiError(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AdminApiError({ kind: "unknown", retryable: false, message: detail, cause });
}

/**
 * Peel `{ success: true, data }` or throw the failure it describes.
 *
 * The status is passed in but never decides anything on its own: a body that
 * says `success: false` is a failure at 200, and a body that says
 * `success: true` is a success at 500. The contract is the envelope.
 */
export function unwrapEnvelope<T>(status: number, body: unknown): T {
  if (typeof body !== "object" || body === null) {
    throw malformedResponse(status, "the body was not a JSON object");
  }
  const envelope = body as { success?: unknown; data?: unknown; error?: unknown };

  if (envelope.success === false) {
    if (!isApiError(envelope.error)) {
      throw malformedResponse(status, "the failure envelope carried no usable `error`");
    }
    throw apiFailure(status, envelope.error);
  }
  if (envelope.success !== true) {
    throw malformedResponse(status, "the body carried no `success` discriminant");
  }
  if (!("data" in envelope)) {
    throw malformedResponse(status, "the success envelope carried no `data`");
  }
  // Safe: the envelope shape is checked above and the payload's shape is the
  // contract's, verified by `shared`'s fixture suite rather than re-validated
  // per request — a second validator here would be a second opinion about the
  // contract, which is the thing generated types exist to prevent.
  return envelope.data as T;
}
