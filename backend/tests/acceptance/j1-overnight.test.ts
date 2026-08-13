import type { Delivery, Device, Reminder } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_QUIET_HOURS } from "../../src/config.js";
import { nextDailyOccurrence } from "../../src/harness/schedule.js";
import { fixedClock } from "../../src/services/clock.js";
import type { JobRunner } from "../../src/services/job-runner.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";

/**
 * **Journeys 1, 2 and 3 — the Commander's night.**
 *
 * The existing US1 story fires a reminder in a single pass. Every P0 this
 * project has found on the never-drop path needed two or more passes, a fifth
 * failure, or a whole night before it appeared. So every journey here is driven
 * across many runner ticks and a simulated night, at half-hour resolution,
 * exactly as the runner's own one-minute ceiling would drive it.
 *
 * 1. "Remind me to call the dentist at 3pm tomorrow" — created, held overnight,
 *    fired at the right wall-clock instant, pushed, acknowledged, shown as
 *    delivered on the admin surface.
 * 2. A bad night — four reminders come due between 23:00 and 06:00, in
 *    different passes. **One** notification when the window lifts, naming all four.
 * 3. A phone that was off — Apple accepts and it never arrives. What actually
 *    happens now, honestly, including `syl-dlz`: the server does not re-arm.
 */

const CHICAGO = "America/Chicago";
const APNS_TOKEN = "7ab34c19".repeat(8);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 15:00 Chicago on the day he asks. Well clear of the quiet window. */
const ASKED_AT = Date.parse("2026-08-09T20:00:00.000Z");
/** 15:00 Chicago the next day. */
const DENTIST_AT = "2026-08-10T20:00:00.000Z";
/**
 * Where a night of quiet hours releases to: the minute the window lifts on the
 * morning of the 11th, asked of the window rather than written down. A literal
 * here would go on driving the night to an hour the window no longer ends at,
 * and the night would push early — which is how this file failed when the
 * window moved.
 */
const MORNING_RELEASE = nextDailyOccurrence(
  DEFAULT_QUIET_HOURS.quiet.end,
  // 01:00 Chicago on the 11th: inside the night, so the next end is that morning.
  new Date(Date.parse("2026-08-11T06:00:00.000Z")),
  CHICAGO,
).toISOString();

