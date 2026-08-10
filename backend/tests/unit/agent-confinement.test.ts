import { randomUUID } from "node:crypto";

import type { ApiError, TokenGrant } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, API_BASE_PATH } from "../../src/index.js";
import {
  AGENT_SURFACE,
  beyondAgentReach,
  confineAgent,
  type AuthenticatedContext,
} from "../../src/middleware/auth.js";
import { ApiFailure } from "../../src/routes/envelope.js";
import { THE_COMMANDER, type ApiKeyService, type KeyScope } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * What the `agent` scope MEANS, which is not what the column says.
 *
 * The column only makes the value expressible. The content of the scope is
 * this: Syl's own credential reaches reminders, to-dos and goals, and nothing
 * else on the contract. Every assertion here is about a door being shut.
 *
 * Two properties are load-bearing and neither is obvious from reading the
 * middleware:
 *
 * 1. **The confinement is an ALLOWLIST, so it is closed by default.** A router
 *    mounted tomorrow is out of her reach until somebody adds it to
 *    `AGENT_SURFACE` on purpose. A denylist would have the opposite default and
 *    would silently hand her every future surface.
 * 2. **A 403 sits BEHIND the ordinary 401.** An anonymous caller must never
 *    learn that scopes exist, so every refusal below is also checked from a
 *    caller with no token at all — which must get the indistinguishable 401.
 */

let db: SylDatabase;
let keys: ApiKeyService;
let running: RunningApp;

beforeEach(async () => {
  db = testDatabase();
  const deps = testDeps(db);
  keys = deps.keys;
  running = await startTestApp(createApp(testConfig(), deps));
});

afterEach(async () => {
  await running.close();
  db.close();
});

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

/** Syl's own credential, as `bootstrap` mints it. */
function agentToken(): string {
  return keys.mint("Syl (her own hands)", { scope: "agent" }).token;
}

/** A paired phone's credential, through the published route. */
async function deviceToken(): Promise<string> {
  const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ pairingCode: keys.issuePairingCode().code, deviceName: "iPhone" }),
  });
  const body = (await response.json()) as Envelope<TokenGrant>;
  return (body.data as TokenGrant).token;
}

