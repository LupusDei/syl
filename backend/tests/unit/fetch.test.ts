import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FetchRefused, safeFetch } from "../../src/connections/fetch.js";

/**
 * The transport is driven against a real loopback server.
 *
 * Loopback is of course exactly what the guard refuses, so these tests pass a
 * permissive `isAllowed`. That is not a hole: the guard is a pure function
 * with its own exhaustive suite in `address-guard.test.ts`, and what is being
 * tested here is the *other* half — schemes, redirects, size and time limits —
 * which cannot be exercised without a socket. The default remains
 * `isPublicAddress`, and there is a test below that it is.
 */
const allowLoopback = { isAllowed: (): boolean => true };

let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) {
    await new Promise<void>((resolve) => running.close(() => resolve()));
  }
});

/** Start a loopback server with the given handler; return its origin. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
  const { port } = created.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A server bound to every loopback family, so `localhost` reaches it however
 * the resolver orders its answers. Returns the port.
 */
async function serveAnyInterface(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, () => resolve()));
  return (created.address() as AddressInfo).port;
}

/** Run `safeFetch` and return the refusal it threw. */
async function refusalOf(promise: Promise<unknown>): Promise<FetchRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchRefused) return error;
    throw error;
  }
  throw new Error("Expected a refusal, got a result.");
}

describe("schemes", () => {
  it("should refuse file:, which is not a fetch", async () => {
    const refusal = await refusalOf(safeFetch("file:///etc/passwd"));

    expect(refusal.reason).toBe("scheme");
  });

  it("should refuse every other exotic scheme", async () => {
    for (const url of ["gopher://x/1", "data:text/plain,hello", "ftp://x/y", "jar:file:///x"]) {
      expect((await refusalOf(safeFetch(url))).reason).toBe("scheme");
    }
  });

  it("should refuse something that is not a URL at all", async () => {
    expect((await refusalOf(safeFetch("not a url"))).reason).toBe("malformed_url");
  });
});

describe("the address guard", () => {
  it("should refuse loopback by default, without being asked", async () => {
    // The default is the whole point. A fetcher that is safe only when
    // configured safely is a fetcher that will one day be configured wrongly.
    const origin = await serve((_request, response) => response.end("secrets"));

    const refusal = await refusalOf(safeFetch(`${origin}/`));

    expect(refusal.reason).toBe("blocked_address");
    expect(refusal.addressClass).toBe("loopback");
  });

  it("should refuse a literal tailnet address, which never reaches a DNS hook", async () => {
    // Node connects directly when the host is already an IP, so the guarded
    // `lookup` — the whole mechanism for vetting a destination — is simply not
    // called. `http://100.100.42.7:4201/` would otherwise sail through.
    const refusal = await refusalOf(safeFetch("http://100.100.42.7:4201/api/v1/reminders"));

    expect(refusal.reason).toBe("blocked_address");
    expect(refusal.addressClass).toBe("carrier_grade_nat");
  });

  it("should refuse a literal IPv6 address in brackets", async () => {
    const refusal = await refusalOf(safeFetch("http://[::1]:4201/"));

    expect(refusal.reason).toBe("blocked_address");
    expect(refusal.addressClass).toBe("loopback");
  });

  it("should refuse the cloud metadata endpoint by literal address", async () => {
    expect((await refusalOf(safeFetch("http://169.254.169.254/latest/meta-data/"))).reason).toBe(
      "blocked_address",
    );
  });

  it("should refuse a NAME that resolves to a blocked address", async () => {
    // The case the guarded lookup exists for: the URL reveals nothing, and the
    // destination is only knowable after DNS answers. `localhost` stands in
    // for `articles.example.com` with an A record pointing at the tailnet.
    const port = await serveAnyInterface((_request, response) => response.end("secrets"));

    const refusal = await refusalOf(safeFetch(`http://localhost:${port}/`));

    expect(refusal.reason).toBe("blocked_address");
    expect(refusal.message).toContain("localhost");
  });

  it("should connect through the guarded lookup when the address is acceptable", async () => {
    const port = await serveAnyInterface((_request, response) => response.end("fine"));

    const result = await safeFetch(`http://localhost:${port}/`, allowLoopback);

    expect(result.body).toBe("fine");
  });

  it("should refuse a name that does not resolve, as a refusal not a raw DNS error", async () => {
    const refusal = await refusalOf(
      safeFetch("http://syl-no-such-host.invalid/", { timeoutMs: 2_000 }),
    );

    expect(refusal.reason).toBe("dns");
  });

  it("should say which class of address it refused, for the log", async () => {
    const refusal = await refusalOf(safeFetch("http://127.0.0.1:1/"));

    expect(refusal.message).toContain("127.0.0.1");
    expect(refusal.message).toContain("loopback");
  });
});

