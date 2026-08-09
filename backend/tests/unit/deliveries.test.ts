import type { ApiError, Delivery, DeliveryPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import {
  DEFAULT_QUIET_HOURS,
  quietHoursFromEnv,
  type EnqueueDelivery,
} from "../../src/services/outbox.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

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
  init: RequestInit & { readonly idempotencyKey?: string | null } = {},
): Promise<Response> {
  const { idempotencyKey, ...rest } = init;
  keyCounter += 1;
  const key = idempotencyKey === undefined ? `key-${keyCounter}` : idempotencyKey;

  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(key === null ? {} : { "Idempotency-Key": key }),
      ...(rest.headers ?? {}),
    },
  });
}

function enqueue(overrides: Partial<EnqueueDelivery> = {}): Delivery {
  return deps.outbox.enqueue({
    channel: "apns",
    messageClass: "reminder_delivery",
    payload: { title: "Syl", body: "Call the pharmacy.", interruptionLevel: "time-sensitive" },
    idempotencyKey: `outbox-${keyCounter}-${Math.random()}`,
    ...overrides,
  }).delivery;
}

describe("quietHoursFromEnv", () => {
  it("should fall back to the Commander's window and zone", () => {
    expect(quietHoursFromEnv({})).toEqual(DEFAULT_QUIET_HOURS);
  });

  it("should take an override", () => {
    expect(
      quietHoursFromEnv({ SYL_QUIET_START: "23:00", SYL_QUIET_END: "07:00", SYL_TZ: "Europe/Berlin" }),
    ).toEqual({ quiet: { start: "23:00", end: "07:00" }, tz: "Europe/Berlin" });
  });

  it("should store an IANA zone rather than an offset", () => {
    // An offset is a property of an instant, not of a place, and one that
    // reaches storage survives exactly one DST boundary.
    expect(DEFAULT_QUIET_HOURS.tz).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
  });
});