async function call(
  method: string,
  path: string,
  options: { readonly token?: string; readonly body?: unknown } = {},
): Promise<Response> {
  return fetch(`${running.baseUrl}${API_BASE_PATH}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      "Idempotency-Key": randomUUID(),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** The error code a response carries, or `null` when it succeeded. */
async function codeOf(response: Response): Promise<string | null> {
  const body = (await response.json()) as Envelope<unknown>;
  return body.error?.code ?? null;
}

/**
 * Every surface she must not reach, with a request that would otherwise work.
 *
 * Spelled out rather than derived, because a derived list would be derived from
 * the same allowlist the code uses and would agree with a mistake in it.
 */
const OUT_OF_REACH: [method: string, path: string, body?: unknown][] = [
  ["GET", "/logs"],
  ["GET", "/devices"],
  ["POST", "/devices", { token: "a".repeat(64), platform: "ios", environment: "production" }],
  ["GET", "/auth/whoami"],
  ["GET", "/conversations"],
  ["GET", "/sync"],
  ["GET", "/jobs"],
  ["GET", "/deliveries"],
];

describe("the agent scope, over HTTP", () => {
  describe("what she may reach", () => {
    it("should let her create a reminder", async () => {
      const response = await call("POST", "/reminders", {
        token: agentToken(),
        body: { text: "Stand up", wallTime: "07:30", tz: "America/Chicago", date: "2026-08-10" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her read the reminders back, so she can confirm from the store", async () => {
      const response = await call("GET", "/reminders", { token: agentToken() });

      expect(response.status).toBe(200);
    });

    it("should let her create a to-do", async () => {
      const response = await call("POST", "/todos", {
        token: agentToken(),
        body: { text: "Book the flight" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her create a goal", async () => {
      const response = await call("POST", "/goals", {
        token: agentToken(),
        body: { title: "Ship the hands" },
      });

      expect(response.status).toBe(201);
    });

    it("should let her reach a single reminder by id, not merely the collection", async () => {
      const created = await call("POST", "/reminders", {
        token: agentToken(),
        body: { text: "Stand up", wallTime: "07:30", tz: "America/Chicago", date: "2026-08-10" },
      });
      const { data } = (await created.json()) as Envelope<{ id: string }>;
      const response = await call("GET", `/reminders/${encodeURIComponent(data?.id ?? "")}`, {
        token: agentToken(),
      });

      expect(response.status).toBe(200);
    });
  });

  describe("what she may not", () => {
    it.each(OUT_OF_REACH)("should refuse %s %s with a 403", async (method, path, body) => {
      const response = await call(method, path, {
        token: agentToken(),
        ...(body === undefined ? {} : { body }),
      });

      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe("FORBIDDEN");
    });

    it.each(OUT_OF_REACH)(
      "should answer %s %s with an indistinguishable 401 when nobody presented a token",
      async (method, path, body) => {
        // The ordering property. Reversed, an anonymous caller would be told a
        // scope exists — a fact about the service they have not earned.
        const response = await call(method, path, body === undefined ? {} : { body });

        expect(response.status).toBe(401);
        expect(await codeOf(response)).toBe("UNAUTHORIZED");
      },
    );

    it("should refuse her the logs even though the log route has its own admin gate", async () => {
      // Two gates now cover `/logs` and they must not be confused for one. The
      // confinement refuses her before `requireScope("admin")` is reached; if
      // somebody later relaxed the admin gate, this still holds.
      const response = await call("GET", "/logs", { token: agentToken() });
      const body = (await response.json()) as Envelope<unknown>;

      expect(response.status).toBe(403);
      expect(body.error?.message).not.toContain("npm run pair");
    });

    it("should tell her what she may reach, so she can say what went wrong", async () => {
      // A refusal she cannot explain reaches the Commander as "something
      // failed". The message is the difference between that and a sentence.
      const response = await call("GET", "/devices", { token: agentToken() });
      const body = (await response.json()) as Envelope<unknown>;

      expect(body.error?.message).toMatch(/reminders/u);
      expect(body.error?.retryable).toBe(false);
    });
  });

  describe("what the phone keeps", () => {
    it("should leave a paired device reaching everything it always could", async () => {
      const token = await deviceToken();

      expect((await call("GET", "/devices", { token })).status).toBe(200);
      expect((await call("GET", "/conversations", { token })).status).toBe(200);
      expect((await call("GET", "/reminders", { token })).status).toBe(200);
    });

    it("should still refuse a paired device the logs, which is admin's alone", async () => {
      const response = await call("GET", "/logs", { token: await deviceToken() });

      expect(response.status).toBe(403);
    });

    it("should leave an admin key reaching the logs", async () => {
      const token = keys.mint("Web admin (console)", { scope: "admin" }).token;
      const response = await call("GET", "/logs", { token });

      expect(response.status).toBe(200);
    });
  });
});

/**
 * The middleware's own contract, including the cases no route can produce.
 */
describe("confineAgent", () => {
  /** A request carrying what `requireBearerToken` would have set. */
  function requestWith(
    scope: KeyScope | undefined,
    originalUrl: string,
  ): Parameters<ReturnType<typeof confineAgent>>[0] {
    const auth: AuthenticatedContext | undefined =
      scope === undefined
        ? undefined
        : {
            principal: THE_COMMANDER,
            key: {
              id: "syl:apikey:0198f100-0000-7000-8000-0000000000ff",
              deviceName: "A device",
              tokenSuffix: "abcd",
              scope,
              createdAt: "2026-08-09T07:00:00.000Z",
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
              revokedReason: null,
            },
          };
    // Safe: `confineAgent` reads `auth` and `originalUrl` and nothing else.
    return { ...(auth === undefined ? {} : { auth }), originalUrl } as Parameters<
      ReturnType<typeof confineAgent>
    >[0];
  }

  /** Run the middleware and return whatever it handed `next`. */
  function run(scope: KeyScope | undefined, originalUrl: string): unknown {
    let passed: unknown = "not called";
    confineAgent({ basePath: "/api/v1", onRefused: () => undefined })(
      requestWith(scope, originalUrl),
      {} as never,
      ((error?: unknown) => {
        passed = error;
      }) as never,
    );
    return passed;
  }

  it("should pass an agent request to a surface she owns", () => {
    expect(run("agent", "/api/v1/reminders")).toBeUndefined();
  });

  it("should pass a query string through rather than reading it as part of the path", () => {
    expect(run("agent", "/api/v1/todos?limit=5")).toBeUndefined();
  });

  it("should refuse an agent request to anything else", () => {
    const refusal = run("agent", "/api/v1/logs");

    expect(refusal).toBeInstanceOf(ApiFailure);
    expect((refusal as ApiFailure).code).toBe("FORBIDDEN");
    expect((refusal as ApiFailure).status).toBe(403);
  });

  it("should not be fooled by a path that merely starts with an allowed word", () => {
    // `/remindersecret` is not `/reminders`, and a naive `startsWith` says it
    // is. The boundary is a segment boundary.
    expect(run("agent", "/api/v1/remindersecret")).toBeInstanceOf(ApiFailure);
    expect(run("agent", "/api/v1/goalsandlogs")).toBeInstanceOf(ApiFailure);
  });

  it("should refuse a path that walks out of an allowed surface", () => {
    // Nothing in Express routes `..` today, so this is a guard against a
    // normalising proxy rather than a live hole — and it is exactly the guard
    // that stops an allowlist matched on a raw path from being a bypass.
    expect(run("agent", "/api/v1/reminders/../logs")).toBeInstanceOf(ApiFailure);
    expect(run("agent", "/api/v1/reminders/%2e%2e/logs")).toBeInstanceOf(ApiFailure);
  });

  it("should refuse a path whose escaping it cannot read", () => {
    expect(run("agent", "/api/v1/reminders/%zz")).toBeInstanceOf(ApiFailure);
  });

  it("should still allow an id whose colons are percent-encoded", () => {
    // Syl's ids contain colons and every client encodes them, so a guard that
    // treated `%` as suspicious would close the one surface she has.
    expect(
      run("agent", "/api/v1/reminders/syl%3Areminder%3A0198f100-0000-7000-8000-000000000001"),
    ).toBeUndefined();
  });

  it("should leave every other scope alone", () => {
    expect(run("device", "/api/v1/logs")).toBeUndefined();
    expect(run("admin", "/api/v1/logs")).toBeUndefined();
  });

  it("should refuse loudly when it is mounted with no authentication in front of it", () => {
    // Reading `undefined !== "agent"` would PASS an unauthenticated request,
    // which is the dangerous direction for a confinement: it fails open.
    const refusal = run(undefined, "/api/v1/logs");

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(ApiFailure);
    expect((refusal as Error).message).toContain("requireBearerToken");
  });

  it("should record the refusal where an operator can see it", () => {
    const refusals: string[] = [];
    confineAgent({ basePath: "/api/v1", onRefused: (path) => refusals.push(path) })(
      requestWith("agent", "/api/v1/devices"),
      {} as never,
      (() => undefined) as never,
    );

    expect(refusals).toEqual(["/api/v1/devices"]);
  });
});

describe("AGENT_SURFACE", () => {
  it("should be the product's own nouns and nothing else", () => {
    // A canary on the boundary itself. Adding to this list is a decision about
    // what Syl can do on the Commander's machine, so it should not be possible
    // to make it as a side effect of some other change.
    expect([...AGENT_SURFACE].sort()).toEqual(["/goals", "/reminders", "/todos"]);
  });
});

describe("beyondAgentReach", () => {
  it("should name what she can do rather than only what she cannot", () => {
    expect(beyondAgentReach("/api/v1/devices").message).toMatch(/reminders, to-dos and goals/u);
  });

  it("should not be retryable — a scope does not change on a second try", () => {
    expect(beyondAgentReach("/api/v1/devices").toApiError().retryable).toBe(false);
  });

  it("should be the contract's FORBIDDEN, so it renders as a 403", () => {
    expect(beyondAgentReach("/api/v1/logs").code).toBe("FORBIDDEN");
    expect(beyondAgentReach("/api/v1/logs").status).toBe(403);
  });
});