describe("fetching", () => {
  it("should return the body, status and headers", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hello");
    });

    const result = await safeFetch(`${origin}/article`, allowLoopback);

    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.bytes).toBe(5);
  });

  it("should return a non-2xx rather than throwing, since 404 is an answer", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(404);
      response.end("gone");
    });

    expect((await safeFetch(`${origin}/x`, allowLoopback)).status).toBe(404);
  });

  it("should refuse a response larger than it agreed to read", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200);
      response.end("x".repeat(10_000));
    });

    const refusal = await refusalOf(safeFetch(`${origin}/`, { ...allowLoopback, maxBytes: 100 }));

    expect(refusal.reason).toBe("too_large");
  });

  it("should give up on a server that never answers", async () => {
    const origin = await serve(() => {
      // Deliberately no response: a hostile host that accepts the connection
      // and then holds it is a denial of service against the job runner, and
      // the runner's concurrency limit is one.
    });

    const refusal = await refusalOf(safeFetch(`${origin}/`, { ...allowLoopback, timeoutMs: 150 }));

    expect(refusal.reason).toBe("timeout");
  });

  it("should turn a connection failure into a refusal, not a raw system error", async () => {
    const refusal = await refusalOf(
      safeFetch("http://127.0.0.1:1/", { ...allowLoopback, timeoutMs: 500 }),
    );

    expect(refusal).toBeInstanceOf(FetchRefused);
    expect(["transport", "timeout"]).toContain(refusal.reason);
  });
});

describe("redirects", () => {
  it("should follow a redirect that stays on the same host", async () => {
    const origin = await serve((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/end" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end("arrived");
    });

    const result = await safeFetch(`${origin}/start`, allowLoopback);

    expect(result.body).toBe("arrived");
    expect(result.url).toBe(`${origin}/end`);
    expect(result.chain).toHaveLength(2);
  });

  it("should REFUSE a redirect to another host", async () => {
    // This is the attack. A URL that passes every check, served by a host that
    // then points at 100.100.42.7 — Syl's own API, from inside her trust zone.
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: "http://100.100.42.7:4201/api/v1/reminders" });
      response.end();
    });

    const refusal = await refusalOf(safeFetch(`${origin}/`, allowLoopback));

    expect(refusal.reason).toBe("cross_host_redirect");
    expect(refusal.message).toContain("100.100.42.7");
  });

  it("should refuse a cross-host redirect even to somewhere entirely public", async () => {
    // Re-validating the new host would be almost enough, and "almost" is a
    // second attempt at picking a destination.
    const origin = await serve((_request, response) => {
      response.writeHead(301, { location: "https://example.com/" });
      response.end();
    });

    expect((await refusalOf(safeFetch(`${origin}/`, allowLoopback))).reason).toBe(
      "cross_host_redirect",
    );
  });

  it("should refuse a redirect that only changes the port", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: "http://127.0.0.1:9/" });
      response.end();
    });

    expect((await refusalOf(safeFetch(`${origin}/`, allowLoopback))).reason).toBe(
      "cross_host_redirect",
    );
  });

  it("should refuse a redirect to a scheme it does not fetch", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(302, { location: "file:///etc/passwd" });
      response.end();
    });

    expect((await refusalOf(safeFetch(`${origin}/`, allowLoopback))).reason).toBe("scheme");
  });

  it("should stop rather than loop forever on a redirect cycle", async () => {
    const origin = await serve((request, response) => {
      response.writeHead(302, { location: request.url === "/a" ? "/b" : "/a" });
      response.end();
    });

    const refusal = await refusalOf(
      safeFetch(`${origin}/a`, { ...allowLoopback, maxRedirects: 3 }),
    );

    expect(refusal.reason).toBe("too_many_redirects");
  });

  it("should record every hop, so a log can show where it was led", async () => {
    const origin = await serve((request, response) => {
      if (request.url === "/1") {
        response.writeHead(302, { location: "/2" });
        response.end();
        return;
      }
      if (request.url === "/2") {
        response.writeHead(302, { location: "/3" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end("done");
    });

    const result = await safeFetch(`${origin}/1`, allowLoopback);

    expect(result.chain).toEqual([`${origin}/1`, `${origin}/2`, `${origin}/3`]);
  });
});

describe("headers", () => {
  it("should send an accept header a text site will understand", async () => {
    let seen = "";
    const origin = await serve((request, response) => {
      seen = String(request.headers.accept);
      response.end("ok");
    });

    await safeFetch(`${origin}/`, allowLoopback);

    expect(seen).toContain("text/html");
  });

  it("should let a caller add headers without losing the defaults", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const origin = await serve((request, response) => {
      seen = request.headers;
      response.end("ok");
    });

    await safeFetch(`${origin}/`, { ...allowLoopback, headers: { "user-agent": "syl/0.1" } });

    expect(seen["user-agent"]).toBe("syl/0.1");
    expect(seen["accept"]).toBeDefined();
  });
});