describe("GET /api/v1/deliveries", () => {
  it("should list the outbox newest first", async () => {
    enqueue();
    const body = (await (await api("/deliveries")).json()) as Envelope<DeliveryPage>;

    expect(body.data?.items).toHaveLength(1);
    expect(body.data?.items[0]?.state).toBe("pending");
  });

  it("should filter to what was never acknowledged", async () => {
    const first = enqueue();
    enqueue();
    deps.outbox.acknowledge(first.id, { ackedAt: "2026-08-09T21:00:07.220Z" });

    const body = (await (
      await api("/deliveries?unacknowledged=true")
    ).json()) as Envelope<DeliveryPage>;
    expect(body.data?.items).toHaveLength(1);
    expect(body.data?.items[0]?.id).not.toBe(first.id);
  });

  it("should filter by state", async () => {
    enqueue();
    const body = (await (
      await api("/deliveries?state=acknowledged")
    ).json()) as Envelope<DeliveryPage>;
    expect(body.data?.items).toHaveLength(0);
  });

  it("should refuse a state the contract does not define", async () => {
    const response = await api("/deliveries?state=gossip");
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<DeliveryPage>).error?.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("should refuse a non-boolean unacknowledged", async () => {
    expect((await api("/deliveries?unacknowledged=perhaps")).status).toBe(400);
  });

  /**
   * `syl-u9e`. This filter is the server half of the delivery guarantee, and until
   * now it had no caller at all — `SylAPI.deliveries(unacknowledged:)` was declared
   * in SylKit and invoked by nothing. The route was written for a reconcile that
   * did not exist, which is why nothing noticed that the row it was meant to
   * surface is invisible to every other query in the system.
   */
  describe("the rows the device still owes an answer for", () => {
    it("should still list a delivery APNs accepted but nobody acknowledged", async () => {
      // The overnight case. Apple took the request — `recordAccepted` sets
      // `delivered` and clears `next_attempt_at`, so `due()` will never return it
      // again — and while the phone was off Apple kept only the most recent
      // notification. This query is the only thing left that can find it.
      const accepted = enqueue();
      deps.outbox.markSending(accepted.id);
      deps.outbox.recordAccepted(accepted.id, { apnsUniqueId: "apns-1" });

      expect(deps.outbox.due(Date.parse("2099-01-01T00:00:00.000Z"))).toHaveLength(0);

      const body = (await (
        await api("/deliveries?unacknowledged=true")
      ).json()) as Envelope<DeliveryPage>;

      expect(body.data?.items.map((item) => item.id)).toEqual([accepted.id]);
      expect(body.data?.items[0]?.state).toBe("delivered");
      expect(body.data?.items[0]?.deliveredAt).not.toBeNull();
      expect(body.data?.items[0]?.ackedAt).toBeNull();
    });

    it("should stop listing it once the device answers", async () => {
      // The loop closing. Nothing else in the system moves this row.
      const accepted = enqueue();
      deps.outbox.markSending(accepted.id);
      deps.outbox.recordAccepted(accepted.id);

      const acked = await api(`/deliveries/${encodeURIComponent(accepted.id)}/ack`, {
        method: "POST",
        body: JSON.stringify({ ackedAt: "2026-08-09T09:15:00.000Z", engagement: "delivered" }),
      });
      expect(acked.status).toBe(200);

      const body = (await (
        await api("/deliveries?unacknowledged=true")
      ).json()) as Envelope<DeliveryPage>;
      expect(body.data?.items).toHaveLength(0);
    });

    it("should list rows push could not carry at all, not only the accepted ones", async () => {
      // `failed` and `abandoned` also have a null `next_attempt_at`, so they are
      // equally invisible to the drain loop and equally the device's problem.
      const failed = enqueue();
      deps.outbox.markSending(failed.id);
      deps.outbox.recordFailure(failed.id, { error: "BadDeviceToken", retryable: false });

      const body = (await (
        await api("/deliveries?unacknowledged=true")
      ).json()) as Envelope<DeliveryPage>;

      expect(body.data?.items.map((item) => item.state)).toEqual(["failed"]);
    });

    it("should answer a repeated acknowledgement with the first instant, not the latest", async () => {
      // The reconcile and a tap can both answer for one delivery, and they carry the
      // same derived key by design. The first instant is the one that is true.
      const accepted = enqueue();
      deps.outbox.markSending(accepted.id);
      deps.outbox.recordAccepted(accepted.id);
      const path = `/deliveries/${encodeURIComponent(accepted.id)}/ack`;
      const body = JSON.stringify({ ackedAt: "2026-08-09T09:15:00.000Z" });

      const first = (await (
        await api(path, { method: "POST", body, idempotencyKey: `ack-${accepted.id}` })
      ).json()) as Envelope<Delivery>;
      const replay = await api(path, {
        method: "POST",
        body,
        idempotencyKey: `ack-${accepted.id}`,
      });
      const replayBody = (await replay.json()) as Envelope<Delivery>;

      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(replayBody.data?.ackedAt).toBe(first.data?.ackedAt);
    });
  });

  it("should refuse a cursor it did not issue", async () => {
    expect((await api("/deliveries?cursor=nope")).status).toBe(400);
  });

  it("should require authentication", async () => {
    const response = await fetch(`${running.baseUrl}/api/v1/deliveries`);
    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/deliveries/{deliveryId}", () => {
  it("should return the outbox row", async () => {
    const delivery = enqueue();
    const body = (await (await api(`/deliveries/${delivery.id}`)).json()) as Envelope<Delivery>;
    expect(body.data?.id).toBe(delivery.id);
  });

  it("should answer 404 for an id it does not have", async () => {
    const response = await api("/deliveries/syl:delivery:00000000-0000-7000-8000-0000000000ff");
    expect(response.status).toBe(404);
  });

  it("should answer 404 for something that is not a delivery id", async () => {
    expect((await api("/deliveries/nonsense")).status).toBe(404);
  });
});

describe("POST /api/v1/deliveries/{deliveryId}/ack", () => {
  it("should be what marks a delivery real", async () => {
    // APNs cannot tell us a notification arrived; the device saying so is the
    // only evidence that exists.
    const delivery = enqueue();
    const response = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z", engagement: "opened" }),
    });
    const body = (await response.json()) as Envelope<Delivery>;

    expect(response.status).toBe(200);
    expect(body.data?.state).toBe("acknowledged");
    expect(body.data?.ackedAt).toBe("2026-08-09T21:00:07.220Z");
    expect(body.data?.engagement).toBe("opened");
  });

  it("should be a no-op the second time, keeping the first instant", async () => {
    const delivery = enqueue();
    await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z" }),
    });
    const again = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T23:00:00.000Z" }),
    });
    const body = (await again.json()) as Envelope<Delivery>;

    expect(again.status).toBe(200);
    expect(body.data?.ackedAt).toBe("2026-08-09T21:00:07.220Z");
  });

  it("should replay a retried acknowledgement", async () => {
    const delivery = enqueue();
    await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z" }),
      idempotencyKey: "same",
    });
    const replayed = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z" }),
      idempotencyKey: "same",
    });
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("should require an Idempotency-Key", async () => {
    const delivery = enqueue();
    const response = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z" }),
      idempotencyKey: null,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<Delivery>).error?.code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  });

  it("should refuse an instant carrying a fixed UTC offset", async () => {
    // Accepting an offset here is how one reaches storage, and a stored offset
    // survives exactly one DST boundary.
    const delivery = enqueue();
    const response = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T16:00:07.220-05:00" }),
    });
    expect(response.status).toBe(400);
  });

  it("should refuse a missing ackedAt", async () => {
    const delivery = enqueue();
    const response = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("should refuse an engagement the contract does not define", async () => {
    const delivery = enqueue();
    const response = await api(`/deliveries/${delivery.id}/ack`, {
      method: "POST",
      body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z", engagement: "shrugged" }),
    });
    expect(response.status).toBe(400);
  });

  it("should answer 404 for a delivery it does not have", async () => {
    const response = await api(
      "/deliveries/syl:delivery:00000000-0000-7000-8000-0000000000ff/ack",
      { method: "POST", body: JSON.stringify({ ackedAt: "2026-08-09T21:00:07.220Z" }) },
    );
    expect(response.status).toBe(404);
  });
});
