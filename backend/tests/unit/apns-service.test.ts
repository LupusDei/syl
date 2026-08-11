import { generateKeyPairSync, verify as verifySignature } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APNS_ORIGINS,
  ApnsClient,
  ApnsProviderToken,
  DEFAULT_TOKEN_REFRESH_MS,
  apnsCredentialsFromEnv,
  buildApnsBody,
  classifyApnsFailure,
  type ApnsCredentials,
} from "../../src/services/apns-service.js";
import { fixedClock } from "../../src/services/clock.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { TEST_NOW } from "../helpers/service.js";

/** A throwaway P-256 key pair, the shape a `.p8` from Apple has. */
function testCredentials(): { credentials: ApnsCredentials; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentials: {
      keyId: "ABCD123456",
      teamId: "TEAM123456",
      bundleId: "com.jmm.syl",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

const TOKEN = "9c0d2e41".repeat(8);

describe("ApnsProviderToken", () => {
  it("should sign an ES256 JWT Apple can verify", () => {
    const { credentials, publicKeyPem } = testCredentials();
    const provider = new ApnsProviderToken(credentials, { clock: fixedClock(TEST_NOW) });

    const jwt = provider.token();
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", kid: credentials.keyId });
    // `iat` is seconds, not milliseconds. Apple rejects a token whose issued-at
    // is more than an hour old, and a millisecond value reads as the year
    // 57000 — which is not old, so the failure is a flat 403 with no clue.
    expect(decodeSegment(payload ?? "")).toEqual({
      iss: credentials.teamId,
      iat: Math.floor(TEST_NOW / 1000),
    });

    // JOSE requires the raw r||s signature, not the DER encoding `createSign`
    // produces by default. Apple rejects DER as an invalid token.
    const raw = Buffer.from(signature ?? "", "base64url");
    expect(raw).toHaveLength(64);
    expect(
      verifySignature(
        "sha256",
        Buffer.from(`${header ?? ""}.${payload ?? ""}`, "utf8"),
        { key: publicKeyPem, dsaEncoding: "ieee-p1363" },
        raw,
      ),
    ).toBe(true);
  });

  it("should reuse one token rather than signing per notification", () => {
    const { credentials } = testCredentials();
    let now = TEST_NOW;
    const provider = new ApnsProviderToken(credentials, { clock: () => now });

    const first = provider.token();
    now += DEFAULT_TOKEN_REFRESH_MS - 1;
    expect(provider.token()).toBe(first);
    // Apple rejects provider-token updates that arrive too frequently, so
    // signing per request is a way to get throttled, not a way to be safe.
    expect(provider.signCount).toBe(1);
  });

  it("should regenerate once the refresh window has passed", () => {
    const { credentials } = testCredentials();
    let now = TEST_NOW;
    const provider = new ApnsProviderToken(credentials, { clock: () => now });

    const first = provider.token();
    now += DEFAULT_TOKEN_REFRESH_MS;
    const second = provider.token();

    expect(second).not.toBe(first);
    expect(provider.signCount).toBe(2);
  });

  it("should refresh on demand when Apple says the token expired", () => {
    const { credentials } = testCredentials();
    let now = TEST_NOW;
    const provider = new ApnsProviderToken(credentials, { clock: () => now });

    const first = provider.token();
    provider.invalidate();
    now += 1_000;
    expect(provider.token()).not.toBe(first);
  });

  it("should stay under Apple's one-hour ceiling", () => {
    expect(DEFAULT_TOKEN_REFRESH_MS).toBeLessThan(3_600_000);
    // And above the floor: Apple rejects updates that arrive too often.
    expect(DEFAULT_TOKEN_REFRESH_MS).toBeGreaterThanOrEqual(20 * 60_000);
  });
});

describe("classifyApnsFailure", () => {
  it("should unregister a token Apple says is gone", () => {
    expect(classifyApnsFailure(410, "Unregistered")).toBe("unregister");
    expect(classifyApnsFailure(400, "BadDeviceToken")).toBe("unregister");
    expect(classifyApnsFailure(400, "DeviceTokenNotForTopic")).toBe("unregister");
  });

  it("should retry a failure that is about this moment rather than this token", () => {
    expect(classifyApnsFailure(429, "TooManyRequests")).toBe("retry");
    expect(classifyApnsFailure(500, "InternalServerError")).toBe("retry");
    expect(classifyApnsFailure(503, "ServiceUnavailable")).toBe("retry");
    expect(classifyApnsFailure(403, "ExpiredProviderToken")).toBe("retry");
    expect(classifyApnsFailure(429, "TooManyProviderTokenUpdates")).toBe("retry");
  });

  it("should retry when Apple never answered at all", () => {
    // Status zero is "we do not know". Concluding anything about the token
    // from a connection that never completed would let a rebooting Mac
    // unregister the Commander's phone.
    expect(classifyApnsFailure(0, "ConnectionFailed")).toBe("retry");
    expect(classifyApnsFailure(0, "IdleTimeout")).toBe("retry");
  });

  it("should treat a wrong credential as a blocked machine, not a doomed notification", () => {
    // `syl-clc`. These are the four values a human types once — the .p8, the
    // key id, the team id, the bundle id — and Apple is refusing the provider,
    // not the reminder. Classified `permanent`, the first refusal wrote
    // `next_attempt_at = NULL` and the reminder became unreachable by every
    // future pass. Correcting the credentials re-armed nothing.
    expect(classifyApnsFailure(403, "InvalidProviderToken")).toBe("blocked");
    expect(classifyApnsFailure(401, "MissingProviderToken")).toBe("blocked");
    expect(classifyApnsFailure(403, "InvalidProviderTokenSignature")).toBe("blocked");
    expect(classifyApnsFailure(403, "BadCertificateEnvironment")).toBe("blocked");
    expect(classifyApnsFailure(400, "BadTopic")).toBe("blocked");
    expect(classifyApnsFailure(400, "TopicDisallowed")).toBe("blocked");
  });

  it("should treat an authentication status as blocked even with a reason it has never seen", () => {
    // A 403 carrying an unknown reason is far more likely to be a fifth way of
    // saying "your key is wrong" than a bad reminder, and the cost of being
    // wrong is asymmetric: holding a deliverable row wastes a retry, dropping
    // an undeliverable one loses a commitment.
    expect(classifyApnsFailure(403, "SomethingAppleAddedLater")).toBe("blocked");
    expect(classifyApnsFailure(401, "SomethingAppleAddedLater")).toBe("blocked");
  });

  it("should treat a notification Apple will never accept as permanent", () => {
    // The narrow, genuine case: we built something malformed. Building it
    // again will not help, and no human fixing an environment file will.
    expect(classifyApnsFailure(413, "PayloadTooLarge")).toBe("permanent");
    expect(classifyApnsFailure(400, "PayloadEmpty")).toBe("permanent");
    expect(classifyApnsFailure(400, "BadExpirationDate")).toBe("permanent");
  });
});

describe("buildApnsBody", () => {
  it("should carry the text itself, never an id to fetch", () => {
    // Push reaches the phone over Apple's network, which does not touch the
    // tailnet. A notification whose body is an id is unreadable exactly when
    // the tunnel is down — which is one of the times it matters most.
    const body = buildApnsBody(
      {
        title: "Syl",
        body: "Call the pharmacy — the refill lapses today.",
        interruptionLevel: "time-sensitive",
        categoryIdentifier: "reminder",
        threadIdentifier: "reminders",
      },
      { deliveryId: "syl:delivery:0198f2c6-0001-7000-8000-000000010001" },
    );

    expect(body).toEqual({
      aps: {
        alert: { title: "Syl", body: "Call the pharmacy — the refill lapses today." },
        sound: "default",
        "interruption-level": "time-sensitive",
        category: "reminder",
        "thread-id": "reminders",
      },
      deliveryId: "syl:delivery:0198f2c6-0001-7000-8000-000000010001",
    });
  });

  it("should default the interruption level rather than omitting it", () => {
    const body = buildApnsBody({ title: "Syl", body: "Two things today." }, {});
    expect(body).toEqual({
      aps: {
        alert: { title: "Syl", body: "Two things today." },
        sound: "default",
        "interruption-level": "active",
      },
    });
  });

  it("should omit a null category or thread rather than sending null", () => {
    const body = buildApnsBody(
      {
        title: "Syl",
        body: "x",
        interruptionLevel: "active",
        categoryIdentifier: null,
        threadIdentifier: null,
      },
      {},
    );
    expect(body).toEqual({
      aps: { alert: { title: "Syl", body: "x" }, sound: "default", "interruption-level": "active" },
    });
  });
});

describe("APNS_ORIGINS", () => {
  it("should point each environment at its own host", () => {
    expect(APNS_ORIGINS.production).toBe("https://api.push.apple.com");
    expect(APNS_ORIGINS.sandbox).toBe("https://api.sandbox.push.apple.com");
  });
});

describe("apnsCredentialsFromEnv", () => {
  it("should read a complete configuration", () => {
    const credentials = apnsCredentialsFromEnv({
      SYL_APNS_KEY_ID: "ABCD123456",
      SYL_APNS_TEAM_ID: "TEAM123456",
      SYL_APNS_BUNDLE_ID: "com.jmm.syl",
      SYL_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    });
    expect(credentials?.bundleId).toBe("com.jmm.syl");
  });

  it("should return null when push is not configured, rather than throwing", () => {
    // A machine with no APNs key still has to boot: the admin, the harness and
    // the conversation surface do not need push, and refusing to start would
    // make an unconfigured optional channel into a hard outage.
    expect(apnsCredentialsFromEnv({})).toBeNull();
  });

  it("should refuse a half-configuration rather than failing at send time", () => {
    expect(() =>
      apnsCredentialsFromEnv({ SYL_APNS_KEY_ID: "ABCD123456", SYL_APNS_TEAM_ID: "TEAM123456" }),
    ).toThrow(/SYL_APNS_BUNDLE_ID/);
  });

  it("should restore newlines in a key pasted as one line", () => {
    // Every secret store mangles the newlines out of a .p8 sooner or later.
    const credentials = apnsCredentialsFromEnv({
      SYL_APNS_KEY_ID: "ABCD123456",
      SYL_APNS_TEAM_ID: "TEAM123456",
      SYL_APNS_BUNDLE_ID: "com.jmm.syl",
      SYL_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----",
    });
    expect(credentials?.privateKeyPem).toContain("\n");
  });
});

describe("ApnsClient", () => {
  let apple: FakeApns;
  let client: ApnsClient;

  beforeEach(async () => {
    apple = await startFakeApns();
    const { credentials } = testCredentials();
    client = new ApnsClient({
      credentials,
      origins: { production: apple.origin, sandbox: apple.origin },
      clock: fixedClock(TEST_NOW),
    });
  });

  afterEach(async () => {
    await client.close();
    await apple.close();
  });

  it("should POST to the device path with the headers Apple requires", async () => {
    const result = await client.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "Call the pharmacy.", interruptionLevel: "time-sensitive" },
      data: { deliveryId: "syl:delivery:0198f2c6-0001-7000-8000-000000010001" },
      apnsId: "1B2C3D4E-5F60-4718-9A2B-3C4D5E6F7081",
    });

    expect(result.ok).toBe(true);
    const push = apple.pushes[0];
    expect(push?.path).toBe(`/3/device/${TOKEN}`);
    expect(push?.headers[":method"]).toBe("POST");
    expect(push?.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(push?.headers["apns-topic"]).toBe("com.jmm.syl");
    // alert + priority 10 is the only combination that is not throttled
    // against a battery budget or dropped in Low Power Mode.
    expect(push?.headers["apns-push-type"]).toBe("alert");
    expect(push?.headers["apns-priority"]).toBe("10");
    expect(push?.headers["apns-id"]).toBe("1B2C3D4E-5F60-4718-9A2B-3C4D5E6F7081");
  });

  it("should return the apns-unique-id Apple hands back", async () => {
    apple.reply({ status: 200, apnsUniqueId: "2C3D4E5F-6071-4829-AB3C-4D5E6F708192" });
    const result = await client.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
    });
    expect(result).toMatchObject({ ok: true, apnsUniqueId: "2C3D4E5F-6071-4829-AB3C-4D5E6F708192" });
  });

  it("should reuse one HTTP/2 session across notifications", async () => {
    // Reconnecting per notification is an explicit Apple anti-pattern, and the
    // only way to observe it is from the far end of a real connection.
    for (let i = 0; i < 3; i += 1) {
      await client.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });
    }
    expect(apple.pushes).toHaveLength(3);
    expect(apple.sessionCount).toBe(1);
    expect(new Set(apple.pushes.map((push) => push.sessionId)).size).toBe(1);
  });

  it("should hold one session per environment, because they are different hosts", async () => {
    // Sandbox and production are separate Apple hosts, so a token routed to
    // the wrong one fails with BadDeviceToken and nothing else. Two fakes,
    // because one fake could not tell the two apart.
    const sandbox = await startFakeApns();
    const { credentials } = testCredentials();
    const routed = new ApnsClient({
      credentials,
      origins: { production: apple.origin, sandbox: sandbox.origin },
      clock: fixedClock(TEST_NOW),
    });

    await routed.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });
    await routed.send({ token: TOKEN, environment: "sandbox", payload: { title: "Syl", body: "x" } });

    expect(apple.pushes).toHaveLength(1);
    expect(sandbox.pushes).toHaveLength(1);

    await routed.close();
    await sandbox.close();
  });

  it("should report a dead token as something to unregister", async () => {
    apple.reply({ status: 410, reason: "Unregistered" });
    const result = await client.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
    });

    expect(result).toMatchObject({ ok: false, status: 410, reason: "Unregistered", disposition: "unregister" });
  });

  it("should report a transient failure as retryable", async () => {
    apple.reply({ status: 503, reason: "ServiceUnavailable" });
    const result = await client.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
    });
    expect(result).toMatchObject({ ok: false, disposition: "retry" });
  });

  it("should refresh the provider token when Apple says it expired", async () => {
    apple.reply({ status: 403, reason: "ExpiredProviderToken" });
    await client.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });
    await client.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });

    const [first, second] = apple.pushes;
    expect(first?.authorization).not.toBe(second?.authorization);
  });

  it("should treat a request that never answers as retryable rather than hanging", async () => {
    apple.reply({ status: 200, delayMs: 5_000 });
    const result = await client.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
      timeoutMs: 30,
    });
    expect(result).toMatchObject({ ok: false, disposition: "retry" });
  });

  it("should treat an unreachable host as retryable rather than throwing", async () => {
    const { credentials } = testCredentials();
    const offline = new ApnsClient({
      credentials,
      // Port 1 on loopback refuses immediately: a Mac mid-reboot, in one line.
      origins: { production: "http://127.0.0.1:1", sandbox: "http://127.0.0.1:1" },
      clock: fixedClock(TEST_NOW),
    });

    const result = await offline.send({
      token: TOKEN,
      environment: "production",
      payload: { title: "Syl", body: "x" },
    });
    expect(result).toMatchObject({ ok: false, disposition: "retry" });
    await offline.close();
  });

  it("should reconnect after the session goes away", async () => {
    await client.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });
    await client.dropSessions();
    await client.send({ token: TOKEN, environment: "production", payload: { title: "Syl", body: "x" } });

    expect(apple.pushes).toHaveLength(2);
    expect(apple.sessionCount).toBe(2);
  });
});