describe("the Commander's night", () => {
  let syl: LiveService;
  let apple: FakeApns;
  let now: number;

  beforeEach(async () => {
    now = ASKED_AT;
    apple = await startFakeApns();
    // Syl, booted the way `main` boots her, with Apple's address changed and
    // her timer in this test's hand.
    syl = await startLiveService({
      clock: fixedClock(ASKED_AT),
      delivery: { apple, clock: () => now },
    });
  });

  afterEach(async () => {
    await apple.close();
    await syl.close();
  });

  async function registerDevice(): Promise<Device> {
    return expectData<Device>(
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
      }),
    );
  }

  async function setReminder(input: {
    text: string;
    wallTime: string;
    date: string;
  }): Promise<Reminder> {
    return expectData<Reminder>(
      await syl.api("/reminders", {
        method: "POST",
        body: JSON.stringify({ ...input, tz: CHICAGO }),
      }),
    );
  }

  /** The service's own delivery runner. Apple was redirected when it booted. */
  function runnerAgainst(target: FakeApns): { runner: JobRunner; close: () => Promise<void> } {
    if (target !== apple) throw new Error("this journey boots against one Apple");
    return { runner: syl.runtime.runner, close: async () => undefined };
  }

  /** Advance the clock to `until`, ticking every half hour on the way. */
  async function passesUntil(runner: JobRunner, until: number): Promise<void> {
    while (now < until) {
      now = Math.min(now + 30 * MINUTE, until);
      await runner.tick();
    }
  }

  async function deliveries(query = ""): Promise<readonly Delivery[]> {
    return (await expectData<{ items: Delivery[] }>(await syl.api(`/deliveries${query}`))).items;
  }

  describe("journey 1 — remind me to call the dentist at 3pm tomorrow", () => {
    it("should hold it overnight through a day of passes, fire at the right instant, and close on the ack", async () => {
      await registerDevice();
      const reminder = await setReminder({
        text: "Call the dentist.",
        wallTime: "15:00",
        date: "2026-08-10",
      });

      // Resolved from a wall time and an IANA zone, never a stored offset.
      expect(reminder.nextFireAt).toBe(DENTIST_AT);

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();

        // A whole day and night of passes. Nothing may be said before 15:00.
        await passesUntil(runner, Date.parse(DENTIST_AT) - MINUTE);
        expect(apple.pushes, "Syl spoke before the reminder was due").toHaveLength(0);
        expect(await deliveries()).toHaveLength(0);

        now = Date.parse(DENTIST_AT);
        await runner.tick();

        expect(apple.pushes).toHaveLength(1);
        const body = apple.pushes[0]?.body as Record<string, unknown>;
        const aps = body["aps"] as Record<string, unknown>;
        expect(aps["alert"]).toEqual({ title: "Syl", body: "Call the dentist." });
        expect(aps["interruption-level"]).toBe("time-sensitive");

        // Further passes must not say it twice.
        await passesUntil(runner, Date.parse(DENTIST_AT) + 2 * HOUR);
        expect(apple.pushes, "the same reminder was pushed more than once").toHaveLength(1);

        // The phone reads the id out of the notification and acknowledges.
        const deliveryId = String(body["deliveryId"]);
        const acked = await expectData<Delivery>(
          await syl.api(`/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
            method: "POST",
            body: JSON.stringify({ ackedAt: "2026-08-10T20:00:04.000Z", engagement: "opened" }),
          }),
        );
        expect(acked.state).toBe("acknowledged");

        // And the admin surface says so, over HTTP, on the real port.
        const shown = (await deliveries())[0];
        expect(shown?.state).toBe("acknowledged");
        expect(shown?.ackedAt).toBe("2026-08-10T20:00:04.000Z");
        const after = await expectData<Reminder>(
          await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
        );
        expect(after.deliveryState).toBe("acknowledged");
      } finally {
        await close();
      }
    });
  });

  describe("journey 2 — a bad night", () => {
    it("should turn four reminders that came due in four different passes into one notification when the window lifts", async () => {
      await registerDevice();

      // 23:00, 01:00, 04:00 and 06:00 Chicago — all inside the quiet window,
      // all releasing together the minute the window lifts.
      const overnight = [
        await setReminder({ text: "Ship the release notes.", wallTime: "23:00", date: "2026-08-10" }),
        await setReminder({ text: "Rotate the backup key.", wallTime: "01:00", date: "2026-08-11" }),
        await setReminder({ text: "Reply to the landlord.", wallTime: "04:00", date: "2026-08-11" }),
        await setReminder({ text: "Move the standing order.", wallTime: "06:00", date: "2026-08-11" }),
      ];

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();

        // Through the night, half an hour at a time. Each reminder comes due in
        // its own pass — which is the only shape that ever happens in
        // production, and the shape that broke coalescing before.
        await passesUntil(runner, Date.parse(MORNING_RELEASE) - MINUTE);

        expect(apple.pushes, "Syl woke him during quiet hours").toHaveLength(0);
        const held = await deliveries();
        expect(held, "a night of reminders must be held as ONE row, not four").toHaveLength(1);

        // The window lifts. One notification, naming all four.
        now = Date.parse(MORNING_RELEASE);
        await runner.tick();

        expect(apple.pushes, "he got more than one notification for one night").toHaveLength(1);
        const body = apple.pushes[0]?.body as Record<string, unknown>;
        const aps = body["aps"] as Record<string, unknown>;
        expect((aps["alert"] as Record<string, unknown>)["body"]).toBe(
          "Four things came in overnight. They're in the app when you're ready.",
        );

        const row = (await deliveries())[0];
        expect(
          [...(row?.coalescedReminderIds ?? [])].sort(),
          "the notification must name every reminder it stands for",
        ).toEqual(overnight.map((r) => r.id).sort());

        // Acknowledging the digest closes all four.
        const deliveryId = String(body["deliveryId"]);
        await syl.api(`/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
          method: "POST",
          body: JSON.stringify({ ackedAt: "2026-08-11T13:00:05.000Z", engagement: "opened" }),
        });

        for (const reminder of overnight) {
          const after = await expectData<Reminder>(
            await syl.api(`/reminders/${encodeURIComponent(reminder.id)}`),
          );
          expect(after.deliveryState, `${after.text} was never closed`).toBe("acknowledged");
        }
      } finally {
        await close();
      }
    });

    /**
     * `syl-xvx` — the morning digest used to offer Snooze and Done, and the
     * device could act on neither.
     *
     * `coalescedPayload` set `categoryIdentifier: "reminder"`, the APNs category
     * carrying the Complete and Snooze actions, so the digest arrived with both
     * buttons on it. But `notificationFor` includes `reminderId` only when the
     * row has one, and a digest is exactly the row that does not — `foldInto`
     * sets it to `null` deliberately, because the digest speaks for all of them
     * and so for none in particular.
     *
     * On the device, `NotificationService.snooze` and `.complete` both open
     * `guard let reminderId = payload.reminderId else { return }` and returned
     * silently. He tapped Snooze on a night's worth of reminders, nothing was
     * deferred, and the ack that fires alongside closed all of them as seen.
     */
    it("should not offer the digest an action the device cannot carry out", async () => {
      await registerDevice();
      const notes = await setReminder({
        text: "Ship the release notes.",
        wallTime: "23:00",
        date: "2026-08-10",
      });
      const key = await setReminder({
        text: "Rotate the backup key.",
        wallTime: "01:00",
        date: "2026-08-11",
      });

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();
        await passesUntil(runner, Date.parse(MORNING_RELEASE));

        const body = apple.pushes[0]?.body as Record<string, unknown>;
        const aps = body["aps"] as Record<string, unknown>;

        // No `reminderId`, because there genuinely is not one...
        expect(body["reminderId"]).toBeUndefined();
        // ...so it must not arrive under the category whose two actions both
        // require one. The device knows one category; anything else opens the
        // app, which is the only honest answer for a notification standing for
        // several things.
        expect(aps["category"]).not.toBe("reminder");

        // What it does carry is everything it stands for — the set a snooze-all
        // would act on, and the same set the ack path closes.
        expect(
          [...((body["coalescedReminderIds"] as string[] | undefined) ?? [])].sort(),
          "the digest must say which reminders it speaks for",
        ).toEqual([notes.id, key.id].sort());

        // And the delivery id, so the acknowledgement still has something to
        // name and the row still closes.
        expect(body["deliveryId"]).toBeDefined();
      } finally {
        await close();
      }
    });
  });

  describe("journey 3 — a phone that was off", () => {
    it("should stay visible as unacknowledged for as long as the device is silent, and be recoverable on foreground", async () => {
      await registerDevice();
      await setReminder({ text: "Call the dentist.", wallTime: "15:00", date: "2026-08-10" });

      const { runner, close } = runnerAgainst(apple);
      try {
        await runner.start();
        await passesUntil(runner, Date.parse(DENTIST_AT));

        // Apple took it. That is all Apple can ever tell us.
        expect(apple.pushes).toHaveLength(1);
        const accepted = (await deliveries())[0];
        expect(accepted?.state).toBe("delivered");
        expect(accepted?.deliveredAt).not.toBeNull();
        expect(accepted?.ackedAt).toBeNull();

        // The phone is off for two days. Every pass in between.
        await passesUntil(runner, Date.parse(DENTIST_AT) + 48 * HOUR);

        // Honest statement of `syl-dlz`: the server does not re-arm. One push
        // was sent, the row sits `delivered`, and nothing will ever try again.
        expect(apple.pushes, "the server re-armed after all").toHaveLength(1);
        const stale = (await deliveries())[0];
        expect(stale?.nextAttemptAt).toBeNull();

        // What DOES hold the guarantee: the row stays visible as unacknowledged
        // the whole time, which is the query the app's foreground reconcile
        // makes.
        const outstanding = await deliveries("?unacknowledged=true");
        expect(outstanding).toHaveLength(1);
        expect(outstanding[0]?.id).toBe(accepted?.id);
        expect(outstanding[0]?.payload.body).toBe("Call the dentist.");

        // The phone comes back and reconciles from that list alone.
        const acked = await expectData<Delivery>(
          await syl.api(`/deliveries/${encodeURIComponent(outstanding[0]?.id ?? "")}/ack`, {
            method: "POST",
            body: JSON.stringify({ ackedAt: "2026-08-12T20:00:00.000Z", engagement: "opened" }),
          }),
        );
        expect(acked.state).toBe("acknowledged");
        expect(await deliveries("?unacknowledged=true")).toHaveLength(0);
      } finally {
        await close();
      }
    });
  });
});
