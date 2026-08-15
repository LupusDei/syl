import { describe, expect, it, vi } from "vitest";

import { AdminApiError } from "../../src/api/errors";
import { createHealthClient } from "../../src/features/health/health-client";
import type { AuthedRequest } from "../../src/api/use-authed-fetch";

/**
 * The health client.
 *
 * The interesting half is {@link asSeries}'s defensiveness, and it is not
 * paranoia about a flaky server: `GET /health/series` is **not in
 * `shared/openapi.yaml`**, so nothing in the contract suite is checking that the
 * field this whole view branches on arrives at all. A missing `state` must land
 * as "we have never been told" and never as a silent `authorised`, because the
 * second draws a flat line that claims to be about his body.
 */

const NO_RETRY = { policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } };

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(request: AuthedRequest) {
  return createHealthClient({ request, ...NO_RETRY });
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "steps",
    unit: "count",
    state: "authorised",
    reportedAt: "2026-08-13T06:00:00.000Z",
    silenceIsEvidence: true,
    watermark: "2026-08-13T05:00:00.000Z",
    samples: [],
    ...overrides,
  };
}

describe("createHealthClient", () => {
  it("should ask for the type and the window it was given", async () => {
    const request = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(ok(payload())));
    await clientFor(request).series({
      type: "steps",
      from: "2026-08-12T00:00:00.000Z",
      to: "2026-08-13T00:00:00.000Z",
    });

    const path = String(request.mock.calls[0]?.[0]);
    expect(path).toContain("/health/series?");
    expect(path).toContain("type=steps");
    expect(path).toContain("from=2026-08-12T00%3A00%3A00.000Z");
    expect(path).toContain("to=2026-08-13T00%3A00%3A00.000Z");
  });

  it("should omit an unset bound rather than sending an empty one", async () => {
    const request = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(ok(payload())));
    await clientFor(request).series({ type: "steps" });
    expect(String(request.mock.calls[0]?.[0])).toBe("/health/series?type=steps");
  });

  it("should return the authorisation state and the samples together", async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        ok(
          payload({
            samples: [
              {
                type: "steps",
                startedAt: "2026-08-13T05:00:00.000Z",
                endedAt: "2026-08-13T05:01:00.000Z",
                value: 42,
                source: "iPhone",
                recordedAt: "2026-08-13T05:02:00.000Z",
              },
            ],
          }),
        ),
      ),
    );
    const series = await clientFor(request).series({ type: "steps" });

    expect(series.state).toBe("authorised");
    expect(series.silenceIsEvidence).toBe(true);
    expect(series.watermark).toBe("2026-08-13T05:00:00.000Z");
    expect(series.samples.length).toBe(1);
  });

  it("should read a missing state as `null`, NOT as authorised", async () => {
    // The one that matters. A defaulted `authorised` would make an empty
    // window read as "nothing happened" on a type nobody ever looked at.
    const request = vi.fn(() => Promise.resolve(ok(payload({ state: null }))));
    const series = await clientFor(request).series({ type: "steps" });
    expect(series.state).toBeNull();
  });

  it("should read an unrecognised state as `null` rather than guessing at it", async () => {
    const request = vi.fn(() => Promise.resolve(ok(payload({ state: "probably-fine" }))));
    const series = await clientFor(request).series({ type: "steps" });
    expect(series.state).toBeNull();
  });

  it("should treat anything but a literal `true` silence flag as false", async () => {
    const request = vi.fn(() => Promise.resolve(ok(payload({ silenceIsEvidence: "true" }))));
    const series = await clientFor(request).series({ type: "steps" });
    expect(series.silenceIsEvidence).toBe(false);
  });

  it("should read the grounds for an inferred `unavailable` when they are complete", async () => {
    // `syl-8ys9.3.3`. The one field on this shape the phone did not produce:
    // the server's own judgement that nothing has ever published this type.
    const request = vi.fn(() =>
      Promise.resolve(
        ok(
          payload({
            type: "heartRateVariability",
            state: "unavailable",
            silenceIsEvidence: false,
            unpublished: {
              type: "heartRateVariability",
              reported: "denied",
              from: "2026-07-10",
              to: "2026-08-13",
              corroboratedDays: 35,
              corroboratedBy: ["heartRate", "steps", "nonsense"],
              because: "Not one heartRateVariability sample has ever been held.",
            },
          }),
        ),
      ),
    );
    const series = await clientFor(request).series({ type: "heartRateVariability" });

    expect(series.unpublished?.reported).toBe("denied");
    expect(series.unpublished?.corroboratedDays).toBe(35);
    // A type name it does not know is dropped rather than rendered as a label
    // lookup that comes back `undefined` on the screen.
    expect(series.unpublished?.corroboratedBy).toEqual(["heartRate", "steps"]);
  });

  it("should discard half-formed grounds rather than render a claim with no window under it", async () => {
    // Fail closed, exactly as `state` does. A finding missing its window is an
    // assertion about his equipment with nothing to check it against, and the
    // honest fallback is the state the phone reported.
    const request = vi.fn(() =>
      Promise.resolve(ok(payload({ unpublished: { reported: "denied", corroboratedDays: 35 } }))),
    );
    const series = await clientFor(request).series({ type: "steps" });
    expect(series.unpublished).toBeNull();
  });

  it("should read an absent `unpublished` as null, so nothing infers a judgement", async () => {
    const request = vi.fn(() => Promise.resolve(ok(payload())));
    const series = await clientFor(request).series({ type: "steps" });
    expect(series.unpublished).toBeNull();
  });

  it("should refuse a series answered under a DIFFERENT type", async () => {
    // It would otherwise be charted under the wrong heading, which is worse
    // than no chart at all.
    const request = vi.fn(() => Promise.resolve(ok(payload({ type: "heartRate" }))));
    await expect(clientFor(request).series({ type: "steps" })).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("should refuse a payload with no samples array rather than inventing an empty one", async () => {
    const request = vi.fn(() => Promise.resolve(ok(payload({ samples: undefined }))));
    await expect(clientFor(request).series({ type: "steps" })).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("should surface a refusal envelope as a typed api failure", async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            error: { code: "VALIDATION_FAILED", message: "type must be one of …", retryable: false },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(clientFor(request).series({ type: "steps" })).rejects.toMatchObject({
      kind: "api",
      code: "VALIDATION_FAILED",
    });
  });

  it("should report a body that is not JSON as malformed, not as empty data", async () => {
    const request = vi.fn(() =>
      Promise.resolve(new Response("<html>nope</html>", { status: 200 })),
    );
    await expect(clientFor(request).series({ type: "steps" })).rejects.toMatchObject({
      kind: "malformed",
    });
  });

  it("should report a request that never arrived as a network failure", async () => {
    const request = vi.fn(() => Promise.reject(new Error("tunnel down")));
    const failure = await clientFor(request)
      .series({ type: "steps" })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect((failure as AdminApiError).kind).toBe("network");
  });

  it("should let an abort through untouched, so a superseded window is not reported as broken", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const request = vi.fn(() => Promise.reject(abort));
    await expect(clientFor(request).series({ type: "steps" })).rejects.toBe(abort);
  });

  it("should pass the abort signal down to the transport", async () => {
    const request = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(ok(payload())));
    const controller = new AbortController();
    await clientFor(request).series({ type: "steps" }, { signal: controller.signal });
    expect(request.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
