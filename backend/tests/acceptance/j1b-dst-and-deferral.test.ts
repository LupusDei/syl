import type { Delivery, Reminder } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JobRunner } from "../../src/services/job-runner.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **The two things a reminder system is actually judged on.**
 *
 * Both are multi-day journeys, and both are invisible to a single-pass test.
 *
 * 1. **A daily reminder across a daylight-saving boundary.** The project's
 *    fifth non-negotiable constraint is "store IANA timezones, never fixed UTC
 *    offsets", and the failure it prevents is exactly this: a recurring
 *    reminder that is correct until the second Sunday in March and an hour
 *    wrong forever after. Nothing else in the suite runs a reminder *through*
 *    a boundary; they assert that the zone was stored.
 *
 * 2. **A deferral.** "Never silently drop a reminder. Deferral must always
 *    return a strictly later instant." Snoozing from the notification and then
 *    actually receiving the deferred one is the whole of the fourth constraint,
 *    and it needs two firings to see.
 */

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * 2027-03-14 is the US spring-forward. A 09:00 Chicago reminder is 15:00Z on
 * the 13th (CST, UTC-6) and 14:00Z on the 14th (CDT, UTC-5). A stored offset
 * would send the 14th's an hour late; adding 24 hours would send it an hour
 * early.
 */
const BEFORE_DST = Date.parse("2027-03-12T18:00:00.000Z");
/** 09:00 Chicago, chosen to sit clear of the quiet window at either end. */
const MORNING_CST = "2027-03-13T15:00:00.000Z";
const MORNING_CDT = "2027-03-14T14:00:00.000Z";
const MORNING_AFTER = "2027-03-15T14:00:00.000Z";

