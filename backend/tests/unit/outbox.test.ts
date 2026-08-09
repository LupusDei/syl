import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SylDatabase } from "../../src/services/database.js";
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  Outbox,
  SENDING_STALE_MS,
  backoffFor,
  blockedWaitFor,
  type EnqueueDelivery,
} from "../../src/services/outbox.js";
import { PagingError } from "../../src/services/paging.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

/** 02:00 America/Chicago on 2026-08-09 — deep inside quiet hours. */
const OVERNIGHT = Date.UTC(2026, 7, 9, 7, 0, 0, 0);
/** 15:00 America/Chicago — nowhere near them. */
const AFTERNOON = Date.UTC(2026, 7, 9, 20, 0, 0, 0);

const QUIET = { quiet: { start: "22:00", end: "08:00" }, tz: "America/Chicago" };

function reminderDelivery(overrides: Partial<EnqueueDelivery> = {}): EnqueueDelivery {
  return {
    channel: "apns",
    messageClass: "reminder_delivery",
    reminderId: "syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f",
    payload: {
      title: "Syl",
      body: "Call the pharmacy — the refill lapses today.",
      interruptionLevel: "time-sensitive",
    },
    idempotencyKey: "reminder:0198f2c1:2026-08-09T21:00:00.000Z",
    ...overrides,
  };
}

