import { describe, expect, it, vi } from "vitest";

import { createMemoryClient, newIdempotencyKey } from "../../src/features/memory/memory-client";

/**
 * The memory client, and the one property that makes a write surface safe.
 *
 * `retry.ts` states the precondition plainly: "Retries here apply to reads only.
 * Every write in the contract requires an `Idempotency-Key`, and a retry loop
 * that does not carry one turns a timeout into a duplicate. The admin client is
 * read-only for exactly that reason; **a write surface must set the key before
 * it may reuse this.**"
 *
 * So the load-bearing test here is that the key is minted ONCE PER OPERATION and
 * survives every retry inside it. Minting inside the loop would typecheck, pass
 * a happy-path test, and silently reject the same edge twice the first time the
 * tunnel hiccuped.
 */

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function failure(code: string, status: number, retryable: boolean): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code, message: `${code} happened`, retryable, details: null, retryAfterMs: null },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const RESULT = {
  verdict: "reject",
  edge: {},
  weightBefore: 0.8,
  weightAfter: 0.016,
  surfacedRecorded: 0,
};

/** No sleeping, no jitter: a retry test that spends real seconds is a flaky one. */
const NO_WAIT = { sleep: () => Promise.resolve(), random: () => 0.5 };

/** The transport, typed as `AuthedRequest` so `mock.calls` keeps its arity. */
type RequestSpy = (path: string, init?: RequestInit) => Promise<Response>;

function spyOn(answer: (path: string, init?: RequestInit) => Response) {
  return vi.fn<RequestSpy>((path, init) => Promise.resolve(answer(path, init)));
}

describe("createMemoryClient", () => {
  it("should send the graph bounds as query parameters", async () => {
    const request = spyOn(() => envelope({ nodes: [], edges: [] }));
    const client = createMemoryClient({ request, ...NO_WAIT });

    await client.graph({ nights: 30, edges: 50 });

    expect(request.mock.calls[0]?.[0]).toContain("nights=30");
    expect(request.mock.calls[0]?.[0]).toContain("edges=50");
  });

  it("should omit a bound the caller did not give, rather than sending it empty", async () => {
    // `?nights=` is a filter on the empty string as far as a server is
    // concerned, and this one refuses it rather than coercing.
    const request = spyOn(() => envelope({ nodes: [] }));
    const client = createMemoryClient({ request, ...NO_WAIT });

    await client.graph();

    expect(request.mock.calls[0]?.[0]).toBe("/memory/graph");
  });

  it("should POST a verdict with an idempotency key and the verdict in the body", async () => {
    const request = spyOn(() => envelope(RESULT));
    const client = createMemoryClient({ request, newKey: () => "key-1", ...NO_WAIT });

    await client.judge("syl:medge:abc", "reject");

    const call = request.mock.calls[0];
    expect(call?.[0]).toBe("/memory/edges/syl%3Amedge%3Aabc/feedback");
    expect(call?.[1]?.method).toBe("POST");
    expect(new Headers(call?.[1]?.headers).get("Idempotency-Key")).toBe("key-1");
    expect(String(call?.[1]?.body)).toContain("reject");
  });

  it("should reuse ONE key across every retry of a single verdict", async () => {
    // The whole reason this client exists rather than reusing the read-only
    // one. A second key on the retry is a second rejection.
    const request = vi
      .fn<RequestSpy>()
      .mockResolvedValueOnce(failure("UPSTREAM_UNAVAILABLE", 503, true))
      .mockResolvedValueOnce(envelope(RESULT));
    let minted = 0;
    const client = createMemoryClient({
      request,
      newKey: () => {
        minted += 1;
        return `key-${String(minted)}`;
      },
      ...NO_WAIT,
    });

    await client.judge("edge-1", "reject");

    expect(request).toHaveBeenCalledTimes(2);
    expect(minted).toBe(1);
    const keys = request.mock.calls.map((call) =>
      new Headers(call[1]?.headers).get("Idempotency-Key"),
    );
    expect(keys).toEqual(["key-1", "key-1"]);
  });

  it("should not retry a refusal the contract calls final", async () => {
    // A CONFLICT means he already rejected this edge. Retrying it fifty times
    // is the worst possible answer to a state that will not change.
    const request = spyOn(() => failure("CONFLICT", 409, false));
    const client = createMemoryClient({ request, newKey: () => "key-1", ...NO_WAIT });

    await expect(client.judge("edge-1", "confirm")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("should surface a non-envelope answer as a contract failure, not as data", async () => {
    const request = spyOn(() => new Response("<html>captive portal</html>", { status: 200 }));
    const client = createMemoryClient({ request, ...NO_WAIT });

    await expect(client.metrics()).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("newIdempotencyKey", () => {
  it("should produce a different key each time", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it("should still produce one where crypto.randomUUID is missing", () => {
    // A page served over plain HTTP on the tailnet has no secure-context
    // crypto. A client that threw there would make the correction surface
    // unusable exactly where it is used.
    vi.stubGlobal("crypto", {});
    try {
      expect(newIdempotencyKey()).toMatch(/^syl-admin-/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