describe("across days", () => {
  let syl: LiveService;
  let apple: FakeApns;
  let now: number;

  beforeEach(async () => {
    now = BEFORE_DST;
    apple = await startFakeApns();
    syl = await startLiveService({ clock: () => now, delivery: { apple, clock: () => now } });
    await syl.api("/devices", {
      method: "POST",
      body: JSON.stringify({
        token: APNS_TOKEN,
        environment: "production",
        platform: "ios",
        name: "Commander's iPhone",
        appVersion: "0.1.0 (14)",
        osVersion: "26.1",
      }),
    });
  });

  afterEach(async () => {
    await apple.close();
    await syl.close();
  });

  /** The service's own delivery runner. Apple was redirected when it booted. */
  function runnerAgainst(target: FakeApns): { runner: JobRunner; close: () => Promise<void> } {
    if (target !== apple) throw new Error("this journey boots against one Apple");
    return { runner: syl.runtime.runner, close: async () => undefined };
  }

  /** Advance to `until`, ticking every fifteen minutes on the way. */
  async function passesUntil(runner: JobRunner, until: number): Promise<void> {
    while (now < until) {
      now = Math.min(now + 15 * MINUTE, until);
      await runner.tick();
    }
  }

  describe("a daily reminder through the spring-forward", () => {
    it("should arrive at 09:00 local on all three mornings, not at a drifting UTC offset", async () => {
      const reminder = await expectData<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Take the tablet.",
            wallTime: "09:00",
            tz: CHICAGO,
            rrule: "FREQ=DAILY",
            kind: "commitment",
          }),
        }),
      );
      expect(reminder.nextFireAt).toBe(MORNING_CST);

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();

        // Three mornings, three notifications, each at 09:00 local.
        for (const morning of [MORNING_CST, MORNING_CDT, MORNING_AFTER]) {
          const target = Date.parse(morning);
          await passesUntil(runner, target - MINUTE);
          const reloaded = await expectData<Reminder>(
            await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
          );
          expect(
            reloaded.nextFireAt,
            `the reminder drifted off 09:00 Chicago on ${morning.slice(0, 10)}`,
          ).toBe(morning);
          await passesUntil(runner, target + MINUTE);
        }

        // Each morning got exactly one row, and each carries the local 09:00.
        const rows = (await expectData<{ items: Delivery[] }>(await syl.api("/deliveries"))).items;
        expect(rows).toHaveLength(3);
        expect([...rows.map((row) => row.scheduledFor)].sort()).toEqual(
          [MORNING_CST, MORNING_CDT, MORNING_AFTER].sort(),
        );

        // None of them is marked late. A reminder that fires an hour off
        // because of a stored offset would be — and saying "late" about a
        // drift is how a timezone bug hides as an honest apology.
        expect(rows.every((row) => row.late === false)).toBe(true);
      } finally {
        await close();
      }
    });

    /**
     * The boundary, end to end, through the live service and a real push.
     *
     * The window ends at 07:00 and `isWithinQuietHours` is end-EXCLUSIVE, so
     * 07:00 is already out of it. That one comparison is what the Commander's
     * whole rhythm rests on: the morning brief is composed at 06:45 and its
     * notification is created at 07:00, and an end that included its own last
     * minute would hold it for another cycle — which is exactly what an 08:00
     * end did on 2026-08-12, holding the brief for seventy-five minutes.
     *
     * This test used to record the opposite as a consequence worth living
     * with: "take the tablet at 07:00" arriving at 08:00 marked late, every
     * day, with nothing late about it except the window. Nothing is held now,
     * so nothing is late.
     */
    it("should deliver a 07:00 commitment AT 07:00, neither held nor marked late", async () => {
      await expectData<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Take the tablet.",
            wallTime: "07:00",
            tz: CHICAGO,
            rrule: "FREQ=DAILY",
            kind: "commitment",
          }),
        }),
      );

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();
        // Up to 07:00 CST on the 13th (13:00Z) and NOT one tick past it, so a
        // push here cannot be a later cycle catching up.
        await passesUntil(runner, Date.parse("2027-03-13T13:00:00.000Z"));

        expect(apple.pushes, "07:00 waited for a later pass").toHaveLength(1);

        const rows = (await expectData<{ items: Delivery[] }>(await syl.api("/deliveries"))).items;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.scheduledFor).toBe("2027-03-13T13:00:00.000Z");
        // Delivered at the instant it was due, not at the end of some later
        // window: the row's own record of when it went out.
        expect(rows[0]?.deliveredAt, "the outbox held a notification it should not have").toBe(
          "2027-03-13T13:00:00.000Z",
        );
        expect(rows[0]?.late, "nothing was late — the window had already lifted").toBe(false);
      } finally {
        await close();
      }
    });
  });

  describe("he snoozes it from the notification", () => {
    it("should fire again fifteen minutes later, having refused to move it earlier", async () => {
      const reminder = await expectData<Reminder>(
        await syl.api("/reminders", {
          method: "POST",
          body: JSON.stringify({
            text: "Move the car.",
            wallTime: "14:00",
            tz: CHICAGO,
            date: "2027-03-12",
          }),
        }),
      );
      const firesAt = Date.parse(reminder.nextFireAt);

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();
        await passesUntil(runner, firesAt);
        expect(apple.pushes).toHaveLength(1);

        // A deferral that does not move forward must be refused outright,
        // never quietly accepted — accepting it is how a reminder disappears.
        const backwards = await syl.api(
          `/reminders/${encodeURIComponent(reminder.id)}/snooze`,
          { method: "POST", body: JSON.stringify({ until: new Date(firesAt - HOUR).toISOString() }) },
        );
        expect(backwards.status).toBe(422);
        expect(((await backwards.json()) as { error: { code: string } }).error.code).toBe(
          "DEFERRAL_NOT_LATER",
        );

        // Fifteen minutes, from the notification action.
        const snoozed = await expectData<Reminder>(
          await syl.api(`/reminders/${encodeURIComponent(reminder.id)}/snooze`, {
            method: "POST",
            body: JSON.stringify({ minutes: 15 }),
          }),
        );
        expect(Date.parse(snoozed.nextFireAt)).toBeGreaterThan(firesAt);
        expect(snoozed.deliveryState).toBe("deferred");

        // And it actually comes back.
        await passesUntil(runner, Date.parse(snoozed.nextFireAt) + MINUTE);
        expect(apple.pushes, "the deferred reminder never came back").toHaveLength(2);
        expect(
          (apple.pushes[1]?.body as { aps: { alert: { body: string } } }).aps.alert.body,
        ).toContain("Move the car.");

        // Two notifications, two rows, one reminder. The second is not a
        // duplicate of the first: its idempotency key is the new occurrence.
        const rows = (await expectData<{ items: Delivery[] }>(await syl.api("/deliveries"))).items;
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(2);
      } finally {
        await close();
      }
    });
  });
});
