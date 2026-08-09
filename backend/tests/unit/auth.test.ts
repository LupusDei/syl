import type { ApiError, Principal, TokenGrant } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/index.js";
import { bearerToken } from "../../src/middleware/auth.js";
import { THE_COMMANDER, type ApiKeyService } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testKeys } from "../helpers/service.js";

let db: SylDatabase;
let keys: ApiKeyService;
let running: RunningApp;

beforeEach(async () => {
  db = testDatabase();
  keys = testKeys(db);
  running = await startTestApp(createApp(testConfig(), { keys }));
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

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
    // A caller who can tell "no code active" from "wrong code" from "expired
    // code" can narrow the search, and there are only a hundred million codes.
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
