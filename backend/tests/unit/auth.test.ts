import { randomUUID } from "node:crypto";

import type { ApiError, Principal, TokenGrant } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/index.js";
import { bearerToken, forbidden, requireScope } from "../../src/middleware/auth.js";
import { ApiFailure } from "../../src/routes/envelope.js";
import type { AuthenticatedContext } from "../../src/middleware/auth.js";
import { THE_COMMANDER, type ApiKeyService } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

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

/**
 * A fresh `Idempotency-Key` per call unless the test names one. Pairing is a
 * write and the contract requires the header on every write; a test that wants
 * to model a lost response has to pass the same key twice, deliberately.
 */
async function post(
  path: string,
  body: unknown,
  options: { readonly token?: string; readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      // `null` means "send none", which is its own test case.
      ...(options.idempotencyKey === null
        ? {}
        : { "Idempotency-Key": options.idempotencyKey ?? randomUUID() }),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, authorization?: string): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** Pair a device through the HTTP surface and return its token. */
async function pair(deviceName = "Commander's iPhone"): Promise<string> {
  const response = await post("/auth/pair", {
    pairingCode: keys.issuePairingCode().code,
    deviceName,
  });
  const body = (await response.json()) as Envelope<TokenGrant>;
  // Non-null: the caller only uses this on the happy path, and a failure here
  // should surface as a missing-property error rather than a silent undefined.
  return (body.data as TokenGrant).token;
}

describe("POST /api/v1/auth/pair", () => {
  it("should return a Bearer grant for a live pairing code", async () => {
    const response = await post("/auth/pair", {
      pairingCode: keys.issuePairingCode().code,
      deviceName: "Commander's iPhone",
    });
    const body = (await response.json()) as Envelope<TokenGrant>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.tokenType).toBe("Bearer");
    expect(body.data?.principal).toEqual(THE_COMMANDER);
  });

  it("should need no token of its own, since it is how a device gets one", async () => {
    const response = await post("/auth/pair", {
      pairingCode: keys.issuePairingCode().code,
      deviceName: "Commander's iPhone",
    });

    expect(response.status).toBe(200);
  });

  it("should refuse a wrong code as UNAUTHORIZED, not NOT_FOUND", async () => {
    // A caller who can tell "no code active" from "wrong code" can learn when
    // a pairing window is open, and there are only a hundred million codes.
    keys.issuePairingCode();

    const response = await post("/auth/pair", {
      pairingCode: "0000-0000",
      deviceName: "Attacker",
    });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("should give the same answer whether or not a code is active", async () => {
    const withoutCode = await post("/auth/pair", {
      pairingCode: "0000-0000",
      deviceName: "Attacker",
    });
    const withoutBody = (await withoutCode.json()) as Envelope<never>;

    keys.issuePairingCode();
    const withCode = await post("/auth/pair", {
      pairingCode: "0000-0000",
      deviceName: "Attacker",
    });
    const withBody = (await withCode.json()) as Envelope<never>;

    expect(withoutBody.error).toEqual(withBody.error);
  });

  /**
   * `syl-q1f` — the four states a pairing screen has to render.
   *
   * On a phone, with no debugger and no console, "that did not work" is the
   * difference between a product and a demo: wrong digits, a stale code, a
   * code already spent, and a Mac that is simply not reachable all have
   * *different next actions*, and rendering them identically sends the
   * Commander round the same loop four times.
   *
   * The fourth state has no test here because it cannot: "cannot reach the
   * server" is the absence of a response, and it is the client that has to
   * tell it from a refusal. `SylKit`'s `APIError.transport` is that seam, and
   * `PairingViewModel` is where the two meet.
   */
  describe("the states a pairing screen must tell apart", () => {
    it("should say a code has expired, but only to somebody who has it", async () => {
      const code = keys.issuePairingCode().code;
      // Superseded by the next issue, which is the ordinary way a code dies:
      // he ran the pairing command twice and typed the first slip.
      keys.issuePairingCode();

      const response = await post("/auth/pair", { pairingCode: code, deviceName: "iPhone" });
      const body = (await response.json()) as Envelope<never>;

      expect(response.status).toBe(401);
      expect(body.error?.code).toBe("PAIRING_CODE_EXPIRED");
      expect(body.error?.retryable).toBe(false);
      expect(body.error?.message).toContain("npm run pair");
    });

    it("should say a code has already paired something, rather than 'wrong code'", async () => {
      const code = keys.issuePairingCode().code;
      await post("/auth/pair", { pairingCode: code, deviceName: "Commander's iPhone" });

      const second = await post("/auth/pair", { pairingCode: code, deviceName: "Second attempt" });
      const body = (await second.json()) as Envelope<never>;

      expect(second.status).toBe(401);
      expect(body.error?.code).toBe("PAIRING_CODE_ALREADY_USED");
      // And it really did not pair anything.
      expect(keys.list()).toHaveLength(1);
    });

    it("should keep the useful answers unreachable without the code", async () => {
      // The whole safety argument in one case. Both of the informative codes
      // above require presenting a code that matches a stored one, so guessing
      // — before, during and after a live window, and after one was spent —
      // only ever yields the one indistinguishable refusal.
      const spent = keys.issuePairingCode().code;
      await post("/auth/pair", { pairingCode: spent, deviceName: "Commander's iPhone" });
      keys.issuePairingCode();

      for (const guess of ["0000-0000", "1111-1111", "9999-9999"]) {
        const response = await post("/auth/pair", { pairingCode: guess, deviceName: "Attacker" });
        const body = (await response.json()) as Envelope<never>;

        expect(body.error?.code, guess).toBe("UNAUTHORIZED");
        expect(body.error?.message, guess).toBe("That pairing code was not accepted.");
      }
    });

    it("should treat a code of the wrong shape as an ordinary refusal", async () => {
      keys.issuePairingCode();

      const response = await post("/auth/pair", { pairingCode: "hello", deviceName: "iPhone" });
      const body = (await response.json()) as Envelope<never>;

      expect(response.status).toBe(401);
      expect(body.error?.code).toBe("UNAUTHORIZED");
    });
  });

  it("should reject a missing pairingCode with a field-level validation error", async () => {
    const response = await post("/auth/pair", { deviceName: "Commander's iPhone" });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
    expect(body.error?.details).toMatchObject({ field: "pairingCode" });
  });

  it("should reject a missing deviceName", async () => {
    const response = await post("/auth/pair", { pairingCode: "1234-5678" });
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(body.error?.details).toMatchObject({ field: "deviceName" });
  });

  it("should reject an absurdly long device name rather than storing it", async () => {
    const response = await post("/auth/pair", {
      pairingCode: keys.issuePairingCode().code,
      deviceName: "x".repeat(500),
    });

    expect(response.status).toBe(400);
  });

  /**
   * `syl-ux1`. The pairing code is consumed on use and there is no endpoint to
   * reissue one, so a lost response used to leave the device permanently
   * unpairable — the service had to be restarted to print a new code. The one
   * write with no recovery path was the one with no protection.
   */
  describe("under a lost response", () => {
    it("should replay the grant rather than burning the code", async () => {
      const body = { pairingCode: keys.issuePairingCode().code, deviceName: "Commander's iPhone" };
      const key = "pair-retry-0001";

      const first = await post("/auth/pair", body, { idempotencyKey: key });
      const firstBody = (await first.json()) as Envelope<TokenGrant>;
      expect(first.status).toBe(200);

      // The response never arrived. The client retries with the key it stored.
      const retry = await post("/auth/pair", body, { idempotencyKey: key });
      const retryBody = (await retry.json()) as Envelope<TokenGrant>;

      expect(retry.status).toBe(200);
      expect(retry.headers.get("idempotency-replayed")).toBe("true");
      // The *same* token, not a second one. Re-minting would leave two live
      // credentials for one pairing and no way to tell which the device kept.
      expect(retryBody.data?.token).toBe(firstBody.data?.token);
    });

    it("should mint exactly one key for a replayed pairing", async () => {
      const body = { pairingCode: keys.issuePairingCode().code, deviceName: "Commander's iPhone" };
      await post("/auth/pair", body, { idempotencyKey: "pair-retry-0002" });
      await post("/auth/pair", body, { idempotencyKey: "pair-retry-0002" });

      expect(keys.list().filter((key) => key.revokedAt === null)).toHaveLength(1);
    });

    it("should let a corrected retry through rather than remembering the refusal", async () => {
      // Only successes are recorded. He mistypes the code once; the same key
      // must not fail forever after he types it correctly.
      const code = keys.issuePairingCode().code;
      const key = "pair-retry-0003";

      const wrong = await post(
        "/auth/pair",
        { pairingCode: "0000-0000", deviceName: "Commander's iPhone" },
        { idempotencyKey: key },
      );
      expect(wrong.status).toBe(401);

      const corrected = await post(
        "/auth/pair",
        { pairingCode: code, deviceName: "Commander's iPhone" },
        { idempotencyKey: key },
      );
      expect(corrected.status).toBe(200);
    });

    it("should refuse one key used for two different pairings", async () => {
      const key = "pair-retry-0004";
      await post(
        "/auth/pair",
        { pairingCode: keys.issuePairingCode().code, deviceName: "Commander's iPhone" },
        { idempotencyKey: key },
      );

      const other = await post(
        "/auth/pair",
        { pairingCode: keys.issuePairingCode().code, deviceName: "Somebody else's iPad" },
        { idempotencyKey: key },
      );
      const body = (await other.json()) as Envelope<never>;

      expect(other.status).toBe(409);
      expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("should not hand the grant to a caller holding only the key", async () => {
      // The one unauthenticated write, so the replay rule has to be precise: a
      // replay is matched on key *and* fingerprint, and the fingerprint covers the
      // body, which carries the pairing code. A stolen key alone must buy nothing.
      const key = "pair-retry-0005";
      const first = await post(
        "/auth/pair",
        { pairingCode: keys.issuePairingCode().code, deviceName: "Commander's iPhone" },
        { idempotencyKey: key },
      );
      const granted = (await first.json()) as Envelope<TokenGrant>;

      const stolen = await post(
        "/auth/pair",
        { pairingCode: "0000-0000", deviceName: "Commander's iPhone" },
        { idempotencyKey: key },
      );
      const body = (await stolen.json()) as Envelope<TokenGrant>;

      expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REUSE");
      expect(body.data).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(granted.data?.token ?? "<none>");
    });

    it("should refuse a pairing that carries no Idempotency-Key at all", async () => {
      const response = await post(
        "/auth/pair",
        { pairingCode: keys.issuePairingCode().code, deviceName: "Commander's iPhone" },
        { idempotencyKey: null },
      );
      const body = (await response.json()) as Envelope<never>;

      expect(response.status).toBe(400);
      expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });
  });

  it("should never mark an auth failure retryable", async () => {
    // Retrying an auth failure fifty times is the worst possible response to a
    // credential problem.
    const response = await post("/auth/pair", { pairingCode: "0000-0000", deviceName: "x" });
    const body = (await response.json()) as Envelope<never>;

    expect(body.error?.retryable).toBe(false);
  });
});

describe("GET /api/v1/auth/whoami", () => {
  it("should name the principal for a live token", async () => {
    const token = await pair();

    const response = await get("/auth/whoami", `Bearer ${token}`);
    const body = (await response.json()) as Envelope<Principal>;

    expect(response.status).toBe(200);
    expect(body.data).toEqual(THE_COMMANDER);
  });

  it("should accept a lower-case scheme, which RFC 7235 makes case-insensitive", async () => {
    const token = await pair();

    expect((await get("/auth/whoami", `bearer ${token}`)).status).toBe(200);
  });

  it("should refuse a request with no Authorization header", async () => {
    const response = await get("/auth/whoami");
    const body = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("should refuse a token that was never issued", async () => {
    const response = await get("/auth/whoami", `Bearer syl_pat_${"0".repeat(32)}`);

    expect(response.status).toBe(401);
  });

  it("should refuse a revoked token", async () => {
    const token = await pair();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    keys.revoke(id, "phone lost");

    expect((await get("/auth/whoami", `Bearer ${token}`)).status).toBe(401);
  });

  it("should give an unknown token and a revoked one the same answer", async () => {
    // Distinguishable rejections turn the API into an oracle for guessing.
    const token = await pair();
    const id = (db.handle.prepare("SELECT id FROM api_keys").get() as { id: string }).id;
    keys.revoke(id, "phone lost");

    const revoked = (await (
      await get("/auth/whoami", `Bearer ${token}`)
    ).json()) as Envelope<never>;
    const unknown = (await (
      await get("/auth/whoami", `Bearer syl_pat_${"0".repeat(32)}`)
    ).json()) as Envelope<never>;

    expect(revoked.error).toEqual(unknown.error);
  });

  it("should never echo the presented token back", async () => {
    const token = `syl_pat_${"a".repeat(32)}`;

    const text = await (await get("/auth/whoami", `Bearer ${token}`)).text();

    expect(text).not.toContain(token);
  });
});

describe("the authenticated surface", () => {
  it("should leave health open, so a monitor needs no credential", async () => {
    expect((await get("/health")).status).toBe(200);
  });

  it("should serve everything under the contract's base path", async () => {
    // Two clients are being written against /api/v1 right now. Serving the
    // same routes one segment away is a silent incompatibility.
    expect((await fetch(`${running.baseUrl}/api/health`)).status).toBe(404);
    expect((await fetch(`${running.baseUrl}/api/v1/health`)).status).toBe(200);
  });
});

describe("bearerToken", () => {
  it("should read the token out of a well-formed header", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  it("should accept any casing of the scheme and extra whitespace around it", () => {
    expect(bearerToken("  bearer   abc123  ")).toBe("abc123");
  });

  it("should be null when there is no header", () => {
    expect(bearerToken(undefined)).toBeNull();
  });

  it("should reject a different scheme rather than treating it as a token", () => {
    expect(bearerToken("Basic abc123")).toBeNull();
  });

  it("should reject a scheme with no token", () => {
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
  });

  it("should reject a header carrying two values", () => {
    expect(bearerToken("Bearer abc def")).toBeNull();
  });
});

/**
 * The scope gate, exercised as a middleware rather than over HTTP.
 *
 * `tests/unit/logs.test.ts` covers what a real caller sees on the one route
 * that uses it. What is here is the middleware's own contract, including the
 * case no route can produce: being mounted with nothing in front of it.
 */
describe("requireScope", () => {
  /** A request carrying the auth context `requireBearerToken` would have set. */
  function requestWith(scope: "device" | "admin" | undefined): Parameters<
    ReturnType<typeof requireScope>
  >[0] {
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
    // Safe: `requireScope` reads `auth` and `path` and nothing else.
    return { ...(auth === undefined ? {} : { auth }), path: "/logs" } as Parameters<
      ReturnType<typeof requireScope>
    >[0];
  }

  /** Run the middleware and return whatever it handed `next`. */
  function run(scope: "device" | "admin" | undefined): unknown {
    let passed: unknown = "not called";
    const refusals: string[] = [];
    requireScope("admin", { onRefused: (wanted) => refusals.push(wanted) })(
      requestWith(scope),
      {} as never,
      ((error?: unknown) => {
        passed = error;
      }) as never,
    );
    return passed;
  }

  it("should pass a request whose key holds the scope", () => {
    expect(run("admin")).toBeUndefined();
  });

  it("should refuse a key with a different scope, as a contract failure", () => {
    const refusal = run("device");

    expect(refusal).toBeInstanceOf(ApiFailure);
    expect((refusal as ApiFailure).code).toBe("FORBIDDEN");
    expect((refusal as ApiFailure).status).toBe(403);
  });

  it("should refuse loudly when it is mounted with no authentication in front of it", () => {
    // A scope check reading `undefined !== "admin"` would answer 403 here,
    // which reads like a working guard and is in fact an unauthenticated
    // request that was never checked at all.
    const refusal = run(undefined);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(ApiFailure);
    expect((refusal as Error).message).toContain("requireBearerToken");
  });

  it("should record the refusal where an operator can see it", () => {
    const refusals: string[] = [];
    requireScope("admin", { onRefused: (scope, path) => refusals.push(`${scope} ${path}`) })(
      requestWith("device"),
      {} as never,
      (() => undefined) as never,
    );

    expect(refusals).toEqual(["admin /logs"]);
  });
});

describe("forbidden", () => {
  it("should name the command that produces the key it is asking for", () => {
    // The one refusal a legitimate operator meets. "Forbidden" on its own is a
    // support call; this is a next step.
    expect(forbidden("admin").message).toContain("npm run pair -- --admin");
    expect(forbidden("admin").code).toBe("FORBIDDEN");
  });

  it("should not be retryable — a scope does not change on a second try", () => {
    expect(forbidden("admin").toApiError().retryable).toBe(false);
  });
});
