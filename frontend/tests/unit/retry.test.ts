import { describe, expect, it, vi } from "vitest";

import type { ErrorEnvelope } from "@syl/shared/types";

import { fixture } from "../helpers/fixtures";

import { apiFailure, malformedResponse, networkFailure } from "../../src/api/errors";
import { backoffDelayMs, DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from "../../src/api/retry";

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.25,
};

/** No jitter: 0.5 sits exactly on the exponential value. */
const centred = (): number => 0.5;

function apiError(name: string, status: number): ReturnType<typeof apiFailure> {
  return apiFailure(status, (fixture(name) as ErrorEnvelope).error);
}

/** Records the delays it was asked to wait, and waits none of them. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe("backoffDelayMs", () => {
  it("should double the delay with each failed attempt", () => {
    expect(backoffDelayMs(POLICY, 1, null, centred)).toBe(100);
    expect(backoffDelayMs(POLICY, 2, null, centred)).toBe(200);
    expect(backoffDelayMs(POLICY, 3, null, centred)).toBe(400);
  });

  it("should cap the exponential growth", () => {
    expect(backoffDelayMs(POLICY, 20, null, centred)).toBe(POLICY.maxDelayMs);
  });

  it("should spread the delay either side of the exponential value", () => {
    expect(backoffDelayMs(POLICY, 1, null, () => 0)).toBe(75);
    expect(backoffDelayMs(POLICY, 1, null, () => 1)).toBe(125);
  });

  it("should treat the server's retryAfterMs as a floor that outranks the cap", () => {
    // The server knows something we do not — including that its floor is
    // longer than any delay we would have chosen.
    expect(backoffDelayMs(POLICY, 1, 30_000, centred)).toBe(30_000);
  });

  it("should ignore the exponential when it already exceeds the server's floor", () => {
    expect(backoffDelayMs(POLICY, 3, 50, centred)).toBe(400);
  });

  it("should ignore a non-finite floor", () => {
    expect(backoffDelayMs(POLICY, 1, Number.NaN, centred)).toBe(100);
  });

  it("should never return a negative delay", () => {
    const wild: RetryPolicy = { ...POLICY, jitterRatio: 4 };
    expect(backoffDelayMs(wild, 1, null, () => 0)).toBe(0);
  });

  it("should ship a default policy that retries but does not hammer", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.jitterRatio).toBeGreaterThan(0);
  });
});

describe("withRetry", () => {
  it("should return the first result without sleeping", async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(() => Promise.resolve("ok"));

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("should retry a retryable failure and honour the server's backoff floor", async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError("errors/rate_limited", 429))
      .mockResolvedValueOnce("ok");

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2_000]);
  });

  it("should retry a network failure, because the tunnel comes back", async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(networkFailure(new TypeError("Failed to fetch")))
      .mockResolvedValueOnce("ok");

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).resolves.toBe("ok");
    expect(delays).toEqual([100]);
  });

  it("should stop at maxAttempts and rethrow the last failure", async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(networkFailure(new TypeError("Failed to fetch")));

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).rejects.toThrowError(
      expect.objectContaining({ kind: "network" }) as Error,
    );
    expect(operation).toHaveBeenCalledTimes(POLICY.maxAttempts);
    expect(delays).toEqual([100, 200]);
  });

  it("should never retry an auth failure", async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(apiError("errors/unauthorized", 401));

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).rejects.toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED" }) as Error,
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("should never retry a malformed response", async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(malformedResponse(200, "x"));

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).rejects.toThrowError(
      expect.objectContaining({ kind: "malformed" }) as Error,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should propagate an abort on the first throw", async () => {
    const { sleep } = recordingSleep();
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(abort);

    await expect(withRetry(operation, { policy: POLICY, sleep, random: centred })).rejects.toBe(abort);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should fall back to the default policy and a real timer", async () => {
    // Exercises the un-injected defaults: no policy, no sleep, no random.
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(networkFailure(new TypeError("Failed to fetch")))
      .mockResolvedValueOnce("ok");

    await expect(withRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
