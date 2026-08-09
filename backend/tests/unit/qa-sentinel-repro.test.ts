import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { deliverDueReminders } from "../../src/jobs/deliver-reminders.js";
import { createReminderDeliveryHandler } from "../../src/jobs/reminder-delivery-job.js";
import { defineReminderDeliveryJob } from "../../src/jobs/reminder-delivery-job.js";
import type { SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { BREAKER_THRESHOLD, JobStore } from "../../src/services/job-store.js";
import { JobRunner, type Timers } from "../../src/services/job-runner.js";
import { Outbox } from "../../src/services/outbox.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { testDatabase } from "../helpers/service.js";

/**
 * QA sentinel reproductions. Every test in this file is expected to FAIL
 * against the current product code — each one demonstrates a defect.
 *
 * Nothing here fixes anything. Delete this file once the beads it names close.
 */

const CHICAGO = "America/Chicago";
const QUIET = { quiet: { start: "22:00", end: "08:00" }, tz: CHICAGO };

/** 2026-08-09T03:00Z — 22:00 Chicago on the 8th, just inside quiet hours. */
const TEN_PM = Date.UTC(2026, 7, 9, 3, 0, 0, 0);

/** Timers that never fire: the runner is driven by hand. */
const inertTimers: Timers = { set: () => null, clear: () => undefined };

describe("syl-qa: the reminder-delivery circuit breaker is a one-way door", () => {
  let db: SylDatabase;
  let now: number;

  beforeEach(() => {
    db = testDatabase();
    now = TEN_PM;
  });
  afterEach(() => db.close());

  it("should keep delivering reminders after five consecutive handler failures", async () => {
    const jobs = new JobStore({ db: db.handle, clock: () => now });
    const reminders = new ReminderService({ db: db.handle, clock: () => now });
    const outbox = new Outbox({ db: db.handle, clock: () => now });
    const devices = new DeviceTokenService({ db: db.handle, clock: () => now });

    defineReminderDeliveryJob(jobs, new Date(now).toISOString());

    // A handler that throws for the first five passes and then recovers. Any
    // transient fault does this: APNs refusing the connection, SQLITE_BUSY,
    // a DNS blip. Nothing here is permanent.
    let failuresLeft = BREAKER_THRESHOLD;
    const real = createReminderDeliveryHandler({ reminders, outbox, devices, apns: null });
    const runner = new JobRunner({
      store: jobs,
      handlers: new Map([
        [
          "reminder_delivery",
          async (context) => {
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error("APNs connection reset");
            }
            return real(context);
          },
        ],
      ]),
      clock: () => now,
      timers: inertTimers,
      onError: () => undefined,
    });

    await runner.start();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      now += 60_000;
      await runner.tick();
    }

    // The transient fault is over. A reminder is created and comes due.
    const reminder = reminders.create({
      text: "Take the medication.",
      wallTime: "23:30",
      tz: CHICAGO,
      date: "2026-08-08",
    });
    now = Date.parse(reminder.nextFireAt) + 1_000;

    // Give the runner every chance: an hour of ticks.
    for (let i = 0; i < 60; i += 1) {
      now += 60_000;
      await runner.tick();
    }

    // The reminder must have reached the outbox. It has not: the breaker is
    // open, `JobStore.due` excludes open breakers, and nothing anywhere ever
    // moves a breaker back to closed or half_open — not a cooldown, not an
    // endpoint, not a restart. Every future reminder is silently dropped.
    expect(reminders.get(reminder.id)?.deliveryState).not.toBe("scheduled");
    expect(outbox.list().items).toHaveLength(1);
  });
});