describe("backoffFor", () => {
  it("should grow with the attempt and then stop growing", () => {
    expect(backoffFor(1, 0)).toBe(BACKOFF_MS[0]);
    expect(backoffFor(2, 0)).toBe(BACKOFF_MS[1]);
    expect(backoffFor(99, 0)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it("should treat a zeroth attempt as the first", () => {
    expect(backoffFor(0, 0)).toBe(BACKOFF_MS[0]);
  });

  it("should add jitter, so a fleet of retries does not arrive together", () => {
    expect(backoffFor(1, 1)).toBeGreaterThan(backoffFor(1, 0));
  });
});

describe("blockedWaitFor", () => {
  it("should start at the first step and climb with the wait", () => {
    expect(blockedWaitFor(0, 0)).toBe(BACKOFF_MS[0]);
    expect(blockedWaitFor(BACKOFF_MS[0] ?? 0, 0)).toBe(BACKOFF_MS[1]);
  });

  it("should reach the ceiling and stay there, however long the block lasts", () => {
    // A week with no device paired must not retry every thirty seconds, and
    // must not escalate past an hour either.
    expect(blockedWaitFor(7 * 86_400_000, 0)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it("should never go backwards as the wait grows", () => {
    let previous = 0;
    for (let age = 0; age <= 4 * 3_600_000; age += 30_000) {
      const wait = blockedWaitFor(age, 0);
      expect(wait).toBeGreaterThanOrEqual(previous);
      previous = wait;
    }
  });
});

describe("Outbox", () => {
  let db: SylDatabase;
  let now: number;
  let outbox: Outbox;

  beforeEach(() => {
    db = testDatabase();
    now = AFTERNOON;
    outbox = new Outbox({ db: db.handle, clock: () => now, jitter: () => 0 });
  });

  afterEach(() => {
    db.close();
  });

  describe("enqueue", () => {
    it("should write a pending row carrying the whole notification", () => {
      const { delivery, created } = outbox.enqueue(reminderDelivery());

      expect(created).toBe(true);
      expect(delivery.state).toBe("pending");
      expect(delivery.attempts).toBe(0);
      expect(delivery.deliveredAt).toBeNull();
      expect(delivery.ackedAt).toBeNull();
      // Self-sufficient: the text travels, never an id to fetch.
      expect(delivery.payload.body).toContain("pharmacy");
      expect(delivery.payload.interruptionLevel).toBe("time-sensitive");
    });

    it("should return the existing row for a repeated idempotency key", () => {
      // A delivery job that runs twice — a reboot recovery, two ticks racing —
      // must write one row. Syl never says the same thing twice.
      const first = outbox.enqueue(reminderDelivery());
      const second = outbox.enqueue(reminderDelivery({ payload: { title: "Syl", body: "different" } }));

      expect(second.created).toBe(false);
      expect(second.delivery.id).toBe(first.delivery.id);
      expect(second.delivery.payload.body).toContain("pharmacy");
      expect(outbox.list().items).toHaveLength(1);
    });

    it("should record lateness and the instant it was actually due", () => {
      const { delivery } = outbox.enqueue(
        reminderDelivery({ late: true, scheduledFor: "2026-08-09T13:00:00.000Z" }),
      );
      expect(delivery.late).toBe(true);
      expect(delivery.scheduledFor).toBe("2026-08-09T13:00:00.000Z");
    });

    it("should carry the ids it coalesced", () => {
      const ids = ["syl:reminder:a", "syl:reminder:b"];
      const { delivery } = outbox.enqueue(reminderDelivery({ coalescedReminderIds: ids }));
      expect(delivery.coalescedReminderIds).toEqual(ids);
    });

    it("should schedule a release for an explicitly null notBefore", () => {
      // syl-jim. `notBefore` is typed `string | null`, and a null written
      // straight through to `next_attempt_at` is a pending row that `due` and
      // `nextDueAt` both filter out forever — a dropped reminder in a table
      // that looks healthy. Nullish means "compute it", never "no instant".
      const { delivery } = outbox.enqueue(reminderDelivery({ notBefore: null }));

      expect(delivery.nextAttemptAt).toBe(new Date(now).toISOString());
      expect(outbox.due(now)).toHaveLength(1);
      expect(outbox.nextDueAt()).not.toBeNull();
    });

    it("should keep every enqueued row reachable by some query", () => {
      // The invariant behind syl-jim, asserted over the whole surface rather
      // than one field: nothing pending may be invisible to the drain loop.
      const gated = new Outbox({ db: db.handle, clock: () => now, quietHours: QUIET });
      for (const notBefore of [undefined, null, new Date(now + 60_000).toISOString()]) {
        gated.enqueue(reminderDelivery({ idempotencyKey: `k-${String(notBefore)}`, notBefore }));
      }

      const pending = gated.list().items.filter((delivery) => delivery.state === "pending");
      expect(pending).toHaveLength(3);
      expect(pending.every((delivery) => delivery.nextAttemptAt !== null)).toBe(true);
      // A year is longer than any release this system computes.
      expect(gated.due(now + 365 * 86_400_000)).toHaveLength(3);
    });
  });

  describe("quiet hours", () => {
    it("should hold a notification until the window lifts", () => {
      now = OVERNIGHT;
      const gated = new Outbox({
        db: db.handle,
        clock: () => now,
        quietHours: QUIET,
        jitter: () => 0,
      });

      const { delivery } = gated.enqueue(reminderDelivery());
      // 08:00 America/Chicago on the same day is 13:00Z.
      expect(delivery.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
      expect(gated.due(now)).toHaveLength(0);
    });

    it("should send an urgent notification anyway", () => {
      now = OVERNIGHT;
      const gated = new Outbox({
        db: db.handle,
        clock: () => now,
        quietHours: QUIET,
        jitter: () => 0,
      });

      const { delivery } = gated.enqueue(reminderDelivery({ urgent: true }));
      expect(delivery.nextAttemptAt).toBe(new Date(now).toISOString());
      expect(gated.due(now)).toHaveLength(1);
    });

    it("should not delay anything outside the window", () => {
      const gated = new Outbox({
        db: db.handle,
        clock: () => now,
        quietHours: QUIET,
        jitter: () => 0,
      });
      const { delivery } = gated.enqueue(reminderDelivery());
      expect(delivery.nextAttemptAt).toBe(new Date(AFTERNOON).toISOString());
    });

    it("should answer what the gate would do, so a caller can coalesce", () => {
      // The reminder job asks this to decide whether a batch is all being held
      // until 08:00, which is exactly when it should become one notification.
      const gated = new Outbox({ db: db.handle, clock: () => now, quietHours: QUIET });
      expect(gated.releaseAt(OVERNIGHT)).toBe("2026-08-09T13:00:00.000Z");
      expect(gated.releaseAt(OVERNIGHT, true)).toBe(new Date(OVERNIGHT).toISOString());
      expect(gated.quietHours).toEqual(QUIET);
    });

    it("should say anything at any hour when no quiet hours are configured", () => {
      expect(outbox.quietHours).toBeNull();
      expect(outbox.releaseAt(OVERNIGHT)).toBe(new Date(OVERNIGHT).toISOString());
    });
  });

  describe("due", () => {
    it("should return rows whose attempt window has arrived", () => {
      outbox.enqueue(reminderDelivery());
      expect(outbox.due(now)).toHaveLength(1);
    });

    it("should not return a row scheduled for later", () => {
      outbox.enqueue(reminderDelivery({ notBefore: new Date(now + 60_000).toISOString() }));
      expect(outbox.due(now)).toHaveLength(0);
      expect(outbox.due(now + 60_000)).toHaveLength(1);
    });

    it("should not return a row that has reached a terminal state", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      outbox.recordAccepted(delivery.id, {});
      expect(outbox.due(now)).toHaveLength(0);
    });

    it("should report the next instant anything is due, or null when quiet", () => {
      expect(outbox.nextDueAt()).toBeNull();
      outbox.enqueue(reminderDelivery({ notBefore: "2026-08-09T22:00:00.000Z" }));
      expect(outbox.nextDueAt()).toBe("2026-08-09T22:00:00.000Z");
    });
  });

  describe("attempts", () => {
    it("should count an attempt before it is made", () => {
      // Counted before, not after: a process that dies mid-send must not be
      // able to retry forever without the counter moving.
      const { delivery } = outbox.enqueue(reminderDelivery());
      const claimed = outbox.markSending(delivery.id);

      expect(claimed?.state).toBe("sending");
      expect(claimed?.attempts).toBe(1);
      // A deadline, not a removal: see the reclaim test below.
      expect(claimed?.nextAttemptAt).toBe(new Date(now + SENDING_STALE_MS).toISOString());
    });

    it("should reclaim a row whose send never came back", () => {
      // A process that dies between markSending and the result would leave
      // this row `sending` forever if claiming cleared the attempt instant —
      // a silently dropped reminder in a table that looks perfectly healthy.
      const { delivery } = outbox.enqueue(reminderDelivery());
      const claimed = outbox.markSending(delivery.id);

      expect(claimed?.nextAttemptAt).not.toBeNull();
      expect(outbox.due(now)).toHaveLength(0);
      expect(outbox.due(now + SENDING_STALE_MS)).toHaveLength(1);
      expect(outbox.nextDueAt()).toBe(new Date(now + SENDING_STALE_MS).toISOString());
    });

    it("should record acceptance without calling it delivered", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      const accepted = outbox.recordAccepted(delivery.id, { apnsUniqueId: "UNIQUE-1" });

      expect(accepted?.state).toBe("delivered");
      expect(accepted?.deliveredAt).toBe(new Date(now).toISOString());
      expect(accepted?.apnsUniqueId).toBe("UNIQUE-1");
      // Apple accepting the request is not the device receiving it.
      expect(accepted?.ackedAt).toBeNull();
    });

    it("should schedule a retry with backoff after a transient failure", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      const failed = outbox.recordFailure(delivery.id, {
        error: "APNs 503 ServiceUnavailable",
        retryable: true,
      });

      expect(failed?.state).toBe("pending");
      expect(failed?.lastError).toContain("503");
      expect(failed?.nextAttemptAt).toBe(new Date(now + (BACKOFF_MS[0] ?? 0)).toISOString());
    });

    it("should fail immediately on a permanent refusal", () => {
      // Retrying a wrong bundle id forever floods Apple with requests that
      // cannot succeed.
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      const failed = outbox.recordFailure(delivery.id, { error: "BadTopic", retryable: false });

      expect(failed?.state).toBe("failed");
      expect(failed?.nextAttemptAt).toBeNull();
    });

    it("should abandon a row that has exhausted its attempts", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        outbox.markSending(delivery.id);
        outbox.recordFailure(delivery.id, { error: "ServiceUnavailable", retryable: true });
      }
      outbox.markSending(delivery.id);
      const abandoned = outbox.recordFailure(delivery.id, {
        error: "ServiceUnavailable",
        retryable: true,
      });

      expect(abandoned?.state).toBe("abandoned");
      // Abandoned is not forgotten: the row is still here, and the app's
      // foreground reconcile still finds it.
      expect(outbox.get(delivery.id)).not.toBeNull();
      expect(outbox.list({ unacknowledged: true }).items).toHaveLength(1);
    });

    it("should ignore an attempt against a row it does not have", () => {
      expect(outbox.recordFailure("syl:delivery:missing", { error: "x", retryable: true })).toBeNull();
      expect(outbox.markSending("syl:delivery:missing")).toBeNull();
    });

    it("should refuse a claim on a row that has already left the queue", () => {
      // syl-eer. The `state IN ('pending','sending')` predicate is the
      // compare-and-swap; returning the row regardless of whether it fired
      // leaves the caller unable to tell a won claim from a lost one, and it
      // pushes a second notification for a reminder already delivered.
      const acked = outbox.enqueue(reminderDelivery({ idempotencyKey: "acked" })).delivery;
      outbox.acknowledge(acked.id, { ackedAt: new Date(now).toISOString() });
      expect(outbox.markSending(acked.id)).toBeNull();
      expect(outbox.get(acked.id)?.attempts).toBe(0);

      const sent = outbox.enqueue(reminderDelivery({ idempotencyKey: "sent" })).delivery;
      outbox.markSending(sent.id);
      outbox.recordAccepted(sent.id, {});
      expect(outbox.markSending(sent.id)).toBeNull();

      const refused = outbox.enqueue(reminderDelivery({ idempotencyKey: "refused" })).delivery;
      outbox.markSending(refused.id);
      outbox.recordFailure(refused.id, { error: "BadTopic", retryable: false });
      expect(outbox.markSending(refused.id)).toBeNull();
    });

    it("should still let a claim through for a row mid-flight", () => {
      // The reclaim path depends on it: a row left `sending` by a crash has to
      // be claimable again or it is a silently dropped reminder.
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      expect(outbox.markSending(delivery.id)?.attempts).toBe(2);
    });
  });

  describe("deferBlocked", () => {
    it("should hold the row without spending an attempt", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      const held = outbox.deferBlocked(delivery.id, "No device is registered to receive this.");

      expect(held?.state).toBe("pending");
      expect(held?.attempts).toBe(0);
      expect(held?.lastError).toContain("No device");
      expect(held?.nextAttemptAt).toBe(new Date(now + (BACKOFF_MS[0] ?? 0)).toISOString());
    });

    it("should stop spinning, and never give up, across a week with no device", () => {
      // syl-eer, second half. The drain loop wakes at most every 60s. A blocked
      // row used to come due every 30 seconds for as long as the block lasted —
      // 20,000 attempts a week — because nothing counted against it.
      const { delivery } = outbox.enqueue(reminderDelivery());

      let woken = 0;
      const started = now;
      for (; now <= started + 7 * 86_400_000; now += 30_000) {
        if (outbox.due(now).length === 0) continue;
        woken += 1;
        outbox.deferBlocked(delivery.id, "No device is registered to receive this.");
      }

      // An hour's ceiling over a week: ~170 wake-ups, not 20,000.
      expect(woken).toBeLessThan(200);
      // And still here, still pending, still holding the reminder. An
      // environment that cannot send yet is a state to wait out.
      const final = outbox.get(delivery.id);
      expect(final?.state).toBe("pending");
      expect(final?.attempts).toBe(0);
      expect(outbox.list({ unacknowledged: true }).items).toHaveLength(1);
    });

    it("should leave a row that has already been acknowledged alone", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.acknowledge(delivery.id, { ackedAt: new Date(now).toISOString() });
      outbox.deferBlocked(delivery.id, "No device is registered to receive this.");

      expect(outbox.get(delivery.id)?.state).toBe("acknowledged");
      expect(outbox.get(delivery.id)?.nextAttemptAt).toBeNull();
    });
  });

  describe("acknowledge", () => {
    it("should be the only thing that marks a delivery real", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.markSending(delivery.id);
      outbox.recordAccepted(delivery.id, {});

      const acked = outbox.acknowledge(delivery.id, {
        ackedAt: "2026-08-09T21:00:07.220Z",
        engagement: "opened",
      });

      expect(acked?.state).toBe("acknowledged");
      expect(acked?.ackedAt).toBe("2026-08-09T21:00:07.220Z");
      expect(acked?.engagement).toBe("opened");
    });

    it("should be a no-op the second time, keeping the first instant", () => {
      // The device retries this call by design, and the first instant is the
      // one that is true.
      const { delivery } = outbox.enqueue(reminderDelivery());
      outbox.acknowledge(delivery.id, { ackedAt: "2026-08-09T21:00:07.220Z", engagement: "opened" });
      const again = outbox.acknowledge(delivery.id, {
        ackedAt: "2026-08-09T23:00:00.000Z",
        engagement: "dismissed",
      });

      expect(again?.ackedAt).toBe("2026-08-09T21:00:07.220Z");
      expect(again?.engagement).toBe("opened");
    });

    it("should default the engagement rather than leaving it null", () => {
      const { delivery } = outbox.enqueue(reminderDelivery());
      const acked = outbox.acknowledge(delivery.id, { ackedAt: "2026-08-09T21:00:07.220Z" });
      expect(acked?.engagement).toBe("delivered");
    });

    it("should return null for a row it does not have", () => {
      expect(
        outbox.acknowledge("syl:delivery:missing", { ackedAt: "2026-08-09T21:00:07.220Z" }),
      ).toBeNull();
    });

    it("should acknowledge a row that was never even sent", () => {
      // The app reconciles on foreground and acknowledges whatever it finds.
      // Push may have collapsed the notification, or never arrived at all.
      const { delivery } = outbox.enqueue(reminderDelivery());
      const acked = outbox.acknowledge(delivery.id, { ackedAt: "2026-08-09T21:00:07.220Z" });
      expect(acked?.state).toBe("acknowledged");
      expect(outbox.due(now)).toHaveLength(0);
    });
  });

  describe("list", () => {
    beforeEach(() => {
      outbox.enqueue(reminderDelivery({ idempotencyKey: "one" }));
      now += 1_000;
      const second = outbox.enqueue(reminderDelivery({ idempotencyKey: "two" }));
      outbox.acknowledge(second.delivery.id, { ackedAt: "2026-08-09T20:00:01.000Z" });
    });

    it("should filter by state", () => {
      expect(outbox.list({ state: "acknowledged" }).items).toHaveLength(1);
      expect(outbox.list({ state: "pending" }).items).toHaveLength(1);
    });

    it("should filter to what was never acknowledged", () => {
      const unacked = outbox.list({ unacknowledged: true });
      expect(unacked.items).toHaveLength(1);
      expect(unacked.items[0]?.idempotencyKey).toBe("one");
    });

    it("should page newest first", () => {
      const first = outbox.list({ limit: 1 });
      expect(first.items[0]?.idempotencyKey).toBe("two");
      expect(first.hasMore).toBe(true);

      const second = outbox.list({ limit: 1, cursor: first.nextCursor });
      expect(second.items[0]?.idempotencyKey).toBe("one");
      expect(second.hasMore).toBe(false);
    });

    it("should refuse a cursor it did not issue", () => {
      expect(() => outbox.list({ cursor: "nope" })).toThrow(PagingError);
    });
  });

  it("should keep the test clock and the fixed instant in agreement", () => {
    // Guards the fixtures the other suites hang off: TEST_NOW is 07:00Z, which
    // is 02:00 in America/Chicago and therefore inside quiet hours.
    expect(TEST_NOW).toBe(OVERNIGHT);
  });
});
