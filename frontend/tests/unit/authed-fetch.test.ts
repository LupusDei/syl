import { describe, expect, it, vi } from "vitest";

import { authorizationHeader, createAuthedFetch, joinUrl } from "../../src/api/authed-fetch";

/** Records what it was called with and hands back whatever status is asked for. */
function stubFetch(status = 200): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status }));
    },
  };
}

describe("authorizationHeader", () => {
  it("should produce a bearer header for a key", () => {
    expect(authorizationHeader("sk-syl-abc")).toEqual({ Authorization: "Bearer sk-syl-abc" });
  });

  it("should trim the key, because pasted credentials carry whitespace", () => {
    expect(authorizationHeader(" sk-syl-abc ")).toEqual({ Authorization: "Bearer sk-syl-abc" });
  });

  it("should throw on a blank key rather than send `Bearer `", () => {
    expect(() => authorizationHeader("  ")).toThrow(/blank/i);
  });
});

describe("joinUrl", () => {
  it("should join a base and a path with exactly one slash", () => {
    expect(joinUrl("http://localhost:4201", "/jobs")).toBe("http://localhost:4201/jobs");
  });

  it("should insert the slash when the path does not carry one", () => {
    expect(joinUrl("/api", "jobs")).toBe("/api/jobs");
  });

  it("should not double the slash when both sides supply one", () => {
    expect(joinUrl("http://localhost:4201/", "/jobs")).toBe("http://localhost:4201/jobs");
  });

  it("should return the base unchanged for an empty path", () => {
    expect(joinUrl("/api", "")).toBe("/api");
  });
});

describe("createAuthedFetch", () => {
  it("should attach the bearer header to every request", async () => {
    const stub = stubFetch();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stub.fetch,
    });

    await request("/jobs");

    expect(stub.calls[0]?.url).toBe("/api/jobs");
    const headers = new Headers(stub.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-syl-abc");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("should preserve caller-supplied headers alongside the bearer header", async () => {
    const stub = stubFetch();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stub.fetch,
    });

    await request("/jobs", { headers: { "X-Trace": "abc" }, method: "POST" });

    const headers = new Headers(stub.calls[0]?.init?.headers);
    expect(headers.get("x-trace")).toBe("abc");
    expect(headers.get("authorization")).toBe("Bearer sk-syl-abc");
    expect(stub.calls[0]?.init?.method).toBe("POST");
  });

  it("should let the caller override Accept when they want a non-JSON body", async () => {
    const stub = stubFetch();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stub.fetch,
    });

    await request("/logs", { headers: { Accept: "text/plain" } });

    expect(new Headers(stub.calls[0]?.init?.headers).get("accept")).toBe("text/plain");
  });

  it("should notify onUnauthorized when the server rejects the key", async () => {
    const onUnauthorized = vi.fn();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stubFetch(401).fetch,
      onUnauthorized,
    });

    const response = await request("/jobs");

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // The transport reports; it does not decide. Callers still see the response.
    expect(response.status).toBe(401);
  });

  it("should notify onUnauthorized on 403 as well as 401", async () => {
    const onUnauthorized = vi.fn();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stubFetch(403).fetch,
      onUnauthorized,
    });

    await request("/jobs");

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("should not notify onUnauthorized for a successful response", async () => {
    const onUnauthorized = vi.fn();
    const request = createAuthedFetch({
      baseUrl: "/api",
      apiKey: "sk-syl-abc",
      fetch: stubFetch(200).fetch,
      onUnauthorized,
    });

    await request("/jobs");

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("should default to the global fetch when none is injected", async () => {
    const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", spy);
    try {
      await createAuthedFetch({ baseUrl: "/api", apiKey: "sk-syl-abc" })("/jobs");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should refuse to build a transport around a blank key", () => {
    expect(() => createAuthedFetch({ baseUrl: "/api", apiKey: "" })).toThrow(/blank/i);
  });
});
