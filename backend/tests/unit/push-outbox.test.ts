import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  apnsIdFor,
  notificationFor,
  pushDueDeliveries,
  type ApnsSender,
} from "../../src/jobs/push-outbox.js";
import type { ApnsNotification, ApnsResult } from "../../src/services/apns-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { Outbox } from "../../src/services/outbox.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

const IPHONE = "9c0d2e41".repeat(8);
const IPAD = "11111111".repeat(8);

/** An APNs client that answers from a script rather than over a wire. */
function scriptedApns(results: readonly ApnsResult[]): ApnsSender & {
  readonly sent: ApnsNotification[];
} {
  const sent: ApnsNotification[] = [];
  let index = 0;
  return {
    sent,
    send: (notification) => {
      sent.push(notification);
      const result = results[index] ?? results[results.length - 1] ?? { ok: true, apnsUniqueId: null, apnsId: "x" };
      index += 1;
      return Promise.resolve(result);
    },
  };
}

const ACCEPTED: ApnsResult = { ok: true, apnsUniqueId: "UNIQUE-1", apnsId: "APNS-1" };

describe("apnsIdFor", () => {
  it("should reuse the uuid already inside our id", () => {
    // A retry must send the same apns-id, so Apple sees one notification.
    expect(apnsIdFor("syl:delivery:0198f2c6-0001-7000-8000-000000010001")).toBe(
      "0198f2c6-0001-7000-8000-000000010001",
    );
  });

  it("should fall back to the whole id if it is not shaped that way", () => {
    expect(apnsIdFor("odd")).toBe("odd");
  });
});

describe("notificationFor", () => {
  it("should carry the delivery id so the device can acknowledge", () => {
    // Without this the acknowledgement has nothing to name, and the
    // acknowledgement is the only evidence of delivery that exists.
    const notification = notificationFor(
      {
        id: "syl:delivery:0198f2c6-0001-7000-8000-000000010001",
        channel: "apns",
        messageClass: "reminder_delivery",
        reminderId: "syl:reminder:abc",
        payload: { title: "Syl", body: "x", interruptionLevel: "time-sensitive" },
        idempotencyKey: "k",
        state: "pending",
        attempts: 0,
        nextAttemptAt: null,
        deliveredAt: null,
        ackedAt: null,
        engagement: null,
        late: false,
        scheduledFor: null,
        coalescedReminderIds: [],
        apnsUniqueId: null,
        lastError: null,
        createdAt: "2026-08-09T21:00:00.000Z",
      },
      IPHONE,
      "production",
    );

    expect(notification.data).toEqual({
      deliveryId: "syl:delivery:0198f2c6-0001-7000-8000-000000010001",
      reminderId: "syl:reminder:abc",
    });
    expect(notification.environment).toBe("production");
    expect(notification.apnsId).toBe("0198f2c6-0001-7000-8000-000000010001");
  });

  it("should carry every reminder a digest stands for", () => {
    // `syl-xvx`. A digest names no single reminder on purpose, so the device
    // had nothing to act on at all. The ids it speaks for travel with it now —
    // the same set the ack path closes, so the two cannot disagree.
    const notification = notificationFor(
      {
        id: "syl:delivery:0198f2c6-0001-7000-8000-000000010002",
        channel: "apns",
        messageClass: "reminder_delivery",
        reminderId: null,
        payload: { title: "Syl", body: "Two things came in overnight." },
        idempotencyKey: "batch",
        state: "pending",
        attempts: 0,
        nextAttemptAt: null,
        deliveredAt: null,
        ackedAt: null,
        engagement: null,
        late: true,
        scheduledFor: null,
        coalescedReminderIds: ["syl:reminder:one", "syl:reminder:two"],
        apnsUniqueId: null,
        lastError: null,
        createdAt: "2026-08-09T21:00:00.000Z",
      },
      IPHONE,
      "production",
    );

    expect(notification.data).toEqual({
      deliveryId: "syl:delivery:0198f2c6-0001-7000-8000-000000010002",
      coalescedReminderIds: ["syl:reminder:one", "syl:reminder:two"],
    });
  });
});