describe("syl-qa: overnight coalescing is per-pass, so it both bursts and drops", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;

  beforeEach(() => {
    db = testDatabase();
    now = TEN_PM;
    reminders = new ReminderService({ db: db.handle, clock: () => now });
    outbox = new Outbox({ db: db.handle, clock: () => now, quietHours: QUIET, jitter: () => 0 });
  });
  afterEach(() => db.close());

  function make(text: string, wallTime: string, date: string): void {
    reminders.create({ text, wallTime, tz: CHICAGO, date });
  }

  it("should coalesce reminders that came due in different passes into one notification", () => {
    // Three reminders spread across the night, exactly as they arrive in
    // reality. The job wakes at most every 60s, so each one is handled by its
    // own pass.
    make("One thing.", "22:30", "2026-08-08");
    make("Another thing.", "23:30", "2026-08-08");
    make("A third thing.", "01:30", "2026-08-09");

    // Pass at 22:31, 23:31 and 01:31 Chicago.
    for (const at of [
      Date.UTC(2026, 7, 9, 3, 31, 0, 0),
      Date.UTC(2026, 7, 9, 4, 31, 0, 0),
      Date.UTC(2026, 7, 9, 6, 31, 0, 0),
    ]) {
      now = at;
      deliverDueReminders({ reminders, outbox }, now);
    }

    // All three release at 08:00 Chicago. The design promises one
    // notification; the outbox holds three, and at 08:00 the phone buzzes
    // three times in one second — the exact burst this was built to prevent.
    const held = outbox.list().items;
    expect(held.map((d) => d.nextAttemptAt)).toEqual([
      "2026-08-09T13:00:00.000Z",
      "2026-08-09T13:00:00.000Z",
      "2026-08-09T13:00:00.000Z",
    ]);
    expect(held).toHaveLength(1);
  });

  it("should not lose reminders into a digest written by an earlier pass", () => {
    // Pass one: two reminders coalesce into a digest keyed on the release
    // instant, `reminder-batch:2026-08-09T13:00:00.000Z`.
    make("Pay the invoice.", "22:30", "2026-08-08");
    make("Email the landlord.", "22:30", "2026-08-08");
    now = Date.UTC(2026, 7, 9, 3, 31, 0, 0);
    deliverDueReminders({ reminders, outbox }, now);

    // Pass two, an hour later: two MORE reminders come due in the same quiet
    // window, so they hash to the same release instant and the same
    // idempotency key.
    make("Call the pharmacy.", "23:30", "2026-08-08");
    make("Move the car.", "23:30", "2026-08-08");
    now = Date.UTC(2026, 7, 9, 4, 31, 0, 0);
    const second = deliverDueReminders({ reminders, outbox }, now);

    // The enqueue is a no-op — the key already exists — but all four
    // reminders are marked fired.
    expect(second.fired).toHaveLength(2);
    for (const reminder of reminders.list().items) {
      expect(reminder.deliveryState).toBe("delivered");
    }

    // Every reminder marked delivered must be named by some outbox row.
    // Two of them are named by nothing at all: the digest still says "Two
    // things" and still carries only the first pair's ids. The Commander is
    // never told about the pharmacy or the car, and no row in the system
    // records that they were dropped.
    const named = new Set(
      outbox.list().items.flatMap((d) => [
        ...(d.reminderId === null ? [] : [d.reminderId]),
        ...d.coalescedReminderIds,
      ]),
    );
    const missing = reminders
      .list()
      .items.map((r) => r.id)
      .filter((id) => !named.has(id));

    expect(missing).toEqual([]);
  });
});

describe("syl-qa: the outbox accepts a delivery that can never become due", () => {
  let db: SylDatabase;
  const now = TEN_PM;

  beforeEach(() => {
    db = testDatabase();
  });
  afterEach(() => db.close());

  it("should refuse, or schedule, an enqueue whose notBefore is null", () => {
    const outbox = new Outbox({ db: db.handle, clock: () => now });

    // `EnqueueDelivery.notBefore` is typed `string | null`. `enqueue` only
    // computes a release instant when the field is *absent*; an explicit null
    // is written straight through to `next_attempt_at`.
    const { delivery } = outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "Take the medication." },
      idempotencyKey: "never-due",
      notBefore: null,
    });

    expect(delivery.state).toBe("pending");
    expect(delivery.nextAttemptAt).not.toBeNull();

    // `due` and `nextDueAt` both require `next_attempt_at IS NOT NULL`, so
    // this row is pending forever and no query in the system will ever return
    // it again. A dropped reminder in a table that looks healthy.
    expect(outbox.due(now + 365 * 86_400_000)).toHaveLength(1);
    expect(outbox.nextDueAt()).not.toBeNull();
  });
});

describe("syl-qa: markSending does not verify it won the claim", () => {
  let db: SylDatabase;
  const now = TEN_PM;

  beforeEach(() => {
    db = testDatabase();
  });
  afterEach(() => db.close());

  it("should refuse to claim a delivery that is already acknowledged", () => {
    const outbox = new Outbox({ db: db.handle, clock: () => now });
    const { delivery } = outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      payload: { title: "Syl", body: "Take the medication." },
      idempotencyKey: "already-acked",
    });

    outbox.acknowledge(delivery.id, { ackedAt: new Date(now).toISOString() });

    // The UPDATE's `state IN ('pending','sending')` predicate matches nothing,
    // but `markSending` returns `this.get(id)` regardless of `changes`, so the
    // caller cannot tell a won claim from a lost one. `pushDueDeliveries`
    // reads that as success and pushes anyway.
    const claimed = outbox.markSending(delivery.id);
    expect(claimed).toBeNull();
  });
});
