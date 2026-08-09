import { describe, expect, it } from "vitest";

import type { ApiError, ErrorEnvelope } from "@syl/shared/types";

import { fixture } from "../helpers/fixtures";

import {
  AdminApiError,
  apiFailure,
  asAdminApiError,
  isAdminApiError,
  isApiError,
  malformedResponse,
  networkFailure,
  unwrapEnvelope,
} from "../../src/api/errors";

/** The real bytes the contract ships for a failure, not a hand-made object. */
function errorFixture(name: string): ErrorEnvelope {
  return fixture(name) as ErrorEnvelope;
}

describe("isApiError", () => {
  it("should accept every shipped error fixture", () => {
    for (const name of [
      "errors/rate_limited",
      "errors/unauthorized",
      "errors/not_found",
      "errors/validation_failed",
      "errors/upstream_unavailable",
    ]) {
      expect(isApiError(errorFixture(name).error)).toBe(true);
    }
  });

  it("should accept a code the client has never heard of", () => {
    // The spec adds codes over time; reporting "malformed response" for one
    // would tell the operator the wrong thing about the wrong layer.
    expect(isApiError({ code: "SOMETHING_NEW", message: "…", retryable: true })).toBe(true);
  });

  it("should reject values that are not usable as an ApiError", () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError("nope")).toBe(false);
    expect(isApiError({ code: "NOT_FOUND", message: "x" })).toBe(false);
    expect(isApiError({ code: 7, message: "x", retryable: false })).toBe(false);
    expect(isApiError({ code: "NOT_FOUND", message: 7, retryable: false })).toBe(false);
  });
});

describe("apiFailure", () => {
  it("should carry the contract's code, retryability and backoff floor", () => {
    const error = errorFixture("errors/rate_limited").error;
    const failure = apiFailure(429, error);

    expect(failure).toBeInstanceOf(AdminApiError);
    expect(failure.kind).toBe("api");
    expect(failure.code).toBe("RATE_LIMITED");
    expect(failure.status).toBe(429);
    expect(failure.retryable).toBe(error.retryable);
    expect(failure.retryAfterMs).toBe(error.retryAfterMs ?? null);
    expect(failure.message).toContain(error.message);
  });

  it("should refuse to retry an auth failure", () => {
    // Constitution-adjacent: retrying an auth failure fifty times is the worst
    // possible response to a key having shadowed the subscription login.
    expect(apiFailure(401, errorFixture("errors/unauthorized").error).retryable).toBe(false);
  });

  it("should report a null backoff floor when the server named none", () => {
    const error: ApiError = { code: "INTERNAL", message: "boom", retryable: true };
    expect(apiFailure(500, error).retryAfterMs).toBeNull();
  });
});

describe("networkFailure", () => {
  it("should be retryable, because a torn-down tunnel is the expected cause", () => {
    const failure = networkFailure(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("network");
    expect(failure.retryable).toBe(true);
    expect(failure.status).toBeNull();
    expect(failure.code).toBeNull();
    expect(failure.message).toContain("Failed to fetch");
    expect(failure.cause).toBeInstanceOf(TypeError);
  });

  it("should describe a non-Error cause without throwing", () => {
    expect(networkFailure("socket hang up").message).toContain("socket hang up");
  });
});

describe("malformedResponse", () => {
  it("should never be retried", () => {
    const failure = malformedResponse(200, "the body was not JSON");
    expect(failure.kind).toBe("malformed");
    expect(failure.retryable).toBe(false);
    expect(failure.status).toBe(200);
  });
});

describe("asAdminApiError", () => {
  it("should pass an AdminApiError through untouched", () => {
    const failure = malformedResponse(500, "x");
    expect(asAdminApiError(failure)).toBe(failure);
  });

  it("should wrap an unknown throw as unretryable", () => {
    const wrapped = asAdminApiError(new RangeError("off the end"));
    expect(wrapped.kind).toBe("unknown");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.message).toBe("off the end");
  });

  it("should wrap a thrown non-Error", () => {
    expect(asAdminApiError("just a string").message).toBe("just a string");
  });
});

describe("isAdminApiError", () => {
  it("should distinguish our failures from any other throw", () => {
    expect(isAdminApiError(malformedResponse(500, "x"))).toBe(true);
    expect(isAdminApiError(new Error("x"))).toBe(false);
    expect(isAdminApiError(null)).toBe(false);
  });
});

describe("unwrapEnvelope", () => {
  it("should return the data of a real success envelope", () => {
    const body = fixture("http/health.ok");
    const health = unwrapEnvelope<{ status: string }>(200, body);
    expect(health.status).toBe("ok");
  });

  it("should throw the typed failure a real error envelope describes", () => {
    expect(() => unwrapEnvelope(404, fixture("errors/not_found"))).toThrowError(
      expect.objectContaining({ kind: "api", code: "NOT_FOUND" }) as Error,
    );
  });

  it("should trust the envelope over the status line", () => {
    // The contract is explicit: the status is advisory. A failure body at 200
    // is a failure.
    expect(() => unwrapEnvelope(200, fixture("errors/internal"))).toThrowError(
      expect.objectContaining({ kind: "api", code: "INTERNAL", status: 200 }) as Error,
    );
  });

  it("should reject a body that is not an object", () => {
    expect(() => unwrapEnvelope(200, "ok")).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
    expect(() => unwrapEnvelope(200, null)).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
  });

  it("should reject a failure envelope carrying no usable error", () => {
    expect(() => unwrapEnvelope(500, { success: false, error: { code: "X" } })).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
  });

  it("should reject a body with no success discriminant", () => {
    expect(() => unwrapEnvelope(200, { items: [] })).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
  });

  it("should reject a success envelope with no data", () => {
    expect(() => unwrapEnvelope(200, { success: true })).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
  });

  it("should accept a null data payload as data", () => {
    expect(unwrapEnvelope<null>(200, { success: true, data: null })).toBeNull();
  });
});