describe("pushDueDeliveries", () => {
  let db: SylDatabase;
  let outbox: Outbox;
  let devices: DeviceTokenService;
  let now: number;

  function enqueue(): string {
    return outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      reminderId: "syl:reminder:abc",
      payload: { title: "Syl", body: "Call the pharmacy.", interruptionLevel: "time-sensitive" },
      idempotencyKey: `k-${Math.random()}`,
    }).delivery.id;
  }

  function register(token: string, environment: "sandbox" | "production" = "production"): void {
    devices.register({
      token,
      environment,
      platform: "ios",
      name: "device",
      appVersion: "1",
      osVersion: "26.1",
    });
  }

  beforeEach(() => {
    db = testDatabase();
    // Movable, so a test can drive many passes across a simulated day. Every
    // defect in this file was invisible to a single pass.
    now = TEST_NOW;
    const clock = (): number => now;
    outbox = new Outbox({ db: db.handle, clock, jitter: () => 0 });
    devices = new DeviceTokenService({ db: db.handle, clock });
  });

  afterEach(() => {
    db.close();
  });

  it("should push a due row and record acceptance, not delivery", () => {
    const id = enqueue();
    register(IPHONE);
    const apns = scriptedApns([ACCEPTED]);

    return pushDueDeliveries({ outbox, devices, apns }).then((result) => {
      expect(result.accepted).toEqual([id]);

      const delivery = outbox.get(id);
      expect(delivery?.state).toBe("delivered");
      expect(delivery?.apnsUniqueId).toBe("UNIQUE-1");
      // Apple taking the request is not the phone receiving it.
      expect(delivery?.ackedAt).toBeNull();
      expect(delivery?.attempts).toBe(1);
    });
  });

  it("should route each token to its own environment", async () => {
    enqueue();
    register(IPHONE, "production");
    register(IPAD, "sandbox");
    const apns = scriptedApns([ACCEPTED]);

    await pushDueDeliveries({ outbox, devices, apns });

    expect(apns.sent.map((n) => n.environment).sort()).toEqual(["production", "sandbox"]);
  });

  it("should unregister a token Apple says is gone", async () => {
    const id = enqueue();
    register(IPHONE);
    register(IPAD);
    const apns = scriptedApns([
      { ok: false, status: 410, reason: "Unregistered", disposition: "unregister" },
      ACCEPTED,
    ]);

    const result = await pushDueDeliveries({ outbox, devices, apns });

    expect(result.unregistered).toHaveLength(1);
    expect(devices.targets()).toHaveLength(1);
    // One device took it, so the row is accepted rather than failed.
    expect(outbox.get(id)?.state).toBe("delivered");
  });

  it("should retry when every device failed transiently", async () => {
    const id = enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 503, reason: "ServiceUnavailable", disposition: "retry" },
    ]);

    const result = await pushDueDeliveries({ outbox, devices, apns });

    expect(result.failed).toEqual([id]);
    const delivery = outbox.get(id);
    expect(delivery?.state).toBe("pending");
    expect(delivery?.nextAttemptAt).not.toBeNull();
    expect(delivery?.lastError).toContain("503");
  });

  it("should fail permanently on a notification Apple will never accept", async () => {
    const id = enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 413, reason: "PayloadTooLarge", disposition: "permanent" },
    ]);

    const result = await pushDueDeliveries({ outbox, devices, apns });
    expect(outbox.get(id)?.state).toBe("failed");
    // Reported as exhausted, which is what lets the job above escalate it.
    // Nothing a wrong credential does may ever reach this list.
    expect(result.exhausted).toEqual([id]);
  });

  it("should hold a row Apple refused over the credentials, and never spend it", async () => {
    // `syl-clc`. The row must survive a week of refusals unchanged, because a
    // wrong key id is a property of the machine and machines get fixed. This
    // is driven across many passes on purpose: the defect was invisible to one.
    const id = enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 403, reason: "InvalidProviderToken", disposition: "blocked" },
    ]);

    let passes = 0;
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      now = TEST_NOW + hour * 60 * 60_000;
      const result = await pushDueDeliveries({ outbox, devices, apns }, now);
      if (result.blocked.length > 0) passes += 1;
      // Not once, ever: a refused credential must not consume the row.
      expect(result.exhausted).toEqual([]);
      expect(result.failed).toEqual([]);
    }

    // It kept trying, rather than giving up after the first refusal.
    expect(passes).toBeGreaterThan(1);

    const delivery = outbox.get(id);
    expect(delivery?.state).toBe("pending");
    // The two fields that decide whether it is reachable at all.
    expect(delivery?.nextAttemptAt).not.toBeNull();
    expect(delivery?.lastError).toContain("InvalidProviderToken");
    // And the attempt budget is untouched, so the first genuine hiccup after
    // the credentials are fixed does not abandon a week-old reminder.
    expect(delivery?.attempts).toBe(0);

    // The credentials are fixed.
    now = TEST_NOW + 24 * 7 * 60 * 60_000;
    const after = await pushDueDeliveries(
      { outbox, devices, apns: scriptedApns([ACCEPTED]) },
      now,
    );
    expect(after.accepted).toEqual([id]);
    expect(outbox.get(id)?.state).toBe("delivered");
  });

  it("should stop asking Apple once it has refused the credentials in a pass", async () => {
    // The answer is about the provider, so it is already known for every other
    // row waiting. Asking once per reminder is the flood the old `permanent`
    // branch was trying to avoid, arrived at from the other direction.
    enqueue();
    enqueue();
    enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 403, reason: "InvalidProviderToken", disposition: "blocked" },
    ]);

    const result = await pushDueDeliveries({ outbox, devices, apns });

    expect(apns.sent).toHaveLength(1);
    expect(result.blocked).toHaveLength(3);
  });

  it("should keep the row when the last device was just unregistered", async () => {
    // The phone re-registering is exactly the case the outbox exists to
    // survive, so the row waits rather than failing outright.
    const id = enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 410, reason: "Unregistered", disposition: "unregister" },
    ]);

    await pushDueDeliveries({ outbox, devices, apns });
    expect(outbox.get(id)?.state).toBe("pending");
  });

  it("should judge each row's retryability on its own attempt", async () => {
    // A token unregistered while sending an earlier row says nothing about
    // whether a later one should be retried. Sharing the flag across the pass
    // would turn a permanent configuration error into an endless retry.
    const first = enqueue();
    const second = enqueue();
    register(IPHONE);
    const apns = scriptedApns([
      { ok: false, status: 410, reason: "Unregistered", disposition: "unregister" },
      { ok: false, status: 400, reason: "BadTopic", disposition: "permanent" },
    ]);

    await pushDueDeliveries({ outbox, devices, apns });

    expect(outbox.get(first)?.state).toBe("pending");
    // The device was unregistered by the first row, so the second found no
    // targets at all — which is itself a wait, not a permanent failure.
    expect(outbox.get(second)?.state).toBe("pending");
    expect(outbox.get(second)?.lastError).toContain("No device");
  });

  it("should hold a row when no device has registered yet", async () => {
    const id = enqueue();
    const result = await pushDueDeliveries({ outbox, devices, apns: scriptedApns([ACCEPTED]) });

    // Blocked, not failed. Nothing was sent and nothing refused us, and the
    // job above reads the difference: a block must not open the breaker.
    expect(result.blocked).toEqual([id]);
    expect(result.failed).toEqual([]);
    expect(outbox.get(id)?.state).toBe("pending");
    expect(outbox.get(id)?.lastError).toContain("No device");
  });

  it("should hold a row when APNs is not configured on this machine", async () => {
    const id = enqueue();
    register(IPHONE);

    await pushDueDeliveries({ outbox, devices, apns: null });
    expect(outbox.get(id)?.state).toBe("pending");
    expect(outbox.get(id)?.lastError).toContain("not configured");
  });

  it("should hold a row on a channel this build cannot deliver", async () => {
    const { delivery } = outbox.enqueue({
      channel: "websocket",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "x" },
      idempotencyKey: "ws",
    });
    register(IPHONE);

    await pushDueDeliveries({ outbox, devices, apns: scriptedApns([ACCEPTED]) });
    expect(outbox.get(delivery.id)?.state).toBe("pending");
    expect(outbox.get(delivery.id)?.lastError).toContain("websocket");
  });

  it("should leave a row that is not yet due alone", async () => {
    outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "x" },
      idempotencyKey: "later",
      notBefore: new Date(TEST_NOW + 60_000).toISOString(),
    });
    register(IPHONE);

    const result = await pushDueDeliveries({ outbox, devices, apns: scriptedApns([ACCEPTED]) });
    expect(result.accepted).toHaveLength(0);
  });

  it("should not push a row the device acknowledged between passes", async () => {
    // syl-eer. `due` is read once, and anything can happen between reading it
    // and claiming a row: another drainer, or the device's own ack arriving
    // over HTTP. `markSending` is the compare-and-swap that settles it, and
    // ignoring its answer sends a second notification for one reminder.
    const first = enqueue();
    const second = enqueue();
    register(IPHONE);

    const sent: string[] = [];
    const apns: ApnsSender = {
      send: (notification) => {
        sent.push(String(notification.data?.["deliveryId"]));
        // The phone acknowledges the second row while we are still sending the
        // first — it was in the same digest-less batch and already arrived.
        outbox.acknowledge(second, { ackedAt: new Date(TEST_NOW).toISOString() });
        return Promise.resolve(ACCEPTED);
      },
    };

    await pushDueDeliveries({ outbox, devices, apns });

    expect(sent).toEqual([first]);
    expect(outbox.get(second)?.state).toBe("acknowledged");
    // Not claimed, so not counted: the attempt column means sends, not passes.
    expect(outbox.get(second)?.attempts).toBe(0);
  });

  it("should stop retrying every thirty seconds when nothing can send for a day", async () => {
    // syl-eer, second half. The blocked branches never touched the attempt
    // counter, so backoffFor(0) was 30s forever: an unpaired install woke the
    // drain loop 2,880 times a day, for weeks, and the docstring one screen up
    // says "Nothing retries forever".
    const id = enqueue();

    let attempts = 0;
    for (let elapsed = 0; elapsed <= 86_400_000; elapsed += 30_000) {
      now = TEST_NOW + elapsed;
      const result = await pushDueDeliveries({ outbox, devices, apns: null });
      attempts += result.failed.length;
    }

    expect(attempts).toBeLessThan(40);
    // Held, not dropped. The phone may register tomorrow and the reminder must
    // still be here when it does.
    expect(outbox.get(id)?.state).toBe("pending");
    expect(outbox.get(id)?.nextAttemptAt).not.toBeNull();
  });

  it("should deliver the held row the moment the device finally registers", async () => {
    // The other half of the same guarantee: backing off must not become
    // forgetting.
    const id = enqueue();
    for (let elapsed = 0; elapsed <= 6 * 3_600_000; elapsed += 60_000) {
      now = TEST_NOW + elapsed;
      await pushDueDeliveries({ outbox, devices, apns: null });
    }

    register(IPHONE);
    const apns = scriptedApns([ACCEPTED]);
    // At most an hour later, by the ceiling in `blockedWaitFor`.
    now += 3_600_000;
    const result = await pushDueDeliveries({ outbox, devices, apns });

    expect(result.accepted).toEqual([id]);
    expect(outbox.get(id)?.state).toBe("delivered");
    expect(outbox.get(id)?.attempts).toBe(1);
  });

  it("should record that the device was heard from", async () => {
    enqueue();
    register(IPHONE);
    await pushDueDeliveries({ outbox, devices, apns: scriptedApns([ACCEPTED]) });

    const device = devices.list().items[0];
    expect(device?.lastSeenAt).toBe(new Date(TEST_NOW).toISOString());
  });
});
