import type { ApiError, Device, DevicePage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

const TOKEN = "9c0d2e41".repeat(8);

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;
let keyCounter = 0;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  keyCounter = 0;
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(
  path: string,
  init: RequestInit & { readonly anonymous?: boolean; readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  const { anonymous, idempotencyKey, ...rest } = init;
  keyCounter += 1;
  const key = idempotencyKey === undefined ? `key-${keyCounter}` : idempotencyKey;

  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(anonymous === true ? {} : { authorization: `Bearer ${token}` }),
      ...(key === null ? {} : { "Idempotency-Key": key }),
      ...(rest.headers ?? {}),
    },
  });
}

function registration(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: TOKEN,
    environment: "production",
    platform: "ios",
    name: "Commander's iPhone",
    appVersion: "0.1.0 (14)",
    osVersion: "26.1",
    ...overrides,
  });
}

describe("POST /api/v1/devices", () => {
  it("should register a device and return it without the token", async () => {
    const response = await api("/devices", { method: "POST", body: registration() });
    const body = (await response.json()) as Envelope<Device>;

    expect(response.status).toBe(201);
    expect(body.data?.tokenSuffix).toBe(TOKEN.slice(-8));
    expect(body.data?.environment).toBe("production");
    expect(body.data?.active).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("should refuse a token that is not an APNs token", async () => {
    const response = await api("/devices", {
      method: "POST",
      body: registration({ token: "not-hex" }),
    });
    const body = (await response.json()) as Envelope<Device>;

    expect(response.status).toBe(422);
    expect(body.error?.code).toBe("DEVICE_TOKEN_INVALID");
  });

  it("should refuse an environment outside the contract", async () => {
    const response = await api("/devices", {
      method: "POST",
      body: registration({ environment: "staging" }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<Device>).error?.code).toBe("VALIDATION_FAILED");
  });

  it("should require a bearer token", async () => {
    const response = await api("/devices", {
      method: "POST",
      body: registration(),
      anonymous: true,
    });
    expect(response.status).toBe(401);
  });

  it("should require an Idempotency-Key", async () => {
    // The client that needs this most is the phone's own outbox, which retries
    // automatically. An optional rail is missing exactly when the network is bad.
    const response = await api("/devices", {
      method: "POST",
      body: registration(),
      idempotencyKey: null,
    });
    const body = (await response.json()) as Envelope<Device>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should replay a retried registration rather than running it twice", async () => {
    const first = await api("/devices", {
      method: "POST",
      body: registration(),
      idempotencyKey: "same",
    });
    const second = await api("/devices", {
      method: "POST",
      body: registration(),
      idempotencyKey: "same",
    });

    expect(second.status).toBe(first.status);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    const listed = (await (await api("/devices")).json()) as Envelope<DevicePage>;
    expect(listed.data?.items).toHaveLength(1);
  });

  it("should refuse one key used for two different requests", async () => {
    await api("/devices", { method: "POST", body: registration(), idempotencyKey: "same" });
    const conflicting = await api("/devices", {
      method: "POST",
      body: registration({ token: "1".repeat(64) }),
      idempotencyKey: "same",
    });

    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as Envelope<Device>).error?.code).toBe(
      "IDEMPOTENCY_KEY_REUSE",
    );
  });

  it("should update the same row when the phone re-registers", async () => {
    await api("/devices", { method: "POST", body: registration({ environment: "sandbox" }) });
    const again = await api("/devices", { method: "POST", body: registration() });
    const body = (await again.json()) as Envelope<Device>;

    expect(body.data?.environment).toBe("production");
    const listed = (await (await api("/devices")).json()) as Envelope<DevicePage>;
    expect(listed.data?.items).toHaveLength(1);
  });
});

describe("GET /api/v1/devices", () => {
  it("should page registered devices", async () => {
    await api("/devices", { method: "POST", body: registration() });
    await api("/devices", {
      method: "POST",
      body: registration({ token: "1".repeat(64), name: "Simulator", environment: "sandbox" }),
    });

    const first = (await (await api("/devices?limit=1")).json()) as Envelope<DevicePage>;
    expect(first.data?.items).toHaveLength(1);
    expect(first.data?.hasMore).toBe(true);

    const second = (await (
      await api(`/devices?limit=1&cursor=${encodeURIComponent(first.data?.nextCursor ?? "")}`)
    ).json()) as Envelope<DevicePage>;
    expect(second.data?.items).toHaveLength(1);
    expect(second.data?.hasMore).toBe(false);
  });

  it("should refuse a cursor it did not issue", async () => {
    const response = await api("/devices?cursor=nope");
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<DevicePage>).error?.code).toBe("VALIDATION_FAILED");
  });

  it("should refuse a limit that is not a whole number", async () => {
    const response = await api("/devices?limit=three");
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/v1/devices/{deviceId}", () => {
  it("should mark the device inactive rather than deleting it", async () => {
    const registered = (await (
      await api("/devices", { method: "POST", body: registration() })
    ).json()) as Envelope<Device>;

    const response = await api(`/devices/${registered.data?.id ?? ""}`, { method: "DELETE" });
    const body = (await response.json()) as Envelope<Device>;

    expect(response.status).toBe(200);
    expect(body.data?.active).toBe(false);

    const listed = (await (await api("/devices")).json()) as Envelope<DevicePage>;
    expect(listed.data?.items).toHaveLength(1);
  });

  it("should answer 404 for an id it does not have", async () => {
    const response = await api("/devices/syl:device:00000000-0000-7000-8000-00000000ffff", {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("should answer 404 for something that is not a device id", async () => {
    const response = await api("/devices/nonsense", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as Envelope<Device>).error?.code).toBe("NOT_FOUND");
  });
});
