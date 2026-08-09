import type { Response } from "express";

// Type-only. Nothing in `@syl/shared` may be imported as a *value* from the
// backend: the package's `exports` point at TypeScript source, which the
// compiled `dist/` could not load at runtime. Types are erased; values would
// not be.
import type { ApiError, ErrorCode } from "@syl/shared";

/**
 * The two shapes a Syl response body can take, and nothing else.
 *
 * ```json
 * { "success": true,  "data": { … } }
 * { "success": false, "error": { "code": "NOT_FOUND", … } }
 * ```
 *
 * A client that cannot parse one of these has hit something that is not Syl —
 * a proxy, a captive portal, a Tailscale error page — and should treat it as a
 * transport failure rather than an API error. That only works if the service
 * never emits a third shape, which is why every route goes through here.
 *
 * **The typed code is the contract; the HTTP status is advisory.** The status
 * exists so proxies and browsers behave sensibly; clients branch on
 * `error.code`.
 */

/** The status each code travels with. Advisory, but it should be sensible. */
export const STATUS_FOR_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHORIZED: 401,
  // 401 and not 410/409: these are still "you may not have a token", and a
  // client that branches on the status line rather than the code should be
  // pushed towards the same conclusion as an ordinary refusal.
  PAIRING_CODE_EXPIRED: 401,
  PAIRING_CODE_ALREADY_USED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSE: 409,
  QUIET_HOURS: 409,
  DEFERRAL_NOT_LATER: 422,
  RRULE_UNSUPPORTED: 422,
  UNKNOWN_JOB_KIND: 422,
  DEVICE_TOKEN_INVALID: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
};

/**
 * The codes whose failures are worth retrying.
 *
 * Auth failures are deliberately absent. Retrying an auth failure fifty times
 * is the worst possible response to a credential problem — and under Syl's
 * billing constraint, a credential problem is the one that must stop the queue
 * and page rather than loop.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
]);

/** Whether a client's backoff should try this code again. */
export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export interface FailureDetail {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterMs?: number;
}

/**
 * An error with a place in the contract.
 *
 * Thrown from anywhere below the route layer and rendered by one handler, so a
 * service does not need a `Response` to refuse something.
 */
export class ApiFailure extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly retryAfterMs: number | null;

  constructor(code: ErrorCode, message: string, detail: FailureDetail = {}) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.details = detail.details ?? null;
    this.retryAfterMs = detail.retryAfterMs ?? null;
  }

  /** The HTTP status this failure should travel with. */
  get status(): number {
    return STATUS_FOR_CODE[this.code];
  }

  /** The wire form. */
  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      retryable: isRetryable(this.code),
      details: this.details,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** Send a success envelope. */
export function sendOk<T>(response: Response, data: T, status = 200): void {
  response.status(status).json({ success: true, data });
}

/** Send a failure envelope. */
export function sendFailure(response: Response, failure: ApiFailure): void {
  response.status(failure.status).json({ success: false, error: failure.toApiError() });
}

/**
 * Turn anything thrown into a contract failure.
 *
 * An unrecognised throw is `INTERNAL` with a fixed message. The detail belongs
 * in stderr, not in a response body: Syl's responses go to a phone and to logs
 * the Commander reads, and a stack trace in either is both useless to him and
 * a gift to anyone else.
 */
export function asApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure("INTERNAL", "The service failed to handle that request.");
}
